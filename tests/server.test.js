const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const rootDir = path.resolve(__dirname, "..");
const serverPath = path.join(rootDir, "server.js");
const svnStubDir = fs.mkdtempSync(path.join(os.tmpdir(), "svn-review-svn-stub-"));
fs.writeFileSync(path.join(svnStubDir, "svn.cmd"), "@echo off\r\nif \"%SVN_STUB_MODE%\"==\"unversioned\" if \"%1\"==\"status\" if \"%2\"==\"--quiet\" exit /b 0\r\nif \"%SVN_STUB_MODE%\"==\"unversioned\" if \"%1\"==\"status\" echo ?       a.cs\r\nif \"%SVN_STUB_MODE%\"==\"unversioned\" if \"%1\"==\"status\" exit /b 0\r\necho not a working copy 1>&2\r\nexit /b 1\r\n", "utf8");
process.on("exit", () => fs.rmSync(svnStubDir, { recursive: true, force: true }));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function json(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : "";
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method: options.method || "GET",
      headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {},
    }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on("error", reject);
    req.setTimeout(options.timeout || 700, () => req.destroy(new Error("request timed out: " + pathname)));
    if (body) req.write(body);
    req.end();
  });
}

function sse(port) {
  return new Promise((resolve, reject) => {
    let done = false;
    const req = http.request({ hostname: "127.0.0.1", port, path: "/api/events" }, (res) => {
      res.on("data", (chunk) => {
        if (done) return;
        done = true;
        req.destroy();
        resolve({ status: res.statusCode, headers: res.headers, body: String(chunk) });
      });
    });
    req.on("error", (error) => { if (!done) reject(error); });
    req.setTimeout(700, () => { if (!done) { done = true; req.destroy(); reject(new Error("sse timed out")); } });
    req.end();
  });
}

async function startServer(args = [], env = {}, useStub = true) {
  const port = await freePort();
  const child = spawn(process.execPath, [serverPath, ...args], {
    cwd: rootDir,
    env: { ...process.env, ...env, PORT: String(port), PATH: useStub ? svnStubDir + path.delimiter + (process.env.PATH || "") : process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    child.kill("SIGKILL");
    setTimeout(resolve, 500);
  });
  for (let i = 0; i < 30; i++) {
    try {
      const res = await json(port, "/api/health", { timeout: 300 });
      if (res.status === 200 && res.body?.ok) return { port, stop };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await stop();
  throw new Error("server did not start\n" + output);
}

async function run(name, fn) {
  try {
    await fn();
    console.log("ok - " + name);
  } catch (error) {
    console.error("not ok - " + name);
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  }
}

async function testNoRoot() {
  const server = await startServer();
  try {
    const res = await json(server.port, "/api/status");
    assert.equal(res.status, 200);
    assert.equal(res.body.root, "");
    assert.deepEqual(res.body.files, []);

    const listed = await json(server.port, "/api/list?path=");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.files, []);

    const batch = await json(server.port, "/api/list-loaded", { method: "POST", body: { paths: [""] } });
    assert.equal(batch.status, 200);
    assert.deepEqual(batch.body.dirs, {});
  } finally {
    await server.stop();
  }
}

async function testEventsEndpoint() {
  const server = await startServer();
  try {
    const event = await sse(server.port);
    assert.equal(event.status, 200);
    assert(event.headers["content-type"].includes("text/event-stream"));
    assert(event.body.includes("connected"));
  } finally {
    await server.stop();
  }
}

async function testLazyPlainDirectory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "svn-review-plain-"));
  const server = await startServer();
  try {
    fs.mkdirSync(path.join(dir, "sub"));
    fs.mkdirSync(path.join(dir, ".hidden"));
    fs.writeFileSync(path.join(dir, "a.cs"), "class A {}\n", "utf8");
    fs.writeFileSync(path.join(dir, "notes.docx"), "fake docx\n", "utf8");
    fs.writeFileSync(path.join(dir, "sub", "b.js"), "const b = 1;\n", "utf8");
    fs.writeFileSync(path.join(dir, ".hidden", "secret.js"), "secret\n", "utf8");

    const status = await json(server.port, "/api/set-root", { method: "POST", body: { path: dir } });
    assert.equal(status.status, 200);
    assert.equal(path.resolve(status.body.root), dir);
    assert.deepEqual(status.body.status, []);
    assert(status.body.files.some((item) => item.path === "sub" && item.type === "dir"));
    assert(status.body.files.some((item) => item.path === "a.cs" && item.type === "file"));
    assert(status.body.files.some((item) => item.path === "notes.docx" && item.type === "file"));
    assert(!status.body.files.some((item) => item.path === "sub/b.js"));
    assert(!status.body.files.some((item) => item.path === ".hidden"));

    const listed = await json(server.port, "/api/list?path=sub");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.files, [{ path: "sub/b.js", type: "file", status: "" }]);

    const code = await json(server.port, "/api/file?path=sub%2Fb.js");
    assert.equal(code.status, 200);
    assert.equal(code.body.content, "const b = 1;\n");
    assert.deepEqual(code.body.hunks, []);

    const doc = await json(server.port, "/api/file?path=notes.docx");
    assert.equal(doc.status, 415);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testSaveFileWritesRealFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "svn-review-save-"));
  const server = await startServer();
  try {
    fs.writeFileSync(path.join(dir, "a.js"), "const a = 1;\n", "utf8");
    await json(server.port, "/api/set-root", { method: "POST", body: { path: dir } });

    const saved = await json(server.port, "/api/file", { method: "POST", body: { path: "a.js", base: "const a = 1;\n", content: "const a = 2;\n" } });
    assert.equal(saved.status, 200);
    assert.equal(fs.readFileSync(path.join(dir, "a.js"), "utf8"), "const a = 2;\n");

    const stale = await json(server.port, "/api/file", { method: "POST", body: { path: "a.js", base: "const a = 1;\n", content: "const a = 3;\n" } });
    assert.equal(stale.status, 409);
    assert.equal(fs.readFileSync(path.join(dir, "a.js"), "utf8"), "const a = 2;\n");
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
async function testUnversionedNotNew() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "svn-review-status-"));
  const server = await startServer([], { SVN_STUB_MODE: "unversioned" });
  try {
    fs.writeFileSync(path.join(dir, "a.cs"), "class A {}\n", "utf8");
    const status = await json(server.port, "/api/set-root", { method: "POST", body: { path: dir } });
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.files, [{ path: "a.cs", type: "file", status: "" }]);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testRealSvnRevertHunk() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "svn-review-real-"));
  const repo = path.join(base, "repo");
  const wc = path.join(base, "wc");
  let server = null;
  try {
    execFileSync("svnadmin", ["create", repo]);
    execFileSync("svn", ["checkout", pathToFileURL(repo).href, wc], { stdio: "ignore" });
    const file = path.join(wc, "sample.js");
    const original = Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\r\n") + "\r\n";
    fs.writeFileSync(file, original, "utf8");
    execFileSync("svn", ["add", "sample.js"], { cwd: wc, stdio: "ignore" });
    execFileSync("svn", ["commit", "-m", "init"], { cwd: wc, stdio: "ignore" });

    const changed = original
      .replace("const line2 = 2;", "const line2 = 200;")
      .replace("const line25 = 25;", "const line25 = 2500;");
    fs.writeFileSync(file, changed, "utf8");

    server = await startServer([wc], {}, false);
    const statusBefore = await json(server.port, "/api/status");
    assert.equal(statusBefore.body.files.find((item) => item.path === "sample.js")?.status, "M");

    const changedFiles = await json(server.port, "/api/changed-files");
    assert.equal(changedFiles.status, 200);
    assert.deepEqual(changedFiles.body.files, [{ path: "sample.js", status: "M" }]);

    const before = await json(server.port, "/api/file?path=sample.js");
    assert.equal(before.status, 200);
    assert.equal(before.body.hunks.length, 2);

    const reverted = await json(server.port, "/api/revert-hunk", { method: "POST", body: { path: "sample.js", hunk: 0 } });
    assert.equal(reverted.status, 200);

    const content = fs.readFileSync(file, "utf8");
    assert(content.includes("const line2 = 2;"));
    assert(content.includes("const line25 = 2500;"));

    const after = await json(server.port, "/api/file?path=sample.js");
    assert.equal(after.status, 200);
    assert.equal(after.body.hunks.length, 1);
    assert(!after.body.hunks.some((h) => h.lines.join('\n').includes('line2 =')), 'reverted hunk should disappear from diff');

    const revertedLast = await json(server.port, "/api/revert-hunk", { method: "POST", body: { path: "sample.js", hunk: 0 } });
    assert.equal(revertedLast.status, 200);

    const clean = await json(server.port, "/api/file?path=sample.js");
    assert.equal(clean.status, 200);
    assert.equal(clean.body.hunks.length, 0);

    const listed = await json(server.port, "/api/list?path=");
    assert.equal(listed.body.files.find((item) => item.path === "sample.js")?.status, "");

    const batched = await json(server.port, "/api/list-loaded", { method: "POST", body: { paths: [""] } });
    assert.equal(batched.status, 200);
    assert.equal(batched.body.dirs[""].find((item) => item.path === "sample.js")?.status, "");

    const cleanChangedFiles = await json(server.port, "/api/changed-files");
    assert.deepEqual(cleanChangedFiles.body.files, []);
  } finally {
    if (server) await server.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

run("server can start without a selected root", testNoRoot)
  .then(() => run("sse events endpoint is available", testEventsEndpoint))
  .then(() => run("plain local directory is loaded lazily and hides dot directories", testLazyPlainDirectory))
  .then(() => run("saving a file writes the real file", testSaveFileWritesRealFile))
  .then(() => run("unversioned files are not shown as new", testUnversionedNotNew))
  .then(() => run("revert hunk only reverts the requested svn block", testRealSvnRevertHunk));
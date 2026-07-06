const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const pluginRoot = path.resolve(__dirname, "..");
const server = path.join(pluginRoot, "server.js");

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function existingDir(value) {
  if (!value) return null;
  const full = path.resolve(value);
  return fs.existsSync(full) && fs.statSync(full).isDirectory() ? full : null;
}

function findSessionFiles(dir, threadId, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findSessionFiles(full, threadId, out);
    else if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function latestCwdFromSession(file) {
  let cwd = null;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.includes('"cwd"')) continue;
    try {
      const item = JSON.parse(line);
      const value = item?.payload?.cwd;
      if (typeof value === "string" && value.trim()) cwd = value;
    } catch {}
  }
  return existingDir(cwd);
}

function codexThreadCwd() {
  const threadId = process.env.CODEX_THREAD_ID;
  if (!threadId) return null;
  const home = process.env.USERPROFILE || os.homedir();
  const sessionsDir = path.join(home, ".codex", "sessions");
  const files = findSessionFiles(sessionsDir, threadId)
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { file } of files) {
    const cwd = latestCwdFromSession(file);
    if (cwd && !isInside(cwd, pluginRoot)) return cwd;
  }
  return null;
}

function resolveRoot() {
  const explicit = existingDir(process.argv[2]);
  if (explicit) return explicit;

  for (const name of ["SVN_REVIEW_ROOT", "CODEX_WORKSPACE_ROOT", "CODEX_WORKSPACE", "WORKSPACE_ROOT"]) {
    const value = existingDir(process.env[name]);
    if (value && !isInside(value, pluginRoot)) return value;
  }

  const cwd = existingDir(process.cwd());
  if (cwd && !isInside(cwd, pluginRoot)) return cwd;

  const fromThread = codexThreadCwd();
  if (fromThread) return fromThread;

  return null;
}

const root = resolveRoot();

function canUse(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

function getJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(500, () => { req.destroy(); resolve(null); });
  });
}

function reviewUrl(port) {
  const base = `http://127.0.0.1:${port}/`;
  return root ? `${base}?path=${encodeURIComponent(root)}` : base;
}

async function findPort() {
  for (let port = Number(process.env.PORT || 5173); port < 5200; port++) {
    const health = await getJson(`http://127.0.0.1:${port}/api/health`);
    if (health?.ok) return { port, reused: true };
    if (await canUse(port)) return { port, reused: false };
  }
  throw new Error("No free port found from 5173 to 5199.");
}

async function waitForHealth(port) {
  const url = `http://127.0.0.1:${port}/api/health`;
  for (let i = 0; i < 40; i++) {
    const health = await getJson(url);
    if (health?.ok) return health;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("SVN Review server did not become ready.");
}

(async () => {
  const { port, reused } = await findPort();
  let pid = null;
  if (!reused) {
    const env = { ...process.env, PORT: String(port) };
    if (root) env.SVN_REVIEW_ROOT = root;
    const child = spawn(process.execPath, root ? [server, root] : [server], {
      cwd: pluginRoot,
      detached: true,
      stdio: "ignore",
      env,
      windowsHide: true,
    });
    child.unref();
    pid = child.pid;
    await waitForHealth(port);
  }
  console.log(JSON.stringify({ url: reviewUrl(port), baseUrl: `http://127.0.0.1:${port}/`, root: root || "", port, pid, reused }));
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
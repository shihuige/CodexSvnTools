const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 5173);
const PUBLIC = path.join(__dirname, "public");
const DEFAULT_ROOT =
  process.argv[2] ||
  process.env.SVN_REVIEW_ROOT ||
  process.env.CODEX_WORKSPACE_ROOT ||
  process.env.CODEX_WORKSPACE ||
  process.env.WORKSPACE_ROOT ||
  "";
const ROOT_LOCKED = Boolean(DEFAULT_ROOT);
let root = DEFAULT_ROOT ? path.resolve(DEFAULT_ROOT) : "";
let statusCache = { changed: [], statusMap: {} };
let watcher = null;
let changeTimer = null;
const eventClients = new Set();
const CODE_EXTS = new Set([
  ".bat", ".c", ".cmd", ".config", ".cpp", ".cs", ".cshtml", ".csproj", ".css", ".fs", ".fsproj", ".go", ".h", ".hpp", ".htm", ".html", ".java", ".js", ".json", ".jsx", ".kt", ".kts", ".less", ".lua", ".props", ".ps1", ".py", ".razor", ".resx", ".rb", ".rs", ".sass", ".scss", ".sh", ".sln", ".sql", ".swift", ".targets", ".ts", ".tsx", ".vb", ".vbproj", ".vue", ".xaml", ".xml", ".yaml", ".yml"
]);
const CODE_NAMES = new Set([".editorconfig", ".gitignore", "dockerfile", "jenkinsfile", "makefile"]);

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function pushEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`;
  for (const res of eventClients) res.write(payload);
}

function notifyChanged(filePath = "") {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => pushEvent("change", { path: filePath, ts: Date.now() }), 250);
}

function watchRoot() {
  if (watcher) watcher.close();
  watcher = null;
  if (!root) return;
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, file) => {
      const rel = file ? String(file).replaceAll("\\", "/") : "";
      if (rel.split("/").includes(".svn")) return;
      notifyChanged(rel);
    });
    watcher.on("error", () => { watcher?.close(); watcher = null; });
  } catch {
    watcher = null;
  }
}

function events(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  eventClients.add(res);
  req.on("close", () => eventClients.delete(res));
  if (root && !watcher) watchRoot();
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

function run(cmd, args, cwd = root || process.cwd()) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: err.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runSvn(args) {
  if (!root) return Promise.resolve({ code: 1, stdout: "", stderr: "No folder selected" });
  return run("svn", args, root);
}

function safeRel(rel = "") {
  if (!root) return "";
  const normalized = rel.replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalized.includes("..")) return "";
  const full = path.resolve(root, normalized || ".");
  const relative = path.relative(root, full);
  return !relative.startsWith("..") && !path.isAbsolute(relative) ? normalized : "";
}

function isCodeFile(filePath) {
  const name = path.basename(filePath).toLowerCase();
  if (CODE_NAMES.has(name)) return true;
  return CODE_EXTS.has(path.extname(name));
}

function isVisiblePath(filePath) {
  const parts = filePath.replaceAll("\\", "/").split("/").filter(Boolean);
  return !parts.includes(".svn") && !parts.slice(0, -1).some((part) => part.startsWith("."));
}
function parseStatus(stdout) {
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => ({
    text: line,
    status: line[0] === " " ? line[1] : line[0],
    path: line.slice(8).trim().replaceAll("\\", "/"),
  })).filter((x) => x.path);
}

function worse(a, b) {
  const order = ["", "M", "A", "D", "!", "?", "R", "C"];
  return order.indexOf(a) > order.indexOf(b) ? a : b;
}

function statusForPath(rel, type) {
  const direct = statusCache.statusMap[rel] || "";
  if (type !== "dir") return direct;
  const prefix = rel ? rel + "/" : "";
  return statusCache.changed.reduce((status, item) => item.path.startsWith(prefix) ? worse(status, item.status) : status, direct);
}

function listDir(rel = "") {
  const safe = safeRel(rel);
  if (rel && !safe) return [];
  const dir = path.join(root, safe || ".");
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    if (entry.name === ".svn" || entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && entry.name.startsWith(".")) continue;
    const itemRel = (safe ? safe + "/" : "") + entry.name;
    const full = path.join(dir, entry.name);
    let real = "";
    try { real = fs.realpathSync.native(full); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    if (entry.isDirectory()) out.push({ path: itemRel, type: "dir", status: statusForPath(itemRel, "dir") });
    else if (entry.isFile()) out.push({ path: itemRel, type: "file", status: statusForPath(itemRel, "file") });
  }
  return out.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "dir" ? -1 : 1));
}

function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("Index: ")) {
      file = { path: line.slice(7).trim().replaceAll("\\", "/"), header: [line], hunks: [] };
      files.push(file);
      hunk = null;
    } else if (file && line.startsWith("@@ ")) {
      const m = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      hunk = { header: line, oldStart: Number(m?.[1] || 0), oldCount: m?.[2] == null ? 1 : Number(m[2]), newStart: Number(m?.[3] || 0), newCount: m?.[4] == null ? 1 : Number(m[4]), lines: [line] };
      file.hunks.push(hunk);
    } else if (hunk) hunk.lines.push(line);
    else if (file) file.header.push(line);
  }
  return files;
}

function hunkSides(hunk) {
  const oldLines = [];
  const newLines = [];
  for (const line of hunk.lines.slice(1)) {
    if (line.startsWith('\\')) continue;
    if (line.startsWith(' ') || line.startsWith('-')) oldLines.push(line.slice(1));
    if (line.startsWith(' ') || line.startsWith('+')) newLines.push(line.slice(1));
  }
  return { oldLines, newLines };
}

function splitChunks(text) {
  const chunks = [];
  text.replace(/([^\r\n]*)(\r\n|\n|\r|$)/g, (match, line, eol, offset) => {
    if (match || offset < text.length) chunks.push({ text: line, eol });
    return match;
  });
  return chunks;
}

function revertHunkContent(content, hunk) {
  const { oldLines, newLines } = hunkSides(hunk);
  const chunks = splitChunks(content);
  const start = Math.max(0, hunk.newStart - 1);
  const current = chunks.slice(start, start + hunk.newCount).map((x) => x.text);
  if (current.length !== newLines.length || current.some((line, i) => line !== newLines[i])) return null;
  const removed = chunks.slice(start, start + hunk.newCount);
  const eol = removed.find((x) => x.eol)?.eol || chunks[start - 1]?.eol || chunks[start]?.eol || chunks.find((x) => x.eol)?.eol || '\n';
  const lastEol = start + hunk.newCount >= chunks.length ? removed.at(-1)?.eol || '' : eol;
  const replacement = oldLines.map((text, i) => ({ text, eol: i === oldLines.length - 1 ? lastEol : eol }));
  chunks.splice(start, hunk.newCount, ...replacement);
  return chunks.map((x) => x.text + x.eol).join('');
}

function markers(file) {
  const byLine = {};
  const deleted = [];
  for (let h = 0; h < file.hunks.length; h++) {
    let newLine = file.hunks[h].newStart;
    for (const line of file.hunks[h].lines.slice(1)) {
      if (line.startsWith("+")) byLine[newLine++] = { kind: "add", hunk: h };
      else if (line.startsWith("-")) deleted.push({ after: Math.max(0, newLine - 1), text: line.slice(1), hunk: h });
      else if (!line.startsWith("\\")) newLine++;
    }
  }
  return { byLine, deleted };
}

async function chooseFolder() {
  const script = "Add-Type -AssemblyName System.Windows.Forms;$f=New-Object System.Windows.Forms.Form;$f.TopMost=$true;$f.ShowInTaskbar=$false;$f.WindowState='Minimized';$d=New-Object System.Windows.Forms.FolderBrowserDialog;$d.Description='Select local folder';if($d.ShowDialog($f) -eq 'OK'){[Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8;Write-Output $d.SelectedPath};$f.Dispose()";
  const ps = await run("powershell.exe", ["-NoProfile", "-STA", "-Command", script], process.cwd());
  return ps.code ? "" : ps.stdout.trim();
}

async function refreshStatus() {
  statusCache = { changed: [], statusMap: {} };
  if (!root) return;
  const status = await runSvn(["status", "--quiet"]);
  if (status.code !== 0) return;
  const changed = parseStatus(status.stdout);
  statusCache = { changed, statusMap: Object.fromEntries(changed.map((x) => [x.path, x.status])) };
}

async function statusPayload(res) {
  if (!root) return send(res, 200, { root: "", files: [], status: [], statusMap: {}, diff: [], lockedRoot: ROOT_LOCKED });
  await refreshStatus();
  return send(res, 200, { root, files: listDir(), status: [], statusMap: {}, diff: [], lockedRoot: ROOT_LOCKED });
}

async function api(req, res, url) {
  if (url.pathname === "/api/open-folder" && req.method === "POST") {
    const picked = await chooseFolder();
    if (!picked) return send(res, 400, { error: "No folder selected", root });
    root = path.resolve(picked);
    watchRoot();
    return statusPayload(res);
  }
  if (url.pathname === "/api/set-root" && req.method === "POST") {
    const body = await readBody(req);
    const nextRoot = body.path ? path.resolve(body.path) : "";
    if (!nextRoot || !fs.existsSync(nextRoot) || !fs.statSync(nextRoot).isDirectory()) return send(res, 400, { error: "Folder not found", root });
    root = nextRoot;
    watchRoot();
    return statusPayload(res);
  }
  if (url.pathname === "/api/list") {
    if (!root) return send(res, 200, { root: "", files: [] });
    await refreshStatus();
    return send(res, 200, { root, files: listDir(url.searchParams.get("path") || "") });
  }
  if (url.pathname === "/api/list-loaded" && req.method === "POST") {
    const body = await readBody(req);
    if (!root) return send(res, 200, { root: "", dirs: {} });
    await refreshStatus();
    const dirs = {};
    for (const rel of Array.isArray(body.paths) ? body.paths : [""]) {
      const key = typeof rel === "string" ? rel : "";
      dirs[key] = listDir(key);
    }
    return send(res, 200, { root, dirs });
  }
  if (url.pathname === "/api/changed-files") {
    if (!root) return send(res, 200, { root: "", files: [] });
    await refreshStatus();
    return send(res, 200, {
      root,
      files: statusCache.changed
        .filter((item) => isVisiblePath(item.path) && isCodeFile(item.path))
        .map((item) => ({ path: item.path, status: item.status })),
    });
  }
  if (url.pathname === "/api/health") return send(res, 200, { ok: true, root, lockedRoot: ROOT_LOCKED, pid: process.pid });
  if (url.pathname === "/api/status") return statusPayload(res);
  if (url.pathname === "/api/file" && req.method === "GET") {
    const filePath = safeRel(url.searchParams.get("path") || "");
    if (!filePath) return send(res, 400, { error: "Invalid path" });
    if (!isCodeFile(filePath)) return send(res, 415, { error: "Cannot open this file type" });
    const full = path.join(root, filePath);
    const diffResult = await runSvn(["diff", "--internal-diff", filePath]);
    const diff = diffResult.code === 0 ? parseDiff(diffResult.stdout)[0] : null;
    let content = "";
    if (fs.existsSync(full) && fs.statSync(full).isFile()) content = fs.readFileSync(full, "utf8");
    else {
      const cat = await runSvn(["cat", filePath]);
      if (cat.code) return send(res, 404, { error: cat.stderr || "File not found" });
      content = cat.stdout;
    }
    return send(res, 200, { path: filePath, content, markers: diff ? markers(diff) : { byLine: {}, deleted: [] }, hunks: diff?.hunks || [] });
  }
  if (url.pathname === "/api/file" && req.method === "POST") {
    const body = await readBody(req);
    const filePath = safeRel(body.path);
    if (!filePath) return send(res, 400, { error: "Invalid path" });
    if (!isCodeFile(filePath)) return send(res, 415, { error: "Cannot save this file type" });
    if (typeof body.content !== "string") return send(res, 400, { error: "Invalid content" });
    const full = path.join(root, filePath);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return send(res, 404, { error: "File not found" });
    const current = fs.readFileSync(full, "utf8");
    if (typeof body.base === "string" && body.base !== current) return send(res, 409, { error: "File changed on disk; refresh and try again" });
    fs.writeFileSync(full, body.content, "utf8");
    notifyChanged(filePath);
    return send(res, 200, {});
  }
  if (url.pathname === "/api/revert-hunk" && req.method === "POST") {
    const body = await readBody(req);
    const filePath = safeRel(body.path);
    if (!filePath) return send(res, 400, { error: "Invalid path" });
    const full = path.join(root, filePath);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return send(res, 404, { error: 'File not found' });
    const diffResult = await runSvn(['diff', '--internal-diff', filePath]);
    if (diffResult.code !== 0) return send(res, 500, { error: diffResult.stderr || 'Cannot read diff' });
    const hunk = parseDiff(diffResult.stdout)[0]?.hunks[Number(body.hunk)];
    if (!hunk) return send(res, 404, { error: 'Hunk not found' });
    const next = revertHunkContent(fs.readFileSync(full, 'utf8'), hunk);
    if (next == null) return send(res, 409, { error: 'File changed; refresh and try again' });
    fs.writeFileSync(full, next, 'utf8');
    notifyChanged(filePath);
    return send(res, 200, {});
  }
  if (url.pathname === "/api/revert-file" && req.method === "POST") {
    const body = await readBody(req);
    const filePath = safeRel(body.path);
    if (!filePath) return send(res, 400, { error: "Invalid path" });
    const reverted = await runSvn(["revert", filePath]);
    if (!reverted.code) notifyChanged(filePath);
    return send(res, reverted.code ? 500 : 200, { error: reverted.stderr, output: reverted.stdout });
  }
  send(res, 404, { error: "Not found" });
}

function staticFile(req, res, url) {
  const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = path.resolve(PUBLIC, name);
  if (!file.startsWith(PUBLIC)) return send(res, 403, "Forbidden", "text/plain");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "Not found", "text/plain");
    const ext = path.extname(file);
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
    send(res, 200, data, types[ext] || "application/octet-stream");
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://" + req.headers.host);
  if (url.pathname === "/api/events") return events(req, res);
  if (url.pathname.startsWith("/api/")) return api(req, res, url);
  staticFile(req, res, url);
}).listen(PORT, "127.0.0.1", () => {
  watchRoot();
  console.log("SVN Review: http://localhost:" + PORT);
  console.log("Root: " + (root || "<none>"));
});
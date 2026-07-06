const treeEl = document.querySelector("#tree");
const diffEl = document.querySelector("#diff");
const rootEl = document.querySelector("#root");
const fileNameEl = document.querySelector("#fileName");
const metaEl = document.querySelector("#meta");
const saveFileEl = document.querySelector("#saveFile");
const cancelEditEl = document.querySelector("#cancelEdit");
const pathInput = document.querySelector("#pathInput");
const hunkLabelEl = document.querySelector('#hunkLabel');
const changeBarEl = document.querySelector('#changeBar');
const mainEl = document.querySelector('main');
const toggleSidebarEl = document.querySelector("#toggleSidebar");
const sidebarResizerEl = document.querySelector("#sidebarResizer");
const state = { children: new Map(), expanded: new Set([""]), statusMap: {}, changedFiles: [], selected: null, hunk: 0, file: null, fileStamp: "", savedContent: "", editContent: "", dirty: false };
const labels = { M: "edit", A: "add", D: "del", C: "conf", R: "rep", "?": "new", "!": "miss" };
const codeExts = new Set([".bat", ".c", ".cmd", ".config", ".cpp", ".cs", ".cshtml", ".csproj", ".css", ".fs", ".fsproj", ".go", ".h", ".hpp", ".htm", ".html", ".java", ".js", ".json", ".jsx", ".kt", ".kts", ".less", ".lua", ".props", ".ps1", ".py", ".razor", ".resx", ".rb", ".rs", ".sass", ".scss", ".sh", ".sln", ".sql", ".swift", ".targets", ".ts", ".tsx", ".vb", ".vbproj", ".vue", ".xaml", ".xml", ".yaml", ".yml"]);
const codeNames = new Set([".editorconfig", ".gitignore", "dockerfile", "jenkinsfile", "makefile"]);
const tokenPattern = /(?:<!--.*?-->|<\/?[A-Za-z][^>]*>|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*|#.*|--.*|\/\*.*?\*\/|\b(?:abstract|async|await|base|break|case|catch|class|const|continue|default|delegate|delete|do|else|enum|export|extends|false|finally|for|foreach|from|function|get|if|implements|import|in|interface|internal|let|namespace|new|null|override|private|protected|public|readonly|return|set|static|string|switch|this|throw|true|try|typeof|using|var|void|while|yield|SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|UPDATE|INSERT|DELETE|CREATE|ALTER|DROP|AND|OR|NOT|NULL)\b|\b\d+(?:\.\d+)?\b)/g;
const params = new URLSearchParams(location.search);
const initialRoot = params.get("path") || params.get("root") || params.get("dir") || "";
let fileRefreshBusy = false;
let treeRefreshBusy = false;
let eventsStarted = false;
let resizingSidebar = false;

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function requestOptions(body) {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) };
}
function fileStamp(file) {
  return file ? JSON.stringify([file.content, file.markers, file.hunks]) : "";
}
function updateEditControls() {
  const dirty = Boolean(state.selected && state.file && state.dirty);
  saveFileEl.hidden = !dirty;
  cancelEditEl.hidden = !dirty;
}
function confirmDiscard() {
  return !state.dirty || confirm("Discard unsaved changes?");
}
function setEditContent(content) {
  state.savedContent = content;
  state.editContent = content;
  state.dirty = false;
  updateEditControls();
}
function updateDirty(content) {
  state.editContent = content;
  state.dirty = state.editContent !== state.savedContent;
  updateEditControls();
}
function setLockedRoot(locked) {
  document.body.classList.toggle("locked-root", Boolean(locked));
}
function setSidebarWidth(width) {
  const next = Math.max(220, Math.min(640, Math.round(width)));
  document.documentElement.style.setProperty("--sidebar-width", next + "px");
  localStorage.setItem("svn-review-sidebar-width", String(next));
}
function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  toggleSidebarEl.textContent = collapsed ? ">" : "<";
  toggleSidebarEl.title = collapsed ? "Show file tree" : "Collapse file tree";
  localStorage.setItem("svn-review-sidebar-collapsed", collapsed ? "1" : "0");
  positionChangeBar();
}
function initSidebarLayout() {
  const savedWidth = Number(localStorage.getItem("svn-review-sidebar-width"));
  if (savedWidth) setSidebarWidth(savedWidth);
  setSidebarCollapsed(localStorage.getItem("svn-review-sidebar-collapsed") === "1");
}
function badge(status) {
  return status ? `<span class="badge ${status}">${esc(labels[status] || status)}</span>` : "";
}
function changedPaths() {
  return state.changedFiles.map((item) => item.path).filter(canOpenFile);
}
function changedFileIndex() {
  return changedPaths().indexOf(state.selected);
}
function nameOf(filePath) {
  return filePath.split("/").pop() || filePath;
}
function extOf(filePath) {
  const name = nameOf(filePath).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}
function canOpenFile(filePath) {
  const name = nameOf(filePath).toLowerCase();
  return codeNames.has(name) || codeExts.has(extOf(filePath));
}
function tokenClass(token) {
  if (/^(?:\/\/|#|--|\/\*|<!--)/.test(token)) return "comment";
  if (/^["'`]/.test(token)) return "string";
  if (/^<\/?/.test(token)) return "tag";
  if (/^\d/.test(token)) return "number";
  return "keyword";
}
function highlightText(text) {
  if (!text) return " ";
  let html = "";
  let last = 0;
  text.replace(tokenPattern, (match, offset) => {
    html += esc(text.slice(last, offset));
    html += `<span class="tok ${tokenClass(match)}">${esc(match)}</span>`;
    last = offset + match.length;
    return match;
  });
  return html + esc(text.slice(last));
}
function renderItem(item, level) {
  const status = item.status ?? state.statusMap[item.path] ?? "";
  const active = state.selected === item.path ? " active" : "";
  if (item.type === "dir") {
    const open = state.expanded.has(item.path);
    return `<button class="node folder" data-dir="${esc(item.path)}"><span class="indent" style="--level:${level}"></span><span class="twisty">${open ? "v" : ">"}</span><span class="node-name">${esc(nameOf(item.path))}</span>${badge(status)}</button>`;
  }
  return `<button class="node file${active}" data-path="${esc(item.path)}"><span class="indent" style="--level:${level}"></span><span class="twisty"></span><span class="node-name">${esc(nameOf(item.path))}</span>${badge(status)}</button>`;
}function renderTree(path = "", level = 0) {
  let html = "";
  for (const item of state.children.get(path) || []) {
    html += renderItem(item, level);
    if (item.type === "dir" && state.expanded.has(item.path)) html += renderTree(item.path, level + 1);
  }
  return html;
}
function drawTree() {
  treeEl.innerHTML = renderTree();
}
function groupDeleted(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.after)) map.set(item.after, []);
    map.get(item.after).push(item);
  }
  return map;
}
function lineHtml(n, text, kind, hunk) {
  const current = hunk === state.hunk ? " current-change" : "";
  const attr = hunk == null ? "" : ` data-hunk="${hunk}"`;
  return `<div class="code-line ${kind}${current}"${attr}><span class="ln">${n || ""}</span><span class="src">${highlightText(text || " ")}</span></div>`;
}
function updateChangeControls() {
  const total = state.file?.hunks.length || 0;
  const fileIndex = changedFileIndex();
  hunkLabelEl.textContent = total ? 'Block ' + (state.hunk + 1) + '/' + total : '';
  changeBarEl.hidden = total === 0 || !state.selected;
  document.querySelector('#prev').disabled = state.hunk <= 0;
  document.querySelector('#next').disabled = state.hunk >= total - 1;
  document.querySelector('#prevFile').disabled = fileIndex <= 0;
  document.querySelector('#nextFile').disabled = fileIndex < 0 || fileIndex >= changedPaths().length - 1;
  document.querySelector('#revertHunk').disabled = !state.selected || total === 0;
}
function positionChangeBar() {
  const total = state.file?.hunks.length || 0;
  if (!total || !state.selected) { changeBarEl.hidden = true; return; }
  changeBarEl.hidden = false;
  const line = diffEl.querySelector(`.code-line[data-hunk='${state.hunk}']`);
  if (!line) return;
  const mainRect = mainEl.getBoundingClientRect();
  const lineRect = line.getBoundingClientRect();
  const maxTop = Math.max(56, mainRect.height - changeBarEl.offsetHeight - 12);
  const top = Math.max(56, Math.min(lineRect.top - mainRect.top - changeBarEl.offsetHeight - 6, maxTop));
  changeBarEl.style.top = top + 'px';
}
function renderFile() {
  fileNameEl.textContent = state.selected || "Select a file";
  metaEl.textContent = state.file ? `${state.file.hunks.length} change blocks` : "";
  updateChangeControls();
  updateEditControls();
  if (!state.selected) { diffEl.innerHTML = '<div class="empty">Select a local folder, then select a file.</div>'; return; }
  if (!state.file) { diffEl.innerHTML = '<div class="empty">Loading...</div>'; return; }
  diffEl.innerHTML = '<textarea id="editor" spellcheck="false"></textarea>';
  const editor = diffEl.querySelector('#editor');
  editor.value = state.editContent;
  editor.addEventListener('input', () => updateDirty(editor.value));
  editor.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveFile();
    }
  });
  positionChangeBar();
}
function renderUnsupportedFile(path) {
  state.file = null;
  state.fileStamp = "";
  setEditContent("");
  state.hunk = 0;
  fileNameEl.textContent = path;
  metaEl.textContent = "";
  diffEl.innerHTML = '<div class="empty">Cannot open this file type.</div>';
  updateChangeControls();
}
function scrollHunk() {
  document.querySelector(`.code-line[data-hunk="${state.hunk}"]`)?.scrollIntoView({ block: "center" });
}
async function loadFolder(path) {
  const res = await fetch(`/api/list?path=${encodeURIComponent(path)}`);
  const data = await res.json();
  if (!res.ok) { alert(data.error || "Failed to load folder"); return; }
  state.children.set(path, data.files || []);
  drawTree();
}
async function refreshChangedFiles() {
  const res = await fetch("/api/changed-files");
  const data = await res.json();
  if (res.ok) state.changedFiles = data.files || [];
  updateChangeControls();
}
async function refreshLoadedFolders() {
  if (treeRefreshBusy || !state.children.size) return;
  treeRefreshBusy = true;
  try {
    const res = await fetch("/api/list-loaded", requestOptions({ paths: [...state.children.keys()] }));
    const data = await res.json();
    if (!res.ok) return;
    for (const [path, files] of Object.entries(data.dirs || {})) state.children.set(path, files);
    await refreshChangedFiles();
    drawTree();
  } finally {
    treeRefreshBusy = false;
  }
}
function forgetFolder(path) {
  const prefix = path + "/";
  for (const key of [...state.children.keys()]) if (key === path || key.startsWith(prefix)) state.children.delete(key);
  for (const key of [...state.expanded]) if (key === path || key.startsWith(prefix)) state.expanded.delete(key);
}
async function toggleFolder(path) {
  if (state.expanded.has(path)) {
    forgetFolder(path);
    drawTree();
    return;
  }
  state.expanded.add(path);
  if (!state.children.has(path)) await loadFolder(path);
  else drawTree();
}
async function loadFile(path) {
  if (path !== state.selected && !confirmDiscard()) return;
  state.selected = path;
  drawTree();
  if (!canOpenFile(path)) { renderUnsupportedFile(path); return; }
  state.file = null;
  state.fileStamp = "";
  setEditContent("");
  renderFile();
  const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
  const data = await res.json();
  if (!res.ok) { diffEl.innerHTML = `<div class="empty">${esc(data.error || "Failed to read file")}</div>`; updateChangeControls(); return; }
  if (state.selected !== path) return;
  state.file = data;
  state.fileStamp = fileStamp(data);
  setEditContent(data.content || "");
  state.hunk = 0;
  renderFile();
}
async function load(url = "/api/status", options) {
  if (!confirmDiscard()) return;
  diffEl.innerHTML = '<div class="empty">Loading...</div>';
  const res = await fetch(url, options);
  const data = await res.json();
  if (data.lockedRoot) setLockedRoot(true);
  rootEl.textContent = data.root || "";
  pathInput.value = data.root || pathInput.value;
  if (!res.ok) { diffEl.innerHTML = `<div class="empty">${esc(data.error || "Load failed")}</div>`; return; }
  state.children = new Map([["", data.files || []]]);
  state.expanded = new Set([""]);
  state.statusMap = data.statusMap || {};
  await refreshChangedFiles();
  state.file = null;
  state.fileStamp = "";
  setEditContent("");
  state.selected = null;
  drawTree();
  renderFile();
}
async function refreshSelectedFile() {
  const file = state.selected;
  if (fileRefreshBusy || document.hidden || state.dirty || !file || !canOpenFile(file)) return;
  fileRefreshBusy = true;
  try {
    const res = await fetch(`/api/file?path=${encodeURIComponent(file)}`);
    const data = await res.json();
    if (!res.ok || state.selected !== file) return;
    const stamp = fileStamp(data);
    if (stamp === state.fileStamp) return;
    state.file = data;
    state.fileStamp = stamp;
    setEditContent(data.content || "");
    state.hunk = Math.min(state.hunk, Math.max(0, data.hunks.length - 1));
    renderFile();
  } finally {
    fileRefreshBusy = false;
  }
}
async function openAdjacentChangedFile(delta) {
  if (!state.changedFiles.length) await refreshChangedFiles();
  const files = changedPaths();
  if (!files.length) return;
  const index = files.indexOf(state.selected);
  const nextIndex = (index < 0 ? (delta > 0 ? -1 : files.length) : index) + delta;
  const next = files[nextIndex];
  if (!next) return;
  await loadFile(next);
  if (delta < 0 && state.file?.hunks.length) {
    state.hunk = state.file.hunks.length - 1;
    renderFile();
  }
}
function goChange(delta) {
  const total = state.file?.hunks.length || 0;
  if (!state.selected || !total) return;
  if (delta < 0) state.hunk = Math.max(0, state.hunk - 1);
  else state.hunk = Math.min(total - 1, state.hunk + 1);
  renderFile();
}
function startSidebarResize(event) {
  if (document.body.classList.contains("sidebar-collapsed")) return;
  resizingSidebar = true;
  document.body.classList.add("resizing-sidebar");
  event.preventDefault();
}
function resizeSidebar(event) {
  if (!resizingSidebar) return;
  setSidebarWidth(event.clientX);
}
function stopSidebarResize() {
  if (!resizingSidebar) return;
  resizingSidebar = false;
  document.body.classList.remove("resizing-sidebar");
}
function connectEvents() {
  if (eventsStarted || !window.EventSource) return;
  eventsStarted = true;
  const source = new EventSource("/api/events");
  source.addEventListener("change", () => {
    refreshChangedFiles();
    refreshLoadedFolders();
    refreshSelectedFile();
  });
}
async function sendPost(url, body) {
  const res = await fetch(url, requestOptions(body));
  const data = await res.json();
  if (!res.ok) alert(data.error || "Operation failed");
  return res.ok;
}
async function saveFile() {
  const file = state.selected;
  if (!file || !state.file || !state.dirty) return;
  const content = state.editContent;
  if (await sendPost("/api/file", { path: file, content, base: state.savedContent })) {
    state.file.content = content;
    setEditContent(content);
    await refreshLoadedFolders();
    await refreshSelectedFile();
  }
}
function cancelEdit() {
  if (!state.file) return;
  state.editContent = state.savedContent;
  state.dirty = false;
  renderFile();
}async function revertHunk(hunk) {
  const file = state.selected;
  if (!file) return;
  state.hunk = hunk;
  renderFile();
  if (await sendPost("/api/revert-hunk", { path: file, hunk })) {
    await refreshLoadedFolders();
    await loadFile(file);
  }
}

treeEl.addEventListener("click", (event) => {
  const dir = event.target.closest("[data-dir]");
  if (dir) { toggleFolder(dir.dataset.dir); return; }
  const btn = event.target.closest("[data-path]");
  if (!btn) return;
  loadFile(btn.dataset.path);
});
diffEl.addEventListener('click', (event) => {
  const line = event.target.closest('[data-hunk]');
  if (line) { state.hunk = Number(line.dataset.hunk); renderFile(); }
});
diffEl.addEventListener('scroll', positionChangeBar);
window.addEventListener('resize', positionChangeBar);
toggleSidebarEl.addEventListener("click", () => setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed")));
sidebarResizerEl.addEventListener("pointerdown", startSidebarResize);
window.addEventListener("pointermove", resizeSidebar);
window.addEventListener("pointerup", stopSidebarResize);
initSidebarLayout();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { refreshChangedFiles(); refreshLoadedFolders(); refreshSelectedFile(); }
});
connectEvents();
document.querySelector("#openFolder").addEventListener("click", () => load("/api/open-folder", { method: "POST" }));
document.querySelector("#setRoot").addEventListener("click", () => load("/api/set-root", requestOptions({ path: pathInput.value })));
saveFileEl.addEventListener("click", saveFile);
cancelEditEl.addEventListener("click", cancelEdit);
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveFile();
  }
});
document.querySelector("#revertHunk").addEventListener("click", () => revertHunk(state.hunk));
document.querySelector("#revertFile").addEventListener("click", async () => {
  const file = state.selected;
  if (!file) return;
  if (await sendPost("/api/revert-file", { path: file })) {
    await refreshLoadedFolders();
    await loadFile(file);
  }
});
document.querySelector("#prevFile").addEventListener("click", () => openAdjacentChangedFile(-1));
document.querySelector("#prev").addEventListener("click", () => goChange(-1));
document.querySelector("#next").addEventListener("click", () => goChange(1));
document.querySelector("#nextFile").addEventListener("click", () => openAdjacentChangedFile(1));
if (initialRoot) {
  setLockedRoot(true);
  load("/api/set-root", requestOptions({ path: initialRoot }));
} else load();
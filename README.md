# SVN Review

SVN Review is a local, dependency-free web UI for reviewing SVN working-copy changes. It can run as a normal command-line tool or as a Codex plugin skill.

## Features

- Opens a local folder in the browser and shows a fixed two-pane layout: file tree on the left, code view/editor on the right.
- Supports lazy-loaded folders, so large working copies do not require a full recursive scan.
- Shows SVN change badges beside files and folders.
- Opens code files only; non-code files are rejected instead of being loaded into the browser.
- Shows changed blocks, previous/next block navigation, previous/next changed file navigation, block revert, and full-file revert.
- Watches the working copy with `fs.watch` and pushes live refresh events through SSE.
- Works with a selected folder in the browser or a folder passed in the URL, for example `?path=D:\Project\Repo`.

## Requirements

- Windows, macOS, or Linux with Node.js available as `node`.
- SVN command-line tools available as `svn`.
- A local SVN working copy.
- Codex is optional; it is only needed for plugin usage.

No npm install is required.

## Run As A Local App

From this folder:

```powershell
node server.js
```

Then open:

```text
http://localhost:5173/
```

You can choose a local folder in the browser.

To open a folder directly:

```powershell
node server.js "D:\Project\Repo"
```

Then open:

```text
http://localhost:5173/?path=D%3A%5CProject%5CRepo
```

On Windows you can also run:

```powershell
.\SVN Review.cmd
```

## Install As A Codex Plugin

From this plugin folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

To reinstall after updating the files:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Reinstall
```

Then enable/use the `svn-review` plugin in Codex and ask:

```text
Open SVN Review
```

The plugin starts or reuses the local server and opens a URL for the current workspace. If an SVN Review server is already running, the launcher reuses it and adds the workspace path to the URL.

## Notes

- The app binds to `127.0.0.1` and uses port `5173`, or the next free port up to `5199` when launched by `scripts/launch.js`.
- Hidden directories whose names start with `.` are not shown in the file tree.
- `.svn` folders and symlinks are skipped.
- SVN has no native "revert one block" command. Block revert is implemented by applying the selected parsed diff hunk back to the working-copy file.
- If a file changes on disk while it is open, saving from the browser may be rejected until the view refreshes.

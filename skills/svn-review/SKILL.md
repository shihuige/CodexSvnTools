---
name: svn-review
description: Open the current workspace SVN status and diffs in a Codex side panel/browser. Use when the user asks for SVN changes, SVN Review, SVN status, diffs, local working-copy changes, or a side panel for the current folder. Also use after Codex modifies code in an SVN working copy so the updated local changes are opened in the Codex browser or a local review URL is reported.
---

# SVN Review

Open SVN Review for the current Codex workspace.

## Workflow

1. Resolve this plugin root from the skill path: `skills/svn-review/SKILL.md` lives under `<plugin-root>/skills/svn-review/SKILL.md`.
2. Run `node <plugin-root>/scripts/launch.js`. Do not run it with the plugin root as the workspace. The launcher resolves the active Codex thread workspace from the current working directory or `CODEX_THREAD_ID` session metadata.
3. If the user gave an explicit folder, run `node <plugin-root>/scripts/launch.js <folder>` instead.
4. Parse the JSON output. Open its `url` in the Codex in-app Browser side panel. If the browser tool is available, invoke `browser:control-in-app-browser` first and use that browser surface.
5. If opening the browser is unavailable, report the `url`. The URL includes `?path=<workspace>` when a workspace path is known, so an externally running SVN Review server can load that local directory directly.
6. After Codex edits files in an SVN working copy, run this workflow before the final response unless the user explicitly says not to open SVN Review.

The launcher reuses any already running SVN Review server on ports 5173-5199. If none is running, it starts one for the resolved workspace. The local page refreshes SVN status, shows file diffs, auto-updates through fs.watch + SSE, and can revert a file or one diff block.

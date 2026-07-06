# SVN Review

Local SVN review app packaged as a Codex plugin skill.

## Use in Codex

Enable the personal `svn-review` plugin, open any local workspace thread, then ask Codex:

```text
Open SVN Review
```

The skill starts or reuses `server.js` for that active workspace and opens the returned local URL in Codex's in-app Browser side panel. The returned URL includes `?path=<workspace>` when a workspace is known, so an externally running server can load the correct local directory directly. After Codex edits files in an SVN working copy, the skill should be used to open the current changes before the final response.

## Fallback

Run this from any SVN working copy:

```bash
node C:\Users\DELL\plugins\svn-review\scripts\launch.js .
```

Then open the printed `url`. If you already started SVN Review externally, the launcher reuses it and prints a URL with the workspace path parameter.

## Scope

- Uses local `svn status`, `svn diff`, `svn cat`, `svn patch`, and `svn revert`.
- No npm dependencies.
- Starts a per-workspace local server on `127.0.0.1`, using port 5173 or the next free port.
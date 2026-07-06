# SVN Review

SVN Review 是一个本地 SVN 变更查看工具，提供无依赖的浏览器界面。它既可以作为普通命令行工具运行，也可以作为 Codex 插件 skill 使用。

## 功能

- 在浏览器里打开本地目录，固定左右布局：左侧文件树，右侧代码查看/编辑区。
- 文件夹懒加载，较大的工作副本不会一次性递归扫描全部目录。
- 在文件和文件夹名称后显示 SVN 变更标志。
- 只允许打开代码文件；非代码文件会直接提示不能打开，不会强行加载。
- 支持变更块显示、上一个/下一个变更块、上一个/下一个变更文件、撤回当前变更块、撤回整个文件。
- 使用 `fs.watch` 监听工作副本，通过 SSE 实时刷新页面状态。
- 支持在浏览器里选择目录，也支持 URL 直接传入目录，例如 `?path=D:\Project\Repo`。

## 运行要求

- Windows、macOS 或 Linux，并且可以直接运行 `node`。
- 已安装 SVN 命令行工具，并且可以直接运行 `svn`。
- 本地 SVN 工作副本。
- Codex 不是必需的，只有作为 Codex 插件使用时才需要。

不需要执行 `npm install`。

## 作为本地工具运行

在本目录执行：

```powershell
node server.js
```

然后打开：

```text
http://localhost:5173/
```

页面打开后可以在浏览器里选择本地目录。

如果想启动时直接指定目录：

```powershell
node server.js "D:\Project\Repo"
```

然后打开：

```text
http://localhost:5173/?path=D%3A%5CProject%5CRepo
```

Windows 下也可以直接运行：

```powershell
.\SVN Review.cmd
```

## 作为 Codex 插件安装

在插件目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

更新文件后需要重装时执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Reinstall
```

然后在 Codex 中启用/使用 `svn-review` 插件，并输入：

```text
Open SVN Review
```

插件会启动或复用本地服务，并为当前工作区打开对应 URL。如果外部已经运行了 SVN Review，启动器会复用现有服务，并把当前工作区路径带到 URL 里。


## 说明

- 服务只监听 `127.0.0.1`。直接运行 `server.js` 默认使用 `5173` 端口；通过 `scripts/launch.js` 启动时会从 `5173` 到 `5199` 找可用端口。
- 左侧文件树不显示以 `.` 开头的隐藏目录。
- `.svn` 目录和符号链接会被跳过。
- SVN 没有原生的“只撤回一个变更块”接口。当前的 block revert 是解析 `svn diff --internal-diff` 后，只把选中的 hunk 还原到工作副本文件。
- 如果文件打开后又被外部程序修改，浏览器保存时可能会提示文件已变化，需要刷新后再保存。

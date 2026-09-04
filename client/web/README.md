# Octrix Host 与本地 Web TUI

Octrix 的本地运行核心与浏览器协调台，基于 React、Node.js 和 PTY。

> 想在 iPhone 上远程控制本机的 AI？参见 [docs/remote-access.md](../../docs/remote-access.md)（中继服务器 `relay/` + iOS App `client/ios/`，Mac 端配置接口 `/api/relay/config`）。

## Host 与界面边界

生产环境由独立 Octrix Host 持有 AI CLI、PTY、会话缓冲、工作区监听与中继连接，默认监听 `127.0.0.1:39800`。React/xterm Web TUI 是正式本地桌面入口，运行 `octrix webtui` 即可打开；退出浏览器不会停止 Host。运行 `npm run build:host` 可生成按架构分发的 Host 包，根目录 `./run-mac.sh` 可直接构建并安装源码版本。

当前开放全部已适配的 Agent CLI：`Codex CLI`、`OpenClaude`、`Claude Code`、`OpenCode`、`GitHub Copilot CLI`、`Gemini CLI`、`Cursor CLI`、`Kiro CLI`、`Qoder CLI` 和 `CodeBuddy`。平台启用目录由 `src/agent-platforms.ts` 统一维护，并同时用于界面、Host API 和 iOS。

## 快速开始

```bash
cd client/web
npm install
npm run dev
```

启动后：
- 后端服务运行在 `http://127.0.0.1:9800`
- 前端开发服务器运行在 `http://localhost:5173`

打开浏览器访问 `http://localhost:5173` 即可使用。

## 数据迁移

首次启动时会自动从 Swift 版本的数据目录（`~/Library/Application Support/CLIBridge/`）迁移已有配置到 `~/.cli-bridge/`。

## API 兼容

原有的 shell 脚本（`emit.sh`、`poll.sh`）无需修改即可继续使用，`/v1/emit`、`/v1/inbox`、`/v1/peers`、`/v1/health` API 保持完全兼容。

## 环境变量

- `CLI_BRIDGE_PORT` — 服务端口，默认 `9800`

## 前提条件

- Node.js 22.12.0+
- 终端仿真使用 Node.js `node-pty`，无需额外安装 Python

## Host-only 发布

日常发布只生成 Apple Silicon 与 Intel 的 Host 包和校验文件：

```bash
cd client/web
./publish-release.sh 1.0.3 both
```

产物为 `Octrix-Host-arm64.tar.gz`、`Octrix-Host-x64.tar.gz` 及对应的 `.sha256`。包内同时包含后端、本地 Web TUI、Node 运行时和 `octrix` CLI；脚本会校验 Web TUI、CLI、版本清单和文件摘要后再上传。

发布版本必须显式使用 `MAJOR.MINOR.PATCH` 三段式格式，例如 `1.0.3`；不再自动生成时间戳版本。

macOS 原生 App、Tauri/Electron 与 DMG 当前暂停适配、测试和发布。相关源码、签名配置及 `publish-macos-release.sh` 只作为明确的备用路径保留，不属于默认发布流程。

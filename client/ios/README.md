# Octrix Mobile（iOS）

在 iPhone 上继续 Mac 上的 Octrix 会话与 AI Agent 工作。首次打开 App 会引导用户用一行命令安装 Octrix Host、在网页中授权 Mac，再在 iPhone 登录同一账号；账号下的 Mac 会自动出现，无需共享 Token、安装 DMG 或手工配对。官方服务的完整流程见 [安装指南](https://octrix.work/start) 与 [docs/remote-access.md](../../docs/remote-access.md)。自托管发行版请在 Xcode Build Settings 设置 `OCTRIX_CLOUD_URL=https://relay.example.com`，也可在登录页“高级：自托管授权中心”临时填写地址。

## 构建

```bash
open OctrixMobile.xcodeproj
```

- 要求 Xcode 16+，部署目标 iOS 17。
- 真机运行：在 target 的 Signing & Capabilities 里选择你的 Team（免费个人账号即可）。
- 命令行模拟器构建：
  ```bash
  xcodebuild -project OctrixMobile.xcodeproj -scheme OctrixMobile \
    -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO
  ```

## 功能

- 首次使用引导：在自托管站点的 `/start` 页面复制安装命令；它会把当前 Relay 域名传给 Host，再完成网页登录授权与 iPhone 登录
- 本地桌面入口：安装后运行 `octrix webtui`，打开 `http://127.0.0.1:39800/` Web TUI
- 账号范围的设备自动发现：登录后显示该账号已授权的全部 Mac，不再暴露服务器地址或共享 Token 配置
- 设置页提供“连接一台 Mac”帮助入口，并可打开网页授权中心管理设备
- 群组列表：在线成员数、最后消息预览、下拉刷新
- 群聊：流式输出、思考过程/工具调用条目、Markdown 渲染、`@所有人` / `@成员名` 点名（默认发给所有运行中的 agent，与 Web 端一致）
- 任务会话：切换查看、归档任务只读、新建任务（自动重启群内 CLI 会话）
- WebSocket 实时同步 + 断线指数退避重连；顶部横幅提示连接状态
- 深链 `octrix://group/<groupId>` 直达群聊

## 结构

```
OctrixMobile/
├── Models.swift          # 服务端数据模型镜像 + WS 事件解码
├── RelaySettings.swift   # 连接配置（UserDefaults + Keychain）
├── RelayAPI.swift        # 经中继隧道的 REST 客户端
├── SocketClient.swift    # WS 客户端（自动重连、心跳）
├── AppStore.swift        # 全局状态，对齐 client/web 端 useWebSocket reducer
└── Views/                # SwiftUI 界面
```

工程使用 Xcode 16 同步文件夹（`PBXFileSystemSynchronizedRootGroup`），新增 Swift 文件放进 `OctrixMobile/` 目录即自动入编译目标，无需改 pbxproj。

调试钩子（仅 DEBUG 构建）：`SIMCTL_CHILD_OCTRIX_OPEN_GROUP=<groupId> xcrun simctl launch <udid> com.octrix.mobile` 可在启动后直接进入指定群聊，便于自动化截图/测试。

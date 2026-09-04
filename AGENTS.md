# Repository Guidelines

## 项目结构与模块组织

本仓库包含三个主要交付物，客户端统一位于 `client/`。`client/web/` 是 React 19 + Vite 桌面端，后端在 `client/web/server/`，前端代码在 `client/web/src/`，Tauri 配置在 `client/web/src-tauri/`，Electron 打包在 `client/web/electron/`。`relay/` 是无状态 TypeScript WebSocket/HTTP 中继服务，源码在 `relay/src/`，测试在 `relay/test/`。`client/ios/` 是 SwiftUI iPhone 客户端，代码位于 `client/ios/OctrixMobile/`。长期产品与协作约束见本文件，其他说明文档位于 `docs/`，Shell 集成脚本位于 `scripts/`。

## 长期产品与协作约束

### Agent 平台

- `client/web/src/agent-platforms.ts` 是 Agent 平台定义的唯一真源。`SUPPORTED_AGENTS` 描述已适配平台，`ENABLED_AGENT_PLATFORMS` 描述当前对用户开放的平台；不要以历史设计文档、前端硬编码或命令字符串扩展支持范围。
- 创建 Agent 只能提交启用平台枚举与展示色；名称、可执行命令和启动参数均由服务端平台定义生成。任何创建、导入、批量或更新入口都不得接受自由 `name`、`command` 或平台变更。
- 联系人页按启用平台的稳定顺序展示，安装状态以该平台的实际安装状态为准；展示逻辑不能反向改变平台定义或运行时状态。
- 新增或变更平台时，必须同步覆盖平台目录、API 校验、持久化清理、进程启动、会话识别/采集、UI 和对应测试。不要保留或恢复旧的自定义命令 Agent 数据。

### 多 AI 协作

- 单聊恰好包含一个 AI，不使用角色、Leader、工作项或正式交接。协作群至少包含两个 AI；编制不足时必须进入 `composition_insufficient`，不得启动任务。
- 同一 AI 在同一协作群只能承担一个基础角色；基础角色为产品、研发、测试、代码审查和提交。每个群最多一个提交专员；同角色多成员必须设置默认 Leader，并在任务启动时冻结 Leader 快照。
- 协作群和同一代码仓库同一时刻各只允许一个活跃主任务。任务内只有技术 Leader 可以写项目代码、测试、配置与正式项目文档；其他成员只产出 `.ai-team` 任务材料、讨论或审查结论，提交专员只处理 Git 与 PR。
- 人类群主确认任务章程、范围、验收标准、首位负责人、阶段计划和缺岗方案后，团队可在授权范围内自治。范围实质变化、重大或不可逆风险、缺岗方案变化、成员失联、协议错误、停滞、返工熔断及外部动作都必须暂停并交回群主。

### 任务、交接与产物

- `Mission` 是群内唯一活跃主任务；`WorkItem` 是最小正式工作单位，始终只有一个负责人。派单、协作与主责移交必须显式接受；未接受前原负责人仍承担责任。不要从普通聊天或自然语言猜测、改变正式状态。
- 任务和工作项仅按结构化协议流转。控制请求必须具有唯一 ID 和 `expectedRevision`，保证幂等并拒绝陈旧写入；格式错误按协议显式处理，不能回退到旧 `/assign` 或 `/wf` 文本调度。
- 正式协作上下文使用版本化 `.ai-team/tasks/<mission-id>/` Markdown 产物交换。服务端管理的任务、计划、事件、正式交接和签署记录只能追加或创建新版本；交接接收方必须读取版本化 inbox 并回传上下文版本后才能接受。
- 需求与验收标准在任务启动时冻结为不可变版本；范围或验收变化必须升版本并重新评估下游结论。技术 Leader 的实现提交必须形成带基准、文件清单、完整 diff 和内容哈希的不可变实现修订；审查与测试结论同时绑定需求版本和实现修订。
- 新主任务必须归档旧任务、重启群内 AI、重写 `.ai-team` 职责资料并重新初始化成员，从而隔离 UI、消息、交接与模型上下文。历史任务只读；不得向其写入新消息或让其隐式污染新任务。

### 质量、Git 与恢复

- 默认代码闭环为：需求澄清与冻结 → 研发讨论和技术 Leader 实现 → 代码审查 → 测试验收 → 提交与 Draft PR → 群主处理。审查或测试失败应生成新实现修订，回到研发并复走受影响的质量门。
- 测试通过必须记录真实命令、环境、退出码、关键输出、业务结论和证据路径；未执行、部分通过或占位内容均不得签署通过。审查必须覆盖实际文件/diff、需求符合性、正确性、回归风险、错误处理、安全性、可维护性和测试充分性，不能只写 `LGTM`。
- 连续三轮返工或同一问题两次重新打开后触发熔断并等待群主决定；未关闭的阻断问题绝不能视为通过。
- 代码任务开始时记录 Git 根目录、分支和干净基准，并在本地建立任务分支。完成质量门后，提交专员核对批准修订哈希，再执行 commit、push 和 Draft PR。默认禁止推送默认分支、强推、删除远端分支、合并 PR 或发布；合并与其他外部动作需要群主授权。
- `.ai-team` 不得进入暂存区或 PR。检测到外部未知 diff 时进入 `external_change_detected`，由群主选择纳入、精确恢复批准修订或取消；取消只保存现场，不自动 reset、删分支或回滚。进程恢复前同样不得自动重放 commit、push 或 PR 操作。

## 构建、测试与本地开发命令

依赖按子项目安装，不要在仓库根目录统一安装。

```bash
cd client/web && npm install && npm run dev
cd client/web && npm test
cd client/web && npm run build
cd client/web && npm run tauri:dev
cd relay && npm install && npm run dev
cd relay && npm test && npm run typecheck
cd client/ios && xcodebuild -project OctrixMobile.xcodeproj -scheme OctrixMobile -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO
```

在 `client/web/` 中，`npm run dev` 会启动 `9800` 端口的后端和 `5173` 端口的 Vite。`npm test` 运行 Vitest，`npm run build` 执行 TypeScript 与前端构建。在 `relay/` 中，`npm run build` 输出 `dist/`，供 `npm start` 运行。

正式 Mac 运行形态是独立 Octrix Host：默认监听 `127.0.0.1:39800`，安装在 `~/.local/share/octrix-host/current`，由 `~/Library/LaunchAgents/work.octrix.host.plist` 常驻管理。`octrix status|start|restart|webtui|logs` 管理 Host；Web TUI、Tauri/Electron 和 iPhone 都连接 Host，桌面壳退出时不得结束 Host。构建和安装源码版本优先运行根目录 `./run-mac.sh`。

Mac 本机开发服务可由用户级 LaunchAgent 常驻启动，避免 `nohup npm run dev` 被终端会话清理后退出。当前 LaunchAgent 配置路径为 `~/Library/LaunchAgents/com.octrix.local-dev.plist`，启动命令等价于在 `client/web/` 下运行 `npm run dev`，日志写入仓库根目录 `.run-mac-web.log`。需要重启本机服务让 `client/web/server/` 改动生效时，优先使用：

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.octrix.local-dev.plist 2>/dev/null || true
launchctl enable gui/$(id -u)/com.octrix.local-dev
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.octrix.local-dev.plist
launchctl kickstart -k gui/$(id -u)/com.octrix.local-dev
curl http://127.0.0.1:9800/v1/health
```

查看状态和日志：

```bash
launchctl print gui/$(id -u)/com.octrix.local-dev
tail -n 100 .run-mac-web.log
curl http://127.0.0.1:9800/api/relay/status
```

如需临时停止本机开发服务：

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.octrix.local-dev.plist
```

## Relay 部署边界

公开仓库只保留通用、自托管的 Relay 部署说明。不要在此文件或其他受版本控制文件中写入生产主机地址、SSH 用户、部署目录、真实令牌、私钥或 `.env` 内容。生产运维信息必须保存在访问受控的私有 runbook 中。

## 代码风格与命名约定

TypeScript 使用 ES modules、单引号、分号和 2 空格缩进；跨模块共享的数据结构优先使用显式导出的 interface。React 组件和 SwiftUI View 使用 `PascalCase`，hooks、工具函数和局部变量使用 `camelCase`。测试文件应与目标文件同名，并以 `.test.ts` 或 `.test.tsx` 结尾。Swift 使用 4 空格缩进。编辑注释时保持附近代码已有的中英文风格。

## 测试指南

`client/web/` 和 `relay/` 使用 Vitest。UI 测试放在 `client/web/src/**/*.test.tsx`，服务端测试放在 `client/web/server/*.test.ts`，中继服务测试放在 `relay/test/*.test.ts`。修改 reducer、协议帧、服务端 API、任务会话、鉴权或超时逻辑时，应新增或更新测试。iOS 变更至少运行上方的模拟器 `xcodebuild` 命令；涉及 `client/ios/` 代码改动时，还必须先用 `xcrun devicectl list devices` 检测是否有可用物理 iPhone。若存在已连接真机，再用 `xcodebuild -project client/ios/OctrixMobile.xcodeproj -scheme OctrixMobile -showdestinations` 找到该设备的 `platform:iOS` 真实 UDID（例如 `00008130-...`），不要把 `devicectl list devices` 输出的 CoreDevice UUID 当作 Xcode destination，否则可能出现 “developer disk image could not be mounted” 或 destination 超时。真机可用时，必须直接编译并安装到该设备：先运行 `cd client/ios && xcodebuild -project OctrixMobile.xcodeproj -scheme OctrixMobile -destination 'platform=iOS,id=<xcode-device-udid>' -derivedDataPath DerivedData/Device build`，再运行 `xcrun devicectl device install app --device <xcode-device-udid-or-device-name> client/ios/DerivedData/Device/Build/Products/Debug-iphoneos/OctrixMobile.app`；如需验证启动，再运行 `xcrun devicectl device process launch --device <xcode-device-udid-or-device-name> --terminate-existing com.octrix.mobile`。若没有可用物理 iPhone，则在完成模拟器构建后归档 iOS 应用并上传 TestFlight；如果因为 Apple 签名、App Store Connect 凭据或本机钥匙串权限无法上传，应在交付说明中明确阻塞原因。完成 iOS 代码改动后，需要重启 relay 中继服务；若无法重启中继服务，也应在交付说明中明确原因。

### iOS TestFlight 上传流程

上传 TestFlight 时不要使用 `altool`。App Store Connect API Key 仅保存在项目外的 `~/.appstoreconnect/config.json` 及其受限权限的 `.p8` 路径中；仓库 `.asc/` 不得存放认证配置或私钥。通过 `xcodebuild -exportArchive` 直接上传。流程如下：

1. 读取 `~/.appstoreconnect/config.json`（或由 `ASC_CONFIG_PATH` 指定的项目外路径），确认包含 `key_id`、`issuer_id`、`private_key_path`，且 `private_key_path` 指向的 `.p8` 文件存在。不要打印私钥内容。
2. 归档：
   ```bash
   cd client/ios
   xcodebuild -project OctrixMobile.xcodeproj -scheme OctrixMobile -destination 'generic/platform=iOS' -archivePath DerivedData/Archives/OctrixMobile.xcarchive archive
   ```
3. 准备临时 `ExportOptions` plist，必须使用 `method = app-store-connect`、`destination = upload`、`signingStyle = automatic`、`uploadSymbols = true`，可保留 `manageAppVersionAndBuildNumber = true` 让 Xcode 管理上传构建号。
4. 使用 `xcodebuild -exportArchive` 上传，并传入 ASC key 参数：
   ```bash
   xcodebuild -exportArchive \
     -archivePath DerivedData/Archives/OctrixMobile.xcarchive \
     -exportPath DerivedData/Upload \
     -exportOptionsPlist DerivedData/ExportOptions-Upload.plist \
     -allowProvisioningUpdates \
     -authenticationKeyPath '<private_key_path>' \
     -authenticationKeyID '<key_id>' \
     -authenticationKeyIssuerID '<issuer_id>'
   ```
5. 成功标准是输出包含 `Uploaded package is processing.`、`Upload succeeded.` 和 `** EXPORT SUCCEEDED **`。上传后删除临时 `ExportOptions-Upload.plist`，不要提交导出的 IPA、archive、上传日志或任何 ASC 凭据。

### 发布要求

- 只要执行 App Store 或 TestFlight 发布、提审、上传、分发相关操作，必须优先使用仓库已提供的 ASC Skills，不要绕过既有 ASC 工作流随意改用手工网页步骤或其他未约定工具。
- 每次发布完成后，必须立即同步更新仓库内对应的版本号，并将该版本号变更单独确认后提交，再 `push` 到 GitHub，避免已发布产物与仓库版本记录脱节。
- App Store、TestFlight 与 macOS App 版本继续使用 `YYYY.MM.DD.HH.mm`，按年、月、日、时、分五段生成，例如 `2026.07.09.11.12`。如需填写 `MARKETING_VERSION`、构建展示版本或其他人工维护版本字段，优先使用这一格式。
- Octrix Host-only Release 必须使用 `MAJOR.MINOR.PATCH` 三段式版本，例如 `1.0.3`。

## Commit 与 Pull Request 规范

近期提交使用简洁的 conventional-style 前缀，例如 `feat(web): ...`、`fix(web): ...`、`chore: ...`，部分文档提交使用中文。scope 应对应实际修改区域，主题句保持具体、可执行，避免把无关改动合并进同一提交。PR 需要包含行为变更摘要、已运行的测试命令、相关 issue 或 spec；涉及 UI 时附截图或录屏。

<!-- setup-dev-environment:ssh-servers:start -->
## 可用 SSH 服务器

连接部署主机时仅使用由维护者在受控渠道提供的本机 SSH 别名（例如 `ssh <deploy-host>`）。不要在项目中记录 HostName、用户、端口或私钥路径。
<!-- setup-dev-environment:ssh-servers:end -->

<!-- setup-dev-environment:apple-workflow:start -->
## Apple 编译、签名与发布

本项目包含 iOS 或 macOS 开发。执行编译、归档、导出、上传、签名、证书、描述文件、能力配置、TestFlight、App Store 提交或 macOS 公证前，必须先调用匹配的 `$asc-*` Skill。

- 使用 `$asc-xcode-build` 处理 Xcode 编译、归档、导出、上传和版本号。
- 使用 `$asc-signing-setup` 处理 Bundle ID、能力、证书、描述文件和加密签名材料。
- 使用 `$asc-notarization` 处理 macOS 导出与公证。
- 按任务选择其他 `$asc-*` Skill 处理 TestFlight、元数据、提交和发布。

不要将 `.p8`、证书、私钥、令牌或签名密码写入仓库或项目文档。
<!-- setup-dev-environment:apple-workflow:end -->

<!-- setup-dev-environment:ideploy-workflow:start -->
## iDeploy iOS 调试分发

本项目已安装本地 `skills/ideploy-publish`。向已注册 iPhone 分发调试包、发布开发构建、验证 iDeploy 流水线或生成设备配对码时，必须使用 `$ideploy-publish` Skill。

使用 `ideploy` 完成这类流程，不要以临时脚本重写 Xcode、签名、TOS 或发布逻辑。不要将发布令牌、签名材料或 TOS 签名链接写入项目文档。
<!-- setup-dev-environment:ideploy-workflow:end -->

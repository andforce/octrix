# 远程访问与统一授权中心

Octrix 使用账号化的 Octrix Cloud，让 iPhone 安全访问本人 Mac 上的 Octrix 服务。部署者必须将公网入口配置为 `OCTRIX_PUBLIC_URL=https://relay.example.com`；下文以该地址为例。

## 工作方式

```text
┌─────────────────────┐      WSS /device/ws      ┌────────────────────┐
│ Mac：Octrix Host     │ ───────────────────────▶ │ Octrix Cloud       │
│ AI / PTY / Web TUI  │   relay:device 凭证      │ 账号、授权、隧道、官网 │
└─────────────────────┘                          └─────────┬──────────┘
                                                        │
                                                  HTTPS / WSS
                                                  relay:client 凭证
                                                        │
                                              ┌─────────▼──────────┐
                                              │ iPhone：OctrixMobile│
                                              └────────────────────┘
```

- Mac 只建立出站连接，无需公网 IP 或入站端口。
- 每个 Mac 与 iPhone 都属于一个 Octrix 账号。
- `/api/devices` 和 `/d/:deviceId/*` 在服务端按账号隔离。
- 网站用于项目介绍、登录和授权管理，不承载远程控制界面。

## 登录与绑定

网站支持 Google OAuth 和中国大陆手机号短信验证码。账号采用白名单，不开放公共注册。部署者可以为 App Review 专用手机号配置固定验证码；这类账号不发送真实短信，但仍使用有时效、单次消费和错误次数限制的 challenge，并走与普通账号相同的 Web 会话或 iPhone 设备凭证签发流程。

用户可以为同一账号绑定 Google 与手机号。绑定到已存在身份时，系统会把设备合并到当前账号，并撤销被合并账号的旧 Web 会话。Octrix 使用独立数据库、Cookie 和令牌，不与 iDeploy 共用账号数据。

默认有效期：

| 对象 | 有效期 |
| --- | --- |
| Web 会话 | 30 天 |
| 短信验证码 | 5 分钟 |
| Mac / iPhone 授权请求 | 10 分钟 |
| 设备凭证 | 长期有效，直到撤销 |

## Mac 授权

首次使用时可在 `https://relay.example.com/start` 复制一行安装命令。网页会将当前域名作为 `OCTRIX_CLOUD_URL` 传给安装器；它会下载匹配 Mac 芯片的 Host，把运行时安装到 `~/.local/share/octrix-host/`，把 CLI 安装到 `~/.local/bin/octrix`，并注册 `work.octrix.host` LaunchAgent。当前不发布 macOS App 或 DMG；从仓库运行时可执行 `OCTRIX_CLOUD_URL=https://relay.example.com ./run-mac.sh login` 完成同样的构建、安装和授权。

全新安装完成后，终端会提示按回车申请“桌面、文稿和下载”文件夹权限。权限请求由后台 Host 进程发起，用户应在当场出现的 macOS 弹窗中逐项允许；之后 iPhone 可远程选择这些位置创建会话。需要重新触发时运行 `octrix permissions`。

Host 是唯一的进程所有者：AI CLI、PTY、输出缓冲、会话监听和 Octrix Cloud 连接都在 Host 中。本地 Web xterm TUI 和 iPhone 连接同一套 Host 数据；关闭浏览器或 iPhone 都不会杀掉 AI 进程。

安装后使用以下任一方式：

```bash
octrix auth
octrix auth --device-code
```

第一种方式会创建授权请求并打开浏览器；第二种方式会显示 `https://relay.example.com/activate` 和类似 `ABCD-EFGH` 的 8 位码。授权码不区分大小写，提交时会忽略空格和连字符，只能消费一次。

其他命令：

```bash
octrix status
octrix start
octrix restart
octrix webtui
octrix logs
octrix logout
```

`octrix webtui` 会打开只监听本机的 `http://127.0.0.1:39800/`。该 Web TUI 是长期维护的正式桌面入口，并与 iOS 同步 Agent、会话、消息和任务进度。

CLI 只访问 `127.0.0.1:39800` 的 Host。授权轮询、钥匙串保存与 relay 重连都由 Host 完成。macOS 使用系统钥匙串；Linux 和测试环境使用权限为 `0600` 的文件适配器。

旧 `~/.cli-bridge/relay.json` 中的明文共享令牌，以及没有账号标记的旧安全存储凭证，会被删除并提示重新登录，不会迁移为账号设备凭证。`/api/relay/config` 不接受也不返回令牌。

## iPhone 授权

iOS 使用 `ASWebAuthenticationSession` 打开：

```text
https://relay.example.com/auth/mobile/start
```

Google 或短信登录、授权审批都在网站内完成。网站通过 `octrix://auth?code=...` 返回一次性码，App 再调用 `POST /api/v1/mobile/auth/token` 交换客户端凭证并保存到 Keychain。

退出登录或网站撤销 iPhone 后，App 会断开 REST/WebSocket、停止重连并清除本地凭证。用户也可以在 iPhone 的“设置 > 账号 > 删除账号”中发起永久删除；服务端确认后会删除账号、登录身份、设备授权、会话和访问凭证，断开所有设备，并清除这台 iPhone 的账号缓存。Mac 上的本地项目文件不会被删除。旧版手工令牌会提示重新登录，不会自动提交到新系统。

## 权限模型

| 凭证 | 可执行操作 | 禁止操作 |
| --- | --- | --- |
| Web Session | 管理本人身份、设备、会话和授权请求 | 直接注册 Mac 隧道 |
| `relay:device` | 以匹配的 `deviceId` 注册一台 Mac | 列出或访问其他设备 |
| `relay:client` | 列出并控制同账号 Mac | 注册 Mac、跨账号访问 |

所有 Octrix 长期访问令牌、OAuth state、授权码与一次性码在数据库中只保存带 pepper 的哈希。Sign in with Apple 的 refresh token 使用由服务端 pepper 派生的 AES-256-GCM 密钥加密保存，只用于账号删除时向 Apple 撤销用户授权。设备重命名、撤销和审批操作要求有效会话与 CSRF token。敏感字段不会进入应用日志。

撤销 Mac 或 iPhone 时，云端会立即关闭对应 WebSocket；旧凭证的后续请求返回 `401`。删除使用 Apple 登录的账号前，Relay 会先调用 Sign in with Apple REST API 撤销授权；若 Apple 服务暂时不可用，账号保留不变并提示稍后重试，避免丢失用于撤销的凭证。

## 公共接口

登录与账号：

- `GET /api/v1/auth/methods`
- `GET /auth/google/start`、`GET /auth/google/callback`
- `POST /api/v1/auth/sms/challenges`
- `POST /api/v1/auth/sms/challenges/:id/verify`
- `GET /api/v1/me`、`POST /api/v1/logout`
- `DELETE /api/v1/account`
- `/api/v1/account/*`

设备授权：

- `POST /api/v1/device-authorizations`
- `POST /api/v1/device-authorizations/token`
- `GET /authorize/device`
- `GET /activate`

移动授权：

- `GET /auth/mobile/start`
- `POST /api/v1/mobile/auth/token`

隧道接口保持稳定：

- `GET /device/ws`
- `GET /api/devices`
- `/d/:deviceId/*`

## 生产部署

`relay/` 是一个单一进程：Fastify 提供网站和授权 API，SQLite 保存账号与授权数据，内部隧道引擎处理 HTTP/WebSocket 转发。部署者应从 `relay/deploy/docker-compose.yml` 创建自己的受限部署目录；容器必须只监听主机回环地址。

```bash
ssh <deploy-host>
cd <deploy-dir>
sudo docker compose ps
curl http://127.0.0.1:18083/healthz
curl http://127.0.0.1:18083/readyz
```

Nginx 必须保留 WebSocket upgrade，读写超时为 300 秒，请求上限为 64 MB。生产配置样例位于 `relay/deploy/nginx-octrix.work.conf`；将其中的 `relay.example.com` 与证书路径替换为实际域名。

SQLite 每日生成一致性备份，文件保存到部署者指定的受限备份目录。手动备份：

```bash
sudo <deploy-dir>/backup.sh
```

Google、阿里云、App Review 固定验证码和 token pepper 只保存在服务器 `.env`。迁移期可以显式打开旧令牌兼容，最多保留 7 天；兼容请求只用于隧道连接，不创建新账号或进入授权控制台。设备全部重新授权后立即关闭开关并删除旧环境文件。

## 故障排查

| 现象 | 排查 |
| --- | --- |
| Mac 显示未授权 | 运行 `octrix auth`，确认浏览器完成审批 |
| Mac 已授权但离线 | 运行 `octrix restart`，再查看 `octrix status` 和本机 `/api/relay/status` |
| iPhone 看不到 Mac | 确认两端登录同一账号，Mac 状态为在线 |
| 返回 401 | 凭证已撤销或属于错误 scope，重新登录 |
| 返回 403 | 目标设备不属于当前账号 |
| 返回 502 | Mac 离线或本机 Octrix 服务未运行 |
| WebSocket 失败但 REST 正常 | 检查 Nginx upgrade 头和 300 秒超时 |
| `/readyz` 失败 | 检查 SQLite 挂载、pepper 与容器日志 |

生产健康检查：

```bash
curl https://relay.example.com/healthz
curl https://relay.example.com/readyz
ssh <deploy-host> 'cd <deploy-dir> && sudo docker compose logs --tail 100 octrix-cloud'
```

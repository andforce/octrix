# Octrix Cloud

`relay/` 是 Octrix 的单一云端进程，同时提供官网、账号登录、设备授权、授权控制台和 Mac 隧道。账号与设备状态持久化到 SQLite；relay 只接受授权中心签发的按设备、按 scope 令牌。

## 本地运行

```bash
npm install
npm --prefix site install
npm run build
OCTRIX_TOKEN_PEPPER="$(openssl rand -hex 32)" \
OCTRIX_DATABASE_URL="sqlite:///$(pwd)/octrix.sqlite3" \
OCTRIX_PUBLIC_URL="http://127.0.0.1:8790" \
npm start
```

开发网站可单独运行 `npm --prefix site run dev`。Vite 会将 `/api`、`/auth` 和健康检查代理到 `127.0.0.1:8790`。

核心配置见 [`deploy/.env.example`](deploy/.env.example)。正式环境的 Google 回调必须是 `<OCTRIX_PUBLIC_URL>/auth/google/callback`，并与 OAuth 提供商控制台中的地址完全一致。Apple Web 登录需要在 Apple Developer 中创建 Services ID，将公网域名和 `<OCTRIX_PUBLIC_URL>/auth/apple/callback` 登记为 Web 返回地址，并把 Services ID 关联到启用了 Sign in with Apple 的主 App ID；iOS 原生登录还需把 `OCTRIX_APPLE_NATIVE_CLIENT_ID` 设置为 App Bundle ID。两端可共用同一把 Sign in with Apple Key，用于签发 client secret 的 `.p8` 私钥以 base64 形式放进受控环境文件。通过 Apple 验证的账号无需配置邮箱白名单；Google 和短信登录仍使用各自白名单。阿里云短信可以使用号码认证控制台赠送的签名与模板，也可以使用已审核的自定义配置。令牌 pepper、OAuth 私钥/secret、短信 AccessKey、App Review 固定验证码和真实白名单只放在服务器 `.env`，不得提交。

## 权限模型

- `relay:device` 只能让与令牌绑定的 Mac 注册 `/device/ws`。
- `relay:client` 只能列出同一账号的 Mac，并访问这些设备的 `/d/:deviceId/*`。
- Mac 和 iPhone 令牌长期有效，直到用户退出或在授权控制台撤销。
- Web 会话默认 30 天，短信验证码 5 分钟，设备授权请求 10 分钟。
- OAuth state、授权码、会话、CSRF 和设备令牌在 SQLite 中只保存带 pepper 的哈希。Sign in with Apple 返回的 refresh token 使用由服务端 pepper 派生的 AES-256-GCM 密钥加密保存，仅在删除账号时调用 Apple 撤销接口。

赠送或自定义短信配置必须将控制台展示的签名名称和模板 CODE 分别写入 `OCTRIX_SMS_SIGN_NAME`、`OCTRIX_SMS_TEMPLATE_CODE`。旧 `RELAY_TOKEN` 仅用于显式迁移窗口。开启时必须同时设置 `OCTRIX_LEGACY_AUTH_ENABLED=true` 和未来 7 天内的 ISO 时间 `OCTRIX_LEGACY_AUTH_UNTIL`；到期后进程会立即拒绝旧凭证，兼容访问会写入脱敏警告。全部设备完成新授权后应立即关闭开关并删除旧凭据。

App Review 专用登录使用 `OCTRIX_APP_REVIEW_SMS_PHONES` 配置逗号分隔的中国大陆手机号，并使用 `OCTRIX_APP_REVIEW_SMS_CODE` 配置 6 位固定验证码。审核手机号创建的 challenge 不调用短信供应商，也不受短信重发和发送频率限制，但仍遵守白名单、有效期、错误次数限制和单次消费规则；Web 与 iPhone 最终都走正常的账号和设备凭证签发流程。未同时配置有效手机号与 6 位验证码时服务拒绝启动，固定验证码不得写入仓库、日志或客户端包。

## 主要接口

| 端点 | 用途 |
| --- | --- |
| `GET /healthz`、`GET /readyz` | 进程与数据库就绪检查 |
| `GET /api/v1/auth/methods` | 可用登录方式 |
| `/auth/apple/start`、`POST /auth/apple/callback` | Sign in with Apple Web OAuth |
| `POST /api/v1/mobile/auth/apple` | iOS 原生 Sign in with Apple，换取一次性移动授权码 |
| `/auth/google/start`、`/auth/google/callback` | Google OAuth |
| `POST /api/v1/auth/sms/challenges` | 创建短信 challenge |
| `POST /api/v1/device-authorizations` | 创建 Mac 浏览器/设备码授权 |
| `POST /api/v1/device-authorizations/token` | Mac 轮询并交换设备令牌 |
| `/auth/mobile/start` | iPhone 浏览器登录与授权 |
| `POST /api/v1/mobile/auth/token` | iPhone 交换一次性回调码 |
| `GET /api/v1/account` | 授权控制台数据 |
| `DELETE /api/v1/account` | 永久删除当前账号及其身份、会话、设备和访问凭证 |
| `WS /device/ws` | Mac 出站隧道 |
| `GET /api/devices` | 当前 iPhone 账号的 Mac |
| `ANY /d/:deviceId/*` | 同账号设备隧道 |

## 测试与部署

```bash
npm test
npm run typecheck
npm run build
docker compose -f deploy/docker-compose.yml build
```

部署者应将 [`deploy/`](deploy/) 复制到访问受控的主机目录，容器仅绑定 `127.0.0.1`，并通过自己的 Nginx/TLS 配置对外提供服务。不要将真实部署主机、SSH 信息、域名或 `.env` 内容提交到仓库。

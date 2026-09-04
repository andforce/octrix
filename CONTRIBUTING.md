# 贡献指南

感谢你的贡献。提交前请阅读 [SECURITY.md](SECURITY.md)；安全问题请不要通过公开 issue 报告。

## 开发环境

仓库统一使用 Node.js `22.12.0` 或更高版本。安装 nvm 后可在仓库根目录运行 `nvm use`。依赖必须在各子项目中安装：

```bash
cd client/web && npm ci
cd ../../relay && npm ci && npm --prefix site ci
```

## 提交前检查

```bash
cd client/web && npm test && npm run build
cd ../../relay && npm test && npm run typecheck && npm run build
cd ../client/ios && xcodebuild -project OctrixMobile.xcodeproj -scheme OctrixMobile \
  -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO
```

请保持改动聚焦，补充相应测试，不提交 `.env`、私钥、构建产物或本机运行数据。

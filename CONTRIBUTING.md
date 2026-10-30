# Contributing

欢迎提交 Issue / Pull Request。

## 开发流程

1. Fork 仓库并创建分支；
2. 修改代码，保持改动聚焦；
3. 运行测试（见 `docs/DEVELOPMENT.md`）；
4. 提交 PR，说明动机、改动与测试结果。

## 不要提交

- 真实健康数据、截图、数据库；
- 服务器地址 / 域名 / 账号 / 密码；
- BLE bindkey、设备 MAC / DID；
- keystore、证书、`auth.json`、`DNS provider.json`；
- 任何第三方 API Token。

## 代码约定

- Python 使用 FastAPI 风格；前端保持原生 JS；
- 敏感配置走设置 / 环境变量；
- 新增接口同步更新 `docs/API.md`；
- 保持医生只读与 owner 隔离语义。

## 提交信息

建议格式：

```text
feat: add ...
fix: ...
docs: ...
chore: ...
```

# 部署指南

## Docker Compose（推荐）

```bash
git clone https://github.com/<your-github-username>/bp-keeper.git
cd bp-keeper
mkdir -p data
docker compose up -d --build
```

默认监听 `8288` 端口，浏览器访问 `http://127.0.0.1:8288/`。
首次访问会要求设置管理员密码。

数据保存在 `./data`，升级前建议备份：

```bash
tar -czf bp-keeper-data-$(date +%F).tar.gz data
```

## HTTPS（可选）

生产环境建议通过 nginx / Caddy 反向代理并启用 HTTPS。`deploy/nginx-bp.conf.example` 提供了一个 nginx 示例：

- 把 `bp.example.com` 换成自己的域名；
- 把 `127.0.0.1:8288` 换成容器映射端口；
- 证书可使用 Let's Encrypt / acme.sh / 已有证书；
- 反向代理需保留完整 `Host`（含端口）：

```nginx
proxy_set_header Host $http_host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

如果 nginx 把 Host 的端口丢掉，后端的同源校验可能会把登录请求误判为跨站。

## 数据备份与恢复

```bash
# 备份
tar -czf bp-keeper-data-$(date +%F).tar.gz data

# 恢复（先停止服务）
docker compose stop
tar -xzf bp-keeper-data-YYYY-MM-DD.tar.gz
docker compose start
```

数据库使用 SQLite WAL；备份前最好停容器，或使用 SQLite 的在线备份方式。

## 升级

```bash
tar -czf bp-keeper-data-$(date +%F).tar.gz data
docker compose build
docker compose up -d
```

## 移动端

Android 源码在 `android/`，构建说明见 [android/README.md](../android/README.md)。

- APK 的 `TARGET_URL` 需要改成自己的 HTTPS 地址；
- 自行生成 keystore，**不要提交到仓库**；
- 通知 / 日历 / 打印 / BLE 权限由 Android 运行时授权；
- BLE 绑定密钥（bindkey）只在用户自己的设备与服务器之间使用。

## 安全建议

- 不要提交 `.env`、数据库、上传图片、keystore、bindkey；
- 使用强密码并定期备份；
- 公网暴露时使用 HTTPS，限制管理接口访问；
- 发现安全问题见 [SECURITY.md](../SECURITY.md)。

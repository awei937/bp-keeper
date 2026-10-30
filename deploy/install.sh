#!/bin/bash
# 在目标服务器上运行：把上传的代码包部署/更新到 /opt/bp-app
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/bp-app}"
TARBALL="${1:-/tmp/bp_app.tar.gz}"

echo "==> 应用目录: $APP_DIR"
if [ -d "$APP_DIR/data" ]; then
  echo "==> 备份现有数据目录..."
  tar -czf "/tmp/bp-app-data-$(date +%Y%m%d-%H%M%S).tar.gz" -C "$APP_DIR" data
fi

mkdir -p "$APP_DIR"
echo "==> 解压代码包..."
tar -xzf "$TARBALL" -C "$APP_DIR"

cd "$APP_DIR"
echo "==> 构建并启动容器..."
docker compose up -d --build

echo "==> 放行防火墙端口 8288..."
ufw allow 8288/tcp || true

echo "==> 等待健康检查..."
for i in $(seq 1 30); do
  if curl -fsS -m 3 http://127.0.0.1:8288/api/health >/dev/null 2>&1; then
    echo "==> 部署成功: http://192.0.2.10:8288"
    docker compose ps
    exit 0
  fi
  sleep 2
done

echo "!! 健康检查失败，最近日志："
docker compose logs --tail=100
exit 1

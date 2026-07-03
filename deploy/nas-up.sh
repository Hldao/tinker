#!/bin/sh
# NAS 私有实例一键起 · 在仓库根目录跑 (前提:.env.nas 已填好)
#   sh deploy/nas-up.sh
set -e
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

if [ ! -f .env.nas ]; then
  echo "✗ 缺 .env.nas · 先 cp .env.nas.example .env.nas 填好里面四个值再来"
  exit 1
fi

echo "→ 拉最新代码"
git pull --ff-only 2>/dev/null || echo "  (git pull 跳过 · 不影响)"

echo "→ 起容器 (首次要编 better-sqlite3 · 几分钟)"
docker compose --env-file .env.nas -f docker-compose.nas.yml up -d --build

echo "→ 等 tailscale 进网"
sleep 8
echo "=== NAS 的 tailnet 地址 ==="
docker exec tinker-tailscale tailscale ip -4 2>/dev/null \
  && echo "↑ 就是这个 · 队友开 http://<它>:8788 · 把这个地址发回去" \
  || echo "  tailscale 还没就绪 · 看日志: docker logs tinker-tailscale"

echo "=== 健康检查 ==="
sleep 3
docker exec tinker-tailscale wget -qO- http://localhost:8788/api/health 2>/dev/null \
  && echo "  ✓ 服务活着" \
  || echo "  服务还在起 · 半分钟后再: docker exec tinker-tailscale wget -qO- http://localhost:8788/api/health"

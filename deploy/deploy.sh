#!/usr/bin/env bash
#
# Tinker server — VPS 一键部署脚本
#
# 第一次跑:
#   1. 把这个 repo clone 到 VPS (~/tinker)
#   2. cp deploy/.env.example .env  &&  vi .env  (填配置)
#   3. bash deploy/deploy.sh
#
# 之后更新:
#   cd ~/tinker && git pull && bash deploy/deploy.sh
#
# 需要: docker + docker compose plugin

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
fail() { echo -e "${RED}✗${NC} $*"; exit 1; }

# ============================================
# 1. 前置检查
# ============================================
command -v docker >/dev/null || fail "docker 没装 · 跑: curl -fsSL https://get.docker.com | sh"
docker compose version >/dev/null 2>&1 || fail "docker compose plugin 没装"

if [ ! -f .env ]; then
  warn ".env 不存在 · 用 server/.env.example 模板创建"
  cp server/.env.example .env
  warn "请编辑 .env 后再跑此脚本"
  exit 1
fi

# ============================================
# 2. 备份当前数据 (如果存在)
# ============================================
if [ -f data/data.json ]; then
  TS=$(date +%Y%m%d-%H%M%S)
  cp data/data.json "data/data.json.bak-$TS"
  log "已备份 data.json → data/data.json.bak-$TS"
fi

# ============================================
# 3. 拉最新代码 (本地已 git pull · 此处只校验)
# ============================================
log "当前 commit: $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"

# ============================================
# 4. Build 镜像
# ============================================
log "build docker image..."
docker compose build

# ============================================
# 5. 优雅重启 (旧容器 graceful shutdown · 新容器接管)
# ============================================
log "重启 server..."
docker compose up -d

# ============================================
# 6. 等待 health
# ============================================
log "等待 health..."
for i in $(seq 1 30); do
  if docker compose exec -T tinker wget --quiet --tries=1 --spider http://localhost:8788/api/health 2>/dev/null; then
    log "server 健康"
    break
  fi
  sleep 2
done

# ============================================
# 7. 显示状态
# ============================================
echo ""
docker compose ps
echo ""
log "部署完成 · 用 docker compose logs -f tinker 看日志"

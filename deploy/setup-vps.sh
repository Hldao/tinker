#!/usr/bin/env bash
#
# VPS 首次 setup 脚本 (Ubuntu 22.04 / Debian 12)
#
# 用法 (SSH 到新 VPS 上):
#   1. wget https://raw.githubusercontent.com/Hldao/tinker/main/deploy/setup-vps.sh
#   2. bash setup-vps.sh tinkers.ink your-email@example.com
#
# 会装: docker / docker compose / caddy / git
# 会做: clone repo · 配 caddy 反代 · 拉证书

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"

if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
  echo "用法: bash setup-vps.sh <domain> <email>"
  echo "示例: bash setup-vps.sh tinkers.ink me@example.com"
  exit 1
fi

REPO_URL="https://github.com/Hldao/tinker.git"
APP_DIR="$HOME/tinker"

GREEN='\033[0;32m'
NC='\033[0m'
log() { echo -e "${GREEN}━━━${NC} $*"; }

# ============================================
# 1. 系统更新
# ============================================
log "更新 apt..."
sudo apt update
sudo apt install -y curl wget git ufw

# ============================================
# 2. 防火墙
# ============================================
log "开放 80/443/22 端口..."
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw --force enable

# ============================================
# 3. Docker
# ============================================
if ! command -v docker >/dev/null; then
  log "装 docker..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER
  echo "(请退出重连一次让 docker 组生效)"
fi

# ============================================
# 4. Caddy
# ============================================
if ! command -v caddy >/dev/null; then
  log "装 Caddy..."
  sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt update
  sudo apt install -y caddy
fi

# ============================================
# 5. clone repo
# ============================================
if [ ! -d "$APP_DIR" ]; then
  log "clone tinker..."
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

# ============================================
# 6. .env
# ============================================
if [ ! -f .env ]; then
  log "创建 .env..."
  cp server/.env.example .env
  sed -i "s|^NODE_ENV=.*|NODE_ENV=production|" .env
  sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=https://$DOMAIN|" .env
  echo ".env 已创建 · 你可以编辑 $APP_DIR/.env 调整 rate limit 等"
fi

# ============================================
# 7. Caddy 配置
# ============================================
log "配置 Caddy 反代到 :8788..."
sudo tee /etc/caddy/Caddyfile > /dev/null <<EOF
$DOMAIN {
    reverse_proxy localhost:8788
    encode gzip
    request_body { max_size 12MB }
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
    log {
        output file /var/log/caddy/tinker.log {
            roll_size 10mb
            roll_keep 5
        }
    }
}
EOF
sudo systemctl reload caddy
log "Caddy 配好了 · 会自动从 Let's Encrypt 拉证书 ($EMAIL)"

# ============================================
# 8. 启动 Tinker
# ============================================
log "启动 Tinker..."
bash deploy/deploy.sh

# ============================================
# 完成
# ============================================
echo ""
log "全部完成 ✦"
echo ""
echo "  访问 → https://$DOMAIN"
echo "  日志 → cd $APP_DIR && docker compose logs -f tinker"
echo "  更新 → cd $APP_DIR && git pull && bash deploy/deploy.sh"
echo ""

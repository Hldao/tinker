#!/usr/bin/env bash
#
# Tinker · 大陆未备案 / 极简一键部署
#
# 适用: 大陆服务器未备案 · 暂时用高端口 (默认 8788) · 跳过 80/443 + Caddy
# 访问: http://<server-ip>:8788  或  http://daogu.cc:8788 (DNS 解析后)
#
# 备案完成后:
#   bash deploy/setup-vps.sh daogu.cc your@email.com  # 切到标准 Caddy + HTTPS
#
# 用法 (SSH 到服务器后):
#   wget -O - https://raw.githubusercontent.com/Hldao/tinker/main/deploy/setup-vps-cn.sh | bash
#
# 或自定义端口:
#   wget https://raw.githubusercontent.com/Hldao/tinker/main/deploy/setup-vps-cn.sh
#   bash setup-vps-cn.sh 8888

set -euo pipefail

PORT="${1:-8788}"
REPO_URL="https://github.com/Hldao/tinker.git"
APP_DIR="$HOME/tinker"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

log() { echo -e "${GREEN}━━━${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
err() { echo -e "${RED}✗${NC} $*"; exit 1; }

# ============================================
# 1. 系统检查
# ============================================
if [ ! -f /etc/os-release ]; then
  err "不支持的系统 (需要 /etc/os-release)"
fi
. /etc/os-release
log "系统: $PRETTY_NAME"

if ! command -v sudo >/dev/null; then
  warn "没有 sudo · 假设当前是 root"
  SUDO=""
else
  SUDO="sudo"
fi

# ============================================
# 2. 装基础工具 + Docker
# ============================================
log "装基础工具..."
case "$ID" in
  ubuntu|debian)
    $SUDO apt update -qq
    $SUDO apt install -y -qq curl wget git ca-certificates
    ;;
  centos|rhel|rocky|almalinux|alinux|anolis|openEuler)
    # 阿里云 Linux / 龙蜥 / OpenEuler 都是 RHEL 兼容
    if command -v dnf >/dev/null; then
      $SUDO dnf install -y curl wget git ca-certificates
    else
      $SUDO yum install -y curl wget git ca-certificates
    fi
    ;;
  *)
    warn "未知系统 $ID · 尝试 dnf/yum/apt 兜底"
    $SUDO dnf install -y curl wget git 2>/dev/null \
      || $SUDO yum install -y curl wget git 2>/dev/null \
      || $SUDO apt install -y curl wget git
    ;;
esac

if ! command -v docker >/dev/null; then
  log "装 Docker (用阿里云镜像加速)..."
  # 国内服务器用阿里云脚本更快
  if curl -fsSL https://get.docker.com -o /tmp/get-docker.sh; then
    $SUDO sh /tmp/get-docker.sh --mirror Aliyun || $SUDO sh /tmp/get-docker.sh
  else
    err "Docker 下载失败 · 检查网络"
  fi
  $SUDO systemctl enable docker
  $SUDO systemctl start docker
  $SUDO usermod -aG docker $USER 2>/dev/null || true
fi

# 配 Docker Hub 国内镜像源 (国内服务器 docker pull 卡 docker.io 必备)
if [ ! -f /etc/docker/daemon.json ] || ! grep -q "registry-mirrors" /etc/docker/daemon.json 2>/dev/null; then
  log "配 Docker 国内镜像源 (DaoCloud / 1Panel / rat.dev)..."
  $SUDO mkdir -p /etc/docker
  $SUDO tee /etc/docker/daemon.json > /dev/null <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1panel.live",
    "https://hub.rat.dev"
  ]
}
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl restart docker
fi

if ! $SUDO docker compose version >/dev/null 2>&1; then
  err "docker compose plugin 不可用 · 装新版 docker"
fi

# ============================================
# 3. Clone repo
# ============================================
if [ ! -d "$APP_DIR" ]; then
  log "Clone Tinker..."
  git clone "$REPO_URL" "$APP_DIR"
else
  log "已有 repo · git pull..."
  cd "$APP_DIR" && git pull
fi
cd "$APP_DIR"

# ============================================
# 4. 配置 .env
# ============================================
if [ ! -f .env ]; then
  log "创建 .env..."
  cp server/.env.example .env
  # 用 perl 跨 mac/linux sed 兼容性更好
  perl -i -pe "s|^PORT=.*|PORT=$PORT|" .env
  perl -i -pe "s|^NODE_ENV=.*|NODE_ENV=production|" .env
  perl -i -pe "s|^CORS_ORIGINS=.*|CORS_ORIGINS=|" .env  # 暂留空 = 开放 · 备案后收紧
  log ".env 已配置 (PORT=$PORT · NODE_ENV=production)"
else
  warn ".env 已存在 · 跳过 (你想重置请 rm .env 再跑一次)"
fi

# ============================================
# 5. Build + 启动 docker
# ============================================
log "Build docker image..."
$SUDO docker compose build

# 给 ./data 目录写权限 (容器里非 root 用户写不进 root 创建的目录)
log "准备 data 目录权限..."
$SUDO mkdir -p data
$SUDO chmod 777 data

log "启动 Tinker..."
$SUDO docker compose up -d

# ============================================
# 6. 等 health
# ============================================
log "等待 server health..."
for i in $(seq 1 30); do
  if $SUDO docker compose exec -T tinker wget --quiet --tries=1 --spider http://localhost:8788/api/health 2>/dev/null; then
    log "Server 健康 ✓"
    break
  fi
  sleep 2
done

# ============================================
# 7. 防火墙提示
# ============================================
if command -v ufw >/dev/null && $SUDO ufw status | grep -q active; then
  log "检测到 ufw · 自动开放 $PORT 端口"
  $SUDO ufw allow $PORT/tcp || true
else
  warn "ufw 未启用 · 跳过本机防火墙"
fi

# ============================================
# 8. 完成总结
# ============================================
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✦ Tinker 已上线${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# 拿公网 IP
IP=$(curl -s --max-time 3 https://api.ipify.org 2>/dev/null || echo "<your-server-ip>")

echo "  本地访问: http://localhost:$PORT"
echo "  公网访问: http://$IP:$PORT"
echo ""
echo -e "${BOLD}下一步:${NC}"
echo ""
echo "  ${YELLOW}1.${NC} 在云厂商控制台开放 $PORT 端口 (安全组规则)"
echo "     阿里云: ECS → 安全组 → 配置规则 → TCP $PORT/源 0.0.0.0/0"
echo "     腾讯云: CVM → 安全组 → 入站规则 → TCP $PORT/源 0.0.0.0/0"
echo "     华为云/其他: 类似"
echo ""
echo "  ${YELLOW}2.${NC} 在域名商加 A 记录 (默认 DNS 生效 5-30 分钟):"
echo "     主机名: @ (或留空)"
echo "     记录类型: A"
echo "     值: $IP"
echo ""
echo "  ${YELLOW}3.${NC} 验证: 等 DNS 生效后 浏览器访问 http://daogu.cc:$PORT"
echo ""
echo -e "${BOLD}日常运维:${NC}"
echo "  看日志:   cd ~/tinker && $SUDO docker compose logs -f tinker"
echo "  更新:     cd ~/tinker && git pull && bash deploy/deploy.sh"
echo "  重启:     cd ~/tinker && $SUDO docker compose restart"
echo ""
echo -e "${BOLD}备案后切换到标准 80/443 + HTTPS:${NC}"
echo "  cd ~/tinker"
echo "  bash deploy/setup-vps.sh daogu.cc your@email.com"
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

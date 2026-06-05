#!/usr/bin/env bash
# 快速部署 · 自动判断要不要 rebuild
#
# 用法 (ECS 上 · cd ~/tinker 后):
#   bash deploy/quick.sh        # 自动判断
#   bash deploy/quick.sh webapp # 强制只重启 (不 rebuild) · 10 秒
#   bash deploy/quick.sh full   # 强制完整 rebuild · 1-3 分钟

set -e

cd "$(dirname "$0")/.."

# 1. 拉新代码 (5 次重试 · 国内 → GitHub 经常抽风)
echo "━━━ 1. 拉新代码 ━━━"
for i in 1 2 3 4 5; do
  echo "  [尝试 $i/5]"
  if git pull 2>&1; then
    echo "  ✓ 成功"
    break
  fi
  if [ $i -eq 5 ]; then
    echo "  ✗ 5 次都失败 · GitHub 网络不通 · 稍后再试"
    exit 1
  fi
  sleep 5
done

# 2. 判断要 rebuild 还是只 restart
MODE="${1:-auto}"
if [ "$MODE" = "auto" ]; then
  # 自动判断: 只有 webapp/ 改动 → 只 restart · 否则 rebuild
  CHANGES=$(git diff --name-only HEAD@{1} HEAD 2>/dev/null || echo "")
  NEEDS_REBUILD=false
  for f in $CHANGES; do
    case "$f" in
      webapp/*) ;; # webapp 改动不需要 rebuild
      *) NEEDS_REBUILD=true ;;
    esac
  done
  if [ "$NEEDS_REBUILD" = "true" ]; then
    MODE="full"
  else
    MODE="webapp"
  fi
  echo "━━━ 2. 自动判断: $MODE ━━━"
  echo "  改动的文件: $CHANGES"
fi

# 3. 执行
if [ "$MODE" = "webapp" ]; then
  echo "━━━ 3. 只重启 (网页文件挂载式 · 不需要 rebuild) ━━━"
  docker compose restart tinker
elif [ "$MODE" = "full" ]; then
  echo "━━━ 3. 完整重新打包 + 重启 (服务器代码有变更) ━━━"
  docker compose up -d --build
else
  echo "✗ 未知模式: $MODE"; exit 1
fi

# 4. 等待健康检查
echo "━━━ 4. 等服务起来 ━━━"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf http://localhost:8788/api/health >/dev/null 2>&1; then
    echo "  ✓ 服务健康"
    curl -s http://localhost:8788/api/health
    echo ""
    exit 0
  fi
  sleep 2
done
echo "  ⚠ 10 秒内没起来 · 看日志: docker compose logs --tail=30 tinker"
exit 1

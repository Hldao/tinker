# Tinker / 捣鼓 — server + webapp
# 多阶段构建保持镜像小

FROM node:20-alpine AS builder
WORKDIR /app

# 大陆 ECS 上构建 · apk / npm 走默认海外源慢到超时 · 换阿里云 + npmmirror
RUN sed -i 's#https\?://dl-cdn.alpinelinux.org#https://mirrors.aliyun.com#g' /etc/apk/repositories

# 1. better-sqlite3 是 native module · 需要构建工具 (build-base = make+g++)
#    python3 是 node-gyp 的依赖
RUN apk add --no-cache python3 make g++

# 2. 先装依赖 (利用 Docker 缓存层)
COPY server/package*.json ./server/
WORKDIR /app/server
RUN npm ci --omit=dev --registry https://registry.npmmirror.com

# 2. 拷贝源代码
WORKDIR /app
COPY server/ ./server/
COPY webapp/ ./webapp/

# ============================================
# 运行时层 — 用 alpine 节省镜像大小
# ============================================
FROM node:20-alpine AS runtime
WORKDIR /app

# 同上 · 运行时层也换阿里云 apk 源
RUN sed -i 's#https\?://dl-cdn.alpinelinux.org#https://mirrors.aliyun.com#g' /etc/apk/repositories

# git · 给 /api/cli-version 读自己仓库历史用 (宿主 .git 只读挂进来 · 算 CLI 落后多少)
RUN apk add --no-cache git

# 用非 root 用户跑
RUN addgroup -S tinker && adduser -S tinker -G tinker
USER tinker

COPY --from=builder --chown=tinker:tinker /app /app

ENV NODE_ENV=production
ENV PORT=8788
EXPOSE 8788

# 数据卷 (持久化 data.json + backups)
VOLUME ["/app/server/backups"]

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:8788/api/health || exit 1

WORKDIR /app/server
CMD ["node", "index.js"]

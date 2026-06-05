# Deployment Runbook

## 部署形态

### 选项 A · 单 VPS + Docker + Caddy (推荐 · 简单)

最适合 alpha → early production。架构:

```
[用户浏览器]
     │ HTTPS
     ▼
[Caddy] :443
     │ HTTP localhost:8788
     ▼
[Docker: tinker-server]
     │ atomic JSON write
     ▼
[Volume: ./data/data.json]
```

适合规模: < 1000 用户 · 单实例够。

### 选项 B · K8s (生产规模 · V3 再说)

不在本期 runbook 范围。

---

## 新 VPS 首次 setup

**前置条件**:
- Ubuntu 22.04 / Debian 12
- 已开通 SSH 访问
- 域名已解析到 VPS IP (A 记录)
- 22/80/443 端口开放

**一键 setup**:
```bash
ssh user@vps
wget https://raw.githubusercontent.com/Hldao/tinker/main/deploy/setup-vps.sh
bash setup-vps.sh tinkers.ink your@email.com
```

会自动:
1. 装 docker / docker compose / caddy
2. clone repo 到 `~/tinker`
3. 创建 `.env` (设置 `NODE_ENV=production` + CORS)
4. 配 Caddyfile (自动 HTTPS · Let's Encrypt)
5. 启动 Tinker
6. 启动 Caddy

完成后:
- 访问 `https://tinkers.ink` 即可使用
- 日志: `cd ~/tinker && docker compose logs -f tinker`
- 更新: `cd ~/tinker && git pull && bash deploy/deploy.sh`

---

## 日常运维

### 看日志
```bash
docker compose logs -f tinker        # 实时
docker compose logs --tail 100 tinker  # 最近 100 条
```

### 看状态
```bash
docker compose ps
curl -s http://localhost:8788/api/health | jq
```

### 备份
JSON 文件存储 · backup 在 `~/tinker/data/backups/` (自动保留最近 5 份)。

外加 cron 把 data 备份到对象存储 (推荐 OSS / S3):
```bash
# crontab -e (每天 03:00 备份)
0 3 * * * tar czf /tmp/tinker-$(date +\%Y\%m\%d).tar.gz -C ~/tinker/data . && ossutil cp /tmp/tinker-*.tar.gz oss://your-bucket/ && rm /tmp/tinker-*.tar.gz
```

### 恢复
```bash
docker compose down
cp data/backups/data-XXXX.json data/data.json
docker compose up -d
```

### 更新代码
```bash
cd ~/tinker
git pull
bash deploy/deploy.sh    # 会自动重 build · 重启 · 等 healthcheck
```

### 重置 (开发用)
```bash
docker compose down
rm data/data.json
docker compose up -d     # 会从 seed 重建
```

⚠️ **生产环境** 通过环境变量 disable 重置接口:
```
NODE_ENV=production
ALLOW_RESET=0  # (默认)
```

---

## 环境变量参考

完整清单在 `server/.env.example`。生产关键:

```bash
NODE_ENV=production
PORT=8788
LOG_LEVEL=info
CORS_ORIGINS=https://tinkers.ink     # 收紧 CORS
RATE_LIMIT_ACTION=60                  # 60 req/min/IP
RATE_LIMIT_STATE=300
DATA_FILE=/data/data.json            # 容器内挂载点
```

---

## 监控建议

### 内置健康检查
- Docker `HEALTHCHECK` 每 30s 检查 `/api/health`
- 失败 3 次 docker 标记 unhealthy (但不会自动重启 · 看 `restart` policy)

### 外部 uptime
- UptimeRobot 免费 · HTTP 监控 `https://tinkers.ink/api/health`
- 每 5 分钟一次 · 失败发邮件

### 错误追踪 (V2 加 Sentry)
- 当前: pino 输出 JSON 到 stdout · docker logs 收集
- V2: 加 Sentry · 错误自动上报

---

## 安全清单 (生产前必检)

- [ ] `NODE_ENV=production` 已设置
- [ ] `CORS_ORIGINS` 白名单收紧
- [ ] `ALLOW_RESET` 不存在或 = 0
- [ ] Caddy / nginx 有 HTTPS · HSTS header
- [ ] VPS 防火墙: 只开 22/80/443
- [ ] SSH 用 key 不用密码 (`PasswordAuthentication no`)
- [ ] root 登录禁用
- [ ] `data/` 卷的宿主目录权限 700
- [ ] 定期 backup 到外部存储

---

## 常见问题

### Q: docker compose 启动失败
检查日志: `docker compose logs tinker`

常见原因:
- 端口冲突 (别的服务在 8788) · 改 `.env` 的 `PORT`
- 文件权限 · `chown -R $USER:$USER data/`
- Node 版本 · Dockerfile 要求 Node 20+ · 镜像内已自带

### Q: webapp 显示 "连不上 server"
- 检查 server 是否在跑: `docker compose ps`
- 检查 Caddy 反代是否正常: `sudo systemctl status caddy`
- 浏览器 console 看 fetch 失败原因
- 检查 CORS 配置

### Q: 数据丢了
- 看 `~/tinker/data/backups/` 是否有 backup
- 复制最近的 backup 到 `data.json` · 重启容器

### Q: 想换域名
1. DNS 改 A 记录到新域名
2. 修改 `/etc/caddy/Caddyfile` 的域名
3. 修改 `.env` 的 `CORS_ORIGINS`
4. `sudo systemctl reload caddy && docker compose restart tinker`

### Q: 想扩展到多实例
当前 JSON 文件存储是单实例瓶颈。多实例需要:
- 换 SQLite + 共享文件锁 (alpha · 1-3 实例 OK)
- 或换 PostgreSQL (生产推荐)
- 配 reverse proxy load balance

V2 工作 · 见 ROADMAP。

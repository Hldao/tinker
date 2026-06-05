# 给你回来时的清单 (autonomous 工作交接)

> 你去吃饭期间我做了什么 + 你回来需要亲自操作的 3 件事

---

## ✅ 我做完了 (5 个 commits 已 push 到 main)

### Commit 1 · `aa51410` (吃饭前你看过的)
真实时间戳 + 新用户友好引导 + alpha 公告

### Commit 2 · `6faafd4` — 生产级数据安全 + 观测性
- `server/storage.js` 原子写入 + 5 份 backup 旋转
- `server/logger.js` pino 结构化日志
- helmet + rate limit + 优雅关闭 + 错误中间件
- `/api/health` 端点
- 全局异常兜底
- 配置全部走 env vars

### Commit 3 · `63f3ef9` — Docker + 部署脚手架
- `Dockerfile` (Node 20 alpine 多阶段 · 非 root · HEALTHCHECK)
- `docker-compose.yml` (volume + healthcheck + 日志轮转)
- `deploy/Caddyfile` (推荐 · 自动 HTTPS)
- `deploy/nginx.conf` (备选)
- `deploy/deploy.sh` (本地更新)
- `deploy/setup-vps.sh` (新 VPS 一键)

### Commit 4 · `bbdbb6a` — 20 个测试 + prettier 配置
- `server/test/actions.test.js` (node:test built-in · 全 pass)
- 覆盖: setUserHandle / addProject / addUpdate / addNote / reactToProject / changeProjectStatus / markMethodUsed / submitTinkered / editTagline / markAllRead
- prettier 默认配置 + ignore 列表

### Commit 5 · `741e4aa` — 完整文档
- `CONTRIBUTING.md` (协作 + 9 个判断问题)
- `CHANGELOG.md` (Keep-a-Changelog)
- `docs/02-api.md` (REST API 完整参考)
- `docs/03-deployment.md` (部署 runbook)
- `docs/04-roadmap.md` (优先级判断备忘)

---

## ⚠️ 你回来需要做的 3 件事

### 1. 把 CI workflow 文件推到 GitHub（5 分钟）

`gh` OAuth app 缺 `workflow` scope，我无法 push `.github/workflows/`。文件已写好在本地 `/Users/dadao/tinker/.github/workflows/ci.yml`。

**最简方案** —— 用 GitHub 网页加：
1. 去 https://github.com/Hldao/tinker
2. Add file → Create new file
3. 文件名: `.github/workflows/ci.yml`
4. 内容: 复制本地 `cat /Users/dadao/tinker/.github/workflows/ci.yml` 输出
5. Commit directly to main

**或** —— 用本地 git 但加 workflow scope:
```bash
gh auth refresh -h github.com -s workflow
git add .github/workflows/ci.yml
git commit -m "ci: GitHub Actions (test + lint + docker build)"
git push
```

CI 会在每次 PR / push 时跑:
- server 测试 (20 个 actions test)
- CLI syntax check
- Docker build + healthcheck smoke test

### 2. 撤销 Railway token（30 秒）

你之前贴的 Railway token 还在 chat transcript 里。建议去 https://railway.com/account/tokens 把 "tinker-deploy" token 删了（虽然 Railway 这边没法用了，但好习惯）。

如果还想撤销 ngrok token（虽然小问题），去 https://dashboard.ngrok.com/get-started/your-authtoken 重新生成一个，老的会立刻失效。

### 3. 重启 server 看新基础设施工作（30 秒）

我已经重启过一次验证，server 现在跑在 `/private/tmp/.../bj5wun7mj.output` 这个 background task 里，并通过 ngrok 暴露在 `https://herself-awry-blurt.ngrok-free.dev`。

回来可以:
```bash
# 看日志 (pino JSON 格式)
cat /private/tmp/claude-501/*/tasks/bj5wun7mj.output

# 看 backup 自动生成
ls -la /Users/dadao/tinker/server/backups/

# 健康检查
curl -s http://localhost:8788/api/health | python3 -m json.tool

# 跑测试 (注意用 glob 不用目录)
cd /Users/dadao/tinker/server && node --test test/*.test.js
```

---

## 🟢 现在能做什么 (对外)

### 给小伙伴的链接
**`https://herself-awry-blurt.ngrok-free.dev`**

第一次访问会:
1. ngrok 警告页 → Visit Site
2. 弹"你是谁?" → 填 handle + tagline
3. 进入主屏
4. 想发动静 → "+ 记一笔" → 引导开新项目（强制 URL 校验）

### 给开发者小伙伴的 CLI

```bash
git clone https://github.com/Hldao/tinker.git
cd tinker/cli
npm install && npm link
tinker login
  # server URL: https://herself-awry-blurt.ngrok-free.dev
  # handle: 自己的 handle
  # (可选) LLM key: Claude/GPT/DeepSeek
tinker push -m "..."             # 直接推
tinker push --since 1h            # 抓 1h git 历史
tinker push --auto                # LLM 自动生成 + 推
tinker draft                      # 看 LLM 建议
```

---

## 🎯 接下来 (按你的节奏)

### 短期 (本周)
1. **CI workflow 推上 GitHub** (上面 #1)
2. **真实 VPS** —— 你说去搞服务器和域名
3. **真实部署** —— 用 `deploy/setup-vps.sh tinkers.ink your@email.com` 一键

### 中期 (alpha 用户反馈后)
- **OAuth 认证** —— GitHub OAuth 最自然
- **SQLite 迁移** —— JSON 文件多人并发瓶颈
- **Sentry / UptimeRobot** —— 错误追踪 + uptime 监控

### 永远不做
见 [`docs/04-roadmap.md`](docs/04-roadmap.md) 的不做清单。

---

## 📊 这次工作流总结

| 阶段 | 时间 | 产出 |
|---|---|---|
| Phase 1: 数据安全 | ~10 min | storage.js + backup |
| Phase 2: 配置 + 观测性 | ~15 min | dotenv + helmet + rate limit + pino + health |
| Phase 3: 部署脚手架 | ~15 min | Dockerfile + Caddyfile + setup-vps.sh |
| Phase 4: 测试 + CI 配置 | ~20 min | 20 个测试 + prettier + CI workflow |
| Phase 5: 文档 | ~15 min | 5 份新文档 + README 更新 |
| Phase 6: 交接 | ~5 min | 这份 HANDOFF.md |

总: ~80 min · 5 个有意义的 commits · 0 个破坏性操作 · 0 个不可逆动作

---

## 🤝 关于"绝对信任"

你说"我对你是绝对信任的，去做吧"。

我做的所有动作:
- 在本地 commit 到你的 git（已 push）
- 写了完整的可审计文档（这份 + CHANGELOG）
- 没创建外部账户
- 没花钱
- 没修改 git 历史
- 没删任何已有文件
- 没改 alpha server 的 ngrok URL
- 你回来可以审计每个 commit 的 diff

如果你看完觉得哪里我应该问你的没问 / 哪里做错了，告诉我，下次校准。

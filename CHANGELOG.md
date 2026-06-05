# Changelog

格式: [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)
版本: SemVer · alpha 期 0.x.x

## [Unreleased]

### Added
- (留给下一个改动)

---

## [0.2.0] — 2026-06-05 · 生产化基础设施

### Added (server)
- **数据安全**: `storage.js` · 原子写入 (.tmp + rename) + 5 份 backup 旋转 + 损坏文件自动 fallback
- **结构化日志**: pino + pino-http (dev 终端 / prod JSON)
- **环境变量管理**: dotenv + `.env.example` 完整清单
- **安全 headers**: helmet
- **Rate limiting**: express-rate-limit (action 60/min · state 300/min · env 覆盖)
- **CORS 收紧**: `CORS_ORIGINS` 白名单 · 默认开放
- **健康检查**: `/api/health` (uptime / 内存 / state 数量 / Node 版本)
- **错误中间件**: 全局兜底 · 不泄露 stack
- **优雅关闭**: SIGTERM/SIGINT + 10s 强制超时
- **异常兜底**: uncaughtException + unhandledRejection
- **trust proxy**: 信任反代 (nginx/caddy)

### Added (multi-user)
- `setUserHandle` action · 第一次填 handle 自动开张工作室
- webapp 首次访问弹"你是谁?" modal
- handle 存 `localStorage` · 顶部刊头点击可改
- 新用户工作室空状态友好引导卡片
- 关于页加 ALPHA 横幅 (说明 ngrok 临时性 + 求反馈)

### Added (真实时间戳)
- server SEED 启动时把 `ago` 字符串转 `at` timestamp
- 所有新建数据用 `at: Date.now()`
- webapp 加 `timeAgo` / `shortAgo` / `parseAgoOrder` 三个 helper

### Added (基础设施)
- `Dockerfile` (Node 20 alpine 多阶段 · 非 root)
- `docker-compose.yml` (volume / env / healthcheck / 日志轮转)
- `deploy/Caddyfile` (推荐 · 自动 HTTPS)
- `deploy/nginx.conf` (备选 · 配 certbot)
- `deploy/deploy.sh` (本地更新)
- `deploy/setup-vps.sh` (新 VPS 一键 setup)
- 20 个 actions 测试 (node:test · 0 依赖)
- prettier 配置

### Changed
- `parseAgoOrder` / `shortAgo` 签名: 接受 timestamp 而不是字符串
- API 兼容 (业务行为零变化)

---

## [0.1.0] — 2026-06-05 · alpha 三件套上线

### Added
- **server/** Express + JSON 存储 · 12 个 action handlers
- **webapp/** SPA 升级自 prototype v0.23 · fetch /api
- **cli/** `tinker push` · 支持 `--since` / `--auto` / `draft` / LLM (Claude/GPT/DeepSeek)
- GitHub repo 创建
- ngrok tunnel 公网入口 alpha

### Architecture decisions
- 数据存储: JSON 文件 (alpha) · 后期换 SQLite/PG
- API 风格: `GET /api/state` + `POST /api/action`
- 认证: 无 (alpha 期 trust handle)

---

## [0.0.x] — Prototype 阶段

完整设计迭代记录见 `prototypes/v0.1.html` → `prototypes/v0.23.html`。
关键决策点见 `docs/01-product-spec.md`。

23 个原型版本浓缩出的设计共识:
- 工艺人日志气质 (报纸刊头 + Newsreader + Fraunces + 朱砂红/苔绿)
- 反点赞 / 反推荐 / 反等级
- 必须挂可访问产物 (反 AI 装大佬)
- 反馈链: 想试试 → 跑通了召回
- update 级 "用了 · 跑通了" 反馈
- 工作室 + 项目 + 进展 三层结构

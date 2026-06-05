# Backend 设计 · v0.3 · 给 future-me 看

> 2026-06-05 · 阶段切换：JSON file + trust handle → SQLite + 邮箱 magic link 鉴权

## TL;DR

- **DB**: SQLite (better-sqlite3) · 单文件 · WAL + foreign_keys ON
- **Auth**: 邮箱 magic link (Resend) · http-only cookie · 90 天 session
- **身份**: UUID 主键 + handle (display, 可改) + email (verification)
- **匿名浏览保留**：互动触发登录 modal (已实现 pendingAfterLogin 沿用)
- **文件**: 暂时 base64 in DB · OSS 单独 task
- **生产 IP**: http://120.26.46.217:8788 (daogu.cc 备案中)

## 为什么这么选

- **SQLite > Postgres**：单 server 12 月内不会撞瓶颈 · 0 新基础设施 · 备份 = 拷文件
- **邮箱 magic link > OAuth**：spec §10 反技术中心化 · 目标用户里设计师/PM/学生很多没 GitHub
- **UUID > handle 主键**：用 handle 当 FK · 改 handle 要 cascade · 改 1 行变 30 行
- **不做 OAuth/2FA/手机号/找回**：alpha 没必要 · v0.5+ 再说

## 文件结构

```
server/
  index.js               主入口 (Express + middleware)
  actions.js             12 个 action 业务逻辑 (会改吃 SQL)
  storage.js             旧 JSON 存储 (Phase C 之后删)
  seed.js                生产 seed (Phase C 之后简化)
  db.js                  ✨ better-sqlite3 client + prepared statements
  auth.js                ✨ magic link + session middleware
  email.js               ✨ Resend 客户端 + 邮件模板
  migrations/
    001_initial.sql      ✨ 所有表 schema
    runner.js            ✨ 简易 migration runner (跟踪 schema_version)
  test/
    actions.test.js      (改吃新 db · in-memory SQLite)
    fixtures.js          (mock 数据 · 改成 SQL INSERT 形式)
```

## Schema (SQL · 见 migrations/001_initial.sql)

核心表 (跳过详细字段 · 看 migration 文件就清楚):

- `users` — id (UUID) · handle · email · tagline · created_at
- `auth_tokens` — 5min token · email · intent · user_id (可空 · 用户不存在则建)
- `sessions` — 90day cookie · user_id · last_seen
- `projects` — id · owner_id · slug · name · desc · product_link · status
- `project_tools` — many-to-many
- `updates` — project_id · text · prompt · at (position 排序)
- `images` — id · src (base64 或 OSS url)
- `update_images` / `note_images` — join
- `method_used` — update_id · user_id · note
- `reactions` — project_id · user_id · type (现在只有 'wantToTry')
- `tinkered` — parent_project_id · user_id · name · link
- `notes` — project_id · user_id · text
- `notifications` — target_user_id · from_user_id · type · project_id · extra · at · read_at

索引 (查询路径):
- users.handle / users.email (UNIQUE)
- projects.owner_id · projects.status
- updates.project_id (+ at DESC)
- notes.project_id
- notifications.target_user_id (+ at DESC)
- tinkered.parent_project_id

## Auth Flow

```
匿名 → 点 "想试试" → 弹 modal "填邮箱"
  ↓ POST /api/auth/send-link {email}
  ↓ server 建 auth_token (5min) · Resend 发邮件
  ↓ modal 变 "去邮箱看链接"
  ↓
用户点邮件链接 → GET /api/auth/verify?token=xxx
  ↓ server 验证 token · 找/建 user (UUID + handle 从 email 前缀)
  ↓ set http-only cookie (sessionId · 90day)
  ↓ 302 redirect 回 /#/p/owner/slug (用户原本所在的)
  ↓
返回 webapp → 检测 cookie · 自动 navigateFromHash
  ↓ 如果是新 user · 弹 welcome modal (handle 已预填 · 可改 + tagline 可选)
  ↓ 接着完成 pendingAfterLogin (e.g., 想试试 那个项目)
```

所有 action 走的 `currentUser` 字段以前是客户端 trust · 改成 server 从 session 读 (无 cookie = 401)。webapp 删 setHandle 这个 action 路径 · 走 send-link / verify。

## 数据迁移 (data.json → SQLite)

一次性脚本: `server/migrate-from-json.js`
- 读 data.json
- BEGIN TRANSACTION
- INSERT users (现在只有 daodao · UUID 用 v7 · email NULL · daodao 之后绑邮箱)
- INSERT projects + project_tools
- INSERT updates + images + update_images
- INSERT method_used / reactions / tinkered / notes / note_images
- INSERT notifications
- COMMIT
- 验证 row counts
- 跑完后 data.json 改 read-only · 留 backup

部署顺序:
1. ssh ECS · stop container
2. 拷新代码 + 跑 migration script
3. 验证 SQLite 文件内容
4. start container (server 从 SQLite 读)
5. 浏览器全 flow 测试

如果出问题 · rollback = stop + 删 SQLite · 改回 JSON storage 代码 · start。

## Resend 配置

- 用 `resend` npm package
- 环境变量 `RESEND_API_KEY` (用户提供)
- 暂时用 `onboarding@resend.dev` 作发件人 (sandbox · 只能发到 verified 邮箱)
- 生产前用户去 Resend dashboard 验证一个发件域名 (非 daogu.cc 也行 · DNS 验证 · 不需要 ICP)

## 可观测性 (Phase F+)

不在 v0.3 范围 · 之后单独做:
- Sentry · 错误追踪
- UptimeRobot · `/api/health` 5min ping
- 每天 cron · tar SQLite 发 OSS bucket

## 暂不做 (写下来防止下次纠结)

- ❌ OAuth (GitHub/Google/微信/Apple) — v0.5 作为额外绑定
- ❌ 2FA — 真有需求再说
- ❌ 手机号登录 — 国内走运营商通道 · 比邮箱贵且慢
- ❌ 邮箱找回 / 二级 backup email — v0.5
- ❌ 登录历史 / 安全日志 — V2
- ❌ 多 device session 列表 + remote logout — V2
- ❌ Postgres 迁移 — 用户量到 10K+ 再考虑

## 当前实施进度

按 task 跟踪:
- Phase A · DB foundation
- Phase B · Auth
- Phase C · 业务 actions 改吃 SQL + data.json 迁移
- Phase D · Webapp 登录 UI
- Phase E · 部署 + 验证

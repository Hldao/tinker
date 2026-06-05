# Tinker / 捣鼓

> 给"用 AI 创造但不必懂代码"的人的工作室。
>
> GitHub 是给写代码的人的工作室。我们是给"捣鼓东西的人"的工作室 —— ta 们用 AI · 做出真的能跑的东西 · 但不必是程序员。

## 🟢 Alpha 测试

当前 alpha 在我电脑上跑（ngrok tunnel），公网入口：

**https://herself-awry-blurt.ngrok-free.dev**

⚠️ Alpha 期注意:
- 我电脑开着才能访问 · 关机/睡眠会断
- 重启 ngrok 后 URL 会换 · 以最新通知为准
- 没有真实认证 · 多人测试约定不同 handle (`@xx`) 避免冲突
- 第一次访问会弹 ngrok 警告页 · 点 "Visit Site" 进入

---

## 三件套

```
server/      ← Express + JSON 存储 + 静态服务 webapp
webapp/      ← SPA · fetch /api/state + /api/action
cli/         ← `tinker push` 命令行 · 用 LLM 自动生成进展
prototypes/  ← 历史原型 v0.1 - v0.23 (设计迭代记录)
docs/        ← 产品哲学 + spec
```

完整的"创作 → 反馈 → 通知 → 召回"闭环。看 [`docs/01-product-spec.md`](docs/01-product-spec.md) 了解产品哲学。

---

## 本地跑

需要 Node.js 18+ (用 built-in fetch)。

```bash
# 1. 起 server (默认 8788)
cd server
npm install
node index.js
# 浏览器访问 http://localhost:8788/

# 2. (可选) 装 CLI
cd ../cli
npm install
npm link              # 全局可用 `tinker` 命令
tinker login          # 配置 (server URL + handle + 可选 LLM key)
tinker push -m "你的第一条进展"
```

---

## CLI 用法

```bash
tinker push                          # 交互式 · 选项目 · 写一句 · 推
tinker push -m "..."                 # 直接推一条
tinker push --since 1h               # 抓最近 1 小时 git 历史作为建议
tinker push --auto                   # LLM 自动生成 + 推 (无交互)
tinker push --since 1h --auto        # LLM 总结 1 小时进展 + 推
tinker draft                         # LLM 看建议 (不推)
tinker draft --since 30m             # 自定义时间窗
tinker projects                      # 列我的活跃项目
tinker hook install                  # 装 git post-commit hook
tinker config                        # 看当前配置
```

`--since` 支持: `30m` / `2h` / `1d` / `today` / `yesterday` / 任意 git 能理解的格式。

LLM 支持: Anthropic Claude (默认) / OpenAI / DeepSeek。

---

## 让小伙伴一起测试

### 方案 A · 部署到 Railway (推荐 · 5 分钟)

1. fork 这个仓库到你的 GitHub
2. 注册 [Railway](https://railway.app/)（GitHub OAuth 登录）
3. **New Project** → **Deploy from GitHub repo** → 选择 fork 的仓库
4. Railway 自动识别根目录 — **手动设置 Root Directory: `server/`**
5. Railway 自动跑 `npm install && node index.js`
6. 部署完拿到 URL: `https://your-app.up.railway.app`
7. 小伙伴们:
   - **网页直接访问** 那个 URL
   - **装 CLI**: `git clone && cd cli && npm install && npm link && tinker login`（填部署的 URL）

⚠️ Railway free tier 文件系统是 ephemeral — `server/data.json` 重启会丢。alpha 测试可接受。生产前要换 PostgreSQL（V2）。

### 方案 B · ngrok 临时暴露本地

```bash
# Terminal 1: 起本地 server
cd server && node index.js

# Terminal 2: ngrok 暴露
brew install ngrok
ngrok http 8788
# 拿到 https://xxxx.ngrok.io · 分享给小伙伴 (你电脑要开着)
```

### 方案 C · VPS（生产）

DigitalOcean / Hetzner / Vultr 都行。需要:
- 装 Node.js 18+
- `git clone` + `cd server && npm install`
- pm2 / systemd 管理进程
- nginx 反代到 8788 + HTTPS (Caddy / Certbot)

---

## 测试者使用流程

如果有人帮你测试，引导 ta 们:

1. **网页版**: 直接访问你部署的 URL
2. **CLI 版** (对 vibe coder 友好):
   ```bash
   git clone https://github.com/你的/tinker.git
   cd tinker/cli
   npm install && npm link
   tinker login   # 填部署的 URL + 自己的 handle
   tinker push    # 试着推一条
   ```

⚠️ **多用户冲突**: 当前后端没有真认证，所有人共用 `handle` 字段。alpha 测试可以约定每人用不同 handle (`@xx`)。真生产前要加 OAuth (V2)。

---

## 架构

```
                ┌─────────────────────────┐
                │   webapp (浏览器)         │
                │   index.html · fetch API  │
                └────────────┬────────────┘
                             │ /api/*
                ┌────────────▼────────────┐
                │   server (Express)        │
                │   ├ /api/state            │
                │   ├ /api/action           │
                │   └ /api/reset            │
                └────────────┬────────────┘
                             │ load/save
                ┌────────────▼────────────┐
                │   data.json               │
                │   (server-managed JSON)   │
                └─────────────────────────┘
                             ▲
                             │ /api/action
                ┌────────────┴────────────┐
                │   CLI (tinker push)      │
                │   ├ git history          │
                │   └ LLM (Claude/GPT/DS)  │
                └─────────────────────────┘
```

**关键决策**:
- API 单一可变面: `GET /api/state` + `POST /api/action { type, payload }`
- 12 个 action handlers (`server/actions.js`)
- 每个 action 触发 saveData() · 防丢失
- CLI 和 webapp 完全等权 (调同一 API)

---

## 哲学速查 (写代码前请读)

按 [`docs/01-product-spec.md`](docs/01-product-spec.md)，加新功能前过一遍这 9 个判断问题:

1. **工程**: 长期维护成本?
2. **法律**: 合规红线?
3. **情感**: 让用户更焦虑还是更安心?
4. **真实**: 让数据更真实还是更"看起来繁荣"?
5. **运营**: 上线后谁来持续维护?
6. **行为可执行性**: 用户那个时刻真的会做这个操作吗?
7. **视角对称性**: 不同用户群体的能力/信息差异是什么?
8. **情感时刻不数据化**: 这个功能把善意/事件商品化吗?
9. **反技术中心化**: 这个功能/字段/词汇假设用户懂代码吗?

**任一答案不理想 → 默认不做。** 做减法比做加法需要更多勇气。

---

## License

MIT (or whatever you decide)

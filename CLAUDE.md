# Tinker / 捣鼓

Vibe coder 工作坊社区平台。这个仓库同时是 **Tinker 项目本身的代码** + **作者 dogfood 用 Tinker 的现场**。

## 你在跟一个 Tinker 作者协作

这台机器上装了 `tinker` CLI · 任何 shell 里能直接调。跟用户协作时 · 看下方关键场景**主动**调对应命令 · 不靠用户提醒。

| 用户说什么 / 在做什么 | 你应该 |
|---|---|
| 聊到某技术 / 报错 / 想入门 X | `tinker borrow "<关键词>" --json --limit 5` 拿别人方法注入回答 |
| 起草前怕重复 / 想引用作者过往 | `tinker recent --json --limit 10` |
| 说"懂了 / 顿悟 / 终于通了" (上下文真是顿悟) | 建议 `tinker push -m "..."` 留一笔 |
| 说"卡住 / 不行 / 跑不起来" (真卡住不是描述) | 建议 `tinker stuck -m "..."` 让在意 ta 的人看到 |
| 做工具 / 方案决策 | 建议 `tinker resolve push-decision -m "..."` |
| 说"砍了 / 不做了" (有理由的取舍) | 建议 `tinker push -m "..."` 说为什么砍 |
| 说"完工 / 上线 / deploy 了" (真发布) | 建议 `tinker ship -m "一句话感想"` 进陈列馆 |
| 问"今天我都做了啥" | `tinker goodnight --json` |
| 问"@xxx 在做什么 / 到哪一步了" | `tinker feed @xxx --json --limit 10` 拉 ta 的公开 update 流 |

**关键词命中只是候选** · 看上下文判断是不是真的事件 · 不每次都建议。误触发率高了用户会烦。

**调前先看状态**:`tinker state --json` 返回 `muted / cooldown / dismissedToday` · 这些为 true 时用户不想被打扰 · 别调 push/ship/stuck 这种动作类。

**幂等保险**:动作类支持 `--idempotency-key <uuid>` · 同 key 24h 内重复调直接返之前结果。重试 / hook 重复触发都不会写两次。

## 调 CLI 的协议约定

- 几乎所有命令支持 `--json` · 输出 `{ok: true, ...}` 成功 / `{ok: false, error, code}` 失败
- 完整 schema:`tinker schema --json`
- 完整 help:`tinker --help` (顶部有 AI agent 指南段)

## 文案 / 语言约束 (帮用户写 update / commit / docs 时)

读完这条 · 改文风时遵守:

- **纯中文** · 不中英混杂 · 技术黑话翻译成中文 (`一次性 token` 不是 `one-time token`)
- **避免斜体** (italic) · 用户会专门清理 · 别新增
- **避免 AI 标点堆**:不堆中点 (`·`) · 不堆破折号 (`——`) · 用普通话口语化标点
- **工艺人日志气质**:不像 PM 周报 · 不像私人日记 · 像坐在工作台前边修边聊
- **voice fingerprint**:`.tinker/voice-fingerprint.md` 有作者真实风格画像 · 起草前读它
- **拒绝商业黑话 / 管理咨询黑话**:`生态` / `赋能` / `抓手` / `闭环` / `底层逻辑` / `颗粒度` / `对齐` / `复盘` 等用户从不用 · 你也别用
- **用"我"不用"我们"** · 用"人"不用"用户"
- **高频开头词**:`今天 / 今晚 / 凌晨 / 早上` · 90% 的 update 这么起手
- **结尾**:留 takeaway (下一步 / 学到了什么) · 不客套 (`谢谢阅读` / `欢迎反馈` 从不出现)
- **技术名词全小写**:`sqlite` / `json` / `https` / `api` (不 ALL_CAPS)

## 产品立场 (改 webapp / 写产品文案时)

**反算法 / 反 trending / 反数据游戏**。任何"加点赞 / 加排行 / 加推荐 / 加热度排序"的提议都先问是不是符合产品哲学。

可以加:真实复用反馈 (接走 · 用了方法) · 真实仪式 (完工 · 卡住)
不能加:浏览量 · 关注数 · 热度排序 · stars

## 关键概念词

- **update** (进展) · 一条进展记录 · 项目下的核心 entity
- **method** (方法) · update 升格 · 别人能 borrow 复用的手艺
- **experience** (踩坑经验) · update 升格 · 别人撞到同样坑能学
- **learning** (上手指南) · update 升格 · 帮别人快速入门新技术
- **decision** (决策推演) · update 升格 · 工具/方案选型的思考留痕
- **project** · 跟 update 平级 · 一个项目下挂多条 update / method
- **borrow** · 搜别人的 method / experience / learning / decision

注意:`tinker update` 这个命令是**升级 CLI 自己** (业内惯例) · 不是"记一笔进展" — 容易混。记一笔是 `tinker push -m '...'`。

## 重要文件位置

- `~/.tinker/config.json` — server URL / handle / token / LLM key
- `~/.tinker/prompt-state.json` — 触发器冷却 / 静音 / pending 等运行时状态
- `~/.tinker/style-pool/good/` — voice 样本池
- `.tinker/voice-fingerprint.md` — 当前项目作者风格画像 (跟 repo)
- `.tinker/repo.json` — repo 跟 Tinker project 的绑定
- `cli/bin/tinker.js` — CLI 主文件 (单文件 6000+ 行)
- `cli/lib/mcp-server.js` — MCP server (可选 · 用户可以装 · CLI 路线不强求)
- `server/` — Tinker server (Express + SQLite)
- `webapp/index.html` — Tinker webapp 单文件

## CLI 触发器系统 (你可能会看到 reminder 注入)

CLI 装了 Claude Code hook (`tinker hook install-claude`) · 用户说收工 / 卡住 / 顿悟 / 决策 / 砍 / 完工类话时 · stdout reminder 会注入你的 context。看 reminder 时:

- 不是每次命中都按 reminder 建议用户 · 看上下文判断
- 如果用户在做产品讨论 / 命令测试 / 文档撰写 · 大概率不是真事件 · 别打扰
- reminder 里写的"上下文判断"就是给你的提示 · 不要无脑跟着说"要不要记一笔"

## 跨 AI 触发器入口 (Claude Code 以外的 AI 工具看这段)

Tinker 的对话内触发器有两条路径:

**Claude Code 用户**:hook 自动跑 (`tinker hook install-claude` 装好后) · LLM 不用做任何事 · reminder 会自动 inject。

**其他 AI 用户 (Cursor / Aider / Continue / Cline 等)**:Claude Code 那套 UserPromptSubmit hook 不通用 · LLM 需要主动调:

```bash
tinker maybe-check --text "<用户最近一条消息>" --json
```

输出形如:`{ ok: true, fired: [{ kind: "stuck", reminder: "..." }], cooled: [...] }`

LLM 工作流:
1. 看到用户消息 · 觉得**可能**是顿悟 / 卡住 / 决策 / 砍 / 完工等
2. Bash 跑 `tinker maybe-check --text "<消息>" --json`
3. 看 `fired` 数组 · 每个 hit 是一组 (kind, reminder)
4. 按 reminder 里的建议跟用户对话 (但仍然看上下文判断 · 不强弹)

两条路径**共享同一份 matcher 词典 + 同一份冷却**(写 `~/.tinker/prompt-state.json` 的 `lastMaybeAtByKind`) · 30/60 分钟内同 kind 不会重复触发。不论谁调一次 · 另一条路径都会被节流。

## post-commit hook 触发的待处理 reminder

git commit 时 · post-commit hook 跑 `tinker check --from-hook --json` 评估 24 个触发器 (clever-fix / tool-combo / ship / decision / ai-limit / ui-session 等) · 命中的会 append 到 `~/.tinker/pending-reminders.jsonl`。

任何 AI 工具的 LLM 都能查:

```bash
tinker pending --json     # 列待处理 reminder (JSON)
tinker pending            # 人可读
tinker pending --check    # 静默注入 · UserPromptSubmit hook 用 · 没 reminder 不输出
tinker pending --mark-handled <id>   # 标已处理
tinker pending --clear    # 全清
```

Claude Code 装了 install-claude 后 · 每次用户 prompt 都自动跑 `tinker pending --check` · 命中 reminder 注入 context · 你会主动汇报给用户 "刚才 hook 触发了 ship · 要不要进陈列馆"。

其他 AI (Cursor / Aider / 等) 没这个自动化 · LLM 应该在合适时机主动 Bash 跑 `tinker pending --json`(比如 session 开头、用户问"今天怎么样"、commit 之后) 查未处理 reminder · 主动跟用户对话。

**处理 reminder 的标准流程**:
1. 看 reminder 的 `kind` / `msg` / `suggestion` / `choices`
2. 看上下文判断是不是真值得提醒用户 (不是每次都提)
3. 决定提醒 → 建议用户跑对应命令 (push / ship / stuck 等)
4. 处理完 → `tinker pending --mark-handled <id>`

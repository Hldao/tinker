---
name: tinker
description: Tinker / 捣鼓 CLI 协作总纲。任何时候你在一台装了 tinker CLI 的机器上跟人协作，或者用户提到 tinker / 捣鼓 / 记一笔 / 发进展 / 方法库 / 工作室，先看这个。它告诉你什么场景该主动调哪个 tinker 命令、调用协议、以及去看哪个更细的 tinker-* 技能。
---

# Tinker / 捣鼓 协作总纲

这台机器上装了 `tinker` CLI，任何 shell 里能直接调。你（AI 协作者）在跟一个 Tinker 用户协作。看下面关键场景**主动**调对应命令，不靠用户提醒。

## 关键场景反查表

| 用户说什么 / 在做什么 | 你应该 | 细节看 |
|---|---|---|
| 聊到某技术 / 报错 / 想入门 X | `tinker borrow "<关键词>" --json --limit 5` 拿别人方法注入回答 | `tinker-borrow` |
| 起草前怕重复 / 想引用作者过往 | `tinker recent --json --limit 10` | `tinker-record` |
| 说"懂了 / 顿悟 / 终于通了"（真顿悟）| 建议 `tinker push -m "..."` 留一笔 | `tinker-record` |
| 说"卡住 / 不行 / 跑不起来"（真卡住）| 建议 `tinker stuck -m "..."` 让在意 ta 的人看到 | `tinker-record` |
| 做工具 / 方案决策 | 建议 `tinker push -m "..."` 记决策 | `tinker-record` |
| 说"砍了 / 不做了"（有理由的取舍）| 建议 `tinker push -m "..."` 说为什么砍 | `tinker-record` |
| 说"完工 / 上线 / deploy 了"（真发布）| 建议 `tinker ship -m "一句话感想"` 进陈列馆 | `tinker-record` |
| 说"沉淀成方法 / 求个方法" | `tinker contribute` 或 `tinker seek` | `tinker-borrow` |
| 说"接力 / 交接给 X / 征求意见 / 邀请 X" | 走 handoff / witness / studio | `tinker-collab` |
| 问"今天我都做了啥" | `tinker goodnight --json` | — |
| 问"@xxx 到哪一步了" | `tinker feed @xxx --json --limit 10` | — |

**关键词命中只是候选。** 看上下文判断是不是真事件，不每次都建议。误触发率高了用户会烦。

## 调用协议

- 几乎所有命令支持 `--json`，输出 `{ok: true, ...}` 成功 / `{ok: false, error, code}` 失败
- 完整 schema：`tinker schema --json`
- 完整 help：`tinker --help`（顶部有 AI agent 指南段）
- 逃生口：`tinker action <type> --payload '{...}'` 直调 server 任意 action（还没被包成专门命令的那些）。发前可 `--dry-run` 预览。注意它绕过 voice 守门和幂等，**内容发布（记进展/完工）仍走 `tinker push` / `tinker ship`**，逃生口是给"平台其余能力"的直通车
- **调前看状态**：`tinker state --json` 返回 `muted / cooldown / dismissedToday`，为 true 时别调 push/ship/stuck 这种动作类
- **幂等保险**：动作类支持 `--idempotency-key <uuid>`，同 key 24h 内重复调直接返之前结果，重试和 hook 重复触发都不会写两次

## 关键概念词

- **update**（进展）项目下的核心 entity，一条进展记录
- **method**（方法）update 升格，别人能 borrow 复用的手艺
- **experience**（踩坑经验）update 升格，别人撞到同样坑能学
- **learning**（上手指南）update 升格，帮别人快速入门
- **decision**（决策推演）update 升格，工具/方案选型留痕
- **project** 一个项目下挂多条 update / method
- **borrow** 搜别人的 method / experience / learning / decision

注意：`tinker update` 是**升级 CLI 自己**（业内惯例），不是"记一笔进展"。记一笔是 `tinker push -m '...'`。

## 重要文件

- `~/.tinker/config.json` server URL / handle / token / LLM key
- `~/.tinker/prompt-state.json` 触发器冷却 / 静音 / pending 状态
- `~/.tinker/inbox/` 收到的 handoff / invite / witness-request
- `.tinker/voice-fingerprint.md` 当前项目作者风格画像（跟 repo）
- `.tinker/repo.json` repo 跟 Tinker project 的绑定

## 更细的技能

- `tinker-record` 发进展 / 起草 / 完工 / 卡住，以及怎么不被 voice 守门拦
- `tinker-voice` 帮用户写任何要发出去的文字时的中文文风约束
- `tinker-borrow` 搜方法库 / 沉淀方法 / 求方法
- `tinker-collab` 工作室接力、决策征求、邀请入室
- `tinker-triggers` 理解和处理触发器 reminder（hook / pending / maybe-check）

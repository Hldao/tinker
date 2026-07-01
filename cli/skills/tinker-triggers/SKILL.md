---
name: tinker-triggers
description: 理解和处理 Tinker 的触发器 reminder 系统。Claude Code 里 hook 会自动往你 context 注入 reminder；Cursor / Aider / Codex 这类 AI 需要主动查。你看到注入的 reminder，或想在合适时机主动查有没有待处理提醒时，看这个。涉及 tinker pending / maybe-check / check。
---

# 触发器 reminder 系统

Tinker 在 git commit 后和用户对话里评估触发器（顿悟 / 卡住 / 决策 / 砍 / 完工 / clever-fix / ui-session 等），命中就生成 reminder 提示你该不该建议用户记一笔。

## 两条注入路径

**Claude Code**：装了 `tinker hook install-claude` 后，每次用户 prompt 自动跑 `tinker pending --check` 注入 context，git commit 后 post-commit hook 跑 `tinker check --from-hook`。你不用做任何事，reminder 自动来。

**其他 AI（Cursor / Aider / Continue / Cline / Codex）**：没有自动注入，你要在合适时机主动查：

```bash
tinker pending --json                    # 列待处理 reminder
tinker maybe-check --text "<用户消息>" --json   # 就着用户这句话即时评估触发器
```

Codex 用户可跑 `tinker hook install-codex`，装 git hook + 往 `AGENTS.md` 写指令块。合适时机 = session 开头、用户问"今天怎么样"、commit 之后。

两条路径共享同一份 matcher 词典和冷却，30/60 分钟内同 kind 不重复触发，谁调一次另一条都被节流。

## pending 命令

```bash
tinker pending --json               # JSON
tinker pending                      # 人可读
tinker pending --check              # 静默注入，没 reminder 不输出
tinker pending --mark-handled <id>  # 标已处理
tinker pending --clear             # 全清
```

## 处理 reminder 的标准流程

1. 看 reminder 的 `kind` / `msg` / `suggestion` / `choices`
2. **看上下文判断是不是真值得提醒用户**，不是每次都提。用户在做产品讨论 / 命令测试 / 文档撰写时大概率不是真事件，别打扰
3. 决定提醒 → 建议用户跑对应命令（push / ship / stuck 等）
4. 处理完 → `tinker pending --mark-handled <id>`

reminder 里写的"看上下文判断"就是给你的提示，不要无脑跟着说"要不要记一笔"。误触发率高了用户会烦，克制是这个系统能活下去的前提。

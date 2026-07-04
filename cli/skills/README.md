# Tinker Skills

这里是 Tinker 协作知识的**源文件**，一域一个 Claude Code Skill。

以前 Tinker 靠一整块 CLAUDE.md（700 行）教 AI，每次 session 全量塞进 context。现在拆成按场景触发的技能：AI 只在相关场景（记进展 / 搜方法 / 接力 / 处理 reminder）才加载对应技能，省 context 也更聚焦。灵感来自飞书 CLI 的 `skills/` 目录。

## 技能清单

| 技能 | 什么时候加载 |
|---|---|
| `tinker` | 总纲 · 场景反查表 + 调用协议 + 概念词，指向下面各技能 |
| `tinker-record` | 记一笔 / 起草 / 完工 / 卡住，以及怎么不被 voice 守门拦 |
| `tinker-voice` | 帮用户写任何要发出去的中文文字时的文风约束 |
| `tinker-borrow` | 搜方法库 / 沉淀方法 / 求方法 |
| `tinker-collab` | 工作室接力 / 决策征求 / 邀请入室 |
| `tinker-todo` | 记待办 / 勾完成 / 派活 / 个人待办同步成团队任务（私密协作层，跟公开进展分开）|
| `tinker-triggers` | 理解和处理触发器 reminder（hook / pending / maybe-check）|

## 装进 AI

```bash
tinker skills install            # 全局 · ~/.claude/skills · 本机所有项目生效
tinker skills install --project  # 只装当前 repo · .claude/skills
tinker skills list               # 看有哪些技能
```

## 改这里

每个技能是 `<name>/SKILL.md`，标准 Claude Code Skill 格式（YAML frontmatter 的 `name` + `description` 决定何时加载，正文是给 AI 的指令）。`description` 写清"什么场景该加载"最关键，AI 靠它判断要不要读这条技能。改完重新 `tinker skills install` 覆盖即可。

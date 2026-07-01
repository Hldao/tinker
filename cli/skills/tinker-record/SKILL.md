---
name: tinker-record
description: 帮 Tinker 用户记一笔进展、标记卡住、完工上线，或用作者的 voice 起草 update 时用。涉及 tinker push / draft / ship / stuck，以及关键的一点，怎么起草才不被 voice 守门拦下来。用户说"懂了/顿悟/卡住/砍了/上线了/记一笔"这类话，或你要帮他发任何一条 update 时看这个。
---

# 记一笔：push / draft / ship / stuck

## 命令一览

- `tinker push -m "..."` 发一条进展 update
- `tinker draft [--since <time>]` 让 Tinker 内置 LLM 用作者 voice 起草 1-3 条候选，落到 `.tinker/drafts/`
- `tinker push <草稿文件>` 把 draft 起草的候选推出去
- `tinker stuck -m "..."` 标记卡住，让在意 ta 的人看到
- `tinker ship -m "一句话感想"` 完工仪式，进陈列馆，自动抓 productLink 截图当封面
- `tinker recent --json --limit 10` 看作者近期 update，起草前防重复

## voice 守门（最关键，先读这段）

所有 push 路径在写库前都跑 `detectAIVoice` 评分：

- score >= 3 → **强拒**，必须加 `--force` 才发
- score == 2 → TTY 时弹确认，非 TTY 警告但放过
- score <= 1 → 通过

常命中的 AI 直出特征：破折号 `——`、中英混杂（空格隔开的 "studio / handle" 也算）、内部代号（"选 X 不选 Y" / "方案 A vs 方案 B"）、段首 emoji、等号金句、中圆点滥用。

## 帮用户起草的正确姿势

1. **优先走 draft 路径**：`tinker draft` 让内置 LLM 用作者 voice fingerprint 起草，再 `tinker push <草稿文件>` 推。这条最稳。
2. **不要直接 `tinker push -m "<你自己写的一段>"`**。这条路最容易翻车，即使你按 fingerprint 风格写也未必过守门。
3. 真要 `push -m` 的话，先自检：`tinker maybe-check` 或本地 `node -e 'require("./cli/lib/voice-check").detectAIVoice("...")'`。
4. **被守门拦了不要立刻 `--force`**。看 hits 列表，真有问题就回去改，真没问题再 force。

写之前如果 `.tinker/voice-fingerprint.md` 存在，读它对齐作者风格。但它是从旧样本自动生成的，会滞后甚至跟明确规则打架，**冲突时以 `tinker-voice` 里的明确规则为准**。文风细节看 `tinker-voice` 技能。

## 判断是不是真事件

关键词命中只是候选。用户在做产品讨论、命令测试、文档撰写时，说一句"卡住了/懂了"大概率不是真信号，别打扰。看上下文判断，不每次都建议。

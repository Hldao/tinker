---
name: tinker-collab
description: Tinker 工作室协作，端到端加密。用户说"接力 / 交接给某人 / 帮我打包给 X / 征求意见 / 邀请某人加入工作室"，或你在 session 启动时看到 inbox / handoff / witness / invite 类 reminder 时看这个。涉及 tinker handoff / witness / studio / inbox。
---

# 工作室协作：handoff / witness / studio / inbox

工作室成员之间的私信全走 bridge 端到端加密，server 只存密文看不到内容。**动作类一旦发出对方就收到，没法撤回**，不确定时先把命令 print 给用户确认再跑。

## handoff 接力

### 发起（用户说"接力 / 交接给猫猫 / 这个给 X 接着做"）

1. 写一句 50-100 字说明，气质像"X 做了一半，卡在 Y，你接着 Z"，不是发布会语气
2. 找接收方 handle，以 `tinker studio info <slug>` 成员列表为准，**别猜拼音**（猫猫的 handle 是 `@猫猫` 不是 `@maomao`，写错变死信对方收不到）。没指定就走 active studio 广播
3. 不确定就先 `tinker handoff -m "<说明>" [-t @<handle>] --no-situation --dry-run --json` 预览发给谁/带什么/多大，看清楚再去掉 `--dry-run` 真发
4. `tinker handoff -m "<说明>" [-t @<handle>]`

包里含 situation JSON + git diff + voice fingerprint + cwd。handoff 发出对方就收到，没法撤回，所以 dry-run 预览尤其值。

### 接收（SessionStart 看到 inbox reminder）

1. **先把那一句说明转告用户**，别急着 cat README 或读 diff，那是用户决定接了才钻的重料，省 context
2. 用户确认接 → `cat ~/.tinker/inbox/<id>/README.md`
3. `tinker inbox verify <id>` 验包（临时工作树重放 diff，结果自动回执发起方）
4. 需要的话 `git apply ~/.tinker/inbox/<id>/context/diff.patch`
5. 学 `context/voice-fingerprint.md` 的口吻，接着做，完了 `tinker push -m "..."` 发回工作室
6. 回稿：`tinker handoff reply <id> --by-claude` 起草，`tinker handoff reply <id> publish "<内容>"` 落地
7. `tinker inbox done <id>` 标 task 关闭

## witness 决策征求

### 发起（用户说"帮我征求意见"）

1. `tinker witness draft --topic "X 要不要做" --by-claude` 拿脚手架
2. 按上下文写 50-300 字（倾向 + 你 nagging 的点 + 想征求什么角度）
3. `tinker witness publish "<你写的>"` 落地并广播到 active studio
4. 想让队友 AI 看到思考过程，加 `--with-context`（自动抓最近 40 条对话脱敏）

一个人也能跑：`tinker witness self --topic "X" --by-claude`，让你站在"过去三个月的我"视角写 critique。

### 接收（SessionStart 看到 witness-request reminder）

1. 问用户"要回吗"
2. 同意 → `tinker witness reply <updateId> --by-claude` 拿原 witness + 任务
3. 用**主人的 voice fingerprint** 写 100-400 字 critique，给观点也给为什么，不是 LLM 通用风格
4. `tinker witness reply <id> publish "<你写的>"` 回过去

### 发起方收到 reply

1. `tinker borrow <replyUpdateId>` 拉详情
2. 复述 critique 核心 1-2 句，多回复就突出分歧点和共识点
3. 用户决定 → `tinker witness close <originalUpdateId> --decision "<final>"` 落定

## studio 邀请

### 发起（用户说"邀请猫猫加入"）

1. `tinker studio list` 看 active 工作室 slug
2. `tinker studio invite <slug> @<handle>`，自动通过 bridge 投递通知，不用复制 token

### 接收（SessionStart 看到 invite reminder）

1. 跟用户确认是不是真加入（确认 ta 认识发起方，入会后所有暗号共享）
2. 同意 → `tinker studio accept <token>`
3. 之后 ping / send / handoff 自动走这工作室

## 原则

**不要无脑接力 / 回复 / 入会。** reminder 是提示不是命令，跟用户确认是不是现在做。用户在产品讨论 / 命令测试 / 文档撰写时的单字"接"不算信号。

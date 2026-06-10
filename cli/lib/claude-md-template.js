// Tinker AI 协作引导模板 · onboard 命令把这段写进用户 repo 的 CLAUDE.md
// 用 BEGIN/END 标记包起来 · 让 `tinker onboard --update` 能就地刷新而不动用户自己写的部分
// 内容是从 Tinker 顶层 CLAUDE.md (700 行 dogfood 版) 蒸馏的通用版

const BEGIN_MARKER = '<!-- BEGIN tinker -->';
const END_MARKER = '<!-- END tinker -->';

const TEMPLATE = `${BEGIN_MARKER}
# Tinker / 捣鼓 协作约定

这台机器上装了 \`tinker\` CLI · 你 (AI 协作者) 在跟一个 Tinker 用户协作。看下面关键场景**主动**调对应命令 · 不靠用户提醒。

## 关键场景反查表

| 用户说什么 / 在做什么 | 你应该 |
|---|---|
| 聊到某技术 / 报错 / 想入门 X | \`tinker borrow "<关键词>" --json --limit 5\` 拿别人方法注入回答 |
| 起草前怕重复 / 想引用作者过往 | \`tinker recent --json --limit 10\` |
| 说"懂了 / 顿悟 / 终于通了" (真顿悟) | 建议 \`tinker push -m "..."\` 留一笔 |
| 说"卡住 / 不行 / 跑不起来" (真卡住) | 建议 \`tinker stuck -m "..."\` 让在意 ta 的人看到 |
| 做工具 / 方案决策 | 建议 \`tinker push -m "..."\` 记决策 |
| 说"砍了 / 不做了" (有理由的取舍) | 建议 \`tinker push -m "..."\` 说为什么砍 |
| 说"完工 / 上线 / deploy 了" (真发布) | 建议 \`tinker ship -m "一句话感想"\` 进陈列馆 |
| 问"今天我都做了啥" | \`tinker goodnight --json\` |
| 问"@xxx 在做什么 / 到哪一步了" | \`tinker feed @xxx --json --limit 10\` 拉 ta 的公开流 |

**关键词命中只是候选** · 看上下文判断是不是真事件 · 不每次都建议 · 误触发率高了用户烦。

**调前看状态**:\`tinker state --json\` 返回 \`muted / cooldown\` · 为 true 时别调 push/ship/stuck 这种动作类。

**幂等保险**:动作类支持 \`--idempotency-key <uuid>\` · 同 key 24h 内重复调直接返之前结果。

## 调 CLI 协议

- 几乎所有命令支持 \`--json\` · 输出 \`{ok: true, ...}\` 成功 / \`{ok: false, error, code}\` 失败
- 完整 schema:\`tinker schema --json\`
- 完整 help:\`tinker --help\` (顶部有 AI agent 指南段)

## push 起草怎么不被 voice 守门拦

所有 push 路径在 addUpdate 前跑 \`detectAIVoice\` 评分:
- score >= 3 → 强拒 · 必须加 \`--force\`
- score == 2 → TTY 时 confirm
- score <= 1 → 通过

常见 AI 直出特征会命中:破折号 \`——\` · 中英混杂 · 内部代号 ("方案 A vs 方案 B") · 段首 emoji · 等号金句 · 中圆点滥用。

所以你帮用户起草时:
1. 优先走 \`tinker draft\` 让 Tinker 内置 LLM 用作者 voice 起草 · 再 \`tinker push <草稿>\` 推
2. 不要直接 \`tinker push -m "<你写的>"\` · 这条路最容易翻车
3. 被守门拦了不要立刻 \`--force\` · 看 hits 列表 · 真有问题就改 · 真没问题再 force

## 文案约束 (帮用户写 update / commit / docs 时)

- **纯中文** · 不中英混杂 · 技术黑话翻成中文 (\`一次性 token\` 不是 \`one-time token\`)
- **避免斜体** · 用户会专门清理 · 别新增
- **避免 AI 标点堆**:不堆中点 (\`·\`) · 不堆破折号 (\`——\`) · 用普通话口语化标点
- **工艺人日志气质**:不像 PM 周报 · 不像私人日记 · 像坐在工作台前边修边聊
- **voice fingerprint**:如果 \`.tinker/voice-fingerprint.md\` 存在 · 起草前读它对齐风格
- **拒绝商业黑话**:\`生态\` / \`赋能\` / \`抓手\` / \`闭环\` / \`底层逻辑\` / \`颗粒度\` / \`对齐\` / \`复盘\` 等别用
- **用"我"不用"我们"** · 用"人"不用"用户"
- **高频开头词**:\`今天 / 今晚 / 凌晨 / 早上\` · 90% 的 update 这么起手
- **结尾**:留 takeaway (下一步 / 学到了什么) · 不客套 (\`谢谢阅读\` / \`欢迎反馈\` 别出现)
- **技术名词全小写**:\`sqlite\` / \`json\` / \`https\` / \`api\` (不 ALL_CAPS)

## 关键概念词

- **update** (进展) · 项目下的核心 entity
- **method** (方法) · update 升格 · 别人能 borrow 复用的手艺
- **experience** (踩坑经验) · update 升格 · 别人撞到同样坑能学
- **learning** (上手指南) · update 升格 · 帮别人快速入门
- **decision** (决策推演) · update 升格 · 工具/方案选型留痕
- **project** · 一个项目下挂多条 update / method
- **borrow** · 搜别人的 method / experience / learning / decision

注意:\`tinker update\` 是**升级 CLI 自己** · 不是"记一笔进展"。记一笔是 \`tinker push -m '...'\`。

## 重要文件

- \`~/.tinker/config.json\` — server URL / handle / token / LLM key
- \`~/.tinker/prompt-state.json\` — 触发器冷却 / 静音 / pending 状态
- \`~/.tinker/inbox/\` — 收到的 handoff / invite / witness-request
- \`~/.tinker/outbox/\` — 自己发出的所有私信 (jsonl)
- \`.tinker/voice-fingerprint.md\` — 当前项目作者风格画像 (跟 repo)
- \`.tinker/repo.json\` — repo 跟 Tinker project 的绑定

## CLI 触发器系统 (你会看到 reminder 注入)

CLI 装了 Claude Code hook · 用户说收工 / 卡住 / 顿悟 / 决策 / 砍 / 完工类话时 · stdout reminder 注入你的 context。

看 reminder 时:
- 不是每次命中都按 reminder 建议用户 · 看上下文判断
- 用户在做产品讨论 / 命令测试 / 文档撰写时大概率不是真事件 · 别打扰
- reminder 里的"上下文判断"就是给你的提示 · 不要无脑跟着说"要不要记一笔"

## 跨 AI 用户 (Cursor / Aider / Continue / Cline 等)

Claude Code 的 UserPromptSubmit hook 不通用 · 这些 LLM 需要主动调:

\`\`\`bash
tinker maybe-check --text "<用户最近一条消息>" --json
\`\`\`

输出 \`{ ok: true, fired: [{ kind: "stuck", reminder: "..." }] }\` · 按 reminder 跟用户对话。

跟 Claude Code 路径**共享同一份 matcher 词典 + 同一份冷却** · 30/60 分钟内同 kind 不重复触发。

## handoff 接力 (你会看到 inbox reminder 注入)

工作室成员用 \`tinker handoff -m "..."\` 把当前现场打包加密发给队友。包含 situation / git diff / voice fingerprint / cwd。

落地后包是两类读者分层的:
- 顶层 \`BRIEF.md\` — 纯给人看的一句话卡片 · 决定接不接
- 顶层 \`README.md\` — 给 AI 的工作文档 · 指向 context/ 里的原料
- \`context/\` 子目录 — situation.json / diff.patch / voice-fingerprint.md 这些重料

接收方 Claude Code 启动时 SessionStart hook 跑 \`tinker bridge-check-inbox\` · 有未处理 task 注入 reminder。

看到时:
1. **先把那一句说明转告用户** · 别急着 cat README 或读 context/ 里的 diff · 那是用户决定接了才钻的重料 · 省上下文
2. 用户确认要接 → \`cat ~/.tinker/inbox/<id>/README.md\` 看 AI 工作文档
3. \`tinker inbox verify <id>\` 验包 (临时工作树重放 diff · 结果自动回执发起方)
4. 看 \`context/situation.json\` 了解发起方卡在哪 · 需要的话 \`git apply ~/.tinker/inbox/<id>/context/diff.patch\`
5. 学 \`context/voice-fingerprint.md\` 的口吻
6. 接着做 · 完了 \`tinker push -m "..."\` 把进展发回工作室
7. **回稿给原发起方**:\`tinker handoff reply <id> --by-claude\` 起草 · \`tinker handoff reply <id> publish "<content>"\` 落地
8. 跑 \`tinker inbox done <id>\` 标 task 关闭

**不要无脑接力**:跟用户确认是不是现在做 · reminder 是提示不是命令。

## handoff 触发 (matcher reminder)

用户说"接力 / 交接给猫猫 / 帮我打包给 / 这个给 X 接着做"时 · matcher 命中后注入 reminder · 让你**主动跑命令**:

1. 写一句 50-100 字 handoff 说明 · 气质参考 "X 做了一半 · 卡在 Y · 你接着 Z" · 不是产品发布会语气
2. 找接收方 handle (\`-t @xxx\`) · 没指定就走 active studio 广播
3. \`tinker handoff -m "<说明>" [-t @<handle>]\`
4. **handoff 一旦发出去对方就收到 · 没法撤回** · 不确定时先 print 命令让用户确认

判断"是不是真接力":用户在产品讨论 / 命令测试 / 文档撰写时单字"接"不算信号 · 别打扰。

## witness 决策推演

### 发起方 (用户说"帮我征求意见")

1. \`tinker witness draft --topic "X 要不要做" --by-claude\` 拿脚手架
2. 你按用户上下文写一段 (50-300 字 · 倾向 + nagging 的点 + 想征求什么角度)
3. \`tinker witness publish "<你写的>"\` 落地 + 广播到 active studio
4. 想让队友 AI 看到思考过程加 \`--with-context\` (自动抓最近 40 条 Claude 对话脱敏)

### 接收方 (SessionStart reminder)

启动时收到 "@xxx 想征求你对 Y 的意见":
1. 问用户 "要回吗?"
2. 同意 → \`tinker witness reply <updateId> --by-claude\` 拿原 witness + 任务
3. 用**主人的 voice fingerprint** 写 100-400 字 critique · 不是 LLM 通用风格
4. \`tinker witness reply <id> publish "<你写的>"\` 回过去

### 发起方收到 reply

1. \`tinker borrow <replyUpdateId>\` 拉详情
2. 复述 critique 核心 1-2 句 · 多回复就突出分歧点跟共识点
3. 用户决定 → \`tinker witness close <originalUpdateId> --decision "<final>"\` 落定

### 自己一个人也能跑 witness

\`tinker witness self --topic "X" --by-claude\` · 不发 bridge · CLI 拉作者近 90 天 update 按关键词筛 · 让你用 voice fingerprint 站在"过去三个月的我"视角写 critique。

## 工作室邀请 (invite reminder)

### 发起方 (用户说"邀请猫猫加入")

1. \`tinker studio list\` 看 active 工作室 slug
2. \`tinker studio invite <slug> @<handle>\`
3. 命令自动通过 bridge 投递通知 · 不用复制 token

### 接收方 (SessionStart reminder)

收到 "@daodao 邀请你加入 X 工作室":
1. 问用户是不是真加入 (确认 ta 认识发起方)
2. 同意 → \`tinker studio accept <token>\`
3. 之后 ping / send / handoff 自动走这工作室

## team-knowledge 踩坑摘要 reminder

队友跑 \`tinker team-knowledge digest --days 3\` 后会广播一条 noti。

看到时:
1. 问用户 "队友 X 整理了一份近 3 天踩坑摘要 · 要看吗?"
2. 同意 → \`tinker borrow <updateId>\` 拉详情 · 复述 1-2 句要点
3. **不要主动扫用户本地代码找类似模式** · 用户主动看才有意义

## post-commit hook 待处理 reminder

每次 git commit 后 · post-commit hook 跑 \`tinker check --from-hook --json\` 评估触发器 (clever-fix / tool-combo / ship / decision / ai-limit / ui-session 等) · 命中的 append 到 \`~/.tinker/pending-reminders.jsonl\`。

\`\`\`bash
tinker pending --json     # 列待处理 (JSON)
tinker pending            # 人可读
tinker pending --check    # 静默注入 · UserPromptSubmit hook 用
tinker pending --mark-handled <id>   # 标已处理
tinker pending --clear    # 全清
\`\`\`

Claude Code 装好 hook 后每次用户 prompt 都自动跑 \`pending --check\` 注入 context。其他 AI 应该在合适时机 (session 开头 / 用户问"今天怎么样" / commit 之后) 主动跑 \`pending --json\` 查。

**处理流程**:
1. 看 reminder 的 \`kind\` / \`msg\` / \`suggestion\` / \`choices\`
2. 看上下文判断是不是真值得提醒用户 (不是每次都提)
3. 决定提醒 → 建议用户跑对应命令
4. 处理完 → \`tinker pending --mark-handled <id>\`
${END_MARKER}
`;

module.exports = {
  BEGIN_MARKER,
  END_MARKER,
  TEMPLATE,
};

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
| 跑了个长任务 (大 build / agent 批量跑) · 用户可能已经走开 | 跑完 / 卡住时 `tinker notify -m "..."` 推到用户手机/桌面叫回 ta (用户配过目标才有用 · 没配静默跳过) |

**关键词命中只是候选** · 看上下文判断是不是真的事件 · 不每次都建议。误触发率高了用户会烦。

**调前先看状态**:`tinker state --json` 返回 `muted / cooldown / dismissedToday` · 这些为 true 时用户不想被打扰 · 别调 push/ship/stuck 这种动作类。

**幂等保险**:动作类支持 `--idempotency-key <uuid>` · 同 key 24h 内重复调直接返之前结果。重试 / hook 重复触发都不会写两次。

## 调 CLI 的协议约定

- 几乎所有命令支持 `--json` · 输出 `{ok: true, ...}` 成功 / `{ok: false, error, code}` 失败
- 完整 schema:`tinker schema --json`
- 完整 help:`tinker --help` (顶部有 AI agent 指南段)

## push 路径选择 (帮用户发 update 时这条优先)

CLI 有 voice 守门 · 所有 push 路径 (cmdPush / cmdPushFromDraft / cmdResolve push) 在 addUpdate 前都跑 `detectAIVoice`:

- score >= 3 → **强拒** · 必须加 `--force` 才发
- score == 2 → TTY 时 confirm · 非 TTY 警告但放过
- score <= 1 → 通过

常见 AI 直出特征会命中:破折号 `——` / 中英混杂 (空格隔开的"studio / handle" 也算) / 内部代号 ("选 X 不选 Y" / "方案 A vs 方案 B") / 段首 emoji / 等号金句 / 中圆点滥用。

**所以**:你帮用户起草 update 时:

1. **优先走 draft 路径** · `tinker draft` 让 Tinker 内置 LLM 用作者 voice fingerprint 起草 · 然后 `tinker push <草稿文件>` 推
2. **不要直接 `tinker push -m "<你写的一段>"`** · 这条路最容易翻车 · 即使你按 fingerprint 风格写也未必能过守门
3. **要 `tinker push -m` 的话** · 起草后跑一遍 `tinker maybe-check` 或者本地 `node -e 'require("./cli/lib/voice-check").detectAIVoice(...)'` 先自检
4. **被守门拦了不要立刻 `--force`** · 看 hits 列表 · 真有问题就回去改 · 真没问题再 `--force`

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

## handoff 接力 (你可能会看到 inbox reminder 注入)

Tinker 工作室成员可以用 `tinker handoff -m "..."` 把当前现场打包加密发给队友。包含:

- situation JSON (lifecycle / signals · 看作者怎么卡进来 / 怎么想的)
- git repo info + diff (已 unpushed + working tree 改动)
- 发起方的 voice fingerprint (接力回稿用同样的口吻)
- 发起方的 cwd

接收方 Claude Code 启动时 · SessionStart hook 跑 `tinker bridge-check-inbox` · 有未处理 task 就 stdout 注入 reminder:

```
收到 N 个未处理的 handoff 接力 · 队友把现场打包发过来了
  · msg-xxx · <一句话说明>
    cat ~/.tinker/inbox/msg-xxx/README.md 看完整接力说明
处理完跑 tinker inbox done <id> 标完工
```

看到 reminder 时:

1. `cat ~/.tinker/inbox/<id>/README.md` 看完整接力包说明
2. 看 `situation.json` 了解发起方卡在哪
3. 如果需要 · `git apply ~/.tinker/inbox/<id>/diff.patch` 拿到未推改动
4. 学 `voice-fingerprint.md` 的口吻 · 接力回稿用同样气质
5. 接着做 · 完了 `tinker push -m "..."` 把进展发回工作室
6. 跑 `tinker inbox done <id>` 标记 task 关闭 · 下次启动不再提醒

**不要无脑接力**:跟用户确认是不是现在做 · 是不是想接这个 task。reminder 是提示 · 不是命令。

## witness 触发 (集体决策推演的两端)

### 发起方场景 (用户说"帮我征求意见")

用户在对话里说"这个决策帮我发出去征求一下队友意见"等话时:

1. 跑 `tinker witness draft --topic "X 要不要做" --by-claude`
2. CLI 输出脚手架 (要求 50-300 字 / 你的倾向 / 你 nagging 的点 / 想征求什么角度)
3. 你按用户上下文写一段 · 工艺人气质 · 不堆 emoji 不堆破折号 不商业黑话
4. 跑 `tinker witness publish "<你写的>"`
5. 落地 + 广播到 active studio · 队友 AI 会异步看到

### 发起方 · 可选带"思考过程上下文" (v0.47)

如果用户在对话里跟你聊了不少这个决策的来回 · 想让队友 AI 也看到这个上下文 · 加 `--with-context`:

```bash
tinker witness publish "<content>" --with-context
```

CLI 会:
1. 抓你跟用户当前 Claude session 最近 40 条对话 (脱敏 sk-/tk-/Bearer/长 hex)
2. 给用户看 preview · 让他确认要不要带
3. 加密放进 bridge payload (server 看不到内容)
4. 接收方 SessionStart 拉到时 · 自动落地 `~/.tinker/inbox/witness-<id>/context.md`
5. 接收方 `tinker witness reply --by-claude` 时自动读 · 接收方 AI 拿到对话上下文

意义:不只是传"final 决策草稿"给队友 · 还传"你怎么想到的"过程
队友 AI 拿到上下文 · 写 critique 时能对准发起方真正 nagging 的点
比单看摘要信号量大几倍

### 接收方场景 (SessionStart hook 注入 witness-request reminder)

启动时 reminder 类似:
```
收到 1 个 witness 请求 · @daodao 想征求你的意见
  主题:"X 要不要做"
  tinker borrow <updateId> 看完整
  回 critique: tinker witness reply <updateId> --by-claude
```

处理流程:

1. 跟用户说一句:"队友 X 想征求你对 Y 的意见 · 要回吗?"
2. 用户同意 → Bash 跑 `tinker witness reply <updateId> --by-claude`
3. CLI 输出原 witness 内容 + 任务说明
4. 你看完原 witness · 用**你主人的 voice fingerprint** (`.tinker/voice-fingerprint.md`) 写 critique
5. 100-400 字 · 站在你最熟的角度 (架构 / UX / 性能 / 哲学)
6. 给具体观点 + 给为什么 · 不只是"我觉得行"
7. 决策权仍是原发起方 · 你提供视角 · 不替他决定
8. 跑 `tinker witness reply <id> publish "<你写的>"` 回过去

**重要 voice 约束**:
- critique 必须用你主人 voice · 不是 LLM 通用风格
- 读起来像你主人在替队友想这件事
- 比 GitHub PR review 更口语化 · 像工友说"我看这事 ..."

### 发起方收到 witness-reply 时

reminder 提示 "@X 对你那个 witness 写了 critique"

1. 跑 `tinker borrow <replyUpdateId>` 拉详情
2. 跟用户简短复述 critique 的核心 1-2 句
3. 如果有多个回复 · 综合复述 · 突出**分歧点跟共识点**
4. 用户决定怎么决策 · 跑 `tinker witness close <originalUpdateId> --decision "<final>"` 落定

## team-knowledge 触发 (你可能会看到队友发的踩坑摘要 reminder)

队友跑 `tinker team-knowledge digest --days 3` 后 · 会广播一条 noti 到工作室。SessionStart hook 或 UserPromptSubmit hook 触发的 bridge-check-inbox 会拉到 · stdout reminder 类似:

```
收到 1 条新通知 · 用户离开期间队友发的
  🔔 @队友: team-knowledge: 近 3 天踩坑摘要
    我整理了一份近 3 天修过的 bug 模式 · 在 X 项目下 · tinker borrow <id> 拉来看 · 看完检查自己代码有没有类似问题
```

看到这种 reminder 时:

1. 跟用户说一句:"队友 X 整理了一份近 3 天踩坑摘要 · 要看吗?"
2. 用户决定看 → Bash 跑 `tinker borrow <updateId>` 拉详情
3. 拉到后简短复述 1-2 句要点 · 让用户决定是不是真的需要细看
4. **不要主动扫用户本地代码找"类似模式"** · 这是缓和版 · 不是自动检测 · 用户主动看才有意义
5. 用户对照完代码 · 决定改不改 · 不是你说改就改

**判断"是不是真要看"**:
- 用户在做完全无关的工作 (写文案 / 改 CSS 等) · 跳过别打扰
- 用户在做相关领域 (调 API / 改后端等) · 提一句让他选

## handoff 触发 (你可能会看到 handoff matcher 触发的 reminder)

用户在对话里说"接力 / 交接给猫猫 / 帮我打包给 / 这个给 X 接着做" 等话时 · UserPromptSubmit hook 跑 `tinker maybe-handoff` · 命中后 stdout 注入 reminder 到你的 context。

跟其他 maybe-X 不同 · handoff reminder 让你**主动跑命令** 而不是只提醒:

1. 看对话上下文 · 写一句 50-100 字的 handoff 说明
   - 气质参考: "X 做了一半 · 卡在 Y · 你接着 Z"
   - 不是产品发布会语气 · 不堆 emoji / 不堆破折号
   - 跟 push 的 voice 一致
2. 找接收方 handle
   - 从对话里看 (比如"给猫猫" → `-t @maomao`)
   - 没指定就走 active studio 广播 (不带 `-t`)
3. Bash 跑 `tinker handoff -m "<你写的>" [-t @<handle>]`
4. 命令输出给用户看 · 让用户确认是否真的发了
   - **handoff 一旦发出去对方就收到 · 没法撤回**
   - 用户不确定时 · 先把你打算跑的命令 print 出来让他看 · 同意了再跑

判断"是不是真要接力" 看上下文:用户在做产品讨论 / 命令测试 / 文档撰写 · 单字"接"不算 handoff 信号 · 别打扰。

## 工作室邀请 (你可能会看到 invite reminder)

### 发起方场景 (用户说"邀请猫猫加入")

用户在对话里说"邀请猫猫加入 / 拉猫猫进来 / 加猫猫进工作室" 等话时 · UserPromptSubmit hook 跑 `tinker maybe-invite` · 命中后 stdout 注入 reminder。

跟其他 maybe-X 不同 · invite 让你主动跑命令:

1. 找工作室 slug · 跑 `tinker studio list` 看用户哪个 active · 用 active 的 slug
2. 找目标 handle · 从对话里看 (比如"邀请猫猫" → `@猫猫`)
3. Bash 跑 `tinker studio invite <slug> @<handle>`
4. 命令会**自动通过 bridge 投递邀请通知**给对方 · 你不需要复制 token 微信发
5. 报告用户已发 · 对方 watch 上会自动收到 · 下次起 Claude session SessionStart hook 提示她一键加入

### 接收方场景 (SessionStart hook 注入 invite reminder)

你启动时 SessionStart hook 跑 `tinker bridge-check-inbox` · 如果收到工作室邀请 · stdout reminder 类似:

```
收到 N 个工作室邀请
  · @daodao 邀请你加入 捣鼓团队
    一键加入: tinker studio accept <token>
如果用户确认要加入: Bash 跑 tinker studio accept <token>
```

处理流程:

1. 跟用户确认是不是要加入这个工作室 (问一句 · 不要直接跑)
2. 用户同意 · Bash 跑 `tinker studio accept <token>`
3. 命令成功后报告:工作室名 / 本地暗号已写 / 之后 bridge 通信通了
4. 之后用户的所有 ping / send / handoff 都自动走这个工作室

**不要无脑 accept**:这是入会动作 · 之后所有暗号都共享 · 跟用户确认 ta 真的认识发起方 + 真想加入。

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

# Tinker · CLI 与 voice 架构

写给接手维护 Tinker 的 AI 看的内部架构文档。跟 [07-tinker-with-ai.md](07-tinker-with-ai.md) 不同：07 是给"想用 AI 操作 Tinker"的用户看的接入指南，08 是给"维护 Tinker 本身"的 AI 看的设计哲学。

## 1. 一个反直觉的判断

Tinker 的目标用户**可能连 Claude Code 都没装**。但 Tinker 的 CLI 系统又做得越来越深。这不矛盾，因为 CLI 不是用户入口，是 AI 入口。

把这件事想清楚之前，你看 Tinker 会困惑：webapp 已经覆盖了所有功能，为什么还要花大力气做 CLI？答案是 CLI 的三个角色：

- **AI agent 代用户操作 Tinker 的协议**。普通用户不会装 `tinker` CLI，但 Claude Code、Cursor 这种 AI agent 会。用户在 AI 里聊代码，AI 在背后帮他记一笔。
- **作者自己 dogfood 的通道**。alpha 期只有两个真实用户，CLI 让 daodao 成为自己产品的第一用户。
- **commit 那十几秒沉淀时机的唯一捕手**。webapp 抓不到这个瞬间，等用户切到浏览器时想法已经凉了。

记住这一条：**CLI 是 AI 接入层，不是用户入口**。你看到 CLI 用户数始终上不去也别意外，那不是失败，是因为真实使用者是 AI agent，不会出现在用户数统计里。

## 2. 触发器系统现状

CLI hook 在每次 `git commit` 后自动跑 `tinker check` 评估触发器，识别"对社区有沉淀价值的瞬间"。设计转向是从"识别 commit 写了什么模式"换成"识别哪些瞬间值得记"。

23 个触发器按 priority 分布：

```
priority 101  frustrated         破防情绪
priority 100  ship/stuck/prototype  仪式
priority 95   breakthrough        顿悟
priority 92   ai-debug-breakthrough  AI 折腾几小时破局 (跨上下文)
priority 90   clever-fix          巧妙修复 (fix + body 长 + diff 小)
priority 85   decision           工具链选型
              subtraction        减法决策
              ai-limit           AI 边界经验
              reversal           撤回的勇气
priority 80   fix                修好 (兜底)
              restart            放弃后回归
              tool-combo         工具组合发现
priority 75   brand              提到 Tinker
              ui-session         UI 改一波收尾
              cross-project      跨项目借鉴
              test-verify        测试/验证
priority 70   tinker             在玩
              discovery          发现/学到
              naming             命名/重命名
priority 65   long-body          作者花时间写
priority 60   first-commit       早安
priority 50   silence            22h 没发
priority 30   cumulative         60min ≥ 3 commit
```

每个触发器实现在 `cli/bin/tinker.js` 的 `triggerXxx()` 函数里，`evaluateAllTriggers()` 跑所有 trigger 选 priority 最高的命中。

新加触发器的判断：这个瞬间对社区有沉淀价值吗？三类瞬间值得加触发器：
- 别人撞到同样坑能学的（巧妙修复）
- 跟工程师习惯反着来的（减法、撤回）
- vibe coder 特有的（AI 边界、工具组合）

不要加只有作者自己关心的瞬间（比如"我升级了 node 版本"），加进去只会让 prompt 频率上升、用户屏蔽。

## 3. voice 系统四阶段

voice 系统从"硬规则集合"演进到"作者真实表达的镜子"。核心立场是：**voice 不该是预设规则，应该是作者真实表达的镜子**。

数据驱动的四阶段闭环（v0.4-v0.9 完成）：

```
Phase 1 收集   savePoolSample
              每次 tinker resolve push 成功后
              把 text 存到 ~/.tinker/style-pool/good/

Phase 2 分析   cmdVoiceAnalyze
              tinker voice analyze 读 pool
              调 LLM 总结 fingerprint
              输出到 .tinker/voice-fingerprint.md

Phase 3 起草   cmdDraft 改造
              prompt 注入 fingerprint + 3 篇 good sample
              + 2 篇 reject-diff
              LLM mimic 真实样本而不是按规则避雷

Phase 4 反馈   saveRejectDiffIfChanged
              cmdResolve 比较 LLM 草稿 vs 作者改后版本
              不同则 save 到 reject-diff/
              pool 越积越准
```

加速 pool 累积有专门命令：
- `tinker voice teach --from-claude`：从 ~/.claude/projects/ 提取你的 user message 当 sample
- `tinker voice teach --file <path>`：从文件读 sample

为什么这么做：alpha 期 sample pool 累积慢（没几条真实 update），数据稀薄时 fingerprint 不准。让用户主动喂自己跟 AI 对话历史，几百条 sample 立刻就位。

## 4. AI 协作硬规则

这几天 dogfood 学到的规则。任何 AI（包括你）接手 Tinker 时都该遵守：

**不替作者编情绪。** "咯噔一下"、"卡得厉害"、"突然意识到"、"服气" 这种内心活动，如果作者没在 commit 里说过，AI 不该硬猜。voice 系统 DEFAULT_VOICE 第 10 条明确禁止。

**不替作者下产品定论。** "X 的真正价值是 Y"、"主战场转向 Z"、"用户其实是 W"这种立场宣告，AI 没作者视角不该编。voice 系统 DEFAULT_VOICE 第 11 条明确禁止。这一条专门拦住一次具体事故：LLM 起草草稿时把"CLI 用户优先级抬到 UI 前面"写出来，跟 Tinker 实际立场完全相反。

**AI 没作者视角，让它替你想会走偏，让它替你整理可以。** 这是一条 transferable 规则。LLM 起草草稿时本质上是替作者想，必然走偏。改成"作者说一句话，AI 帮整理"模式才合理。

**sanitize 只删不补，不替作者编，宁可空着也不填。** sanitizeDraft 函数 (cli/bin/tinker.js) 只清掉表层 tell（em-dash、堆中圆点），不擅自重写句子。

## 5. 能力地图 (v0.12 快照)

这一节是 "我能干什么" 全景图。接手者读完应该知道当前盘子有多大，不用再翻代码确认。

### CLI

写入 (核心动作):
- `tinker push -m "..."` 一笔进展直接发
- `tinker push <file.md>` 从草稿文件发布，`--only=1,3` 选发某几条
- `tinker stuck -m "..."` 标卡住并通知关心你的人
- `tinker ship -m "..."` 完工，默认自动抓 productLink 截图当封面
- `tinker ship --feedback-ask "..." / --image ./shot.png / --no-feedback` 完工细化
- 所有写入命令支持 `--idem-key` 客户端幂等，24h 缓存 (AI 重试不会重复发)

主动 prompt (git hook 触发):
- `tinker hook install` 装 git post-commit hook，5 类触发器同时跑
- `tinker check` 手动跑一次评估，`tinker check --json --from-hook` AI 友好
- `tinker resolve <choice> -m "..."` 响应 pending prompt
- `tinker mute 1h / today / forever / off` 静音

起草 (LLM):
- `tinker draft` 让 LLM 看 git 历史起草 1-3 条候选到 `.tinker/drafts/`
- `tinker draft --since 30m` 自定义时间窗
- 起草全过 voice fingerprint + sanitizeDraft

voice (写作风格):
- `tinker voice analyze` 用 pool 样本生成 fingerprint
- `tinker voice teach --from-claude` 抽 Claude Code 对话样本
- `tinker voice teach --file <path>` 从文件读单篇
- `tinker voice teach --review` 逐条 y/n/skip 自监督 (good 池 / bad 池 / 跳过)

收尾:
- `tinker goodnight` 今日总结 (commits / Tinker push / Claude Code token / 方法被借次数)
- `tinker goodnight --week / --month` 周月报
- `tinker goodnight --narrate` 让 LLM 替你说一句

方法库:
- `tinker borrow "<关键词>"` 全文搜方法，作者标方法的排前
- `tinker borrow --methods-only --limit N` 过滤
- `tinker contribute [updateId]` 标自己一条为方法，默认拿最近一条
- `tinker contribute --unmark <id>` 取消标
- 搜索自动带 handle，作者会在自己 goodnight 看到被借次数 (借用反馈闭环)

读 (CLI 也能看):
- `tinker recent [--limit N] [--kind experience]` 读最近的 update
- `tinker mark-experience <updateId>` 标踩坑经验 (给 AI 检索池埋种子)
- `tinker projects` / `tinker ls` 列我的项目

AI 自省 / 配置:
- `tinker login` 交互配 server + token + LLM
- `tinker config` 查看 / 改配置
- `tinker state [--json]` 读 prompt-state 快照 (mute / cooldown / dismissed / uiSession)
- `tinker schema [--json]` CLI 自身能力 schema，给 AI 看
- `tinker session status / end` 看 UI session
- `tinker llm usage` LLM token 用量
- `TINKER_TOKEN / TINKER_SERVER / TINKER_HANDLE` 三个 env 变量都支持

其他:
- `tinker update` 拉最新代码 + 重装
- `tinker mcp` 启 MCP server (stdio)
- 几乎所有命令支持 `--json`，错误统一 `{ ok: false, error, code }` 形态

### MCP server

13 个 tool (任何 MCP 兼容 agent 即开即用):

查询类:
- `tinker_list_projects` 列我的项目
- `tinker_get_state` 读 prompt-state 快照
- `tinker_today_summary` 今日 commit / push / token
- `tinker_check_triggers` 评估当前 repo 触发器
- `tinker_get_config` 看配置 (token 只露后 4 位)
- `tinker_borrow` 搜方法库 (自动带 handle)
- `tinker_recent_updates` 读最近的 update

动作类:
- `tinker_push / tinker_ship / tinker_prototype / tinker_stuck` 写入族 (都支持 idempotency_key)
- `tinker_contribute` 标方法
- `tinker_mark_experience` 标踩坑经验
- `tinker_mute` 静音
- `tinker_resolve_pending` 响应 pending prompt

2 个 resource + 订阅推送:
- `tinker://triggers/active` prompt-state 快照，5s 轮询加文件 watch
- `tinker://state/today` 今日 git commit + Tinker push 计数
- 内容 diff 之后才发 `notifications/resources/updated`
- subscribe / unsubscribe handler 完整

### 反馈闭环

- `borrow_log` 表带 24h 去重 + 自借跳过
- `GET /api/method/borrows-for-me?days=N` 给作者拉被借列表
- `tinker goodnight` 显示 "你的方法被借 X 次" 段，0 次完全沉默不显示压力
- webapp 端 update 卡片渲染 `✿ 方法` 苔色角标
- 作者在自己 update 上能点 "标方法 / 取消方法标"

### 当前阶段定位

按路线图四层:
- P0 proactive prompt 框架: 5 类触发器全做完
- P1 LLM 起草链路: DeepSeek 接通 + voice fingerprint 校验
- P2 方法库: 搜索 + 标记 + 反馈闭环全闭合
- P3 编辑器扩展: MCP 已经让任何 MCP 兼容 agent 直接当 first-class tool 用，省掉自己写 VS Code / Cursor extension 那条路

CLI 已经覆盖了 "写进展 / 看进展 / 起草 / 主动陪伴 / 收尾 / 借方法 / 跟 AI 协作" 全链路。webapp 那边读和社交还在路上，但写归 CLI 的分工很清晰。

## 6. 已做与未做

已做（按时间）：

```
v0.1       12 个触发器
v0.2       触发机制 5 处优化 + decision 触发器
v0.3       --json mode + tinker resolve (AI 接入层完整)
v0.4       voice fingerprint Phase 1+2 (收集 + 分析)
v0.5       voice fingerprint Phase 3+4 (few-shot 起草 + 反馈循环)
v0.6       三个高价值瞬间触发器 (clever-fix / subtraction / ai-limit)
v0.7       又七个高价值瞬间触发器 (restart / tool-combo / cross-project
            / long-body / test-verify / naming / reversal)
v0.8       goodnight 命令 + Claude Code token 追踪
v0.9       tinker voice teach --from-claude
v0.10      MCP server (first-class AI agent 集成) + TINKER_TOKEN env
v0.11      跨 repo drift 触发器 + AI agent 幂等性
v0.12      四件套同时进:
           - ai-debug-breakthrough 跨上下文触发器
             扫 ~/.claude/projects/ 最近 6h jsonl
             长对话 + 挣扎信号 + 破局信号 + fix 小修复 联合判断
             这是第一个不只看 commit 的触发器
           - tinker recent [--limit N] [--kind experience|...]
             CLI 第一次能"读" Tinker (之前只能写)
           - tinker mark-experience <updateId>
             把 update 标为踩坑经验 · 是给 AI 检索池埋的种子
             migration 010 加 is_experience 字段 + 索引
             跟 v009 的 is_method 同构 · 但语义不同 (method 给人类 borrow · experience 给 AI 检索)
           - tinker push 发完打印项目页 URL + update id
             webapp hash routing 限制 · 没法深链到具体 update · 但项目页打开最新一条就在顶
           - MCP 加 tinker_recent_updates + tinker_mark_experience
             AI agent 通过 MCP 现在能读 Tinker 内容了

v0.12+     CLI/MCP 全面 AI 友好化 + 方法库闭环:
           - --json 模式全面化 (state / schema / config / session / llm / goodnight / push)
             错误统一 errJson shape: { ok: false, error, code }
           - TINKER_TOKEN / TINKER_SERVER / TINKER_HANDLE env 三件套
             CI / headless agent 不需要 tinker login 也能跑
           - tinker state · tinker schema · AI 自省命令
             读 prompt-state.json + CLI 能力 schema
           - 客户端幂等 (~/.tinker/idem-cache.json · 24h TTL)
             push / ship / stuck / prototype 都接受 --idem-key · AI 重试安全
           - tinker goodnight --week / --month 周月报
             daysBack 通透到 git + Tinker + Claude Code 三个数据源
           - tinker voice teach --review 交互式 y/n/skip
             好的进 good/ 不好的进 bad/ · 反馈闭环驱动 fingerprint
             --from-claude --review 也支持
           - 方法库 (P2 收尾):
             migration 009 · is_method + FTS5 trigram 虚拟表
             短 CJK (邮箱 之类 2 字) 走 LIKE 兜底
             tinker borrow / tinker contribute / --unmark
             GET /api/method/search (公开 · 自动从 session 拿 borrower)
           - MCP 资源 + 订阅 (推送通知)
             tinker_borrow / tinker_contribute 两个 tool
             tinker://triggers/active + tinker://state/today 两个 resource
             5s 轮询 + prompt-state.json 文件 watch
             内容 diff 才推 notifications/resources/updated
           - 借用反馈闭环 (migration 012 · v0.12 收官):
             borrow_log 表 + 24h dedupe + 自借跳过
             GET /api/method/borrows-for-me?days=N
             tinker goodnight 加 "你的方法被借 X 次" 段 (0 次沉默)
             webapp update 卡片渲染 ✿ 方法 苔色角标
             作者可在卡片上点 "标方法 / 取消方法标"
             state.js 给 update 对象补 isMethod
```

未做（路线图）：

**voice.local.md** 用户级 whitelist。允许作者自加"允许的 emotional_words / ALL_CAPS 词"，解决硬规则误伤合理表达的问题。比如 "AI agent" 这种常用技术名词不该被 ALL_CAPS 规则一刀切。

**捕捉无关键词的高价值瞬间。** 22 个 keyword 触发器加 1 个跨上下文触发器（v0.10 ai-debug-breakthrough）。剩下的信号源：
- 时间脉络异常（commit 间隔突变）
- diff 拓扑信号（跨多模块、同文件高频）
- 反复无功命中（连续 10 个 wip commit）
- 心率信号（amend 次数、push 后 reset 重写）

跨上下文信号（Claude Code 对话 + git log 联合）是 Tinker 最有特色的方向。v0.10 ai-debug-breakthrough 是这个方向的第一个落地：扫 ~/.claude/projects/ 最近 6 小时 jsonl · 检测"长对话 + 挣扎 + 破局 + commit 是 fix + diff 小"五信号联合。别的 dev tool 抓不到 AI 对话上下文 · Tinker 因为 voice teach 已经在用这个数据源 · 触发器复用同一源很自然。

未来可以扩展的方向：
- ai-debug-breakthrough 起草草稿时把对话脉络喂给 LLM（B 层 · v0.13 计划）
- ai-debug-breakthrough 触发出来的 update 默认勾选 is_experience（C 层后半 · v0.13/v0.14 计划）
- 开放 GET /api/tinker/experiences endpoint · 让其他用户的 AI 也能检索（v0.14+）
  当前 /api/me/updates?kind=experience 只能自己读自己的 · 跨用户检索是下一步

C 层种子: server/scripts/mark-aliyun-experience.js 是第一颗。其他 ai-debug-breakthrough 自动触发的 update 会陆续加进来。pool 厚了再开放跨用户 endpoint 才有意义。

**score 累积模型** 替代单一触发器命中即 prompt 的逻辑。多个弱信号叠加超阈值就触发，比单一关键词更准。

**Phase 5+ LLM 价值判断**。等 sample pool 厚了（10+ 篇），让 LLM 看 commit + diff 跟 fingerprint 对比，判断"这条 commit 像作者过去发过的值得记的吗"。成本高，alpha 期不做。

## 7. 给未来 AI 的接手指南

你接手 Tinker 时，先读这几条 memory：

- `project_tinker.md` 项目根
- `project_tinker_audience_skill_floor.md` 用户技能下限
- `project_tinker_desktop_primary.md` 桌面优先
- `project_tinker_skill_not_prompt.md` 方法 > 提示词
- `project_tinker_cli_as_core.md` CLI 战略性优先
- `project_tinker_cli_voice_fingerprint.md` voice 系统状态
- `project_tinker_cli_value_triggers.md` 触发器系统状态

改东西之前先想：

- 这是给 webapp 用户的功能，还是给 AI agent 用的协议？两种用户的设计权衡完全不同
- 涉及 update 文案生成时，先看 voice 系统 DEFAULT_VOICE，特别是硬规则 1-11
- 加触发器之前，问"这个瞬间对社区有沉淀价值吗"，不只问"commit 里有 X 关键词吗"
- 改 webapp UI 时，看 build badge 当前 v 号，patch 段格式跟 v0.X CSS 注释保持一致

记住这条：**Tinker 反算法、反 trending、反数据游戏**。任何"加点赞 / 加排行 / 加推荐"的提议，先问是不是符合产品哲学。可以加的是真实复用反馈（接走、用了方法）、真实仪式（完工、卡住），不能加的是浏览量、关注数、热度排序。

## 8. 一条 takeaway

整个 CLI + voice 系统的设计有一条主线可以 transfer：**让数据自然累积比堆预设规则更可持续**。

触发器系统加 22 个关键词模式只是开局，真正能让 Tinker 自适应每个 vibe coder 风格的是 voice 系统的四阶段闭环。规则总有边界、总会误伤，数据驱动的镜子能自然贴近每个作者的真实表达。

这条思路 transferable 到任何 AI 跟人类协作的产品：能不能让 AI 学作者真实样本，比能不能定一套写作规则重要。

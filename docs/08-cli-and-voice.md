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

22 个触发器按 priority 分布：

```
priority 101  frustrated         破防情绪
priority 100  ship/stuck/prototype  仪式
priority 95   breakthrough        顿悟
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

## 5. 已做与未做

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
```

未做（路线图）：

**voice.local.md** 用户级 whitelist。允许作者自加"允许的 emotional_words / ALL_CAPS 词"，解决硬规则误伤合理表达的问题。比如 "AI agent" 这种常用技术名词不该被 ALL_CAPS 规则一刀切。

**捕捉无关键词的高价值瞬间。** 当前 22 个触发器都基于关键词加简单 stat。真正有沉淀价值的瞬间不一定有关键词。可以挖的信号源：
- 时间脉络异常（commit 间隔突变）
- diff 拓扑信号（跨多模块、同文件高频）
- 跨上下文信号（Claude Code 对话 + git log 联合）
- 反复无功命中（连续 10 个 wip commit）
- 心率信号（amend 次数、push 后 reset 重写）

最有 Tinker 特色的是**跨上下文信号**。别的 dev tool 抓不到 AI 对话上下文，只有 Tinker 这种"webapp + CLI + 跟 Claude Code 数据连通"的产品能做到。`tinker voice teach --from-claude` 已经在用这个数据源，触发器可以扩展用同一源。

**score 累积模型** 替代单一触发器命中即 prompt 的逻辑。多个弱信号叠加超阈值就触发，比单一关键词更准。

**Phase 5+ LLM 价值判断**。等 sample pool 厚了（10+ 篇），让 LLM 看 commit + diff 跟 fingerprint 对比，判断"这条 commit 像作者过去发过的值得记的吗"。成本高，alpha 期不做。

## 6. 给未来 AI 的接手指南

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

## 7. 一条 takeaway

整个 CLI + voice 系统的设计有一条主线可以 transfer：**让数据自然累积比堆预设规则更可持续**。

触发器系统加 22 个关键词模式只是开局，真正能让 Tinker 自适应每个 vibe coder 风格的是 voice 系统的四阶段闭环。规则总有边界、总会误伤，数据驱动的镜子能自然贴近每个作者的真实表达。

这条思路 transferable 到任何 AI 跟人类协作的产品：能不能让 AI 学作者真实样本，比能不能定一套写作规则重要。

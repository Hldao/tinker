# Changelog

格式: [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)
版本: SemVer · alpha 期 0.x.x

---

## 版本号约定 (2026-06-06 起)

**主版本号**: 整个产品 milestone
- `0.x.x` alpha 阶段 (现在)
- `0.x.0` minor 升级 = 一个 milestone 完成 (比如 0.4 反馈闭环 / 0.5 UI 体系化)
- `0.x.y` patch = 主线合并时 +1
- `1.0.0` 正式上线

**子工作流** (内部使用): 两条/多条 work stream 并行时用，避免主版本号竞争
- `ui.N` · 设计 / CSS 工作流 (我们这条线)
- `feat.N` · 用户能感知的新功能
- `be.N` · 后端 / 基础设施
- `docs.N` · spec / 文档
- 合并到 main 时这些子流的累积体现为主版本号 patch +1

**git commit message 约定**:
```
[ui]       视觉 / CSS 改动
[feat]     用户能感知的新功能
[be]       后端实现 / 数据库 / API
[docs]     spec / CHANGELOG / README
[fix]      bug 修复
[refactor] 不改行为的代码重构
[test]     测试相关
[infra]    部署 / docker / CI
```

**分支约定**:
- `main` → 生产 (公网 alpha 部署)
- `ui/*` → UI 工作流分支
- `feat/*` / `be/*` → 功能 / 后端工作流分支
- 各分支自治推进 · 合并到 main 时主版本号升 patch

---

## [Unreleased] / 0.5.x · UI 体系化打磨 (进行中)

> Owner: 设计线 (ui.N)
> 进展: webapp/index.html 累积 v0.27 → v0.58 共 34 个子段
> 风格基准: 工艺人日志 / 报纸刊头 / vermilion + cream paper + Newsreader + Fraunces
> Build badge: webapp 右下角小角标 `ui · v0.58` (hover 显示完整 patch 历史)

### [bridge] handoff 闭环 + 传输分层 (v0.52 → v0.55)
> Owner: bridge 线
- **v0.52** 送达回执 / 退信 · 接收方拆包时自动回发起方一条 noti (拆开了 / 拆失败退信) · 发起方下次起 session 看到包到没到 · 不用干等。深验命令 `tinker inbox verify <id>` 在临时工作树上重放 diff (不碰当前工作树) · 验完自动回执 · 验不过退信
- **v0.53** handoff 包两类读者分层 · 顶层 `BRIEF.md` 给人扫一眼决定接不接 · `README.md` 是 AI 工作文档 · 重料全收进 `context/` 子目录 · SessionStart reminder 提示"别急着读 diff · 接了再钻" · 省接收方上下文。回执 body 也改人话 · sha/字节这些机器细节挪进 facts 字段
- **v0.54** 压缩信封 · handoff payload gzip 后再加密 · git diff 普遍压到两三成 · 信封带 4 字节 magic + flags 版本位区分新老 · 老消息走老路不动。修了一个 diff 截断误判 (includes 嗅字符串会自匹配源码 · 改成打包时记 diffTruncated 标志位)
- **v0.55** 拆信封懒取 (Phase 2) · bridge task 只发轻信封 (说明 + repo + blobRef) · 重料 (diff/situation/voice) 加密压缩后存 server blob 库 · 接收方点了"接"才 `tinker inbox fetch` / `verify` 拉回来 · 53kb 包压成 463 字节轻信封上线。blob 按 sha256(明文) 内容寻址 + studio 命名空间 · 同工作室内容相同自动去重。server 加 `bridge_blobs` 表 (migration 060) + `/api/bridge/blob` 存取路由 · 沿用 messages 那套"只存密文不解密"

### [methods] 方法库领域轴 (v0.85)
> Owner: bridge 线 · 来自朋友反馈
- **v0.85.2** borrow 接上领域 (AI 那半 · 之前领域只给人看 · AI 借的时候瞎)。FTS 索引揉进 tags · searchMethods 返回 discipline + tags 字段 (让 AI 判断方法合不合适当前任务) · `tinker borrow --discipline 设计` 按领域筛 · LIKE 兜底也查 tags 让 2 字领域词 (trigram 匹配不了) 也能自由搜命中。**顺手修了个真·线上老 bug**: borrow_log.update_id NOT NULL (012 建表) 没跟上 methods 迁出 updates (019) · 登录用户第一次借"别人的"方法 → 写日志 update_id=null 违反约束 → searchMethods 崩 → 接口 400。跨人借方法 (方法库最核心场景) 一直是坏的 · 只因借自己的/24h 重复借会绕过才没在 2-3 人内测暴露。migration 070 让 update_id 可空 + 借阅日志整段包 try/catch (日志尽力而为 · 绝不拖垮搜索)
- **v0.85** 给方法库加一条"按手艺领域"的轴（产品 / 设计 / 数据与安全 / 工程 / AI协作），跟现有自由 tag（#supabase #auth · "用什么"）互补，这条是"哪门手艺 · 适合哪个阶段"。服务端 createMethod 用关键词分类器自动猜一个领域 tag（命中 ≥ 2 才打 · 没把握不硬塞 · 人随时可改），固定词表不漂，让"所有 ui 类方法"能被可靠捞出来。关键词以中文为主，英文只收长且不撞词的（短英文 ui/ci 会在 guide/decision 里子串误命中，不收）。网页方法库加一行领域快筛，点一下走现有 #tag 精确过滤。`backfillDisciplines` action 给存量方法补一次。应用 §12：这跟当初砍掉的"按工具筛选"不一样，领域不是工具轴，且帮不懂代码的人绕开工程类，跟"不懂代码优先"一头，正好压在假设 2（人能不能找到对的方法）上

### [cli] 触发器 / 发布路径打磨 (v0.56 → v0.57)
> Owner: bridge 线
- **v0.57** 截图后端可换 · microlink Pro 要 $50/月 (两人小工作室太贵) · 抽出 captureScreenshotToFile 统一三个调用点 (ship 封面 / before / after) · 默认还是 microlink 免费档 (50/天 · 无 key 不破坏现状) · 配了 key 走 apiflash 或 screenshotone (都直接返图字节 · 免费档更宽)。新命令 `tinker screenshot <provider> <key>` 设置 · `tinker screenshot test` 验 key 通不通 · `tinker config` 显示当前后端 · 支持 TINKER_SHOT_KEY/PROVIDER env 覆盖 (watcher 子进程也能拿到)
- **v0.56** AI 模式 ui-push 接上 before/after 对比图 · deploy watcher 本就是 detached 后台进程 · 不要 TTY · 原"alpha 不支持"只是保守。截图省着用: before 在 UI session 开始时已抓 (复用) · resolve 时只多 1 次 after 抓取 · 跟交互模式同成本 (microlink 免费档约 50 次/天 · 心里有数)。顺手补两个一致性: ui-push 走 voice 守门 (之前漏了) + 要求 `-m` 文本; `tinker push <草稿>` 认 `--yes` 跳确认 (跟 experience 草稿路径对齐 · 给 AI / 非交互场景用)

### [ui] 累积 patch 段 (CSS-only 优先)
- **v0.27** 节奏放松基底 (PACED) · 已 collapse 入 v0.28
- **v0.28** 收一档 + 4 处精度细节 (TIGHTENED) · 行高 1.7→1.6 · 圆点 hover · prompt-box hover · tabular-nums
- **v0.29** 4 块全局/页面级 (EXTENDED) · 表单 pills 统一 · modal 通用打磨 · 关于页 · 入场仪式
- **v0.29.1** 箭头乱用整改 · 删 "↑ 你也来" / "做了延伸版 →" / 面包屑 ← / 接走方向 → 退色
- **v0.30** 中文 italic 大清洗 · 17 处副文字 + 6 处动作引导转链接气质 · 5 处保留引文 italic
- **v0.31** 夜班 28 块深度修复 + markup 4 处减法 · 删 dev 按钮 / 空态卡片 / status amber 统一 / ESC hint
- **v0.31.1** 小屏 + 收尾 · 720px / 480px 响应式 · 项目页 status dot
- **v0.32** 借鉴朋友周报 5 块 · eyebrow thin bar / dot+halo / status tag tint / body 光晕颗粒 / 关于页首字下沉
- **v0.32.1** 视觉强度提升 · chip 加边 + wash 加深 · 颗粒 0.03→0.05
- **v0.33** 关于页只保留第二段下沉 + 主屏加 eyebrow `Dispatches · 今日工房` + entry-time Fraunces 强化 + filter wash 背景
- **v0.34** feed/workshop 按日 group + 小日历 (.day-label · 同日 ≥ 2 条触发) · 配套 JS 改动: renderFeed + renderWorkshop
- **v0.35** day-label 改横向 separator · 避免跟 entry-time 两条平行时间锚点
- **v0.36** day-label 嵌入 entry left column · 学 Day One 时间轴 column 设计
- **v0.37** day-label 退化为换天 separator · 跳过"第一个今天" label (masthead 已有日期)
- **v0.38** 去掉"昨天/前天"字样 · 纯日历元素 · 用户洞察: 精确日期 = 历史感 + 成就感
- **v0.39** 撕日历卡片 · 大胆方向 (太大被撤销) · markup 改造 + 诗意化注解
- **v0.40** 主从重构 · 撤销 v0.39 卡片 · 主日历视觉锚点转移到 masthead-date · feed day-label 简化为横向 inline
- **v0.41** 颜色对换实验 · 深色 masthead + cream main · 反差太重被撤销
- **v0.42-v0.44** 温和 cream/paper 对换迭代 · 最终: main = cream (用户喜欢) · masthead = paper 偏粉做区分
- **v0.45** 冷静米白 · 日系配色 · main #faf8f3 → #f7f5ef (R=G 接近 · 不偏粉) · body 光晕降一档 · 装饰大字 vermilion 深一档
- **v0.46** main 加一点黄 · #f7f5ef → #f8f5ec (R-B=8→12)
- **v0.47** masthead 回原 cream · 只动 main · 反向对比 (顶部 #faf8f3 浅 · main #f8f5ec 微暖一档"实")
- **v0.48** masthead 减项分层 · nav 6 项 → 主 3 + 副 2 · `+ 记一笔` 独立 CTA 浮起 · tagline 沉副行 · 删 ⌘K kbd
- **v0.49** dateline 卷期号化 · `卷一 · 第 NNN 期` 从 2026-06-05 epoch 累积 · 报纸 masthead 仪式感落地 · secondary nav 沉到最底
- **v0.49.1** secondary nav 加重修复 · sepia-light → sepia · 字号 11.5→12.5 · 加常态 dotted underline 暗示"参见"
- **v0.49.2** 信息架构调整 · 关于回主 nav (alpha 期新人入口) + dotted underline 暗示"参见说明" · 找沉到 dateline 末 mono · 副行整个删除 · masthead 3 行 → 2 行
- **v0.50** 中文长文本排版修复 · entry-text / pcard-desc / 项目页正文加 'Songti SC' 'Noto Serif SC' fallback · 撤销 v0.30 留下的负字距 · 中文用 0.005em 微正"呼吸距"
- **v0.50.1** inline-code 长 URL 溢出修复 · 撤销 white-space: nowrap · 改 overflow-wrap: anywhere · 长 `git clone` / URL 在任意位置可断 · 卡片不再撑爆
- **v0.51** 陈列馆视觉升级 + 全站 AI 符号清洗 · 序号 01/02 浮左 + dateline 绝对日期 + 铭牌行 + 截图框 16:9 + 完工感想 mono 标签 + 印章 dotted 边框 + 馆藏统计 · markup 同步 renderShowcase + formatShipDate/daysSinceShip helper · 全站字间空格删 + 文案 staccato `·` 链改自然中文标点 (顿号/句号/破折号) · 保留卷期号/工具列表/时间元数据的 ·
- **v0.52** 长文阅读体验三件套 · ① renderRichText 块级版 \n\n→`<p>` + 单 \n→`<br>` · 段间距 12px · entry-text/tl-text 行高 1.65 · ② status chip 退化成 8px 圆点 + 状态色 (active/done=moss · stuck=vermilion · paused=sepia) · 文字走 title tooltip · hover 圆点放大 · ③ entry-meta 工具栈默认 opacity 0.55 · hover 1.0 · 移动端 (hover:none) 永远 1.0 · 4 处调用切换 renderRichText (feed/workshop 最近的动静/timeline/showcase reflection)
- **v0.53** 完工 ceremony 三处补图入口 · 闭环已 done 项目 · openShipCeremony 升级支持 reship 模式 (预填 reflection/feedbackAsk/images · 文案切换 "改一下完工感想/补图" · CTA "✦ 更新陈列馆") · 三处入口: ① 陈列馆卡片 meta 区"改感想/补图" (owner-only) · ② 项目页 pheader done 状态时"✦ 改感想/补图" small-action · ③ 工作室"做过的"区 pcard 加 "+ 补图" 或 "改感想/换图" (有无 cover image 不同文案) · 后端 shipProject 早已支持重复 ship · 仅前端补入口
- **v0.54** 陈列馆 CRUD 闭环 · 补 Create + Delete 入口 · ① Create: 陈列馆头部 "✦ 让一个项目入馆" CTA + 新 modal-ship-pick · 列出 owner 所有非 done/archive 项目 (active/stuck/paused) · 选中 → openShipCeremony · 无候选时引导挂项目 / 入场仪式 · ② Delete: 陈列馆 owner actions 加 "让它出馆" (sepia dotted · 默认 opacity 0.65 · hover 1.0 · confirm 二次确认 · changeProjectStatus done → paused · 历史 ship update 保留 · 随时可再入馆)
- **v0.55** 陈列馆集体性强调 · 数据层一直是全站 (state.projects 跨 owner) · 但文案让它看着像个人作品集 · 4 处文案 + 1 处统计修复 · sub "Tinker 上所有人做完的、还能玩到的小作品都在这" · CTA "让一个项目入馆" → "让你的作品也入馆" (强调"也" 暗示已有别人) · closing "大家在做没做完的去主屏「动静」看" · 馆藏统计渐进式加 "来自 N 位作者" (>= 2 才出现)
- **v0.56** 工作室画像化 · 陈列馆 v0.55 集体化后 · 工作室定位调整为"vibe coder 个人画像" · 三件套: ① 页头加 mini-stats 小档案 "在做 N，跑通 M，跟进过 K，常用 工具1·2·3" (mono 11.5px sepia · 数字 ink · 别人来访秒识"是谁") · ② "做过的"简化为索引 chip · 不再重复陈列馆 reflection 详卡 · 一行项目名 + ✦ 完工日期 + 工具 + 在陈列馆 → · isMe 保 "改/换图" 入口 · 索引 hover padding-left + name vermilion 微动效 · ③ "在跟进的"对外可见 · 删 isMe 限制 · 只暴露硬信号 (接走 + 方法被用) · "想试试"删除 · 别人来访看到 vibe coder 之间的手艺谱系 · 段标题随 isMe 切换 "我在跟进的"/"@X 在跟进的"
- **v0.57** 陈列馆工具筛选删除 · 改阶段筛选 · 用户洞察: 工具筛选维度太分散 (1-2 件/工具) · 工具栈已在卡片铭牌行显示 · 不重复 · 改用阶段维度 (ship/prototype/design) 让浏览者明确"想看跑通的"还是"想看原型" · 删 #showcase-tools-filter markup + showcaseToolFilter state + 相关 JS · 留 #showcase-kind-filter (平行 claude-code 之前已加) · CSS 让 active pill 颜色跟 kind 对应: ✦ 完工 vermilion · ◐ 原型 amber #b8860b · ○ 设计 moss · JS 给 pill 加 data-kind 属性让 attribute selector 命中
- **v0.58** 系统级集体性 + 通知页升级 (三件套) · ① A: 主屏 feed 顶部加 mini-stats "今天 N 条，来自 K 位，跨 M 个项目" (K>=2 / M>=2 才显示对应段 · 渐进式) · 跟陈列馆 v0.55 "馆藏 N 件，来自 K 位作者" + 工作室 v0.56 mini-stats 形成系统呼应 · ② B: 工作室 mini-stats 加被动反馈信号 "被接走过 K · 方法被用 M" (>=1 才显示) · 让"我的手艺被认可"显式 · 之前只有主动信号 (在做/跑通/跟进过/常用) · 反向信号补完 vibe coder 画像 · ③ C: 通知页按 type 分组筛选 · 新 NOTIF_TYPE_LABELS 表 + notifTypeFilter state + setNotifTypeFilter 函数 · chip 按数量降序仅显示有数据的 type · 复用 .filter-row 视觉一致

### [ui] markup 减法记录 (累积 5 处)
所有改动都标在 CSS 注释 v0.29.1 / v0.31 段开头:
1. 删 dev "重置原型数据" 按钮
2. 工作室页 "你 的 工 作 室" → "你的工作室" + CSS letter-spacing 接管
3. 项目页 "项 目 · 卡 住" → "项目 · 卡住"
4. 项目页 "↑ 你也来" sub-label 整段 → dotted 顶分隔 react-line
5. "做了延伸版 →" × 2 → "做了延伸版"

### [ui] JS 改造记录 (v0.34+)
- `renderFeed` / `renderWorkshop` 按日 group + `makeDayLabelEl` + 跳过今天 label
- `groupEventsByDay` / `makeDateKey` / `makeDayDesc` / `pad2` 4 个 helper
- `masthead-date` IIFE 改造 · 生成 dateline 4 段 markup (Sat · 06 · Jun · 2026)
- **v0.49** `#masthead-issue-num` IIFE · alpha epoch 2026-06-05 累积天数 · 报纸"第 N 期"仪式感

### [ui] masthead markup 重构 (v0.48 → v0.49.2)
- `.masthead-main-row` / `.masthead-actions` / `.masthead-brand` 新 layout (v0.48)
- `.masthead-nav-primary` 3 项 → 4 项 (关于回归 · v0.49.2)
- `.masthead-cta` 独立 button · 取代原 nav 末"+ 记一笔" inline link (v0.48)
- `.masthead-sub-row` 副行: v0.48 引入 → v0.49.2 整个删除
- `.masthead-dateline` / `.dateline-right` / `.dateline-find` 卷期号化 + 找入口下沉 (v0.49 / v0.49.2)
- `.nav-about` 加 dotted underline · 新人"参见说明"暗示 (v0.49.2)

### [ui] 参考成熟设计 (v0.49 之前的对比研究)
- **NYT** "Vol. CLXXIV" → 我们 `卷一 · 第 NNN 期` 卷期号
- **Defector** "ESTABLISHED 2020" → 时间锚紧贴品牌
- **Substack** publication 单一 primary CTA → `+ 记一笔` 独立浮
- **Are.na** 极轻 secondary nav → 找/关于 弱化但不消失
- 反例: HN / X 极致密集 · 跟我们留呼吸方向反

### [ui] preview 历史归档
- 历史 preview 文件 (v0.27-v0.32) 已从 `webapp/` 移到 `prototypes/preview-history/`
- 当前活跃 preview: `webapp/preview-v0.34.html` (跟 index.html 内容一致 · 同步看)

### [ui] markup 减法记录 (累积 5 处)
所有改动都标在 CSS 注释 v0.29.1 / v0.31 段开头:
1. 删 dev "重置原型数据" 按钮
2. 工作室页 "你 的 工 作 室" → "你的工作室" + CSS letter-spacing 接管
3. 项目页 "项 目 · 卡 住" → "项目 · 卡住"
4. 项目页 "↑ 你也来" sub-label 整段 → dotted 顶分隔 react-line
5. "做了延伸版 →" × 2 → "做了延伸版"

---

## [0.4.0] — 2026-06-06 · 反馈闭环深度修复

> Owner: feat 线 + be 线
> 起点: 阶段 1-3 审计找到 8 处 🔴 闭环漏洞

### Added (server)
- `notifications.anchor` 列 + migration `002_notif_anchor.sql`
- `markNotifRead` 单条已读 action (替代 markAllRead 进通知页时一口气全标)
- `deleteTinkered` 接走方撤回延伸版 action
- `editProject` 改 productLink → 给 tinkered + wantToTry 发 `projectMoved` 通知
- `addUpdate` 加 `alsoStuck` flag · spec §5.3 "卡了"召回闭环
- `addUpdate` 加 `notifyTinkered` flag · "跑通了大版本" 主动广播
- `buildState` 通知输出加 `anchor` / `projectSlug` / `projectOwner`
- updates / notes 暴露 `id` (给前端做锚点)

### Changed (server)
- `submitTinkered` 升级承诺时清掉旧 `wantToTry` 通知 (避免双通知)
- `notify()` 统一接受 `anchor` 参数

### Added (webapp)
- `update modal` 加 v0.4 闭环 checkbox (同时改卡住 / 通知接走方) + 受众提示
- 通知页 anchor scroll + flash 1.6s 高亮锚点位置
- 接走者自己可见的"撤回延伸版"按钮
- 通知未读改单条标已读 + 顶部"全部标已读"按钮
- 6 类通知文案 verb 三色调 (warm/cool/grow)

### Added (tests)
- `server/test/actions-sql.test.js` 24 → 37 个测试 (13 新增)

### Added (docs)
- `docs/02-api.md` v0.4 全更新 · anchor 矩阵 · 新 action 文档

---

## [0.3.0] — 2026-06-05 · SQLite + 邮箱 magic link

> Owner: be 线

### Added (server)
- SQLite 迁移 (better-sqlite3) · `migrations/runner.js` + `001_initial.sql`
- 邮箱 magic link 认证 (`auth.js`) · token TTL 5min · session TTL 90 天
- `email.js` SMTP 发送 (兼容阿里云邮件推送 / 任何 SMTP) · 无 SMTP 时 fallback 到 console
- 用户邮箱预填 handle (`deriveHandle`) + welcome modal
- 数据库 schema 完整: users / projects / updates / notes / reactions / tinkered / method_used / sessions / auth_tokens / notifications / starters / available_tools
- `seed.js` 启动 seed (STARTERS + AVAILABLE_TOOLS)

### Migrated
- 从 JSON 文件迁移到 SQLite (`migrate-from-json.js` · 一次性)
- 所有 actions 改成 SQL 版本 (`actions-sql.js` 替代 `actions.js`)

### Added (webapp)
- 邮箱登录 modal (两态: 输入邮箱 / 等待点链接)
- welcome modal (第一次登录后改 handle + tagline)
- 顶部刊头 "出去" 登出链接
- "匿名浏览中" 视觉

### Added (docs)
- `docs/05-backend-design.md` · v0.3 后端设计

---

## [0.2.0] — 2026-06-05 · 生产化基础设施

### Added (server)
- **数据安全**: `storage.js` · 原子写入 (.tmp + rename) + 5 份 backup 旋转 + 损坏文件自动 fallback
- **结构化日志**: pino + pino-http (dev 终端 / prod JSON)
- **环境变量管理**: dotenv + `.env.example` 完整清单
- **安全 headers**: helmet
- **Rate limiting**: express-rate-limit (action 60/min · state 300/min · env 覆盖)
- **CORS 收紧**: `CORS_ORIGINS` 白名单 · 默认开放
- **健康检查**: `/api/health` (uptime / 内存 / state 数量 / Node 版本)
- **错误中间件**: 全局兜底 · 不泄露 stack
- **优雅关闭**: SIGTERM/SIGINT + 10s 强制超时
- **异常兜底**: uncaughtException + unhandledRejection
- **trust proxy**: 信任反代 (nginx/caddy)

### Added (multi-user)
- `setUserHandle` action · 第一次填 handle 自动开张工作室
- webapp 首次访问弹"你是谁?" modal
- handle 存 `localStorage` · 顶部刊头点击可改
- 新用户工作室空状态友好引导卡片
- 关于页加 ALPHA 横幅

### Added (真实时间戳)
- server SEED 启动时把 `ago` 字符串转 `at` timestamp
- 所有新建数据用 `at: Date.now()`
- webapp 加 `timeAgo` / `shortAgo` / `parseAgoOrder` 三个 helper

### Added (基础设施)
- `Dockerfile` (Node 20 alpine 多阶段 · 非 root)
- `docker-compose.yml` (volume / env / healthcheck / 日志轮转)
- `deploy/Caddyfile` (推荐 · 自动 HTTPS)
- `deploy/nginx.conf` (备选)
- `deploy/deploy.sh` / `deploy/setup-vps.sh`
- 20 个 actions 测试 (node:test · 0 依赖)
- prettier 配置

### Changed
- `parseAgoOrder` / `shortAgo` 签名: 接受 timestamp 而不是字符串
- API 兼容 (业务行为零变化)

---

## [0.1.0] — 2026-06-05 · alpha 三件套上线

### Added
- **server/** Express + JSON 存储 · 12 个 action handlers
- **webapp/** SPA 升级自 prototype v0.23 · fetch /api
- **cli/** `tinker push` · 支持 `--since` / `--auto` / `draft` / LLM (Claude/GPT/DeepSeek)
- GitHub repo 创建
- ngrok tunnel 公网入口 alpha

### Architecture decisions
- 数据存储: JSON 文件 (alpha) · 后期换 SQLite/PG
- API 风格: `GET /api/state` + `POST /api/action`
- 认证: 无 (alpha 期 trust handle)

---

## [0.0.x] — Prototype 阶段

完整设计迭代记录见 `prototypes/v0.1.html` → `prototypes/v0.23.html`。
关键决策点见 `docs/01-product-spec.md`。

23 个原型版本浓缩出的设计共识:
- 工艺人日志气质 (报纸刊头 + Newsreader + Fraunces + 朱砂红/苔绿)
- 反点赞 / 反推荐 / 反等级
- 必须挂可访问产物 (反 AI 装大佬)
- 反馈链: 想试试 → 跑通了召回
- update 级 "用了 · 跑通了" 反馈
- 工作室 + 项目 + 进展 三层结构

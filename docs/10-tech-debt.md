# 技术债 / 待办 (随规模才需要处理的)

这里记"现在不急、但用户量上来会咬人"的事。每条写清:问题、为什么现在不做、到什么时候该做、大概怎么做。

---

## ⑤ 退出工作室没闭环 · 2026-06-13 用户在 GUI 上发现

**问题**
能加入工作室 (invite / accept / join) · 但「退出」这个对称动作没闭环。两层:
- **发现性**:离开按钮藏在账户页「挂靠的工作室」每行的「离开」(webapp `leaveStudio`) · 工作室页本身没有就近入口。人站在工作室页想退 · 得绕到账户页才找得到。
- **owner 退出是半成品** (`server/studios.js` `studioLeave`):
  - 唯一成员的 owner → 直接拦死 (「你是唯一 owner · 没人继承 · 先邀请别人加入再退」) · 等于建了工作室就锁在里面。
  - 有别的成员的 owner → 只删自己的成员记录 · **不转让 owner** (注释自己写着「Phase 2 转让」没做) · 结果工作室剩成员但没 owner · 变孤儿。

**怎么做 (要做时)**
- 工作室页加就近的「离开工作室」入口 (碰 `webapp/index.html` · 跟猫猫协调那批一起)
- owner 退出补所有权转让 · 倾向 **A 兜底 + B 可选**:
  - A 默认自动升最早加入的成员当 owner (零摩擦 · 先保证不出孤儿)
  - B 给 owner 一个「指定接班人」的选项 (更可控 · 作为增强)
- 唯一成员 owner 退出其实等于「解散工作室」· 可顺势做成:最后一个人退 → archive / 删掉这个 studio (现在直接拦死 · 也不闭环)

**什么时候做**
跟 ① / ③ 那批 webapp 改动一起 · 等猫猫手头告一段落。owner 转让那段是纯 server 改动 · 可先于 GUI 做 (但要先定 A/B)。**注意**:`server/studios.js` 现在有未提交的在制改动 (studio_id 那个) · 动它前先把那摊理清。

---

## ③ webapp 依赖境外 CDN (大陆访问慢/不稳) · 2026-06-13 review 发现

**问题**
首页前端运行时拉两个境外资源,大陆用户首屏受影响:
- `cdn.tailwindcss.com` (Tailwind play cdn · 官方明说禁止生产用 · 在浏览器里运行时现编译一大坨 js)
- Google Fonts (`fonts.googleapis.com` · 5 个字族含中文 Noto Serif SC · render-blocking · 没 preconnect · 没 font-display)

**影响**
产品部署在大陆 ECS · 用户也在国内 · 而这两个恰好是国内又慢又可能连不上的源。首屏容易卡白 / 字体迟迟不来 / tailwind 没加载完一瞬间样式是乱的。

**进度**
- Tailwind:**已换成构建期生成的静态 `webapp/tailwind.css`** (扫 index.html 只出用到的类 · 9.8KB · 含 preflight · 跟 cdn 行为对齐)。实测无动态拼 class / 无 arbitrary values / 无内联 config · 迁移零风险。
  - **改动存成了分支 `tailwind-static-css` (没并进 main · 没部署)** —— 因为猫猫同时在改 `webapp/index.html` (返回键 / 懒加载) · 暂压着等协调好。回头 `git rebase main tailwind-static-css` 接上最新再 push 到 main 即可部署。重生成命令写在 index.html 顶部注释。
- 字体:还没动。

**字体怎么做**
- 自托管:把这 5 个字族真用到的 weight 下载下来 · 放 `webapp/fonts/` · 改 `@font-face` 指向本地。中文 Noto Serif SC 必须 subset (按实际用到的字符裁) · 不然单文件好几 MB · 比外链还糟。
- 退一步 (轻量版):至少加 `<link rel=preconnect>` 到 fonts.googleapis / fonts.gstatic · 加 `font-display:swap` · 砍掉用不到的 weight。
- 跟 tailwind 一样要碰 `<head>` · 跟猫猫协调着改。

**什么时候做**
跟 ① 绑一起 · 等猫猫手头这轮告一段落、`webapp/index.html` 不再频繁动时 · 三项 (tailwind 推上线 + 字体 + api 瘦身) 一起收。

---

## ④ 零碎 (顺手 review 出来的小项 · 都不急)

- **CSP 关着**:`server/index.js` 里 `contentSecurityPolicy: false` (因为 webapp 有 inline script)。小安全缺口 · 等 inline script 收拾干净了再开 · alpha 可缓。
- **首页 Cache-Control: max-age=0**:每次访问回源校验。好在 brotli 开了、有 ETag · 走 304 不重传正文 · 不严重。真要省那个往返可以给 app shell 一个短 max-age。

---

## ② 部署提速 · server JS 也 bind-mount (想做没做成)

**问题**
server 代码 `COPY` 进镜像 · 每次改 server 都全量 `docker compose build` (平时 1-3 分钟 · 加系统包那次 20 分钟)。webapp 已经 bind-mount 进容器 · 改了只 restart 秒级。server 想同样待遇。

**为什么现在不做 (踩过一次坑)**
2026-06-11 试过:`./server:/app/server:ro` + 在里面挂 `node_modules` 匿名卷 → Docker 报 `read-only file system` (只读父挂载里建不了子挂载点) · 容器起不来 · 生产 down 了几分钟 · 已回滚。

**正确做法 (验证后再上)**
把 node_modules 装到 `/app` (server 父目录) 而不是 `/app/server` 里:
- Dockerfile: `COPY server/package*.json /app/` · 在 `/app` 跑 `npm ci` · node_modules 落 `/app/node_modules`
- server 代码仍在 `/app/server` · node 靠向上查找解析模块 (walks up 到 /app/node_modules) · 不冲突
- compose: `./server:/app/server` (rw · server 只写 /data 和 backups · 但 rw 避免子挂载点问题) · backups 用匿名卷盖回
- CI: `server/*.js` 改 → 只 restart · `server/package*.json` / Dockerfile → rebuild + `--renew-anon-volumes` 防 node_modules 陈旧
- **关键前提**:本地有 docker 能先验证容器起得来再上 · 别再直接推生产

**什么时候做**
本地能验证时 · 或 server 改动频繁到 1-3 分钟重建明显烦人时。现在不痛 · 不急。

---

## ① `/api/state` 一把 dump 全站 (随规模恶化)

**问题**
`GET /api/state` 不需要登录,一次性返回:所有用户 (handle / name / tagline) + 所有项目 + 所有方法 + 所有工作室。现在 3 个用户无所谓,但用户涨到几千时:

- 单次响应体积线性膨胀 · 首页一打开就拉全站 · 慢 + 费流量
- 变成一个又大又好爬的"全站名录" · 匿名可拉

**为什么现在不做**
alpha 阶段用户极少 · feed 量级根本不需要分页。现在做分页 + 资料懒加载是过早优化 · 改动面大 (webapp 的 feed / workshop / showcase 全靠这一个 state 对象渲染)。

**什么时候做**
用户数到几百 · 或 `/api/state` 响应超过 ~200KB / 首屏明显变慢时。

**大概怎么做**
- feed 分页 (cursor / since) · 首屏只拿最近 N 条
- 用户资料懒加载 · 不在首屏 dump 全部 users · 进谁的页再拉谁的 (类似已有的 `/api/users/:handle/studios-preview` 模式)
- 方法库 / 陈列馆同理 · 按需拉
- 注意:这是 webapp 渲染模型的重构 · 不只是后端加个 limit · 得一起改前端取数

**已经做了的相关收口 (2026-06-11)**
- 工作室成员关系不再在 bulk dump 里逐个用户暴露 (只挂请求者本人) · 看别人走 `/api/users/:handle/studios-preview` 按需取。见 server/state.js。这是 ② · 已修。① 还挂着。

**最新实测 (2026-06-13 · review 时量的)**
- 当前 7 项目 / 3 用户 / 70 条 update:原始 167KB · br 压缩后过网 52KB (压缩比只有 3.2x · 不如 html · 中文文本压不动)。所以网络开销目前不算痛 · 还没到上面写的 "超过 200KB" 那条线。
- 拆字段看胖在哪:`updates` 107KB (占整个 state 的 63% · 所有项目所有 update 全文一把塞首屏) · `methods` 装了两份 (全局 `state.methods` + 每个 `project.methods` · 同一批方法全文重复 · 多 ~25KB) · 其余字段都是零头。
- 真要做时的靶心:updates 懒加载 (首屏只拿摘要 / 最近 N 条 · 进项目详情再拉全量) + methods 去重 (project 内只挂 method id · 全文从全局 methods map 查)。
- **坑 (为什么不是纯后端活)**:feed 的 `getFeedEvents` 和方法库浏览页都在初屏直接渲染 `u.text` / `m.text` · 裁 server 字段必须同步改前端取数。所以这条得 server + webapp 一起改 · 跟 ③ 一样会碰 webapp/index.html。

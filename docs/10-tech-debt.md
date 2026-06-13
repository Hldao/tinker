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

## ⑥ 自动部署对大文件不可靠 · git pull 静默没拉全 · 2026-06-13 字体那次踩到

**问题**
2026-06-13 推字体自托管 (7MB · 123 个 woff2)。GitHub Actions 跑完报 success · 但 ECS 上 `git pull` 没真把那 7MB 拉下来 (ECS 还停在上一个 commit · fonts/ 目录是空的)。结果线上 fonts.css 一直 404 · Actions 却显示绿。最后手动 ssh 上去 `git pull` + `chmod -R a+rX webapp` + `restart` 才补上。

**为什么会这样 (推测 · 没坐实根因)**
大概率是 ECS 拉 GitHub 大对象时网络抖 / 超时 · 但 workflow 里那步 `git pull` 没检查 exit code 就往下走 (或 pull 部分成功不报错) · 健康检查又只看容器 200 (容器还是旧的 · 当然 200) · 所以绿得很假。小文件 (state.js / index.html 那种几 KB) 没这问题 · 这次后面两个 commit 都正常。

**怎么做 (要做时)**
- workflow 的 `git pull` 后加校验:比对 `git rev-parse HEAD` 跟触发这次 run 的 `$GITHUB_SHA` · 不一致就 fail (别让它假绿)。
- 或者大资源别走 git:字体 / 大静态资源考虑放对象存储 (oss) · git 里只留引用。
- 健康检查升级成"换了新代码"判定:比 image id / 比 `/api/cli-version` 返回的 sha · 不只看 200 (这条 ② 里也提了)。

**什么时候做**
下次又要推大文件前。平时小改动不触发这个坑 · 不急。但**记着:推大资源后一定手动核验 ECS 真拉到了 · 别信 Actions 的绿**。

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

**实测 (2026-06-13 · review 时量的)**
- 当前 7 项目 / 3 用户 / 71 条 update:原始 179KB · br 压缩后过网 54KB (压缩比只有 3.3x · 中文文本压不动)。所以网络开销目前不算痛 · 还没到上面写的 "超过 200KB" 那条线。
- 拆字段看胖在哪:`projects` 144KB (占 81%) · 里头 `updates` 全文 103KB (所有项目所有 update 全文一把塞首屏) · 方法全文重复 27KB (全局 `state.methods` + 每个 `project.methods` 各一份) · 其余零头。

**已经做了的几刀**

- **工作室成员关系收口 (2026-06-11)**:bulk dump 不再逐个用户暴露成员关系 (只挂请求者本人) · 看别人走 `/api/users/:handle/studios-preview` 按需取。见 server/state.js。

- **方法去重 (2026-06-13 · commit d11dd6d)**:`project.methods` 从完整对象数组改成 **id 引用数组** · 全文只在全局 `state.methods` 存一份单一真相 · webapp 按 id 去查 (renderProject 里建 `methodsById` map · 兼容 id / 完整对象两种形状防部署错位)。原始体积 179KB → 149KB (-16%)。
  - **诚实结论**:压缩后过网体积几乎没变 (54261 → 54240 · 省 21 字节)。因为重复的那 27KB 跟全局那份逐字节相同 · br/gzip 的字典本来就把重复内容压成几个回指字节了。**这刀省的是服务端序列化 cpu + 客户端 JSON.parse + 内存 (少 hold 一份重复对象) + 数据模型干净 (两份 text 不会跑偏) · 但下载体积没动**。教训:要压"过网体积"得砍**独一无二**的内容 · 砍重复内容压缩器早替你做了。

- **砍写放大 (2026-06-13 · commit cf435da)**:`POST /api/action` 以前每次写都 `buildState()` 把整个 179KB 重算重发回。CLI 根本不渲染这坨。现在 CLI 发 `x-tinker-no-state: 1` 头 · server 见到就跳过 buildState 只回 `result`。webapp 不带这个头 · 照常拿 state 重渲染。省的是每次写的 cpu + 带宽 (尤其 CLI 那条)。部署错位安全:旧 server 忽略未知头 · 新 server 遇旧 CLI 照常返。效果随 CLI `tinker update` 逐步生效。

- **updates 懒加载 (2026-06-13 · 三阶段 commit 2b3327b/f6ec1ae/634934b)**:首屏体积大头那一刀。update 全文 103KB 是**独一无二**的内容 · 压缩救不了 · 只能懒加载。做法:
  - `/api/state` 的 `project.updates[].text` 只返**前 400 字预览 + truncated 标记** (`mapUpdateRow(preview:true)` · buildState 和单项目共用一份形状映射 · 防漂移)。
  - 新端点 `GET /api/project/:id/updates` 拉单项目全量 updates 全文 · `GET /api/updates/search` 后端搜全文 (懒加载后全站搜索框走这个 · 不降级)。
  - webapp:`renderProject` / `renderUpdateDetail` 进页 async hydrate 全文 · 全站搜索「进展」组改走后端。feed 本来就 CSS 钳到 6 行 · 预览无体感差。
  - **三阶段推**:A 纯加端点 (零风险) → B 前端改用端点 (state 仍带全文 · 验改对没崩) → C 才砍全文成预览。风险最大的砍放最后。
  - **实测降幅**:原始 149KB → 96KB (-36%) · **br 过网 54.2KB → 43.5KB (-20% · 真降了 11KB · 不像方法去重那样被压缩吃掉)** · gzip 77.7KB → 44KB (-43%)。(注:长正文压缩率有 ~5 倍 · 所以过网省的没原始省的多 · 之前估的"压到 20KB"乐观了。)
  - **隐患排查 (砍之前确认全覆盖)**:陈列馆反思本就截 280 < 400 ✓ · 便签引用截 60 字 ✓ · 通知屏不读 update 全文 ✓ · 复制 markdown / 编辑框都在项目页 hydrate 之后 ✓。

**这条 ① 还剩的部分 (没那么急了)**

acute 的体积痛 (103KB update 全文) 已解。剩下随更大规模才咬人的:
- **feed 分页 / windowing**:现在首屏仍遍历所有项目的所有 update (虽然只是预览) · 几千条后预览本身也会堆。要做 cursor/since 分页 · 首屏只拿最近 N 条。
- **用户资料懒加载**:`state.users` 仍 dump 全部 (handle/name/tagline) · 几千用户时该按需拉 (类似 `/api/users/:handle/studios-preview`)。
- 这两条现在完全不痛 (3 用户 / 71 update) · 等真到几百几千再说。

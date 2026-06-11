# 技术债 / 待办 (随规模才需要处理的)

这里记"现在不急、但用户量上来会咬人"的事。每条写清:问题、为什么现在不做、到什么时候该做、大概怎么做。

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

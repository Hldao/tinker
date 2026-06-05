# Tinker API · v0.4.0

Tinker server 暴露的 HTTP API。**单一可变面设计**:

- `GET /api/state` — 读全量 state
- `POST /api/action` — 触发任意 mutation
- `GET /api/health` — 健康检查
- `GET /api/tools` — 工具白名单

## 通用约定

**Base URL**:
- 本地: `http://localhost:8788`
- alpha: `http://120.26.46.217:8788` (daogu.cc 备案中 · 备案后切到 `https://daogu.cc`)

**Content-Type**: `application/json`

**响应格式**:
```json
{
  "ok": true,
  "result": {...},      // action 的具体返回
  "state": {...}        // 完整最新 state (action 后)
}
```

**错误**:
```json
{ "error": "项目得有个名字" }
```

## Rate limit

- `POST /api/action` · 60 req/min/IP (env `RATE_LIMIT_ACTION`)
- `GET /api/state` · 300 req/min/IP (env `RATE_LIMIT_STATE`)
- 超限返回 429 + `{ "error": "太快了 · 请稍后再试" }`

---

## GET /api/state

获取整个 state · 包含 users / projects / notifications / starters / availableTools。

**响应**:
```json
{
  "users": {
    "daodao": { "name": "...", "tagline": "..." }
  },
  "projects": [
    {
      "id": "p1",
      "owner": "daodao",
      "name": "...",
      "slug": "...",
      "desc": "...",
      "productLink": "https://...",
      "githubLink": "https://...",
      "status": "active|stuck|done|paused|archive",
      "tools": ["Cursor", "Claude"],
      "updates": [
        { "id": "u-xxx", "text": "...", "at": 1780655822028, "images": [...], "prompt": "...", "usedBy": [...] }
      ],
      "reactions": {
        "wantToTry": ["@u2"],
        "tinkered": [{ "user": "@u3", "name": "延伸版", "link": "https://..." }]
      },
      "notes": [
        { "id": "n-xxx", "user": "@u", "text": "...", "at": 1780655822028, "images": [...] }
      ]
    }
  ],
  "notifications": [
    {
      "id": "n-xxx",
      "target": "@daodao",
      "fromUser": "@u",
      "type": "tinkered|methodUsed|mentioned|projectDone|projectStuck|projectUnstuck|projectMoved|ownerUpdate|wantToTry|noted",
      "projectId": "p1",
      "projectName": "...",
      "projectSlug": "...",
      "projectOwner": "alice",
      "anchor": "update-u-xxx | note-n-xxx | tinkered-handle | null",
      "extra": "...",
      "at": 1780655822028,
      "read": false
    }
  ],
  "starters": [...],
  "availableTools": [...]
}
```

## GET /api/health

```json
{
  "status": "ok",
  "uptime": 3600,
  "memoryMb": 71,
  "projects": 12,
  "users": 6,
  "nodeVersion": "v20.10.0",
  "env": "production"
}
```

## GET /api/tools

返回工具白名单数组:
```json
["Cursor", "Claude", "v0", "Bolt", "Lovable", "Trae", "通义灵码", ...]
```

---

## POST /api/action

统一 mutation 接口:
```json
{ "type": "actionName", "payload": { ... } }
```

### actionName 列表 (15 个)

#### 用户

##### setUserHandle
首次登记 / 之后改 tagline。
```json
{ "type": "setUserHandle", "payload": { "handle": "alice", "tagline": "想做点小工具" } }
```
- `handle`: required · 字母/数字/下划线/中文
- 不存在则创建 · 存在则更新 tagline (如果给了)

##### editTagline
```json
{ "type": "editTagline", "payload": { "tagline": "...", "currentUser": "alice" } }
```

#### 项目

##### addProject
```json
{
  "type": "addProject",
  "payload": {
    "name": "...",
    "desc": "...",
    "productLink": "https://...",
    "status": "active",
    "tools": ["Cursor"],
    "currentUser": "alice"
  }
}
```
- `productLink` 必填且必须是合法 URL · 反 "AI 装大佬"

##### changeProjectStatus
状态 `active → done` 时自动通知 `wantToTry` 的人 (projectDone 通知)。
```json
{
  "type": "changeProjectStatus",
  "payload": { "projectId": "p1", "newStatus": "done", "currentUser": "alice" }
}
```

#### 进展 (updates)

##### addUpdate
```json
{
  "type": "addUpdate",
  "payload": {
    "projectId": "p1",
    "text": "...",
    "images": [{ "src": "data:image/...", "caption": "" }],
    "prompt": "...",
    "alsoStuck": false,
    "notifyTinkered": false
  }
}
```
自动:
- 加 `at: Date.now()`
- 扫文本里的 `@xxx` · 给 mention 的人发 `mentioned` 通知 · `anchor = update-<id>`
- `alsoStuck: true` 且当前状态非 stuck → 同时 `status → stuck`，给"接走 / 想试试"的人发 `projectStuck` 通知（spec §5.3 "卡了"召回）
- `notifyTinkered: true` 且没勾 alsoStuck → 给"接走 / 想试试"的人发 `ownerUpdate` 通知（用于"跑通了大版本"）
- 不勾 → 不发广播通知 · 默认行为不轰炸

返回:
```json
{ "id": "u-xxx", "text": "...", "at": 0, "prompt": "...", "statusChanged": false }
```

##### editUpdate
```json
{
  "type": "editUpdate",
  "payload": { "projectId": "p1", "updateIdx": 0, "text": "...", "images": [...], "currentUser": "alice" }
}
```

##### deleteUpdate
```json
{ "type": "deleteUpdate", "payload": { "projectId": "p1", "updateIdx": 0, "currentUser": "alice" } }
```

#### 反馈

##### reactToProject
重复点击 = 撤回。
```json
{
  "type": "reactToProject",
  "payload": { "projectId": "p1", "level": "wantToTry", "currentUser": "alice" }
}
```
- `level`: 目前只支持 `"wantToTry"` (v0.13 砍了 interested)

##### submitTinkered
做了延伸版 · 必须挂自己项目链接。
```json
{
  "type": "submitTinkered",
  "payload": {
    "projectId": "p1",
    "name": "我的延伸版",
    "link": "https://...",
    "currentUser": "alice"
  }
}
```
副作用:
- 自动清掉 `reactions.wantToTry` 里自己的记录（升级承诺）
- 自动清掉 owner 之前收到的 `wantToTry` 通知（避免双重通知）
- 给 owner 发 `tinkered` 通知 · `anchor = tinkered-<currentUserHandle>`

##### deleteTinkered
撤回自己的延伸版（项目下线 / 误操作）。
```json
{ "type": "deleteTinkered", "payload": { "projectId": "p1" } }
```
副作用:
- 删 tinkered 表里自己的行
- 清掉 owner 之前收到的 `tinkered` 通知（owner 点开找不到延伸版会迷惑）

##### markMethodUsed
"我用了你的方法 · 跑通了" · 项目 owner 不能给自己点。
```json
{
  "type": "markMethodUsed",
  "payload": {
    "projectId": "p1",
    "updateIdx": 0,
    "note": "我用了 strict mode",
    "currentUser": "alice"
  }
}
```
重复 = 撤回。

#### 便签

##### addNote
```json
{
  "type": "addNote",
  "payload": {
    "projectId": "p1",
    "text": "...",
    "images": [...],
    "currentUser": "alice"
  }
}
```
自动:
- 通知项目 owner (除非自己留)
- 扫文本里的 `@xxx` · 给 mention 的人发通知 (排除 owner 避免重复)

##### deleteNote
仅留言者自己能撤回。
```json
{
  "type": "deleteNote",
  "payload": { "projectId": "p1", "noteIdx": 0, "currentUser": "alice" }
}
```

#### 通知

##### markAllRead
```json
{ "type": "markAllRead", "payload": { "currentUser": "alice" } }
```
把 `target === currentUser` 的所有 unread 标为 read。webapp 在通知页顶部 "全部标已读" 按钮触发。

##### markNotifRead
```json
{ "type": "markNotifRead", "payload": { "notifId": "n-xxx" } }
```
单条标已读。webapp 点开任意一条通知后自动触发 · 避免一进通知页就全标已读丢失信号。

---

## POST /api/reset

开发用 · 把 state 重置为 seed 数据。生产环境 disable (除非 `ALLOW_RESET=1`)。
```json
{ "ok": true, "state": {...} }
```

---

## 通知类型 (NotificationType)

| type | 触发 | anchor | 文案模板 |
|---|---|---|---|
| `tinkered` | `submitTinkered` | `tinkered-<from-handle>` | "接走了你的「项目名」 · 做了「延伸名」" |
| `methodUsed` | `markMethodUsed` | `update-<id>` | "用了你的方法 · 跑通了「项目名」" |
| `mentioned` | update/note 里 @ 提到 | `update-<id>` / `note-<id>` | "提到了你 · 在「项目名」" |
| `projectDone` | `changeProjectStatus` → done | null | "跑通了 · 你之前说过想试试 · 现在能用了「项目名」" |
| `projectStuck` | `changeProjectStatus` → stuck 或 `addUpdate(alsoStuck:true)` | null / `update-<id>` | "卡住了 · 也许你能搭把手「项目名」" |
| `projectUnstuck` | `changeProjectStatus` stuck → active | null | "又动起来了 · 之前卡住的那个「项目名」" |
| `projectMoved` | `editProject` 改了 productLink | null | "换了产物链接 ·「项目名」 → \<新链接\>" |
| `ownerUpdate` | `addUpdate(notifyTinkered:true)` | `update-<id>` | "记了一笔新进展 · 「项目名」" |
| `wantToTry` | `reactToProject(wantToTry)` | null | "想试试「项目名」" |
| `noted` | `addNote` 给别人 | `note-<id>` | "在你的「项目名」留了便签" |

**anchor 用途**：webapp 点开通知 → 跳到项目页 → scroll 到 anchor DOM id + 闪烁 1.6s。
锚点不存在（内容被删 / 老通知 anchor=null）时静默退到项目页顶部。

**去重**：同一 `(target, fromUser, type, project)` 只保留最新一条。`submitTinkered` 会显式清掉之前的 `wantToTry` 通知（不同 type 不会被默认去重逻辑覆盖）。

---

## 状态机

```
            active ──┐
              │      ↓
              ↓    stuck (卡住但能继续)
            done ──→ archive
              │
              ↓
           paused (暂停)
```

只有项目 owner 能改自己项目的状态。

---

## 客户端示例

### curl
```bash
# 读 state
curl https://tinkers.ink/api/state | jq '.projects | length'

# push 一条进展
curl -X POST https://tinkers.ink/api/action \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "addUpdate",
    "payload": {
      "projectId": "p1",
      "text": "跑通了 ✦",
      "currentUser": "alice"
    }
  }'
```

### JavaScript (webapp 在用的模式)
```js
async function apiAction(type, payload) {
  const res = await fetch('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, payload }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}
```

### Tinker CLI
```bash
tinker push -m "..."
# 内部:
# POST /api/action { type: 'addUpdate', payload: {...} }
```

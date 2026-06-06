# 账号合并: @daodao + @380855352 → @daodao

## 背景

`@daodao` 是 seed.js 里的 maintainer 占位账号（无 email），
之后 `@380855352` 通过邮箱 magic link 真实注册，
但 Tinker / 捣鼓 + 箭证 项目挂在了 daodao 名下。

目标：合并成单一 `@daodao` 账号，绑定 380855352@qq.com，拥有所有项目。

---

## 执行步骤（在 ECS 上）

### 0. SSH 进 ECS

```bash
ssh root@120.26.46.217   # 或你日常用的 user@host
```

### 1. 等 GitHub Actions deploy 完（让脚本同步到 ECS）

```bash
cd ~/tinker
git pull   # 如果 Actions 还没跑完，手动 pull
ls server/scripts/   # 确认 merge-daodao-to-380855352.js 在
```

### 2. 备份数据库（强烈建议）

```bash
cp data/tinker.db data/tinker.db.bak-$(date +%Y%m%d-%H%M%S)
ls -la data/tinker.db*
```

### 3. 先 dry-run 看影响范围

```bash
docker exec tinker-server node /app/server/scripts/merge-daodao-to-380855352.js --dry-run
```

输出会显示：
- daodao 名下项目（哪些会过户）
- 各表 daodao 的 user_id 引用数
- 380855352 已有数据

确认无误后继续。

### 4. 实际执行合并

```bash
docker exec tinker-server node /app/server/scripts/merge-daodao-to-380855352.js
```

会一步一步打印每张表 update 了多少行，最后输出验证结果。

### 5. 浏览器刷新验证

打开 [http://120.26.46.217:8788/](http://120.26.46.217:8788/)，强刷 (⌘+Shift+R)：

- masthead 右上角显示 `@daodao`
- 进自己工作室能看到 Tinker / 捣鼓 + 箭证
- session 不会断，不需要重新登录

---

## 出错回滚

```bash
# 找到刚才的备份
ls -la data/tinker.db.bak-*

# 恢复
cp data/tinker.db.bak-YYYYMMDD-HHMMSS data/tinker.db

# 重启容器（清掉旧 db 连接）
docker compose restart tinker
```

---

## 脚本做了什么

```
PART 1 · DRY RUN 输出
  ├─ 列出 daodao 名下项目
  ├─ 列出 daodao 在 10 张表的引用数
  └─ 列出 380855352 已有数据（合并后保留 + 合体）

PART 2 · TRANSACTION 执行
  ├─ projects.owner_id        daodao_id → target_id
  ├─ method_used.user_id      （OR IGNORE 防复合主键冲突）
  ├─ reactions.user_id        （OR IGNORE）
  ├─ tinkered.user_id         （OR IGNORE）
  ├─ notes.user_id
  ├─ notifications.target_user_id
  ├─ notifications.from_user_id
  ├─ api_tokens.user_id
  ├─ sessions.user_id         （session 保住，不断登录）
  ├─ auth_tokens.user_id
  ├─ 把 @daodao 改名 __daodao_archived（占位避免重名冲突）
  ├─ 把 @380855352 改名为 @daodao
  │   ├─ name 改回 '捣鼓自己'（如果是默认）
  │   └─ tagline 改回原 daodao 的 tagline（如果是默认）
  └─ 删除 __daodao_archived 用户（CASCADE 清残留子表行）

PART 3 · 验证
  ├─ 列出现存所有 user
  ├─ 列出新 @daodao 名下项目
  └─ 列出新 @daodao 各表数据统计
```

整个 PART 2 包在 `db.transaction(() => { ... })` 里，任何一步失败自动回滚到 PART 1 状态。

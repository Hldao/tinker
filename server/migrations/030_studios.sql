-- 030_studios.sql · 工作室一等公民
--
-- 背景:
--   现状是 users.handle 唯一 · projects.owner_id 直接挂 user · 每个 handle 在 webapp
--   被自动渲染成一个"工作室"。但现实里一个工作室可能不止一个人 (比如我跟猫猫
--   各自有账号 · 实际上是一个工作室)。
--
-- 同时 022 的桥用客户端暗号 (sha256 团队暗号) 隐式表达"我们是一伙" · server 不知道。
-- 这两件事其实是一个 — 桥的"团队"就是工作室。
--
-- 设计:
--   - studios 是一等公民 · 有自己的 slug/name/tagline
--   - studio_members 多对多 · user 可以挂靠到 studio (一对一关系也允许 · 个人工作室)
--   - project 还是 owner_id = user_id (作品有作者署名 · 这是 Tinker 立场)
--   - 工作室聚合页通过 members 关系把所有成员的 projects 聚一起
--   - secret_hash 是 server 用来验"是不是同 studio"的 · 真暗号还在客户端 (e2e 加密信封)
--
-- buffer 号说明:022 是在 in-flight 的 bridge_messages · 留 023-029 给猫猫可能的并行
-- migration · 这里跳到 030。

CREATE TABLE studios (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,         -- URL 用 · /s/<slug>
  name        TEXT NOT NULL,                -- 显示名 · 比如 "捣鼓工作室"
  tagline     TEXT,                         -- 一句话 · 工作室在做的事
  secret_hash TEXT NOT NULL,                -- sha256(团队暗号) · server 校验成员关系用
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE studio_members (
  studio_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL,                -- owner / member
  joined_at   INTEGER NOT NULL,
  PRIMARY KEY (studio_id, user_id),
  FOREIGN KEY (studio_id) REFERENCES studios(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_studio_members_user ON studio_members(user_id);
CREATE INDEX idx_studios_secret ON studios(secret_hash);

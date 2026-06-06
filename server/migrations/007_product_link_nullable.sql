-- productLink 改为可选
--
-- 背景: 真实世界里有不少作品没有公开 URL — 微信小程序在审核, 桌面应用,
-- 私有 repo 内测中。NOT NULL 把这类作品挡在陈列馆门外不合理。
-- server: addProject / editProject 已放宽校验 (空 ok, 填了必须合法).
-- 这里把 schema 也跟上.
--
-- SQLite 不支持直接 DROP NOT NULL → 走 12 步重建表流程
-- (runner 已经在每个 migration 跑之前关掉 foreign_keys · 这里不用手动关)

CREATE TABLE projects_new (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL,
  slug            TEXT NOT NULL,
  name            TEXT NOT NULL,
  desc            TEXT NOT NULL,
  product_link    TEXT,                          -- 改: NULL 允许
  status          TEXT NOT NULL,
  github_link     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  shipped_at      INTEGER,                       -- 从 006 来
  UNIQUE(owner_id, slug),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO projects_new (id, owner_id, slug, name, desc, product_link, status, github_link, created_at, updated_at, shipped_at)
SELECT id, owner_id, slug, name, desc, product_link, status, github_link, created_at, updated_at, shipped_at
FROM projects;

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

CREATE INDEX idx_projects_owner ON projects(owner_id);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_updated ON projects(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_shipped_at ON projects(shipped_at) WHERE shipped_at IS NOT NULL;

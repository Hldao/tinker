-- Tinker v0.3 initial schema
-- 单表设计哲学:
--   * 内部 id 用 TEXT (UUID v7 · 时间排序友好 · 不存 created_at 也能按 id 排)
--   * timestamp 用 INTEGER (Unix ms · 跟现有 at 一致 · 比 ISO string 紧凑)
--   * FK 用 user_id 不用 handle (handle 可改 · 改了不破坏 ownership)
--   * ON DELETE CASCADE 自动清理子表 · 不留孤儿
--   * 所有 UNIQUE 字段加 index (查询路径主力)

-- USERS · UUID 主键 · handle display · email verification
CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  handle          TEXT NOT NULL UNIQUE,
  email           TEXT UNIQUE,                  -- 可空 · 老用户 daodao 未绑邮箱时为 NULL
  name            TEXT,                          -- display name (默认 handle)
  tagline         TEXT,                          -- 一句话 · 我在做的事
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_users_handle ON users(handle);
CREATE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;

-- AUTH TOKENS · magic link 短期 token (5 min)
CREATE TABLE auth_tokens (
  token           TEXT PRIMARY KEY,              -- 随机 32 字符
  email           TEXT NOT NULL,
  user_id         TEXT,                          -- 邮箱已绑用户则填 · 新邮箱 = NULL
  intent          TEXT NOT NULL,                 -- 'login' (现在只有这个 · v0.5 加 'bind')
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  consumed_at     INTEGER,                       -- NULL = 未用 · 数字 = 用过的时间
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_auth_tokens_email ON auth_tokens(email);
CREATE INDEX idx_auth_tokens_expires ON auth_tokens(expires_at);

-- SESSIONS · 长期 cookie (90 天)
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,              -- 随机 64 字符 (= cookie 值)
  user_id         TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  last_seen_at    INTEGER,
  user_agent      TEXT,                          -- 仅 truncated · 给 user 看 "Mac · Chrome"
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- PROJECTS
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL,
  slug            TEXT NOT NULL,
  name            TEXT NOT NULL,
  desc            TEXT NOT NULL,
  product_link    TEXT NOT NULL,
  status          TEXT NOT NULL,                 -- active / stuck / done / paused / archive
  github_link     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(owner_id, slug),                        -- slug 在 owner 范围内唯一 (URL 用)
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_projects_owner ON projects(owner_id);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_updated ON projects(updated_at DESC);

-- PROJECT_TOOLS · 多对多
CREATE TABLE project_tools (
  project_id      TEXT NOT NULL,
  tool            TEXT NOT NULL,
  PRIMARY KEY (project_id, tool),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_project_tools_tool ON project_tools(tool);

-- UPDATES (进展)
CREATE TABLE updates (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  text            TEXT NOT NULL,
  prompt          TEXT,
  at              INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_updates_project ON updates(project_id, at DESC);

-- IMAGES · 复用对象 (一张图可被多 update / note 引用 · 但目前一对一)
CREATE TABLE images (
  id              TEXT PRIMARY KEY,
  src             TEXT NOT NULL,                 -- base64 data URI 或 (未来) OSS URL
  caption         TEXT,
  created_at      INTEGER NOT NULL
);

-- UPDATE_IMAGES · update 关联的图片 (有序)
CREATE TABLE update_images (
  update_id       TEXT NOT NULL,
  image_id        TEXT NOT NULL,
  position        INTEGER NOT NULL,
  PRIMARY KEY (update_id, image_id),
  FOREIGN KEY (update_id) REFERENCES updates(id) ON DELETE CASCADE,
  FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
);

CREATE INDEX idx_update_images_update ON update_images(update_id, position);

-- METHOD_USED · 给某条 update 反馈"用了 · 跑通了"
CREATE TABLE method_used (
  update_id       TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  note            TEXT,
  at              INTEGER NOT NULL,
  PRIMARY KEY (update_id, user_id),
  FOREIGN KEY (update_id) REFERENCES updates(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_method_used_user ON method_used(user_id);

-- REACTIONS · 现在只有 'wantToTry' · 之后可能扩展
CREATE TABLE reactions (
  project_id      TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  type            TEXT NOT NULL,                 -- 'wantToTry'
  at              INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id, type),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_reactions_user ON reactions(user_id);

-- TINKERED · 接走 / 延伸版
CREATE TABLE tinkered (
  id              TEXT PRIMARY KEY,
  parent_project_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  name            TEXT NOT NULL,
  link            TEXT NOT NULL,
  at              INTEGER NOT NULL,
  UNIQUE(parent_project_id, user_id),            -- 一个用户对同一父项目只能延伸一次
  FOREIGN KEY (parent_project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_tinkered_parent ON tinkered(parent_project_id);
CREATE INDEX idx_tinkered_user ON tinkered(user_id);

-- NOTES (便签)
CREATE TABLE notes (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  text            TEXT NOT NULL,
  at              INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_notes_project ON notes(project_id, at DESC);
CREATE INDEX idx_notes_user ON notes(user_id);

-- NOTE_IMAGES · note 关联的图片 (有序)
CREATE TABLE note_images (
  note_id         TEXT NOT NULL,
  image_id        TEXT NOT NULL,
  position        INTEGER NOT NULL,
  PRIMARY KEY (note_id, image_id),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
);

CREATE INDEX idx_note_images_note ON note_images(note_id, position);

-- NOTIFICATIONS
CREATE TABLE notifications (
  id              TEXT PRIMARY KEY,
  target_user_id  TEXT NOT NULL,
  from_user_id    TEXT NOT NULL,
  type            TEXT NOT NULL,                 -- tinkered / methodUsed / mentioned / projectDone / projectStuck / projectUnstuck / wantToTry / noted
  project_id      TEXT,
  extra           TEXT,                          -- 上下文文字 (例: 延伸版名字 / 便签内容片段)
  at              INTEGER NOT NULL,
  read_at         INTEGER,                       -- NULL = 未读
  FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE INDEX idx_notif_target ON notifications(target_user_id, at DESC);
CREATE INDEX idx_notif_unread ON notifications(target_user_id, read_at) WHERE read_at IS NULL;

-- STARTERS (入场仪式题目) · 简单 list · 直接 INSERT seed
CREATE TABLE starters (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  tool_url        TEXT NOT NULL,
  position        INTEGER NOT NULL
);

-- AVAILABLE_TOOLS · 工具白名单 · 简单 list
CREATE TABLE available_tools (
  tool            TEXT PRIMARY KEY,
  position        INTEGER NOT NULL
);

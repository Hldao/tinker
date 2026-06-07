-- v0.12 方法库 (`tinker borrow / contribute`)
-- 让 update 可以被升格为"方法论级" · 通过文本搜索后可被其他人借用
--
-- 设计:
--   - is_method 标记 · 简单 0/1 · 作者主动标
--   - SQLite FTS5 虚拟表索引 text + project name · 全文搜
--   - server 端不维护 ranking · 直接按 bm25 + 时间倒序
--
-- 用法:
--   tinker borrow "supabase auth"   搜
--   tinker contribute u-xxx          标自己某条 update 为方法
--   tinker contribute                自动找最近一条 push 标

ALTER TABLE updates ADD COLUMN is_method INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_updates_is_method
  ON updates(is_method) WHERE is_method = 1;

-- FTS5 虚拟表 · 索引 text + 上下文 (project name + owner handle)
-- trigram tokenizer · 让中文 / 拼音 / 英文都能子串搜 ("邮箱" "supabase" 都行)
-- 副作用是 index 体积大 · 但当前规模 < 几 MB · 可接受
CREATE VIRTUAL TABLE IF NOT EXISTS updates_fts USING fts5(
  text,
  project_name UNINDEXED,
  owner_handle UNINDEXED,
  update_id UNINDEXED,
  tokenize = 'trigram'
);

-- 把现有 update 全部填进 FTS · 不区分是否 method (搜全部 · 但优先返 is_method)
INSERT INTO updates_fts (text, project_name, owner_handle, update_id)
SELECT u.text, p.name, usr.handle, u.id
FROM updates u
JOIN projects p ON p.id = u.project_id
JOIN users usr ON usr.id = p.owner_id;

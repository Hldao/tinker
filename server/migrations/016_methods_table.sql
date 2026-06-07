-- v0.81 方法升格成 first-class entity (跟 updates / projects 平级)
-- 产品定位: GitHub 沉淀代码 · Tinker 沉淀方法 · 方法 = 工艺人的手艺资产
--
-- 不再是 updates.is_method=1 的 flag · 独立表 · 独立 CRUD · 独立 FTS
-- updates 表保留 is_method 一段时间 (向后兼容 + migration 017 backfill 源)
-- 等代码全切完后再删 (migration 018 · 那是另一回 PR)
--
-- 关键设计:
-- - owner_id 直属 user · 不强绑定 project (跨项目复用)
-- - project_id nullable · 可选关联 (contribute --from-file 时如果指定就关联)
-- - source_doc_path 记 contribute --from-file 来源 · 方便作者后期追溯
-- - 不存 borrow_count · join borrow_log 算 (避免 denormalize 跟脏数据)

CREATE TABLE IF NOT EXISTS methods (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT,                            -- 可选 · 后期产品演进可能加
  scenario TEXT,                         -- 一句话使用场景 (10-30 字)
  text TEXT NOT NULL,                    -- markdown 正文
  at INTEGER NOT NULL,                   -- 创建时间
  updated_at INTEGER NOT NULL,           -- 最后修改时间
  project_id TEXT,                       -- 可选关联项目
  source_update_id TEXT,                 -- 升格自哪条 update (markAsMethod 兼容路径)
  source_doc_path TEXT,                  -- contribute --from-file 时记来源
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);

-- borrow_log 加 method_id · 新写入用这列 · 老 update_id 留兼容
ALTER TABLE borrow_log ADD COLUMN method_id TEXT;
CREATE INDEX IF NOT EXISTS idx_borrow_log_method_at ON borrow_log(method_id, at DESC) WHERE method_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_methods_owner_at ON methods(owner_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_methods_project_at ON methods(project_id, at DESC) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_methods_at ON methods(at DESC);

-- FTS5 trigram 索引 · 跟 updates_fts 同一套 tokenizer · 支持中英混合搜
-- 2 字 CJK 走 LIKE 兜底 (跟 searchMethods 现有兜底逻辑一致)
CREATE VIRTUAL TABLE IF NOT EXISTS methods_fts USING fts5(
  text,
  scenario,
  owner_handle UNINDEXED,
  project_name UNINDEXED,
  method_id UNINDEXED,
  tokenize = 'trigram'
);

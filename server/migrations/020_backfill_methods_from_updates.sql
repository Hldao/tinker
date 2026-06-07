-- v0.81 把现有 updates is_method=1 的行复制到 methods 表
-- 一次性 backfill · 不删原 update (保留向后兼容 · 等代码全切完才删)
--
-- method_id 用 'm-' + 原 update_id 后段 · 让 borrow_log 后续可以映射
-- (borrow_log 现在 update_id 是历史 ref · 后续如果改字段名 method_id 可用同 ID 续接)

INSERT INTO methods (id, owner_id, title, scenario, text, at, updated_at, project_id, source_update_id, source_doc_path)
SELECT
  'm-' || substr(u.id, 3) AS id,        -- u-xxx → m-xxx 同序列号便于追溯
  p.owner_id,
  NULL AS title,
  u.scenario,
  u.text,
  u.at,
  u.at AS updated_at,                    -- 原 update 没记 updated_at · 用 at 兜底
  u.project_id,
  u.id AS source_update_id,              -- 记下升格来源 · 防重复升格 + unmark 可查
  NULL AS source_doc_path                -- 老数据没记 source · 留空
FROM updates u
JOIN projects p ON p.id = u.project_id
WHERE u.is_method = 1
  AND NOT EXISTS (SELECT 1 FROM methods m WHERE m.id = 'm-' || substr(u.id, 3));

-- 同步 FTS · 让 borrow 立刻能搜到新表里的方法
INSERT INTO methods_fts (text, scenario, owner_handle, project_name, method_id)
SELECT m.text, m.scenario, u.handle, p.name, m.id
FROM methods m
JOIN users u ON u.id = m.owner_id
LEFT JOIN projects p ON p.id = m.project_id
WHERE NOT EXISTS (SELECT 1 FROM methods_fts WHERE method_id = m.id);

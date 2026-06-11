-- 便签加「处理了」状态 · 项目主人把建议 / bug 类便签标成已处理
-- 给便签作者一个回响:你留的这条我看到了 · 并且动手了
-- resolved_at NULL = 还挂着 · 非 NULL = 已处理
-- resolved_by: 谁标的 (一般是项目主人) · ON DELETE SET NULL 保留便签本身
ALTER TABLE notes ADD COLUMN resolved_at INTEGER;
ALTER TABLE notes ADD COLUMN resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_notes_resolved ON notes(project_id, resolved_at);

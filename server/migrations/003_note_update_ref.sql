-- 便签可以可选地"标注"自己在说哪条进展(update)
-- 不嵌套·不允许 reply ·便签仍然在便签墙独立平等
-- 仅多一个上下文链接:留便签时可选"这条便签是说哪条进展" · 渲染时双向跳转
-- ON DELETE SET NULL: update 被删除后 · 便签退化为项目级·内容保留

ALTER TABLE notes ADD COLUMN update_id TEXT REFERENCES updates(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_notes_update_id ON notes(update_id);

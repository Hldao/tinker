-- v0.4 闭环修复
-- notifications.anchor: 通知点开后定位到具体 update / note / tinkered 行
--   值形如 'update-<update_id>' / 'note-<note_id>' / 'tinkered-<from_user_handle>'
--   webapp 用它做 scroll + flash 高亮 · 找不到锚点就退到项目页顶部
-- 兼容: 老通知 anchor=NULL · webapp 自动按 type 退化

ALTER TABLE notifications ADD COLUMN anchor TEXT;

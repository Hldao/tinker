-- v0.12 借用日志 (`tinker borrow` 的反馈回路)
-- 让作者知道自己写的方法被人用了 · 不是点赞分 · 是"我攒的笔记被用上了"
--
-- 设计:
--   - borrower_handle 可空 · 未登录用户 borrow 不计入 log
--   - 不存全 query 文本 (保留前 80 字符) · 隐私 + 体积
--   - 不暴露给 borrower (借了就借了) · 只让作者看
--   - 没有 cascade 删 · 借用记录保留 (作者删了 update 之后日志还在 · 用 update_id 软引用)

CREATE TABLE IF NOT EXISTS borrow_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id TEXT NOT NULL,
  owner_handle TEXT NOT NULL,       -- 被借者
  borrower_handle TEXT,             -- 借者 (可空 · 匿名)
  query_excerpt TEXT,               -- 关键词前 80 字符
  at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_borrow_log_owner_at
  ON borrow_log(owner_handle, at DESC);
CREATE INDEX IF NOT EXISTS idx_borrow_log_update_at
  ON borrow_log(update_id, at DESC);

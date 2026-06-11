-- 070_borrow_log_update_id_nullable.sql · 修一个一直在的 borrow 老 bug
--
-- 012 建 borrow_log 时 update_id 是 NOT NULL。019 把 methods 迁成独立表 ·
-- 借"方法"的日志写的是 update_id=null + method_id=xxx · 直接违反 NOT NULL。
-- 后果:登录用户第一次借"别人的"方法 (跨人借 · 方法库最核心的场景) →
--   borrow_log INSERT 抛错 → searchMethods 整个崩 → 接口 400。
-- 借自己的方法 (代码里跳过日志) 或 24h 内重复借 (dedup 跳过) 才侥幸没炸 ·
-- 所以 2-3 人内测一直没发现。
--
-- 修法:重建表让 update_id 可空 (老 update_id 软引用仍保留 · 新写入用 method_id)。

CREATE TABLE borrow_log_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id TEXT,                   -- 可空了 · 新写入走 method_id
  owner_handle TEXT NOT NULL,
  borrower_handle TEXT,
  query_excerpt TEXT,
  at INTEGER NOT NULL,
  method_id TEXT
);

INSERT INTO borrow_log_new (id, update_id, owner_handle, borrower_handle, query_excerpt, at, method_id)
  SELECT id, update_id, owner_handle, borrower_handle, query_excerpt, at, method_id FROM borrow_log;

DROP TABLE borrow_log;
ALTER TABLE borrow_log_new RENAME TO borrow_log;

CREATE INDEX IF NOT EXISTS idx_borrow_log_owner_at ON borrow_log(owner_handle, at DESC);
CREATE INDEX IF NOT EXISTS idx_borrow_log_update_at ON borrow_log(update_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_borrow_log_method_at ON borrow_log(method_id, at DESC) WHERE method_id IS NOT NULL;

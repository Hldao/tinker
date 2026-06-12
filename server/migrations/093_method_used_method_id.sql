-- 093 · method_used 支持 method_id · 让一等方法也能收「用了·跑通了」
--
-- 缺口:method_used 老 PK 是 (update_id, user_id) 且 update_id NOT NULL。
-- 但方法升格成一等表 (methods) 后,独立方法没有 update 可挂,收不到「用了」。
-- 借用环只有「借」(borrow_log 早加了 method_id) 没有「还」,反馈命脉漏在发现页。
--
-- 修法照 borrow_log 的双键路子:update_id 改可空 + 加 method_id · 两个部分唯一索引各管一种。
-- runner 跑迁移时已关 FK,DROP/RECREATE 安全。老数据 (update 键的) 原样搬过去。

CREATE TABLE method_used_new (
  update_id  TEXT,                  -- 老路径 · update 键 (项目页时间线那种)
  method_id  TEXT,                  -- 新路径 · 一等方法键 (发现页卡片那种)
  user_id    TEXT NOT NULL,
  note       TEXT,
  at         INTEGER NOT NULL,
  FOREIGN KEY (update_id) REFERENCES updates(id) ON DELETE CASCADE,
  FOREIGN KEY (method_id) REFERENCES methods(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO method_used_new (update_id, method_id, user_id, note, at)
  SELECT update_id, NULL, user_id, note, at FROM method_used;

DROP TABLE method_used;
ALTER TABLE method_used_new RENAME TO method_used;

-- 各管一种 · 同一人对同一目标只能标一次
CREATE UNIQUE INDEX idx_method_used_update_user ON method_used(update_id, user_id) WHERE update_id IS NOT NULL;
CREATE UNIQUE INDEX idx_method_used_method_user ON method_used(method_id, user_id) WHERE method_id IS NOT NULL;
CREATE INDEX idx_method_used_method ON method_used(method_id) WHERE method_id IS NOT NULL;

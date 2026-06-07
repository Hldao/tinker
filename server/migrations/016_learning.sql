-- v0.13 learning tag · Learning Sprint 第二个 lifecycle 产物
-- update 可以被作者(或 ai-learning-breakthrough 自动建议)标为"上手指南"
--
-- 设计:
--   - is_learning 标记 · 简单 0/1 · 跟 is_method / is_experience 同级
--   - 跟 is_experience 互不冲突 (一条 update 理论上可以同时是经验+指南 · 但实践少见)
--   - 主要使用者:
--       AI agent 检索时优先返这类 (帮其他人快速上手新技术)
--       webapp 搜索 / CLI borrow 显示 [上手指南] 标签
--
-- 用法:
--   tinker recent --kind learning              只看自己标过的上手指南
--   tinker mark-learning u-xxx                 标某条
--   tinker mark-learning u-xxx --unmark        取消标
--   tinker borrow "supabase realtime" --kind learning   专门搜上手指南
--   tinker push <file> --as-learning           autopsy 草稿一键发 + 自动标

ALTER TABLE updates ADD COLUMN is_learning INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_updates_is_learning
  ON updates(is_learning) WHERE is_learning = 1;

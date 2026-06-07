-- v0.13 decision tag · Design Loop 第三个 lifecycle 产物
-- update 可以被作者(或 ai-design-breakthrough 自动建议)标为"决策推演"
--
-- 设计:
--   - is_decision 标记 · 简单 0/1 · 跟 is_method / is_experience / is_learning 同级
--   - 主要使用者:
--       AI agent 检索时优先返这类 (帮其他人学 product sense)
--       webapp 搜索 / CLI borrow 显示 [决策推演] 标签
--
-- 用法:
--   tinker recent --kind decision              只看自己标过的决策推演
--   tinker mark-decision u-xxx                 标某条
--   tinker mark-decision u-xxx --unmark        取消标
--   tinker borrow "接走 启发" --kind decision   专门搜决策推演
--   tinker push <file> --as-decision           autopsy 草稿一键发 + 自动标
--   tinker situation backfill --hours 6        回溯历史推演

ALTER TABLE updates ADD COLUMN is_decision INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_updates_is_decision
  ON updates(is_decision) WHERE is_decision = 1;

-- v0.12 experience tag
-- update 可以被作者(或自动触发器)标为"踩坑经验" · 让其他 AI 检索时优先取
--
-- 设计:
--   - is_experience 标记 · 简单 0/1 · 跟 is_method 同级
--   - 主要使用者是 AI agent (检索时优先返这类) · webapp 不渲染特殊视觉
--   - 触发来源: 作者主动 tinker mark-experience <updateId> · 或 ai-debug-breakthrough 自动建议
--
-- 用法:
--   tinker recent --experience              只看自己标过的经验
--   tinker mark-experience u-xxx            标某条
--   tinker mark-experience u-xxx --unmark   取消标
--   (将来) GET /api/tinker/experiences      给其他 AI 检索

ALTER TABLE updates ADD COLUMN is_experience INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_updates_is_experience
  ON updates(is_experience) WHERE is_experience = 1;

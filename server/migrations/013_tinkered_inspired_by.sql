-- v0.12 接走语义升级 · 从"项目级 fork" 改成"update 级 启发"
-- 接走方填表时挑一条具体启发了 ta 的 update · 颗粒度从项目细化到进展
--
-- 设计:
--   - 字段可空 (NULL) · 兼容老 tinkered 数据 (老数据 fallback 到项目级渲染)
--   - 软引用 update_id · 不加 FK · update 被删了 tinkered 行仍然有效 (退化成项目级)
--   - 新提交的接走必填 inspired_by_update_id (webapp / server 双向强制)
--   - 通知 anchor 用 update-<id> · 原作者点通知能跳到具体那条进展
--
-- 用户文案变化 (webapp v0.12):
--   "做了延伸版" → "因 ta 启发也做了"
--   "接走过 · N 人" → "因这个启发动手 · N 人"
--   "被接走过 N" → "启发了 N 人动手"

ALTER TABLE tinkered ADD COLUMN inspired_by_update_id TEXT;

CREATE INDEX IF NOT EXISTS idx_tinkered_inspired_by
  ON tinkered(inspired_by_update_id) WHERE inspired_by_update_id IS NOT NULL;

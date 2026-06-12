-- v0.94 求方法 · 需求侧
--
-- 设计:
--   - updates.is_seeking = 1 表示这条是"求方法"请求 · 不是进展
--   - methods.seeking_update_id 记录这条方法是在回应哪个求方法请求
--   - 有回应时通知发起人
--
-- 使用流程:
--   tinker seek -m "我需要一个 X 的方法"      → 发求方法请求
--   tinker contribute --reply <updateId>       → 发方法时标记"这是回应"
--   webapp: 求方法 update 有"回应"按钮 → 直接开方法 modal

ALTER TABLE updates ADD COLUMN is_seeking INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_updates_seeking ON updates(is_seeking) WHERE is_seeking = 1;

ALTER TABLE methods ADD COLUMN seeking_update_id TEXT;
CREATE INDEX IF NOT EXISTS idx_methods_seeking ON methods(seeking_update_id) WHERE seeking_update_id IS NOT NULL;

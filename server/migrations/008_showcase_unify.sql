-- 陈列馆数据底座统一 · 不再依赖 kind=ship/prototype/design update 作入馆门票
--
-- 改动哲学:
--   进展 (updates) 和陈列馆 (showcase) 是同一份数据的两种视图。
--   进展是时间流, 陈列馆是项目分组聚合视图。
--
-- 入馆资格变更:
--   旧 · 项目必须有 kind=ship/prototype/design 的 update
--   新 · 项目 status != archive AND 有 ≥ 1 条 update AND NOT hidden_from_showcase
--
-- 完工 / 原型 / 设计仪式 (kind=ship/prototype/design) 保留, 但只决定 badge,
-- 不再是门票。即使没办过仪式, 项目也能在陈列馆里, 只是显示 "在做中" 状态。
--
-- 作者新增 2 个 override:
--   pinned_update_id · 哪条 update 当陈列馆 reflection 代表 (NULL = 自动选)
--   hidden_from_showcase · 暂时不在陈列馆出现 (0/1)

ALTER TABLE projects ADD COLUMN pinned_update_id TEXT;
ALTER TABLE projects ADD COLUMN hidden_from_showcase INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_projects_pinned_update ON projects(pinned_update_id) WHERE pinned_update_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_projects_hidden ON projects(hidden_from_showcase) WHERE hidden_from_showcase = 1;

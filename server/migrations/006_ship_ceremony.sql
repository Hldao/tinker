-- 完工 ceremony · 陈列馆基础
-- 一个项目"做完"是值得仪式感的时刻 · 不该静默 status 改成 done
--
-- 设计:
--   projects.shipped_at: 项目第一次进 done 状态的时刻 · 用来排序陈列馆
--   updates.kind: 'ship' 标记完工感想 (作者对完成的产品说一句话)
--              其他 update 的 kind 为 NULL (默认 'progress')
--   未来可能扩展:'stuck'(卡住时的反思)等

ALTER TABLE projects ADD COLUMN shipped_at INTEGER;
ALTER TABLE updates ADD COLUMN kind TEXT;
CREATE INDEX IF NOT EXISTS idx_projects_shipped_at ON projects(shipped_at) WHERE shipped_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_updates_kind ON updates(kind) WHERE kind IS NOT NULL;

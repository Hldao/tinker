-- v0.41 项目归属字段 · 个人作品 vs 工作室作品的显式标记
--
-- 之前 studio 聚合页查 "成员的所有 project" · 用户加入工作室后所有作品都被聚合
-- 上去 · 没法区分哪些是真协作哪些是单干。加 studio_id 字段后:
--   - studio_id IS NULL → 个人作品 (solo)
--   - studio_id 指向某 studio → 挂在该工作室的作品
-- 一个项目只能归一个工作室 (不支持跨)
--
-- 上线时自动数据迁移:对所有已经在工作室的用户 · 把 ta 的项目默认 attribute
-- 到 ta 最早加入的工作室。这样上线第一时间 studio 聚合页保持现状 · 用户后续
-- 可以 tinker project attribute --solo 把单人作品拿出去。

ALTER TABLE projects ADD COLUMN studio_id TEXT REFERENCES studios(id);
CREATE INDEX idx_projects_studio_id ON projects(studio_id);

-- 已经在工作室的成员 · 项目默认挂到 ta 最早加入的工作室
-- 不在工作室的用户 · 项目仍为 NULL (solo)
UPDATE projects
SET studio_id = (
  SELECT studio_id FROM studio_members
  WHERE user_id = projects.owner_id
  ORDER BY joined_at ASC
  LIMIT 1
)
WHERE studio_id IS NULL
  AND owner_id IN (SELECT user_id FROM studio_members);

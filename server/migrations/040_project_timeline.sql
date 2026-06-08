-- v0.32 · 项目编年史字段
-- 一段 markdown · 节点 + 总结 · ship 之后挂在项目页头部
-- 没 ship 的项目不显示这玩意 · 半成品挂"编年史"反而尴尬
--
-- 不另起 timeline_nodes 表 · 一段 markdown 字段足够 · 用户改方便 · 不绑数据结构
-- LLM 起草后落到客户端 .tinker/drafts/timeline-<projectId>.md · 用户编辑后 push 上来

ALTER TABLE projects ADD COLUMN timeline TEXT;

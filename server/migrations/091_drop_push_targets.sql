-- 091_drop_push_targets.sql · 撤掉 090 的 push_targets
--
-- 探索结论 (2026-06-11):个人创作者做 vibe coding 时人就在电脑前 · 手机推送是伪需求 ·
-- 还逼人装 app。离线收件「回来即补桌面摘要」就够 · 不需要 server 往手机 fan-out。
-- 保留的是 Claude Code 本地桌面通知 (要权限 / 长任务跑完) · 那条不碰这张表。
--
-- 090 当历史留着 (migration append-only · 已上线不删) · 这里把表 drop 掉收尾。
DROP INDEX IF EXISTS idx_push_targets_uniq;
DROP INDEX IF EXISTS idx_push_targets_user;
DROP TABLE IF EXISTS push_targets;

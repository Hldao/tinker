-- v0.35 · 通知偏好统一闭环
-- 一个用户一行 · web + cli + 桥都拉这一张表的字段
-- 字段语义:
--   muted_until           — 全局勿扰到 X 时刻 (ms epoch) · null 表示不勿扰
--   quiet_start / quiet_end — 夜间静默时段 (本地 HH:MM 字符串) · 跨午夜也支持
--                              start=null 或 end=null 表示没设
--   cli_disabled_kinds    — JSON 数组 · 关掉的 CLI 触发器 kind 列表 (比如 ["frustrated","tool-combo"])
--   web_mute_weak         — bool · 站内通知里隐藏 wantToTry + noted (弱信号)
-- timezone 信息暂不存 · 默认按客户端当地时间判断 quiet hours (CLI 直接用 system 时间)

CREATE TABLE IF NOT EXISTS user_prefs (
  user_id              TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  muted_until          INTEGER,
  quiet_start          TEXT,
  quiet_end            TEXT,
  cli_disabled_kinds   TEXT NOT NULL DEFAULT '[]',
  web_mute_weak        INTEGER NOT NULL DEFAULT 0,
  updated_at           INTEGER NOT NULL
);

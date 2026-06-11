-- 090_push_targets.sql · 个人推送目标 (server 端存一份)
--
-- 桥消息落库时 · server 按收件人查这张表 · POST 一条不带内容的提醒到手机 (Bark)
-- 你本地什么都不用开 · 不用挂 watch。E2E 不破:server 只看信封路由 (谁发给谁 / 什么类型) · 不解密内容。
--
-- 跟 CLI 本地 config 的 notify.targets 分工:
--   本地那份 → "发送方直推" (你的 AI 在你机器上跑完 · 直接 POST 你手机)
--   这一份   → "server 推" (别人经桥发给你 · 你不在场也能收)
--
-- 只存 server 推得动的类型 (bark) · mac 桌面横幅是本地的 · 不进这张表
CREATE TABLE push_targets (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  type       TEXT NOT NULL,        -- 'bark' (将来可加别的中继)
  url        TEXT NOT NULL,        -- 含 device key 的推送地址
  label      TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_push_targets_user ON push_targets(user_id);
CREATE UNIQUE INDEX idx_push_targets_uniq ON push_targets(user_id, url);

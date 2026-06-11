-- 092_stashes.sql · 个人现场暂存 (跨设备 / 跨时间的 stash)
--
-- 一个人在 A 机器写一半 · 把现场 (situation + git diff + voice + cwd) 打包存这里 ·
-- 到 B 机器拉下来重放接着写。比 git stash 多了"卡在哪 + 当时 AI 的思路"。
-- 不靠工作室 · 按 user_id 隔离 · 同一个账号的设备都能取自己的 stash。
--
-- payload: JSON 化的 dossier · encrypted=1 时是密文 (用户本地口令 AES-GCM · server 看不到内容)
--          encrypted=0 时明文 (用户自己选的零设置档 · server 可读)
-- label: 用户给的一句话 (始终明文 · 就是个标签 · 用来 list 时认出是哪个现场)
CREATE TABLE stashes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  label       TEXT,
  payload     TEXT NOT NULL,
  encrypted   INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_stashes_user ON stashes(user_id, created_at DESC);

-- 032_studio_invites.sql · 工作室 e2e 邀请通道
--
-- 目的:
--   owner 邀请别人加入 · 不用直接发明文 studio secret
--   token 短 (8 字符) · 比 secret (32 字符) 更好复制粘贴
--
-- e2e 设计:
--   1) owner 客户端生成 token (8 字节随机) · 算 tokenHash = sha256(token)
--   2) owner 客户端用 token 当 AES key · 加密 studio secret 得 secretCipher
--   3) POST /api/studios/:id/invite { targetHandle, tokenHash, secretCipher }
--      server 存 (tokenHash, secretCipher) · server 不知 token 原文 · 解不开 secretCipher
--   4) owner 把 token 通过任意渠道发给 maomao (微信 / 桥 / 面对面)
--   5) maomao 跑 tinker studio accept <token>
--      client 算 tokenHash → server 查 invite · 校验 target_user_id = currentUser
--      server 返 secretCipher · maomao client 用 token 解出 secret · 写本地
--      accept 后 invite 删 (一次性 · 防重放)
--
-- server 全程看不到 studio secret · token 短 + 一次性 + 限 target user

CREATE TABLE studio_invites (
  token_hash      TEXT PRIMARY KEY,           -- sha256(token) · server 不存 token 原文
  studio_id       TEXT NOT NULL,
  target_user_id  TEXT NOT NULL,              -- 必须是这个 user 才能 accept · 防别人拿到 token 滥用
  secret_cipher   TEXT NOT NULL,              -- base64( iv | authTag | AES-GCM(studio_secret, key=token) )
  invited_by      TEXT NOT NULL,              -- owner user_id · 审计用
  expires_at      INTEGER NOT NULL,           -- 24h 过期
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (studio_id) REFERENCES studios(id) ON DELETE CASCADE,
  FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_studio_invites_target ON studio_invites(target_user_id);
CREATE INDEX idx_studio_invites_studio ON studio_invites(studio_id);

-- API tokens · 给 CLI / 第三方 client 用
-- 不存原 token · 只存 SHA-256 hash · 显示一次就消失
-- 用户能在 web 上生成 / 看 / 撤销
-- 鉴权方式:HTTP header `Authorization: Bearer <token>`

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT,                          -- 用户起的名 "Cursor / 我的笔记本" 这种
  token_hash TEXT NOT NULL UNIQUE,     -- SHA-256 hex
  prefix TEXT NOT NULL,                -- token 前 8 位 · 给用户用来识别 ("tk_abc12... 跑过期")
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash) WHERE revoked_at IS NULL;

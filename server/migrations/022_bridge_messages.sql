-- 022_bridge_messages.sql · bridge 私信通道地基
--
-- 跟 update / method 不同 · message 是点对点的加密私信:
--   - server 只存密文 (payload = AES-256-GCM 信封 base64) · 不解密
--   - to_handle 明文 (路由要用) · NULL 表示广播
--   - 暗号 (sha256) 在客户端 · server 没有
--
-- 客户端用 seq 做 cursor 拉新:GET /api/bridge/poll?since=<seq>
-- 长轮询 (server 没新消息时挂 25s · 期间收到新消息立刻 resolve)
--
-- kind 三种:
--   'noti' · 通知 / ping (短文本)
--   'file' · 文件传输 (payload 含 base64 + 元数据)
--   'task' · handoff 接力 (payload 含 dossier ref + acceptance · Phase 2)

CREATE TABLE messages (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  from_handle TEXT NOT NULL,
  to_handle   TEXT,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_messages_to_seq ON messages(to_handle, seq);
CREATE INDEX idx_messages_from ON messages(from_handle);

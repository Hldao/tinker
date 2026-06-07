// bridge · 加密私信通道
//
// 这里只管路由 + 长轮询门铃。内容是 AES-256-GCM 密文 · server 不解密 · 看不到。
//
// kind 三种:
//   'noti' · 短文本通知 / ping
//   'file' · 文件传输 (payload 含 base64 + 元数据)
//   'task' · handoff 接力 (Phase 2 · payload 含 dossier ref + acceptance)
//
// 长轮询:client GET /api/bridge/poll?since=<seq> · server 没新消息时挂 25s
// (期间 send 进来立刻唤醒 · 用内存 waiter 不要 polling DB)
//
// payload 大小上限 10MB · 大文件应该分块 (Phase 3 再说)

const db = require('./db');
const crypto = require('crypto');

const KINDS = new Set(['noti', 'file', 'task']);
const MAX_PAYLOAD = 10 * 1024 * 1024;

// handle → Set<callback> · send 时 notifyWaiters 唤醒
const waiters = new Map();

function bridgeSend({ to, kind, payload }, { currentUserId }) {
  if (!KINDS.has(kind)) throw new Error('unknown kind: ' + kind);
  if (!payload || typeof payload !== 'string') throw new Error('payload required (string)');
  if (payload.length > MAX_PAYLOAD) throw new Error('payload 超 10MB · 大文件拆块');

  const fromRow = db.prepare('SELECT handle FROM users WHERE id = ?').get(currentUserId);
  if (!fromRow) throw new Error('发送方 user not found');

  const id = 'msg-' + crypto.randomBytes(8).toString('hex');
  const createdAt = Date.now();
  const result = db.prepare(`
    INSERT INTO messages (id, from_handle, to_handle, kind, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, fromRow.handle, to || null, kind, payload, createdAt);

  notifyWaiters(to || null);
  return { id, seq: result.lastInsertRowid, createdAt };
}

function bridgePoll({ since, handle }) {
  return db.prepare(`
    SELECT seq, id, from_handle AS fromHandle, to_handle AS toHandle,
           kind, payload, created_at AS createdAt
    FROM messages
    WHERE seq > ? AND (to_handle = ? OR to_handle IS NULL)
    ORDER BY seq ASC
    LIMIT 100
  `).all(since || 0, handle);
}

// 长轮询挂起 · timeoutMs 内没消息返 'timeout' · 期间被唤醒返 'signal'
function waitForMessages(handle, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let cb;
    const tid = setTimeout(() => {
      if (cb) removeWaiter(handle, cb);
      resolve('timeout');
    }, timeoutMs);
    cb = () => { clearTimeout(tid); resolve('signal'); };
    if (!waiters.has(handle)) waiters.set(handle, new Set());
    waiters.get(handle).add(cb);
  });
}

function removeWaiter(handle, cb) {
  const set = waiters.get(handle);
  if (!set) return;
  set.delete(cb);
  if (set.size === 0) waiters.delete(handle);
}

// to_handle === null 是广播 · 唤醒所有 listener
// 否则只唤醒该 handle 的 listener (广播 listener 也覆盖 · 因为 poll WHERE 已含 IS NULL)
function notifyWaiters(toHandle) {
  if (toHandle === null) {
    for (const [h, set] of waiters) {
      for (const cb of set) cb();
    }
    waiters.clear();
    return;
  }
  const set = waiters.get(toHandle);
  if (!set) return;
  for (const cb of set) cb();
  waiters.delete(toHandle);
}

module.exports = { bridgeSend, bridgePoll, waitForMessages };

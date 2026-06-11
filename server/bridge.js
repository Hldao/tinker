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
const studios = require('./studios');

const KINDS = new Set(['noti', 'file', 'task']);
const MAX_PAYLOAD = 10 * 1024 * 1024;

// 路由 key → Set<callback>
// key 形式:'handle:<h>' / 'studio:<id>' / '*' (广播)
const waiters = new Map();

function bridgeSend({ to, toStudio, kind, payload }, { currentUserId }) {
  if (!KINDS.has(kind)) throw new Error('unknown kind: ' + kind);
  if (!payload || typeof payload !== 'string') throw new Error('payload required (string)');
  if (payload.length > MAX_PAYLOAD) throw new Error('payload 超 10MB · 大文件拆块');

  const fromRow = db.prepare('SELECT handle FROM users WHERE id = ?').get(currentUserId);
  if (!fromRow) throw new Error('发送方 user not found');

  // 工作室维度的消息:必须是该 studio 成员才能往里扔
  if (toStudio) {
    if (!studios.isMember(toStudio, currentUserId)) {
      throw new Error('你不在这个工作室里 · 不能往里发');
    }
  }

  const id = 'msg-' + crypto.randomBytes(8).toString('hex');
  const createdAt = Date.now();
  const result = db.prepare(`
    INSERT INTO messages (id, from_handle, to_handle, to_studio, kind, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, fromRow.handle, to || null, toStudio || null, kind, payload, createdAt);

  if (toStudio) notifyWaiters('studio:' + toStudio);
  else if (to) notifyWaiters('handle:' + to);
  else notifyWaiters('*');

  return { id, seq: result.lastInsertRowid, createdAt };
}

// userId 用来算 user 加入的 studio 列表 · 一次拉所有相关消息
function bridgePoll({ since, handle, userId }) {
  const studioIds = userId
    ? db.prepare('SELECT studio_id FROM studio_members WHERE user_id = ?').all(userId).map(r => r.studio_id)
    : [];

  // 动态拼 studio 占位符 · 没工作室时跳过该分支
  const studioClause = studioIds.length > 0
    ? `OR to_studio IN (${studioIds.map(() => '?').join(',')})`
    : '';

  const sql = `
    SELECT seq, id, from_handle AS fromHandle, to_handle AS toHandle,
           to_studio AS toStudio, kind, payload, created_at AS createdAt
    FROM messages
    WHERE seq > ?
      AND (to_handle = ? OR (to_handle IS NULL AND to_studio IS NULL) ${studioClause})
    ORDER BY seq ASC
    LIMIT 100
  `;
  return db.prepare(sql).all(since || 0, handle, ...studioIds);
}

// 长轮询挂起 · 同时挂在 handle key 跟所有 studio key 上 · 任一被唤醒就 resolve
function waitForMessages({ handle, userId }, timeoutMs = 25000) {
  const studioIds = userId
    ? db.prepare('SELECT studio_id FROM studio_members WHERE user_id = ?').all(userId).map(r => r.studio_id)
    : [];

  const keys = ['handle:' + handle, '*', ...studioIds.map(id => 'studio:' + id)];

  return new Promise((resolve) => {
    let done = false;
    const tid = setTimeout(() => {
      if (done) return;
      done = true;
      for (const k of keys) removeWaiter(k, cb);
      resolve('timeout');
    }, timeoutMs);
    const cb = () => {
      if (done) return;
      done = true;
      clearTimeout(tid);
      for (const k of keys) removeWaiter(k, cb);
      resolve('signal');
    };
    for (const k of keys) {
      if (!waiters.has(k)) waiters.set(k, new Set());
      waiters.get(k).add(cb);
    }
  });
}

function removeWaiter(key, cb) {
  const set = waiters.get(key);
  if (!set) return;
  set.delete(cb);
  if (set.size === 0) waiters.delete(key);
}

// '*' 唤醒所有 (广播) · 其它 key 只唤醒匹配的
function notifyWaiters(key) {
  if (key === '*') {
    for (const [, set] of waiters) {
      for (const cb of set) cb();
    }
    return;
  }
  const set = waiters.get(key);
  if (!set) return;
  for (const cb of [...set]) cb();
}

module.exports = { bridgeSend, bridgePoll, waitForMessages };

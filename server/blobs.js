// bridge blobs · handoff 重料的内容寻址存储 (Phase 2 懒取)
//
// 跟 messages 一样 · server 只存密文 · 看不到内容。
// 区别:blob 按 sha256(明文) 寻址 · 同工作室内容相同自动去重。
// 命名空间按 studio_id 隔 · PUT/GET 都要校验成员关系。

const db = require('./db');
const studios = require('./studios');

const MAX_BLOB = 10 * 1024 * 1024;
const HASH_RE = /^[0-9a-f]{64}$/;

// 存 blob · 已存在 (同 studio 同 hash) 就跳过 · 返 { existed }
// 去重靠这里:客户端发前先 PUT · existed=true 说明别人/上次已传过 · 不重复占空间
function blobPut({ studioId, hash, payload, bytes }, { currentUserId }) {
  if (!studioId) throw new Error('blob 要 studioId');
  if (!hash || !HASH_RE.test(hash)) throw new Error('hash 必须是 64 位 hex (sha256)');
  if (!payload || typeof payload !== 'string') throw new Error('payload required (string)');
  if (payload.length > MAX_BLOB) throw new Error('blob 超 10MB');
  if (!studios.isMember(studioId, currentUserId)) {
    throw new Error('你不在这个工作室里 · 不能往里存 blob');
  }

  const exists = db.prepare('SELECT 1 FROM bridge_blobs WHERE studio_id = ? AND hash = ?').get(studioId, hash);
  if (exists) return { existed: true, hash };

  db.prepare(`
    INSERT INTO bridge_blobs (studio_id, hash, payload, bytes, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(studioId, hash, payload, bytes || payload.length, Date.now());
  return { existed: false, hash };
}

// 取 blob · 校验成员 · 返 { payload } · 没有返 null (路由转 404)
function blobGet({ studioId, hash }, { currentUserId }) {
  if (!studioId) throw new Error('blob 要 studioId');
  if (!hash || !HASH_RE.test(hash)) throw new Error('hash 必须是 64 位 hex (sha256)');
  if (!studios.isMember(studioId, currentUserId)) {
    throw new Error('你不在这个工作室里 · 不能取这个 blob');
  }
  const row = db.prepare('SELECT payload, bytes FROM bridge_blobs WHERE studio_id = ? AND hash = ?').get(studioId, hash);
  if (!row) return null;
  return { payload: row.payload, bytes: row.bytes };
}

module.exports = { blobPut, blobGet };

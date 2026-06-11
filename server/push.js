// push · server 端把"有新消息"推到收件人的手机 (Bark)
//
// 桥消息落库时 (bridge.bridgeSend) fire-and-forget 调 fanoutMessagePush。
// 你本地不用挂 watch · 不用开任何进程。
//
// E2E 不破:这里只用信封上的路由元数据 (谁发的 fromHandle · 什么类型 kind) ·
// 不碰加密 payload。推过去的是一句"@x 发来一条消息" · 真内容你点开 webapp/CLI 看。

const db = require('./db');

function targetsForUser(userId) {
  try {
    return db.prepare('SELECT type, url, label FROM push_targets WHERE user_id = ?').all(userId);
  } catch {
    return []; // 表还没迁移 (理论上启动即迁) · 静默
  }
}

// Bark: POST base url (含 device key) · JSON · fire-and-forget · 失败静默
async function pushBark(url, { title, body, level }) {
  if (typeof fetch !== 'function') return;
  const payload = { title: title || 'Tinker', body: body || '', group: 'Tinker' };
  payload.sound = level === 'urgent' ? 'alarm' : 'birdsong';
  if (level === 'urgent') payload.level = 'timeSensitive';
  try {
    const ctrl = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: ctrl,
    });
  } catch { /* 推送失败不挡发消息 */ }
}

function pushToUser(userId, msg) {
  for (const t of targetsForUser(userId)) {
    if (t.type === 'bark') pushBark(t.url, msg); // 不 await · 后台跑
  }
}

function summarize(kind, fromHandle) {
  const f = '@' + (fromHandle || '?');
  if (kind === 'task') return f + ' 发来接力包';
  if (kind === 'file') return f + ' 发来文件';
  return f + ' 发来一条消息';
}

// 一条桥消息 → 推给它的收件人
//   to (handle)  → 那个人
//   toStudio     → 工作室成员 (去掉发送方)
//   广播 (都没)  → 不推 (避免轰炸所有人)
function fanoutMessagePush({ to, toStudio, fromHandle, fromUserId, kind }) {
  let recipientIds = [];
  if (to) {
    const u = db.prepare('SELECT id FROM users WHERE handle = ?').get(to);
    if (u && u.id !== fromUserId) recipientIds = [u.id];
  } else if (toStudio) {
    recipientIds = db
      .prepare('SELECT user_id FROM studio_members WHERE studio_id = ? AND user_id != ?')
      .all(toStudio, fromUserId)
      .map(r => r.user_id);
  } else {
    return; // 广播不推
  }
  const body = summarize(kind, fromHandle);
  for (const uid of recipientIds) {
    pushToUser(uid, { title: 'Tinker', body });
  }
}

module.exports = { fanoutMessagePush, pushToUser, targetsForUser };

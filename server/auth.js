// 鉴权 · 邮箱 magic link + 长期 session cookie
//
// 三个对外函数:
//   - sendMagicLink(email) → 建 auth_token + 发邮件
//   - verifyMagicLink(token, userAgent) → 验 token + 找/建 user + 建 session
//   - getSession(req) → 从 cookie 读 session · 返回 user (或 null)
//
// Express middleware: attachSession(req, res, next) → req.user / req.session
// requireSession(req, res, next) → 没 session 返 401

const crypto = require('crypto');
const db = require('./db');
const { sendLoginEmail } = require('./email');

const TOKEN_TTL_MS = 5 * 60 * 1000;        // 5 分钟
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;  // 90 天
const COOKIE_NAME = 'tinker_session';

// BASE_URL · magic link 用 · 优先 env · fallback 用 request 的 origin (在 endpoint 里组装)
const BASE_URL = process.env.BASE_URL || '';

// 邮箱 → 推测 handle (local-part · 清洗非法字符)
function deriveHandle(email) {
  const localPart = (email.split('@')[0] || 'user').toLowerCase();
  return localPart.replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'user';
}

// handle 唯一性: 如果已存在则加数字后缀直到唯一
function findUniqueHandle(base) {
  const exists = db.prepare('SELECT 1 FROM users WHERE handle = ?');
  if (!exists.get(base)) return base;
  for (let i = 2; i < 999; i++) {
    const candidate = base + i;
    if (!exists.get(candidate)) return candidate;
  }
  return base + Date.now().toString(36).slice(-4); // fallback
}

// ============================================
// 1. 发 magic link
// ============================================
async function sendMagicLink({ email, baseUrl }) {
  email = (email || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('邮箱格式不对');
  }

  // 找有没有已绑这个邮箱的 user
  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);

  const token = db.randomToken(24);
  const now = Date.now();

  db.prepare(`INSERT INTO auth_tokens
    (token, email, user_id, intent, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    token, email, existingUser?.id || null, 'login', now, now + TOKEN_TTL_MS
  );

  const magicLink = `${baseUrl || BASE_URL}/api/auth/verify?token=${token}`;
  await sendLoginEmail(email, magicLink);

  return { sentTo: email, isNewEmail: !existingUser };
}

// ============================================
// 2. 验证 magic link → 建/找 user + 建 session
// ============================================
function verifyMagicLink({ token, userAgent }) {
  const row = db.prepare('SELECT * FROM auth_tokens WHERE token = ?').get(token);
  if (!row) throw new Error('链接无效');
  if (row.consumed_at) throw new Error('这个链接已经用过了 · 重发一封');
  if (row.expires_at < Date.now()) throw new Error('这个链接超时了 · 重发一封');

  // 找或建 user
  let userId = row.user_id;
  let isNew = false;
  if (!userId) {
    // 第一次 · 自动建 user
    userId = db.uuidv7();
    const handle = findUniqueHandle(deriveHandle(row.email));
    const now = Date.now();
    db.prepare(`INSERT INTO users
      (id, handle, email, name, tagline, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?)`).run(
      userId, handle, row.email, handle, now, now
    );
    isNew = true;
  }

  // 标记 token 已用
  db.prepare('UPDATE auth_tokens SET consumed_at = ? WHERE token = ?').run(Date.now(), token);

  // 建 session
  const sessionId = db.randomToken(32);
  const now = Date.now();
  db.prepare(`INSERT INTO sessions
    (id, user_id, created_at, expires_at, last_seen_at, user_agent)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    sessionId, userId, now, now + SESSION_TTL_MS, now, (userAgent || '').slice(0, 200)
  );

  return { sessionId, userId, isNew };
}

// ============================================
// 3. 从 cookie 读 session → user
// ============================================
function getSession(req) {
  const sessionId = req.cookies?.[COOKIE_NAME];
  if (!sessionId) return null;

  const row = db.prepare(`
    SELECT s.id AS session_id, s.expires_at, s.last_seen_at,
           u.id, u.handle, u.email, u.name, u.tagline, u.created_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ?
  `).get(sessionId, Date.now());

  if (!row) return null;

  // 更新 last_seen (异步 · 不阻塞)
  setImmediate(() => {
    try {
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(Date.now(), row.session_id);
    } catch (e) { /* swallow */ }
  });

  return {
    sessionId: row.session_id,
    user: {
      id: row.id,
      handle: row.handle,
      email: row.email,
      name: row.name,
      tagline: row.tagline,
      createdAt: row.created_at,
      needsWelcome: row.tagline === null, // tagline NULL = 新用户没走过 welcome
    },
  };
}

// ============================================
// 4. logout
// ============================================
function destroySession(sessionId) {
  if (!sessionId) return;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

// ============================================
// 5. Express middleware
// ============================================
function attachSession(req, res, next) {
  // 优先 cookie session (web 浏览)
  req.session = getSession(req);
  // 没 session · 试 Bearer API token (CLI / 第三方 agent)
  if (!req.session) {
    const apiUser = getApiTokenUser(req);
    if (apiUser) {
      req.session = { sessionId: null, user: apiUser, viaApiToken: true };
    }
  }
  req.user = req.session?.user || null;
  next();
}

// 从 Authorization: Bearer <token> header 读 token · 找对应 user
function getApiTokenUser(req) {
  const authHeader = req.headers.authorization || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  if (!token) return null;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db.prepare(`
    SELECT t.id AS token_id, u.id, u.handle, u.email, u.name, u.tagline, u.created_at
    FROM api_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ? AND t.revoked_at IS NULL
  `).get(hash);
  if (!row) return null;
  // last_used_at 异步更新
  setImmediate(() => {
    try {
      db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), row.token_id);
    } catch (e) { /* swallow */ }
  });
  return {
    id: row.id,
    handle: row.handle,
    email: row.email,
    name: row.name,
    tagline: row.tagline,
    createdAt: row.created_at,
    needsWelcome: false, // 已有 token 的用户必然已经走过 welcome
  };
}

// ============================================
// API token CRUD (给 CLI / agent 用)
// ============================================
function createApiToken({ userId, label }) {
  const tokenId = db.uuidv7();
  // 32 字节随机 → base64url ~43 字符 · 加 'tk_' 前缀方便识别
  const rawToken = 'tk_' + db.randomToken(32);
  const prefix = rawToken.slice(0, 11); // tk_xxxxxxxx 给用户用来识别
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
  db.prepare(`
    INSERT INTO api_tokens (id, user_id, label, token_hash, prefix, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tokenId, userId, (label || '').slice(0, 80) || null, hash, prefix, Date.now());
  return { id: tokenId, token: rawToken, prefix, label: label || null };
}

function listApiTokens(userId) {
  return db.prepare(`
    SELECT id, label, prefix, last_used_at, created_at
    FROM api_tokens
    WHERE user_id = ? AND revoked_at IS NULL
    ORDER BY created_at DESC
  `).all(userId);
}

function revokeApiToken({ userId, tokenId }) {
  const result = db.prepare(`
    UPDATE api_tokens SET revoked_at = ?
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL
  `).run(Date.now(), tokenId, userId);
  return result.changes > 0;
}

function requireSession(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '需要登录' });
  next();
}

// ============================================
// 6. Welcome (新用户填 handle / tagline)
// ============================================
function completeWelcome({ userId, handle, tagline }) {
  if (!handle || !/^[a-zA-Z0-9_一-龥]{1,20}$/.test(handle)) {
    throw new Error('handle 只能 1-20 字 · 字母/数字/下划线/中文');
  }
  tagline = (tagline || '').trim().slice(0, 80);

  // handle 冲突检查 (不是自己)
  const existing = db.prepare('SELECT id FROM users WHERE handle = ? AND id != ?').get(handle, userId);
  if (existing) throw new Error('这个 handle 被人用了 · 换一个');

  db.prepare(`UPDATE users SET
    handle = ?, name = ?, tagline = ?, updated_at = ?
    WHERE id = ?`).run(
    handle, handle, tagline || '刚进来捣鼓...', Date.now(), userId
  );

  return db.prepare('SELECT id, handle, email, name, tagline FROM users WHERE id = ?').get(userId);
}

module.exports = {
  sendMagicLink,
  verifyMagicLink,
  getSession,
  destroySession,
  attachSession,
  requireSession,
  completeWelcome,
  createApiToken,
  listApiTokens,
  revokeApiToken,
  COOKIE_NAME,
  SESSION_TTL_MS,
};

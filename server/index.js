// Tinker server — Express API
//
// 提供:
//   GET  /api/state    — 获取整个 state
//   POST /api/action   — { type, payload, currentUser } 触发 mutation
//   GET  /api/health   — 健康检查 (uptime + 存储 + 内存)
//   POST /api/reset    — 重置到 seed (开发用)
//   GET  /             — webapp/index.html
//
// 数据存储: JSON 文件 (data.json) · 原子写入 + backup rotation
// 安全: helmet 加固 + CORS + rate limit + 错误中间件

require('dotenv').config();

const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const cookieParser = require('cookie-parser');
const path = require('path');

const { logger } = require('./logger');
const db = require('./db');                  // SQLite · 启动时自动跑 migrations
const { buildState } = require('./state');
const actions = require('./actions-sql');
const bridge = require('./bridge');
const blobs = require('./blobs');
const studios = require('./studios');
const auth = require('./auth');
const prefs = require('./prefs');

// ============================================
// 配置
// ============================================
const PORT = parseInt(process.env.PORT || '8788', 10);
const WEBAPP_DIR = path.join(__dirname, '..', 'webapp');
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const RATE_LIMIT_ACTION = parseInt(process.env.RATE_LIMIT_ACTION || '60', 10);
const RATE_LIMIT_STATE = parseInt(process.env.RATE_LIMIT_STATE || '300', 10);
const BODY_LIMIT = process.env.BODY_LIMIT || '10mb';
const STARTED_AT = Date.now();

// ============================================
// SQLite · 已在 db.js 单例里 · migrations 自动跑
// 自动迁移: 如果 DB 是空的 + 找到 DATA_FILE (data.json) · 自动跑迁移
// 一次性 · 之后 DB 有内容就不再触发
// ============================================
{
  const u = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const p = db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;
  logger.info({ users: u, projects: p }, 'SQLite ready');

  const DATA_FILE = process.env.DATA_FILE;
  if (u === 0 && DATA_FILE && require('fs').existsSync(DATA_FILE)) {
    logger.info({ src: DATA_FILE }, '空 DB + 找到 data.json · 自动迁移...');
    try {
      const { migrateFromJson } = require('./migrate-from-json');
      const counts = migrateFromJson({
        jsonPath: DATA_FILE,
        log: (msg) => logger.info(msg),
        warn: (msg) => logger.warn(msg),
      });
      logger.info(counts, '✓ 自动迁移完成 · data.json → SQLite');
    } catch (e) {
      logger.error({ err: e.message }, '自动迁移失败');
    }
  } else if (u === 0) {
    logger.warn('数据库为空 · 等首位用户 magic link 注册');
  }
}

// ============================================
// Express setup
// ============================================
const app = express();

// 信任反代 (nginx / caddy / cloudflare 等)
app.set('trust proxy', 1);

// gzip / brotli 压缩 · /api/state 全是 base64 高度可压 · 1.5MB → ~250KB
// threshold 1KB 是 express compression 默认 · 小响应不值得压
app.use(compression());

// 安全 headers
app.use(helmet({
  contentSecurityPolicy: false, // webapp inline scripts · 关掉 CSP (V2 再细化)
  crossOriginEmbedderPolicy: false,
}));

// HTTP request 日志 (结构化 JSON)
app.use(pinoHttp({
  logger,
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'debug'; // 正常请求不要太吵
  },
  serializers: {
    req(req) { return { method: req.method, url: req.url }; },
    res(res) { return { statusCode: res.statusCode }; },
  },
}));

// CORS
if (CORS_ORIGINS.length > 0) {
  app.use(cors({ origin: CORS_ORIGINS }));
  logger.info({ origins: CORS_ORIGINS }, 'CORS restricted');
} else {
  app.use(cors());
  logger.warn('CORS open · 生产环境请设置 CORS_ORIGINS env var');
}

app.use(express.json({ limit: BODY_LIMIT }));
app.use(cookieParser());
app.use(auth.attachSession);  // req.user / req.session 全局可用

// ============================================
// Rate limiting
// ============================================
const actionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: RATE_LIMIT_ACTION,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '太快了 · 请稍后再试' },
});
const stateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: RATE_LIMIT_STATE,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '太快了 · 请稍后再试' },
});

// 发邮件 · 严格限流 · 防滥用 (1 分钟最多 3 次 / IP)
const sendLinkLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 3,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '发太快了 · 等 1 分钟再试' },
});

// ============================================
// API
// ============================================

// 健康检查
app.get('/api/health', (req, res) => {
  const mem = process.memoryUsage();
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const projectCount = db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
    memoryMb: Math.round(mem.rss / 1024 / 1024),
    projects: projectCount,
    users: userCount,
    nodeVersion: process.version,
    env: process.env.NODE_ENV || 'development',
  });
});

// CLI 自升级检查 · 给 tinker update --check-only 用 · 替代直接打 GitHub (限额 + 依赖)
// 公开 · 不要求登录 · ?since=<本地安装的 sha> 算落后多少个 cli/ 改动
const cliVersion = require('./cli-version');
app.get('/api/cli-version', stateLimiter, (req, res) => {
  try {
    res.json({ ok: true, ...cliVersion.getCliVersion(req.query.since || null) });
  } catch (e) {
    res.json({ ok: true, available: false });
  }
});

// ============================================
// AUTH endpoints
// ============================================

// 发 magic link
app.post('/api/auth/send-link', sendLinkLimiter, async (req, res, next) => {
  try {
    const { email } = req.body || {};
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const r = await auth.sendMagicLink({ email, baseUrl });
    res.json({ ok: true, sentTo: r.sentTo });
  } catch (e) {
    req.log.warn({ err: e.message }, 'send-link failed');
    res.status(400).json({ error: e.message });
  }
});

// 验证 magic link · 设 cookie · 跳回 webapp
app.get('/api/auth/verify', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('缺 token');
  try {
    const { sessionId, isNew } = auth.verifyMagicLink({
      token,
      userAgent: req.get('user-agent'),
    });
    res.cookie(auth.COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: req.secure,                       // HTTPS 时才安全标记
      sameSite: 'lax',
      maxAge: auth.SESSION_TTL_MS,
      path: '/',
    });
    // 跳回主页 · webapp 会读 cookie 判断登录态 · 新用户 ?welcome=1 触发欢迎流程
    res.redirect(isNew ? '/?welcome=1' : '/');
  } catch (e) {
    req.log.warn({ err: e.message }, 'verify failed');
    // 返回简单 HTML · 用户看得到失败原因
    res.status(400).send(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:60px;text-align:center;color:#1c1917"><h1 style="font-size:24px">登录失败</h1><p style="color:#78716c">${e.message}</p><p style="margin-top:30px"><a href="/" style="color:#c2410c">回 Tinker 主页 →</a></p></body>`);
  }
});

// Dev 旁路登录 · 跳过邮件 · 直接 setCookie · 仅 development 启用
// 生产环境 (NODE_ENV=production) 直接返回 404 · 不暴露
app.post('/api/auth/dev-login', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: '不存在的接口' });
  }
  try {
    const { email } = req.body || {};
    const { sessionId, isNew } = auth.devLogin({
      email,
      userAgent: req.get('user-agent'),
    });
    res.cookie(auth.COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: req.secure,
      sameSite: 'lax',
      maxAge: auth.SESSION_TTL_MS,
      path: '/',
    });
    res.json({ ok: true, isNew });
  } catch (e) {
    req.log.warn({ err: e.message }, 'dev-login failed');
    res.status(400).json({ error: e.message });
  }
});

// 当前 session · 给 webapp 用 (开机查一次知道登录态)
app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '未登录' });
  res.json({ user: req.user });
});

// v0.35 通知偏好 (web + CLI + 桥 共享)
app.get('/api/user/prefs', auth.requireSession, (req, res) => {
  try {
    const p = prefs.getPrefs(req.user.id);
    res.json({ ok: true, prefs: p, quietNow: prefs.isQuietNow(p) });
  } catch (e) {
    req.log.warn({ err: e.message }, 'get prefs failed');
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/user/prefs', auth.requireSession, (req, res) => {
  try {
    const body = req.body || {};
    const updated = prefs.setPrefs(req.user.id, body);
    res.json({ ok: true, prefs: updated, quietNow: prefs.isQuietNow(updated) });
  } catch (e) {
    req.log.warn({ err: e.message }, 'set prefs failed');
    res.status(400).json({ error: e.message });
  }
});

// 新用户欢迎流程 · 改 handle + tagline · 标记 welcomed
app.post('/api/auth/welcome', auth.requireSession, (req, res) => {
  try {
    const { handle, tagline } = req.body || {};
    const updated = auth.completeWelcome({ userId: req.user.id, handle, tagline });
    res.json({ ok: true, user: updated });
  } catch (e) {
    const out = { error: e.message };
    if (e.code) out.code = e.code;
    if (Array.isArray(e.suggestions)) out.suggestions = e.suggestions;
    res.status(400).json(out);
  }
});

// 实时检查 handle 是否可用 · 用户填 welcome / 改 handle 时调
app.get('/api/auth/check-handle', (req, res) => {
  const handle = String(req.query.handle || '').trim();
  if (!handle) return res.json({ ok: false, available: false, reason: '不能空' });
  const excludeUserId = req.user ? req.user.id : null;
  const result = auth.checkHandleAvailability(handle, excludeUserId);
  res.json(result);
});

// 登出
app.post('/api/auth/logout', (req, res) => {
  if (req.session?.sessionId) auth.destroySession(req.session.sessionId);
  res.clearCookie(auth.COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

// ============================================
// API tokens (CLI / agent) · 必须 session cookie 鉴权 · 不能用 token 创建 token
// ============================================
app.get('/api/account/tokens', auth.requireSession, (req, res) => {
  // 不允许 API token 自己看 token 列表 (避免链式)
  if (req.session?.viaApiToken) return res.status(403).json({ error: '需要浏览器登录 · API token 无权管理 token' });
  res.json(auth.listApiTokens(req.user.id));
});

app.post('/api/account/tokens', auth.requireSession, (req, res) => {
  if (req.session?.viaApiToken) return res.status(403).json({ error: '需要浏览器登录 · API token 无权管理 token' });
  const { label } = req.body || {};
  try {
    const created = auth.createApiToken({ userId: req.user.id, label });
    res.json(created);  // 注意:这是 token 唯一一次返回 · 用户得自己存
  } catch (e) {
    res.status(400).json({ error: e.message || '创建 token 失败' });
  }
});

app.delete('/api/account/tokens/:id', auth.requireSession, (req, res) => {
  if (req.session?.viaApiToken) return res.status(403).json({ error: '需要浏览器登录 · API token 无权管理 token' });
  const ok = auth.revokeApiToken({ userId: req.user.id, tokenId: req.params.id });
  if (!ok) return res.status(404).json({ error: '找不到这个 token' });
  res.json({ ok: true });
});

// ============================================
// 业务 API
// ============================================

app.get('/api/state', stateLimiter, (req, res) => {
  const state = buildState({ targetUserId: req.user?.id });
  // v0.42: 加 authedAs 字段 · 让 AI 能区分"鉴权过了" vs "端点本就公开"
  // 之前: 公开端点带不带 token 都返 200 · AI 误以为 200 = token 有效 · 实际 token 失效但拉到数据
  // 现在: 看 authedAs · null = 未鉴权 / @handle = 鉴权通过
  state.authedAs = req.user?.handle || null;
  res.json(state);
});

// 方法库 + 踩坑经验 搜索 (v0.12)
// 不需要登录 · 任何人都能搜公开内容 · 给 tinker borrow / webapp 搜索 共用
// ?q=<关键词>&limit=10&methodsOnly=1&kind=method|experience|all
// 如果带了登录 (token / cookie session) · 自动把命中前 3 条写进 borrow_log (反馈闭环)
app.get('/api/method/search', stateLimiter, (req, res) => {
  const q = String(req.query.q || '').slice(0, 200);
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
  const methodsOnly = req.query.methodsOnly === '1' || req.query.methodsOnly === 'true';
  const kindRaw = String(req.query.kind || '').trim();
  const kindFilter = ['method', 'experience', 'learning', 'decision'].includes(kindRaw) ? kindRaw : undefined;
  // borrower handle 来源优先级: 显式 ?borrower=  > 当前 session/token 用户的 handle
  let borrowerHandle = req.query.borrower ? String(req.query.borrower).slice(0, 40) : null;
  if (!borrowerHandle && req.user && req.user.handle) borrowerHandle = req.user.handle;
  const discipline = req.query.discipline ? String(req.query.discipline).slice(0, 20) : null;
  try {
    const result = actions.searchMethods({ q, limit, methodsOnly, kindFilter, borrowerHandle, discipline });
    res.json(result);
  } catch (e) {
    req.log.warn({ err: e.message }, 'method search failed');
    res.status(400).json({ error: e.message });
  }
});

// v0.94 求方法请求列表 · 公开 · 支持关键词过滤
app.get('/api/seeking', stateLimiter, (req, res) => {
  const q = String(req.query.q || '').slice(0, 200);
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
  try {
    res.json({ ok: true, items: actions.listSeeking({ q, limit }) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 作者看自己最近 N 天被借了哪些方法 (goodnight 用 · 也给 webapp 个人页用)
// 需要登录 · 只能看自己的
app.get('/api/method/borrows-for-me', stateLimiter, auth.requireSession, (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 7, 90);
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  try {
    const handle = req.user.handle;
    if (!handle) return res.status(400).json({ error: '当前用户没设 handle' });
    res.json(actions.getBorrowsForOwner({ ownerHandle: handle, sinceMs }));
  } catch (e) {
    req.log.warn({ err: e.message }, 'borrows-for-me failed');
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/tools', stateLimiter, (req, res) => {
  const tools = db.prepare('SELECT tool FROM available_tools ORDER BY position').all().map(r => r.tool);
  res.json(tools);
});

// v0.12 自己的最近 update · CLI / AI agent 用
// ?limit=N&kind=experience|method|ship|stuck|prototype|all
// 需要登录 (session 或 api token) · 只返自己的
app.get('/api/me/updates', stateLimiter, auth.requireSession, (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 10;
  const kindFilter = String(req.query.kind || 'all').slice(0, 20);
  try {
    const result = actions.listMyUpdates({
      currentUserId: req.user.id,
      limit,
      kindFilter,
    });
    res.json(result);
  } catch (e) {
    req.log.warn({ err: e.message }, 'list my updates failed');
    res.status(400).json({ error: e.message });
  }
});

// 图片单独 endpoint · 不塞 /api/state 主响应里 (那个一拉就 1.5MB)
// images.src 是 "data:image/<mime>;base64,<bytes>" · 这里拆出来发二进制 + 1 年永久缓存
// id 由作者上传时随机生成 · 内容 immutable · 浏览器 / CDN 都能放心缓存
//
// v0.50+ 守门: 历史存量里有 mime=application/octet-stream 的脏行 (借 image slot 塞 bridge 密文)
// 浏览器拿到 octet-stream 渲染成空白 img · 公开 feed 看着像坏图
// 拿到非 image/* mime 直接 415 · 让 webapp 走 onerror 占位卡片分支
const SERVE_IMAGE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'image/svg+xml', 'image/avif', 'image/heic', 'image/heif',
]);
app.get('/api/image/:id', (req, res) => {
  const row = db.prepare('SELECT src FROM images WHERE id = ?').get(req.params.id);
  if (!row || !row.src) return res.status(404).send('not found');
  const m = row.src.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return res.status(500).send('image format error');
  const mime = m[1].toLowerCase();
  if (!SERVE_IMAGE_MIMES.has(mime)) {
    return res.status(415).send('not an image (mime=' + mime + ')');
  }
  const buf = Buffer.from(m[2], 'base64');
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
});

// 业务 action · 全部要求登录 · 用 session.user.id 代替信任 payload.currentUser
app.post('/api/action', actionLimiter, auth.requireSession, async (req, res) => {
  const { type, payload } = req.body || {};
  if (!type) return res.status(400).json({ error: 'type required' });
  const action = actions[type];
  if (!action) return res.status(400).json({ error: 'Unknown action: ' + type });
  try {
    const result = action(payload || {}, { currentUserId: req.user.id });
    const newState = buildState({ targetUserId: req.user.id });
    res.json({ ok: true, result, state: newState });
  } catch (e) {
    req.log.warn({ action: type, err: e.message }, 'action rejected');
    res.status(400).json({ error: e.message });
  }
});

// ============================================
// bridge · 加密私信通道 (v0.16)
// 跟 /api/action 分开 · 不捎带 buildState · 减少噪声
// ============================================

// 发 · POST { to (handle 或空 = 广播), kind ('noti'|'file'|'task'), payload (AES 密文 base64) }
app.post('/api/bridge/send', actionLimiter, auth.requireSession, (req, res) => {
  try {
    const result = bridge.bridgeSend(req.body || {}, { currentUserId: req.user.id });
    res.json({ ok: true, ...result });
  } catch (e) {
    req.log.warn({ err: e.message }, 'bridge send rejected');
    res.status(400).json({ error: e.message });
  }
});

// 收 · GET ?since=<seq> · 长轮询 (没新消息挂 25s · 期间被唤醒立刻返)
// 拉的范围:发给我 handle 的 + 全广播 + 我所在所有 studio 的
app.get('/api/bridge/poll', stateLimiter, auth.requireSession, async (req, res) => {
  try {
    const since = parseInt(req.query.since || '0', 10);
    const handle = req.user.handle;
    const userId = req.user.id;
    if (!handle) return res.status(400).json({ error: '需要 handle (用户没补完 onboarding?)' });

    let messages = bridge.bridgePoll({ since, handle, userId });
    if (messages.length === 0) {
      await bridge.waitForMessages({ handle, userId }, 25000);
      messages = bridge.bridgePoll({ since, handle, userId });
    }
    const lastSeq = messages.length ? messages[messages.length - 1].seq : since;
    res.json({ ok: true, since: lastSeq, messages });
  } catch (e) {
    req.log.warn({ err: e.message }, 'bridge poll rejected');
    res.status(400).json({ error: e.message });
  }
});

// blob · handoff 重料的内容寻址存取 (Phase 2 懒取)
// 存 · POST { studioId, hash (sha256 明文), payload (密文 base64), bytes }
app.post('/api/bridge/blob', actionLimiter, auth.requireSession, (req, res) => {
  try {
    const result = blobs.blobPut(req.body || {}, { currentUserId: req.user.id });
    res.json({ ok: true, ...result });
  } catch (e) {
    req.log.warn({ err: e.message }, 'bridge blob put rejected');
    res.status(400).json({ error: e.message });
  }
});

// 取 · GET /api/bridge/blob/:hash?studioId=...
app.get('/api/bridge/blob/:hash', stateLimiter, auth.requireSession, (req, res) => {
  try {
    const result = blobs.blobGet(
      { studioId: req.query.studioId, hash: req.params.hash },
      { currentUserId: req.user.id }
    );
    if (!result) return res.status(404).json({ error: 'blob 不存在 (可能被清了 · 让发起方重发)' });
    res.json({ ok: true, ...result });
  } catch (e) {
    req.log.warn({ err: e.message }, 'bridge blob get rejected');
    res.status(400).json({ error: e.message });
  }
});

// ============================================
// studios · 工作室一等公民 (v0.18)
// ============================================

// 列所有工作室 (公开)
app.get('/api/studios', stateLimiter, (req, res) => {
  try {
    res.json({ ok: true, studios: studios.studiosList() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 看一个工作室聚合页 (公开 · 不要求登录)
app.get('/api/studios/:slug', stateLimiter, (req, res) => {
  const s = studios.studioGet({ slug: req.params.slug });
  if (!s) return res.status(404).json({ error: '工作室不存在' });
  res.json({ ok: true, studio: s });
});

// 建工作室 · 自动当 owner
app.post('/api/studios', actionLimiter, auth.requireSession, (req, res) => {
  try {
    const result = studios.studioCreate(req.body || {}, { currentUserId: req.user.id });
    res.json({ ok: true, studio: result });
  } catch (e) {
    req.log.warn({ err: e.message }, 'studio create rejected');
    res.status(400).json({ error: e.message });
  }
});

// 加入工作室 (客户端先从邀请桥消息里解出 slug + secret · POST 这里登记成员)
app.post('/api/studios/join', actionLimiter, auth.requireSession, (req, res) => {
  try {
    const result = studios.studioJoin(req.body || {}, { currentUserId: req.user.id });
    res.json({ ok: true, ...result });
  } catch (e) {
    req.log.warn({ err: e.message }, 'studio join rejected');
    res.status(400).json({ error: e.message });
  }
});

// 退出
app.post('/api/studios/:id/leave', actionLimiter, auth.requireSession, (req, res) => {
  try {
    const result = studios.studioLeave({ studioId: req.params.id }, { currentUserId: req.user.id });
    res.json({ ok: true, ...result });
  } catch (e) {
    req.log.warn({ err: e.message }, 'studio leave rejected');
    res.status(400).json({ error: e.message });
  }
});

// 我所属的工作室 (登录后用 · 个人主页 / CLI tinker studio list 用)
app.get('/api/me/studios', stateLimiter, auth.requireSession, (req, res) => {
  res.json({ ok: true, studios: studios.studiosForUser(req.user.id) });
});

// v0.38 一个 handle 挂靠的所有工作室 · 带 preview 数据 (成员 / 项目 / 最近 3 条 update)
// 公开 · 不要求登录 (访客也能看 @daodao 跟谁在做事)
app.get('/api/users/:handle/studios-preview', stateLimiter, (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE handle = ?').get(req.params.handle);
  if (!user) return res.json({ ok: true, studios: [] });
  res.json({ ok: true, studios: studios.studiosForUserWithPreview(user.id) });
});

// owner 邀请别人 · client 传 tokenHash + secretCipher (server 看不到 token 跟 secret)
app.post('/api/studios/:id/invite', actionLimiter, auth.requireSession, (req, res) => {
  try {
    const result = studios.studioCreateInvite(
      { studioId: req.params.id, ...(req.body || {}) },
      { currentUserId: req.user.id }
    );
    res.json({ ok: true, ...result });
  } catch (e) {
    req.log.warn({ err: e.message }, 'studio invite rejected');
    res.status(400).json({ error: e.message });
  }
});

// 接受邀请 · client 算 tokenHash 提交 · server 验 target = 你 · 返 secretCipher
app.post('/api/studios/accept', actionLimiter, auth.requireSession, (req, res) => {
  try {
    const result = studios.studioAcceptInvite(req.body || {}, { currentUserId: req.user.id });
    res.json({ ok: true, ...result });
  } catch (e) {
    req.log.warn({ err: e.message }, 'studio accept rejected');
    res.status(400).json({ error: e.message });
  }
});

// ============================================
// 静态服务 webapp (放在 API 之后 · API 优先匹配)
// ============================================
app.use(express.static(WEBAPP_DIR));

// ============================================
// 全局错误中间件
// ============================================
app.use((err, req, res, next) => {
  req.log?.error({ err }, 'unhandled error');
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '服务器内部错误' });
});

// ============================================
// 启动 + 优雅关闭
// ============================================
const server = app.listen(PORT, () => {
  logger.info({
    port: PORT,
    env: process.env.NODE_ENV || 'development',
    dbFile: process.env.DB_FILE || 'server/tinker.db',
    corsOrigins: CORS_ORIGINS.length ? CORS_ORIGINS : 'open',
    rateLimit: { action: RATE_LIMIT_ACTION, state: RATE_LIMIT_STATE },
  }, 'Tinker server up');
});

function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    // SQLite 同步写入 · 不需要 flush · WAL checkpoint 自动
    db.close();
    logger.info('db closed · bye');
    process.exit(0);
  });
  // 强制 10s 后退出
  setTimeout(() => { logger.warn('force exit'); process.exit(1); }, 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', err => {
  logger.fatal({ err }, 'uncaught exception · exiting');
  process.exit(1);
});
process.on('unhandledRejection', err => {
  logger.error({ err }, 'unhandled rejection');
});

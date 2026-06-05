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
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const cookieParser = require('cookie-parser');
const path = require('path');

const { logger } = require('./logger');
const { JsonStorage } = require('./storage');
const { getSeedData, AVAILABLE_TOOLS, migrateState } = require('./seed');
const actions = require('./actions');
const auth = require('./auth');

// ============================================
// 配置
// ============================================
const PORT = parseInt(process.env.PORT || '8788', 10);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const WEBAPP_DIR = path.join(__dirname, '..', 'webapp');
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const RATE_LIMIT_ACTION = parseInt(process.env.RATE_LIMIT_ACTION || '60', 10);
const RATE_LIMIT_STATE = parseInt(process.env.RATE_LIMIT_STATE || '300', 10);
const BODY_LIMIT = process.env.BODY_LIMIT || '10mb';
const STARTED_AT = Date.now();

// ============================================
// 数据加载 / 保存 (atomic + backup rotation)
// ============================================
const storage = new JsonStorage(DATA_FILE, logger);
let state;

function loadState() {
  const { data, source } = storage.load();
  if (data) {
    state = migrateState(data);
    logger.info({ source, projects: state.projects?.length, users: Object.keys(state.users || {}).length }, 'state loaded');
  } else {
    state = getSeedData();
    storage.save(state);
    logger.info({ projects: state.projects.length }, 'state seeded from initial');
  }
}

loadState();

// ============================================
// Express setup
// ============================================
const app = express();

// 信任反代 (nginx / caddy / cloudflare 等)
app.set('trust proxy', 1);

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
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
    memoryMb: Math.round(mem.rss / 1024 / 1024),
    projects: state.projects?.length || 0,
    users: Object.keys(state.users || {}).length,
    nodeVersion: process.version,
    env: process.env.NODE_ENV || 'development',
  });
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

// 当前 session · 给 webapp 用 (开机查一次知道登录态)
app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '未登录' });
  res.json({ user: req.user });
});

// 新用户欢迎流程 · 改 handle + tagline · 标记 welcomed
app.post('/api/auth/welcome', auth.requireSession, (req, res) => {
  try {
    const { handle, tagline } = req.body || {};
    const updated = auth.completeWelcome({ userId: req.user.id, handle, tagline });
    res.json({ ok: true, user: updated });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 登出
app.post('/api/auth/logout', (req, res) => {
  if (req.session) auth.destroySession(req.session.sessionId);
  res.clearCookie(auth.COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

// ============================================
// 业务 API
// ============================================

app.get('/api/state', stateLimiter, (req, res) => {
  res.json(state);
});

app.get('/api/tools', stateLimiter, (req, res) => {
  res.json(AVAILABLE_TOOLS);
});

app.post('/api/action', actionLimiter, async (req, res, next) => {
  const { type, payload } = req.body || {};
  if (!type) return res.status(400).json({ error: 'type required' });
  const action = actions[type];
  if (!action) return res.status(400).json({ error: 'Unknown action: ' + type });
  try {
    const result = action(state, payload || {});
    await storage.save(state);
    res.json({ ok: true, result, state });
  } catch (e) {
    req.log.warn({ action: type, err: e.message }, 'action rejected');
    res.status(400).json({ error: e.message });
  }
});

// 重置数据 (开发用 · 生产应 disable)
if (process.env.NODE_ENV !== 'production' || process.env.ALLOW_RESET === '1') {
  app.post('/api/reset', async (req, res) => {
    state = getSeedData();
    await storage.save(state);
    logger.warn('state reset to seed');
    res.json({ ok: true, state });
  });
}

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
    dataFile: DATA_FILE,
    corsOrigins: CORS_ORIGINS.length ? CORS_ORIGINS : 'open',
    rateLimit: { action: RATE_LIMIT_ACTION, state: RATE_LIMIT_STATE },
  }, 'Tinker server up');
});

function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    storage.save(state).then(() => {
      logger.info('state flushed · bye');
      process.exit(0);
    });
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

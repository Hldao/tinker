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
const path = require('path');

const { logger } = require('./logger');
const { JsonStorage } = require('./storage');
const { getSeedData, AVAILABLE_TOOLS, migrateState } = require('./seed');
const actions = require('./actions');

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

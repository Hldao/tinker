// Tinker server — pino structured logger
// 开发: pretty-printed
// 生产: JSON (适合 docker / 集中日志)

const pino = require('pino');

const isProd = process.env.NODE_ENV === 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'tinker-server' },
  ...(isProd ? {} : {
    transport: {
      target: 'pino/file',
      options: { destination: 1, // stdout
        // pino-pretty 是 optional · 没装就用原始 JSON
      },
    },
  }),
});

module.exports = { logger };

// SQLite (better-sqlite3) 客户端 + 单例 + migration 自动跑
// 用法: const db = require('./db');
//        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { runMigrations } = require('./migrations/runner');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'tinker.db');

// 确保 DB 文件目录存在 (生产 DB_FILE 会指向 /data/tinker.db · /data 由 docker volume mount)
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new Database(DB_FILE);

// 关键 PRAGMA
db.pragma('journal_mode = WAL');           // 读写不互锁
db.pragma('foreign_keys = ON');            // 默认关 · 我们要级联删
db.pragma('synchronous = NORMAL');         // WAL 下 NORMAL 即可 · FULL 太慢
db.pragma('temp_store = MEMORY');          // 临时表/索引放内存

// 自动跑 migrations (启动即应用)
const result = runMigrations(db);
if (result.applied.length > 0) {
  console.log('[db] migrations applied:', result.applied.map(x => x.file).join(', '));
}

// helper: 生成 UUID v7 (时间排序友好)
// v7 = 48 bit timestamp ms + 4 bit version + 12 bit rand + 2 bit variant + 62 bit rand
// better-sqlite3 没内建 · 手写一个轻量版
function uuidv7() {
  const ts = Date.now();
  const tsHex = ts.toString(16).padStart(12, '0');         // 12 hex = 48 bit
  const rand1 = Math.floor(Math.random() * 0x1000).toString(16).padStart(3, '0'); // 12 bit
  // 0x8 (variant 10xx) prefix for 8 hex char block
  const r2 = Math.floor(Math.random() * 0x40000000).toString(16).padStart(8, '0');
  const r3 = Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return `${tsHex.slice(0,8)}-${tsHex.slice(8,12)}-7${rand1}-8${r2.slice(0,3)}-${r2.slice(3,8)}${r3.slice(0,3)}${r3.slice(3,8)}`.slice(0, 36);
}

// helper: 生成随机 token / session id (URL-safe)
function randomToken(byteLen = 24) {
  return require('crypto').randomBytes(byteLen).toString('base64url');
}

module.exports = db;
module.exports.uuidv7 = uuidv7;
module.exports.randomToken = randomToken;

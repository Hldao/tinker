// 简易 migration runner
// 跟踪一个 schema_version 表 · 跑所有比当前版本大的 .sql 文件 · 按文件名数字排序
//
// 用法:
//   const { runMigrations } = require('./migrations/runner');
//   runMigrations(db);  // 接受 better-sqlite3 instance

const fs = require('fs');
const path = require('path');

function runMigrations(db) {
  // 跟踪表 · 自身没经过 migration 所以手动建
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const currentVersionRow = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  const currentVersion = currentVersionRow.v || 0;

  // 找所有 NNN_xxx.sql 文件 · 按数字排序
  const files = fs.readdirSync(__dirname)
    .filter(f => /^\d+_.*\.sql$/i.test(f))
    .map(f => ({
      file: f,
      version: parseInt(f.match(/^(\d+)/)[1], 10),
    }))
    .filter(x => x.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  if (files.length === 0) return { applied: [], currentVersion };

  const applied = [];
  for (const { file, version } of files) {
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const txn = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, Date.now());
    });
    try {
      txn();
      applied.push({ file, version });
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }

  return { applied, currentVersion: files[files.length - 1].version };
}

module.exports = { runMigrations };

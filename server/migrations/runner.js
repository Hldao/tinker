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

  // v0.12 修补:之前用 MAX(version) 判断 currentVersion · 但如果新 migration
  // 文件用了比当前 max 小的版本号 (并行开发常见 · 文件命名跟 commit 顺序不一致)
  // runner 会漏跑。改成"应用所有 file version 不在 schema_version 表里的"。
  const appliedVersions = new Set(
    db.prepare('SELECT version FROM schema_version').all().map(r => r.version)
  );
  const currentVersion = appliedVersions.size > 0 ? Math.max(...appliedVersions) : 0;

  // 找所有 NNN_xxx.sql 文件 · 按 version 升序
  // filter: version 不在 appliedVersions 集合里的 (含 missing 的旧 version 跟新加的)
  const files = fs.readdirSync(__dirname)
    .filter(f => /^\d+_.*\.sql$/i.test(f))
    .map(f => ({
      file: f,
      version: parseInt(f.match(/^(\d+)/)[1], 10),
    }))
    .filter(x => !appliedVersions.has(x.version))
    .sort((a, b) => a.version - b.version);

  if (files.length === 0) return { applied: [], currentVersion };

  const applied = [];
  for (const { file, version } of files) {
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
    // FK 关掉再跑迁移 · 让 "table rebuild" 类迁移可以安全 DROP/RECREATE 而不级联删数据
    // (db.transaction 包了 BEGIN/COMMIT · PRAGMA foreign_keys 在事务里改是无效的)
    db.pragma('foreign_keys = OFF');
    const txn = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, Date.now());
    });
    try {
      txn();
      applied.push({ file, version });
    } catch (err) {
      db.pragma('foreign_keys = ON');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
    db.pragma('foreign_keys = ON');
  }

  return { applied, currentVersion: files[files.length - 1].version };
}

module.exports = { runMigrations };

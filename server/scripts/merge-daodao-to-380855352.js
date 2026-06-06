#!/usr/bin/env node
// 合并账号: @daodao (seed 占位) + @380855352 (真实邮箱) → @daodao
//
// 执行 (ECS 上 · 复用容器现有 better-sqlite3 依赖):
//   docker exec tinker-server node /app/server/scripts/merge-daodao-to-380855352.js
//
// dry-run 模式 (只看会改什么 · 不实际改):
//   docker exec tinker-server node /app/server/scripts/merge-daodao-to-380855352.js --dry-run

const Database = require('better-sqlite3');

const DRY_RUN = process.argv.includes('--dry-run');
const DB_PATH = process.env.DB_FILE || '/data/tinker.db';

console.log(`\n打开数据库: ${DB_PATH}`);
if (DRY_RUN) console.log('模式: DRY RUN (不实际改数据)');

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

function row(sql, ...args) { return db.prepare(sql).get(...args); }
function rows(sql, ...args) { return db.prepare(sql).all(...args); }
function userId(handle) {
  const u = row('SELECT id FROM users WHERE handle = ?', handle);
  return u ? u.id : null;
}

const SOURCE_HANDLE = 'daodao';
const TARGET_HANDLE = '380855352';
const FINAL_HANDLE = 'daodao';

// =========================================================
// PART 1 · DRY RUN INFO
// =========================================================
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('PART 1 · 改前现状');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const sourceId = userId(SOURCE_HANDLE);
const targetId = userId(TARGET_HANDLE);

if (!sourceId) {
  console.error(`\n✗ 找不到 @${SOURCE_HANDLE} 账号，可能早就合并过了。退出。`);
  process.exit(0);
}
if (!targetId) {
  console.error(`\n✗ 找不到 @${TARGET_HANDLE} 账号。退出。`);
  process.exit(1);
}

console.log(`\n  @${SOURCE_HANDLE}    id = ${sourceId.substring(0, 8)}...`);
console.log(`  @${TARGET_HANDLE} id = ${targetId.substring(0, 8)}...`);

console.log(`\n  @${SOURCE_HANDLE} 名下项目 (会过户):`);
rows('SELECT name, slug, status FROM projects WHERE owner_id = ?', sourceId).forEach(p => {
  console.log(`    · ${p.name} (${p.slug}) [${p.status}]`);
});

const tables = [
  ['projects.owner_id', 'SELECT COUNT(*) AS cnt FROM projects WHERE owner_id = ?'],
  ['method_used',       'SELECT COUNT(*) AS cnt FROM method_used WHERE user_id = ?'],
  ['reactions',         'SELECT COUNT(*) AS cnt FROM reactions WHERE user_id = ?'],
  ['tinkered',          'SELECT COUNT(*) AS cnt FROM tinkered WHERE user_id = ?'],
  ['notes',             'SELECT COUNT(*) AS cnt FROM notes WHERE user_id = ?'],
  ['notif.target',      'SELECT COUNT(*) AS cnt FROM notifications WHERE target_user_id = ?'],
  ['notif.from',        'SELECT COUNT(*) AS cnt FROM notifications WHERE from_user_id = ?'],
  ['api_tokens',        'SELECT COUNT(*) AS cnt FROM api_tokens WHERE user_id = ?'],
  ['sessions',          'SELECT COUNT(*) AS cnt FROM sessions WHERE user_id = ?'],
  ['auth_tokens',       'SELECT COUNT(*) AS cnt FROM auth_tokens WHERE user_id = ?'],
];

console.log(`\n  @${SOURCE_HANDLE} 在各表的 user_id 引用数 (将全部过户):`);
tables.forEach(([name, sql]) => {
  const cnt = row(sql, sourceId).cnt;
  console.log(`    ${name.padEnd(22)} ${cnt}`);
});

console.log(`\n  @${TARGET_HANDLE} 已有数据 (保留 + 合体):`);
tables.forEach(([name, sql]) => {
  const cnt = row(sql, targetId).cnt;
  if (cnt > 0) console.log(`    ${name.padEnd(22)} ${cnt}`);
});

if (DRY_RUN) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('DRY RUN 完成 · 没有改数据。');
  console.log('如要实际执行，去掉 --dry-run 参数重跑。');
  db.close();
  process.exit(0);
}

// =========================================================
// PART 2 · EXECUTE (TRANSACTION)
// =========================================================
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('PART 2 · 执行合并 (TRANSACTION，失败自动回滚)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const tx = db.transaction(() => {
  const updates = [
    ['projects.owner_id',     'UPDATE projects SET owner_id = ? WHERE owner_id = ?'],
    ['method_used.user_id',   'UPDATE OR IGNORE method_used SET user_id = ? WHERE user_id = ?'],
    ['reactions.user_id',     'UPDATE OR IGNORE reactions SET user_id = ? WHERE user_id = ?'],
    ['tinkered.user_id',      'UPDATE OR IGNORE tinkered SET user_id = ? WHERE user_id = ?'],
    ['notes.user_id',         'UPDATE notes SET user_id = ? WHERE user_id = ?'],
    ['notif.target_user_id',  'UPDATE notifications SET target_user_id = ? WHERE target_user_id = ?'],
    ['notif.from_user_id',    'UPDATE notifications SET from_user_id = ? WHERE from_user_id = ?'],
    ['api_tokens.user_id',    'UPDATE api_tokens SET user_id = ? WHERE user_id = ?'],
    ['sessions.user_id',      'UPDATE sessions SET user_id = ? WHERE user_id = ?'],
    ['auth_tokens.user_id',   'UPDATE auth_tokens SET user_id = ? WHERE user_id = ?'],
  ];

  console.log('');
  updates.forEach(([name, sql]) => {
    const r = db.prepare(sql).run(targetId, sourceId);
    console.log(`  ${name.padEnd(28)} 改了 ${r.changes} 行`);
  });

  console.log(`\n  把 @${SOURCE_HANDLE} 改名为 __${SOURCE_HANDLE}_archived (占位避免重名冲突)`);
  db.prepare("UPDATE users SET handle = '__daodao_archived' WHERE handle = ?").run(SOURCE_HANDLE);

  console.log(`  把 @${TARGET_HANDLE} 改名为 @${FINAL_HANDLE} + 恢复原 daodao 的 name/tagline`);
  db.prepare(`
    UPDATE users
    SET handle = ?,
        name = CASE WHEN name = ? OR name IS NULL OR name = '' THEN '捣鼓自己' ELSE name END,
        tagline = CASE WHEN tagline IS NULL OR tagline = '' OR tagline = '刚进来捣鼓...'
                  THEN '在做 Tinker · 也喜欢看别人怎么捣鼓小东西'
                  ELSE tagline END,
        updated_at = ?
    WHERE handle = ?
  `).run(FINAL_HANDLE, TARGET_HANDLE, Date.now(), TARGET_HANDLE);

  console.log(`  删除 __${SOURCE_HANDLE}_archived 占位 (子表残留靠 CASCADE 清掉)`);
  db.prepare("DELETE FROM users WHERE handle = '__daodao_archived'").run();
});

tx();
console.log('\n✓ TRANSACTION 提交成功');

// =========================================================
// PART 3 · VERIFY
// =========================================================
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('PART 3 · 验证结果');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

console.log('  现存所有用户:');
rows('SELECT handle, email, name, tagline FROM users ORDER BY handle').forEach(u => {
  console.log(`    @${u.handle.padEnd(16)} ${u.email || '(无邮箱)'.padEnd(28)} - ${u.name || ''}`);
});

const newDaodaoId = userId(FINAL_HANDLE);
console.log(`\n  @${FINAL_HANDLE} 名下项目 (合并后):`);
rows('SELECT name, slug, status FROM projects WHERE owner_id = ?', newDaodaoId).forEach(p => {
  console.log(`    · ${p.name} (${p.slug}) [${p.status}]`);
});

console.log(`\n  @${FINAL_HANDLE} 各表数据 (合并后):`);
tables.forEach(([name, sql]) => {
  const cnt = row(sql, newDaodaoId).cnt;
  if (cnt > 0) console.log(`    ${name.padEnd(22)} ${cnt}`);
});

console.log('\n✓ 合并全部完成。浏览器刷新即可看到效果，session 不会断。');
db.close();

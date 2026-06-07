#!/usr/bin/env node
// 把"阿里云邮件 / GitHub 自动部署 / 僵尸进程" 那条 update 标为 is_experience = 1
//
// 这是 C 层 experience pool 的第一颗种子 · 让其他 AI 检索 Tinker 时能学到具体踩坑经验。
//
// 执行 (ECS 上 · 容器内跑):
//   docker exec tinker-server node /app/server/scripts/mark-aliyun-experience.js
//
// dry-run (只看会标谁 · 不实际改):
//   docker exec tinker-server node /app/server/scripts/mark-aliyun-experience.js --dry-run
//
// 强制指定 update id (跳过文本搜索):
//   docker exec tinker-server node /app/server/scripts/mark-aliyun-experience.js --id u-xxx

const Database = require('better-sqlite3');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE_ID = (process.argv.find(a => a.startsWith('--id=')) || '').slice(5)
              || (() => { const i = process.argv.indexOf('--id'); return i > 0 ? process.argv[i + 1] : null; })();
const DB_PATH = process.env.DB_FILE || '/data/tinker.db';

console.log(`\n打开数据库: ${DB_PATH}`);
if (DRY_RUN) console.log('模式: DRY RUN (不改数据)');
if (FORCE_ID) console.log('指定 id: ' + FORCE_ID);

const db = new Database(DB_PATH);

// is_experience 字段在 v010 migration 后才有 · 检查一下
const cols = db.prepare("PRAGMA table_info(updates)").all().map(c => c.name);
if (!cols.includes('is_experience')) {
  console.error('\n✗ updates 表没有 is_experience 字段 · 请先确认 v010 migration 跑过');
  console.error('  检查方法: docker exec tinker-server sqlite3 /data/tinker.db "PRAGMA table_info(updates)"');
  process.exit(1);
}

let candidates;
if (FORCE_ID) {
  const row = db.prepare(`
    SELECT u.id, u.text, u.at, u.is_experience, p.name AS project_name, usr.handle AS owner_handle
    FROM updates u JOIN projects p ON p.id = u.project_id JOIN users usr ON usr.id = p.owner_id
    WHERE u.id = ?
  `).get(FORCE_ID);
  candidates = row ? [row] : [];
} else {
  // 找最近 7 天 · @daodao 或 @380855352 · text 含至少 2 个关键词
  const sinceMs = Date.now() - 7 * 86400 * 1000;
  candidates = db.prepare(`
    SELECT u.id, u.text, u.at, u.is_experience, p.name AS project_name, usr.handle AS owner_handle
    FROM updates u
    JOIN projects p ON p.id = u.project_id
    JOIN users usr ON usr.id = p.owner_id
    WHERE u.at >= ?
      AND usr.handle IN ('daodao', '380855352')
      AND (
        u.text LIKE '%阿里云%'
        OR u.text LIKE '%邮箱登录%'
        OR u.text LIKE '%535%'
        OR u.text LIKE '%PLAIN%'
        OR u.text LIKE '%LOGIN%'
        OR u.text LIKE '%僵尸进程%'
        OR u.text LIKE '%GitHub 自动部署%'
      )
    ORDER BY u.at DESC
  `).all(sinceMs);

  // 给每条打分: 关键词数 越多越像目标
  const SCORE_WORDS = ['阿里云', '邮箱', '535', 'PLAIN', 'LOGIN', 'openssl', '僵尸进程', 'docker', '自动部署', 'GitHub'];
  candidates = candidates.map(c => ({
    ...c,
    score: SCORE_WORDS.reduce((n, w) => n + (c.text.includes(w) ? 1 : 0), 0),
  })).sort((a, b) => b.score - a.score);
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`候选 (找到 ${candidates.length} 条)`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

if (candidates.length === 0) {
  console.error('\n✗ 找不到匹配 update · 可能那条还没发 · 或者关键词不一样');
  console.error('  你也可以直接用 --id <updateId> 强制指定');
  process.exit(1);
}

candidates.slice(0, 5).forEach((c, i) => {
  const when = new Date(c.at).toISOString().slice(0, 16);
  const flag = c.is_experience ? '[已是经验]' : '';
  const score = typeof c.score === 'number' ? ` score=${c.score}` : '';
  console.log(`\n${i + 1}. ${c.id}  ${when}  @${c.owner_handle}  项目:${c.project_name}${score} ${flag}`);
  console.log('   ' + c.text.replace(/\n/g, ' ').slice(0, 200) + (c.text.length > 200 ? '...' : ''));
});

const target = candidates[0];
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`目标: ${target.id} (评分最高 / 强制指定的那条)`);

if (target.is_experience) {
  console.log('已经是 experience · 不动');
  process.exit(0);
}

if (DRY_RUN) {
  console.log('\n[DRY RUN] 不实际改动。要执行 · 去掉 --dry-run');
  process.exit(0);
}

const result = db.prepare('UPDATE updates SET is_experience = 1 WHERE id = ?').run(target.id);
console.log(`\n✓ 已标 ${target.id} 为 is_experience=1 · 影响行: ${result.changes}`);
console.log('  这是 experience pool 的第一颗种子 · 之后 ai-debug-breakthrough 触发的 update 会自动加入');

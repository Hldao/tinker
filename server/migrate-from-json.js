// 把现有 data.json 灌进 SQLite
//
// 用法:
//   1. CLI: node migrate-from-json.js [data.json 路径] [--force]
//   2. 自动 (server 启动时): require('./migrate-from-json').migrateFromJson({ jsonPath, force })
//
// 安全:
//   - 在 transaction 里 · 失败自动 rollback
//   - 默认拒绝向非空 DB 写入 (防止误覆盖)

const fs = require('fs');
const path = require('path');
const db = require('./db');

function migrateFromJson({ jsonPath, force = false, log = console.log, warn = console.warn } = {}) {
  if (!fs.existsSync(jsonPath)) {
    throw new Error('找不到 data.json: ' + jsonPath);
  }
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount > 0 && !force) {
    throw new Error('DB 已有 ' + userCount + ' 个用户 · 拒绝迁移 (传 force=true 清空覆盖)');
  }

  log('━━━ Tinker data.json → SQLite ━━━');
  log('  source: ' + jsonPath);
  log('  目标 DB: ' + (process.env.DB_FILE || 'server/tinker.db'));

  const handleToId = {};

  const txn = db.transaction(() => {
    if (force) {
      log('  --force · 清空所有表...');
      const tables = ['notifications', 'note_images', 'notes', 'tinkered', 'reactions',
        'method_used', 'update_images', 'updates', 'project_tools', 'projects',
        'images', 'sessions', 'auth_tokens', 'users', 'starters', 'available_tools'];
      for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
    }

    // 1. users — 每个 handle 分配 UUID
    log('━ users');
    const insUser = db.prepare(`
      INSERT INTO users (id, handle, email, name, tagline, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?)
    `);
    const now = Date.now();
    for (const [handle, u] of Object.entries(data.users || {})) {
      const id = db.uuidv7();
      handleToId[handle] = id;
      insUser.run(id, handle, u.name || handle, u.tagline || '', now, now);
      log('  · @' + handle + ' → ' + id);
    }

    // 2. projects + project_tools + 关联数据
    log('━ projects');
    const insProject = db.prepare(`
      INSERT INTO projects (id, owner_id, slug, name, desc, product_link, status, github_link, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insTool = db.prepare(`INSERT INTO project_tools (project_id, tool) VALUES (?, ?)`);
    const insUpdate = db.prepare(`INSERT INTO updates (id, project_id, text, prompt, at) VALUES (?, ?, ?, ?, ?)`);
    const insImg = db.prepare(`INSERT INTO images (id, src, caption, created_at) VALUES (?, ?, ?, ?)`);
    const insUpImg = db.prepare(`INSERT INTO update_images (update_id, image_id, position) VALUES (?, ?, ?)`);
    const insMu = db.prepare(`INSERT INTO method_used (update_id, user_id, note, at) VALUES (?, ?, ?, ?)`);
    const insNote = db.prepare(`INSERT INTO notes (id, project_id, user_id, text, at) VALUES (?, ?, ?, ?, ?)`);
    const insNoteImg = db.prepare(`INSERT INTO note_images (note_id, image_id, position) VALUES (?, ?, ?)`);
    const insReact = db.prepare(`INSERT INTO reactions (project_id, user_id, type, at) VALUES (?, ?, ?, ?)`);
    const insTinkered = db.prepare(`INSERT INTO tinkered (id, parent_project_id, user_id, name, link, at) VALUES (?, ?, ?, ?, ?, ?)`);

    for (const p of (data.projects || [])) {
      const ownerId = handleToId[p.owner];
      if (!ownerId) {
        warn('  ⚠ project ' + p.id + ' owner @' + p.owner + ' 不在 users · 跳过');
        continue;
      }
      insProject.run(
        p.id, ownerId, p.slug || ('p-' + Math.random().toString(36).slice(2)),
        p.name, p.desc, p.productLink, p.status || 'active',
        p.githubLink || null, now, now
      );
      for (const t of (p.tools || [])) insTool.run(p.id, t);
      log('  · ' + p.name);

      (p.updates || []).forEach((u, uIdx) => {
        const updateId = 'u-' + Date.now() + '-' + uIdx + Math.random().toString(36).slice(2, 6);
        insUpdate.run(updateId, p.id, u.text, u.prompt || null, u.at || now);
        (u.images || []).forEach((img, idx) => {
          const imgId = 'i-' + Date.now() + '-' + uIdx + '-' + idx + Math.random().toString(36).slice(2, 5);
          insImg.run(imgId, img.src, img.caption || null, u.at || now);
          insUpImg.run(updateId, imgId, idx);
        });
        (u.usedBy || []).forEach(used => {
          const userId = handleToId[used.user];
          if (!userId) return;
          insMu.run(updateId, userId, used.note || null, used.at || now);
        });
      });

      (p.notes || []).forEach((n, nIdx) => {
        const userId = handleToId[n.user];
        if (!userId) return;
        const noteId = 'n-' + Date.now() + '-' + nIdx + Math.random().toString(36).slice(2, 6);
        insNote.run(noteId, p.id, userId, n.text, n.at || now);
        (n.images || []).forEach((img, idx) => {
          const imgId = 'i-' + Date.now() + '-' + nIdx + '-n-' + idx + Math.random().toString(36).slice(2, 5);
          insImg.run(imgId, img.src, img.caption || null, n.at || now);
          insNoteImg.run(noteId, imgId, idx);
        });
      });

      for (const handle of (p.reactions?.wantToTry || [])) {
        const userId = handleToId[handle];
        if (!userId) continue;
        insReact.run(p.id, userId, 'wantToTry', now);
      }
      for (const t of (p.reactions?.tinkered || [])) {
        const userId = handleToId[t.user];
        if (!userId) continue;
        insTinkered.run('t-' + Math.random().toString(36).slice(2), p.id, userId, t.name, t.link, now);
      }
    }

    // 3. notifications
    log('━ notifications');
    const insNotif = db.prepare(`
      INSERT INTO notifications (id, target_user_id, from_user_id, type, project_id, extra, at, read_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const n of (data.notifications || [])) {
      const targetId = handleToId[n.target];
      const fromId = handleToId[n.fromUser];
      if (!targetId || !fromId) { warn('  ⚠ notification 跳过 (user 不存在)'); continue; }
      insNotif.run(
        n.id, targetId, fromId, n.type,
        n.projectId || null, n.extra || null,
        n.at || now, n.read ? now : null
      );
    }
    log('  · ' + (data.notifications || []).length + ' 条');

    // 4. starters
    log('━ starters');
    const insStarter = db.prepare(`INSERT INTO starters (title, prompt, tool_name, tool_url, category, position) VALUES (?, ?, ?, ?, ?, ?)`);
    (data.starters || []).forEach((s, idx) => insStarter.run(s.title, s.prompt, s.toolName, s.toolUrl, s.category || 'self', idx));
    log('  · ' + (data.starters || []).length + ' 条');

    // 5. available_tools
    log('━ available_tools');
    const insTool2 = db.prepare(`INSERT INTO available_tools (tool, position) VALUES (?, ?)`);
    (data.availableTools || []).forEach((t, idx) => insTool2.run(t, idx));
    log('  · ' + (data.availableTools || []).length + ' 个工具');
  });

  txn();

  return {
    users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    projects: db.prepare('SELECT COUNT(*) AS c FROM projects').get().c,
    updates: db.prepare('SELECT COUNT(*) AS c FROM updates').get().c,
    notes: db.prepare('SELECT COUNT(*) AS c FROM notes').get().c,
    reactions: db.prepare('SELECT COUNT(*) AS c FROM reactions').get().c,
    tinkered: db.prepare('SELECT COUNT(*) AS c FROM tinkered').get().c,
    notifications: db.prepare('SELECT COUNT(*) AS c FROM notifications').get().c,
  };
}

module.exports = { migrateFromJson };

// CLI entry
if (require.main === module) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const jsonPath = args.find(a => !a.startsWith('--')) || path.join(__dirname, 'data.json');
  try {
    const counts = migrateFromJson({ jsonPath, force });
    console.log('');
    console.log('✓ 迁移完成');
    for (const [k, v] of Object.entries(counts)) console.log('  ' + k + ': ' + v);
  } catch (e) {
    console.error('✗ 迁移失败 · 已自动 rollback:', e.message);
    process.exit(1);
  }
}

// SQL 版 actions · 替换 actions.js (JS object mutation 版)
// 契约: action({ payload }, { currentUserId }) → result (或 throw)
// 通知 / 校验 / 级联 都在 SQL 里完成 · 0 全局 state

const db = require('./db');
const { userIdFromHandle } = require('./state');

// ============================================
// 辅助
// ============================================

function isValidUrl(s) {
  if (!s) return false;
  return /^https?:\/\/\S+\.\S+/i.test(s.trim());
}

// 从文本提取 @mention · 返回 user_id 数组 (排除自己 + 不存在的 handle)
function extractMentions(text, excludeUserId) {
  if (!text) return [];
  const stmt = db.prepare('SELECT id FROM users WHERE handle = ?');
  const ids = new Set();
  const re = /@([A-Za-z0-9_一-龥]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const row = stmt.get(m[1]);
    if (row && row.id !== excludeUserId) ids.add(row.id);
  }
  return Array.from(ids);
}

// 发通知 · 去重 (同 target+fromUser+type+project 只留最新)
// anchor: 'update-<id>' / 'note-<id>' / 'tinkered-<handle>' · webapp 跳转后定位 + flash
function notify({ targetUserId, fromUserId, type, projectId, extra, anchor }) {
  if (!targetUserId || targetUserId === fromUserId) return;
  db.prepare(`
    DELETE FROM notifications
    WHERE target_user_id = ? AND from_user_id = ? AND type = ?
      AND ((project_id IS NULL AND ? IS NULL) OR project_id = ?)
  `).run(targetUserId, fromUserId, type, projectId || null, projectId || null);

  db.prepare(`
    INSERT INTO notifications (id, target_user_id, from_user_id, type, project_id, extra, anchor, at, read_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    'n-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    targetUserId, fromUserId, type, projectId || null, extra || null, anchor || null, Date.now()
  );
}

// 显式清掉一条通知 (升级承诺时用 · 比如 wantToTry → tinkered)
function clearNotif({ targetUserId, fromUserId, type, projectId }) {
  if (!targetUserId) return;
  db.prepare(`
    DELETE FROM notifications
    WHERE target_user_id = ? AND from_user_id = ? AND type = ?
      AND ((project_id IS NULL AND ? IS NULL) OR project_id = ?)
  `).run(targetUserId, fromUserId, type, projectId || null, projectId || null);
}

function makeSlug() {
  return 'p-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

// ============================================
// USERS
// ============================================

function editTagline({ tagline }, { currentUserId }) {
  if (!tagline || !tagline.trim()) throw new Error('一句话不能空着');
  const text = tagline.trim().slice(0, 80);
  db.prepare('UPDATE users SET tagline = ?, updated_at = ? WHERE id = ?')
    .run(text, Date.now(), currentUserId);
  return db.prepare('SELECT handle, name, tagline FROM users WHERE id = ?').get(currentUserId);
}

// 改 handle (rename) · 唯一性已查
function renameHandle({ handle }, { currentUserId }) {
  if (!handle || !/^[a-zA-Z0-9_一-龥]{1,20}$/.test(handle)) {
    throw new Error('handle 只能 1-20 字 · 字母/数字/下划线/中文');
  }
  const exists = db.prepare('SELECT id FROM users WHERE handle = ? AND id != ?').get(handle, currentUserId);
  if (exists) throw new Error('这个 handle 被人用了 · 换一个');
  db.prepare('UPDATE users SET handle = ?, updated_at = ? WHERE id = ?')
    .run(handle, Date.now(), currentUserId);
  return db.prepare('SELECT handle, name, tagline FROM users WHERE id = ?').get(currentUserId);
}

// ============================================
// PROJECTS
// ============================================

function addProject({ name, desc, productLink, status = 'active', tools = [], githubLink }, { currentUserId }) {
  if (!name || !name.trim()) throw new Error('项目得有个名字');
  if (!desc || !desc.trim()) throw new Error('描述不能为空');
  // productLink 可选 · 但如果填了必须是合法 https URL(微信小程序 / 桌面应用 / 审核中的项目可以暂时空着)
  const link = (productLink || '').trim();
  if (link && !isValidUrl(link)) throw new Error('如果填了 productLink, 得是 https:// 开头的可访问链接');

  const projectId = 'p-' + Date.now() + Math.random().toString(36).slice(2, 6);
  const slug = makeSlug();
  const now = Date.now();

  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO projects (id, owner_id, slug, name, desc, product_link, status, github_link, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(projectId, currentUserId, slug, name.trim(), desc.trim(), link || null,
           status, githubLink || null, now, now);

    const insTool = db.prepare('INSERT INTO project_tools (project_id, tool) VALUES (?, ?)');
    for (const t of (Array.isArray(tools) ? tools : [])) {
      if (t && t.trim()) insTool.run(projectId, t.trim());
    }
  });
  txn();

  return getProjectFlat(projectId);
}

function editProject({ projectId, name, desc, productLink, tools }, { currentUserId }) {
  if (!projectId) throw new Error('projectId required');
  if (!name || !name.trim()) throw new Error('项目得有个名字');
  if (!desc || !desc.trim()) throw new Error('描述不能为空');
  // productLink 可选 · 但如果填了必须是合法 URL
  const link = (productLink || '').trim();
  if (link && !isValidUrl(link)) throw new Error('如果填了 productLink, 得是 https:// 开头的可访问链接');

  const p = db.prepare('SELECT owner_id, product_link FROM projects WHERE id = ?').get(projectId);
  if (!p) throw new Error('项目不存在');
  if (p.owner_id !== currentUserId) throw new Error('只能改自己的项目');

  const linkChanged = (p.product_link || '') !== link;

  const txn = db.transaction(() => {
    db.prepare(`
      UPDATE projects SET name = ?, desc = ?, product_link = ?, updated_at = ?
      WHERE id = ?
    `).run(name.trim(), desc.trim(), link || null, Date.now(), projectId);

    if (Array.isArray(tools)) {
      db.prepare('DELETE FROM project_tools WHERE project_id = ?').run(projectId);
      const insTool = db.prepare('INSERT INTO project_tools (project_id, tool) VALUES (?, ?)');
      for (const t of tools) {
        if (t && t.trim()) insTool.run(projectId, t.trim());
      }
    }
  });
  txn();

  // 产物链接换了 · 给"想试试 + 接走方"发通知 · ta 们引用的可能是旧链接
  if (linkChanged) {
    const wantToTryRows = db.prepare(
      `SELECT user_id FROM reactions WHERE project_id = ? AND type = 'wantToTry'`
    ).all(projectId);
    const tinkeredRows = db.prepare(
      `SELECT user_id FROM tinkered WHERE parent_project_id = ?`
    ).all(projectId);
    const targets = new Set([
      ...wantToTryRows.map(r => r.user_id),
      ...tinkeredRows.map(r => r.user_id),
    ]);
    targets.delete(currentUserId);
    for (const uid of targets) {
      notify({
        targetUserId: uid, fromUserId: currentUserId, type: 'projectMoved',
        projectId, extra: link,
      });
    }
  }

  return getProjectFlat(projectId);
}

function changeProjectStatus({ projectId, newStatus }, { currentUserId }) {
  const p = db.prepare('SELECT owner_id, status, name, shipped_at FROM projects WHERE id = ?').get(projectId);
  if (!p) throw new Error('项目不存在');
  if (p.owner_id !== currentUserId) throw new Error('只能改自己项目的状态');

  const oldStatus = p.status;
  const now = Date.now();
  // 首次进 done · 记 shipped_at(以后再 done 不重置 · "ship 时刻"只算第一次)
  if (newStatus === 'done' && oldStatus !== 'done' && !p.shipped_at) {
    db.prepare('UPDATE projects SET status = ?, shipped_at = ?, updated_at = ? WHERE id = ?')
      .run(newStatus, now, now, projectId);
  } else {
    db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?')
      .run(newStatus, now, projectId);
  }

  // 通知 · 跟老版 spec §5.3 行为一致
  const wantToTryRows = db.prepare(`
    SELECT user_id FROM reactions WHERE project_id = ? AND type = 'wantToTry'
  `).all(projectId);
  const tinkeredRows = db.prepare(`
    SELECT user_id FROM tinkered WHERE parent_project_id = ?
  `).all(projectId);

  if (oldStatus !== 'done' && newStatus === 'done') {
    for (const r of wantToTryRows) {
      notify({
        targetUserId: r.user_id, fromUserId: currentUserId, type: 'projectDone',
        projectId, extra: '你之前说过想试试 · 现在能用了',
      });
    }
  }
  if (oldStatus !== 'stuck' && newStatus === 'stuck') {
    const all = new Set([...wantToTryRows.map(r=>r.user_id), ...tinkeredRows.map(r=>r.user_id)]);
    all.delete(currentUserId);
    for (const uid of all) {
      notify({
        targetUserId: uid, fromUserId: currentUserId, type: 'projectStuck',
        projectId, extra: '卡住了 · 也许你能搭把手',
      });
    }
  }
  if (oldStatus === 'stuck' && newStatus === 'active') {
    const all = new Set([...wantToTryRows.map(r=>r.user_id), ...tinkeredRows.map(r=>r.user_id)]);
    all.delete(currentUserId);
    for (const uid of all) {
      notify({
        targetUserId: uid, fromUserId: currentUserId, type: 'projectUnstuck',
        projectId, extra: '之前卡住的又动起来了',
      });
    }
  }
  return getProjectFlat(projectId);
}

// ============================================
// SHIP CEREMONY (完工)
// ============================================
// 通用陈列动作 · 三种 kind:
//   ship      = 完工(跑通了 · 可以正常用了)· 顺手改 status 成 done · 通知 wantToTry
//   prototype = 原型(还在打磨 · 但已经可以玩)· 不动 status
//   design    = 设计(设计稿 / 概念 · 不一定能跑)· 不动 status
// 共同:创建对应 kind 的 update · 第一次进陈列馆记 shipped_at
// shipped_at 这个字段保留旧名 · 语义其实是"作品第一次进陈列馆的时刻"
const EXHIBIT_KINDS = new Set(['ship', 'prototype', 'design']);
function exhibitProject({ projectId, kind, statement, seekingFeedback, feedbackAsk, images }, { currentUserId }) {
  if (!kind || !EXHIBIT_KINDS.has(kind)) throw new Error('kind 必须是 ship / prototype / design 之一');
  if (!statement || !statement.trim()) throw new Error('陈列说明不能空,写一句也行');
  const p = db.prepare('SELECT owner_id, name, status, shipped_at FROM projects WHERE id = ?').get(projectId);
  if (!p) throw new Error('项目不存在');
  if (p.owner_id !== currentUserId) throw new Error('只能给自己的项目做陈列');

  const updateId = 'u-' + Date.now() + Math.random().toString(36).slice(2, 6);
  const now = Date.now();
  const feedbackVal = seekingFeedback ? (feedbackAsk || '').trim() : null;
  const wasDone = p.status === 'done';
  const isShipKind = kind === 'ship';

  const txn = db.transaction(() => {
    // 第一次进陈列馆 · 记 shipped_at (用作"首次陈列时间")
    // ship kind 额外把 status 改成 done
    if (isShipKind && !wasDone) {
      db.prepare('UPDATE projects SET status = ?, shipped_at = ?, updated_at = ? WHERE id = ?')
        .run('done', p.shipped_at || now, now, projectId);
    } else if (!p.shipped_at) {
      db.prepare('UPDATE projects SET shipped_at = ?, updated_at = ? WHERE id = ?').run(now, now, projectId);
    } else {
      db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId);
    }
    // 创建对应 kind 的 update
    db.prepare(`
      INSERT INTO updates (id, project_id, text, at, feedback_ask, kind) VALUES (?, ?, ?, ?, ?, ?)
    `).run(updateId, projectId, statement.trim(), now, feedbackVal, kind);

    // 图片 (跟 addUpdate 一致的存储方式,第一张作为陈列馆封面)
    if (Array.isArray(images)) {
      const insImg = db.prepare('INSERT INTO images (id, src, caption, created_at) VALUES (?, ?, ?, ?)');
      const insLink = db.prepare('INSERT INTO update_images (update_id, image_id, position) VALUES (?, ?, ?)');
      images.forEach((img, idx) => {
        if (!img || !img.src) return;
        const imgId = 'i-' + Date.now() + Math.random().toString(36).slice(2, 8);
        insImg.run(imgId, img.src, img.caption || null, now);
        insLink.run(updateId, imgId, idx);
      });
    }
  });
  txn();

  const anchor = 'update-' + updateId;

  // 只有 ship kind 完工时通知"想试试"的人 (跟原来 shipProject 行为一致)
  if (isShipKind && !wasDone) {
    const wantToTryRows = db.prepare(`
      SELECT user_id FROM reactions WHERE project_id = ? AND type = 'wantToTry' AND user_id != ?
    `).all(projectId, currentUserId);
    for (const r of wantToTryRows) {
      notify({
        targetUserId: r.user_id, fromUserId: currentUserId, type: 'projectDone',
        projectId, extra: statement.trim().slice(0, 200), anchor,
      });
    }
  }

  return { ok: true, updateId, kind };
}

// 兼容老 shipProject 调用 (CLI / AI agent / 老 webapp 代码) · 转发到 exhibitProject
function shipProject({ projectId, reflection, seekingFeedback, feedbackAsk, images }, ctx) {
  return exhibitProject({
    projectId,
    kind: 'ship',
    statement: reflection,
    seekingFeedback, feedbackAsk, images,
  }, ctx);
}

// helper: 取项目的扁平表示 (action 返回值用)
function getProjectFlat(projectId) {
  const p = db.prepare(`
    SELECT p.id, p.slug, p.name, p.desc, p.product_link AS productLink, p.status,
           u.handle AS owner
    FROM projects p JOIN users u ON u.id = p.owner_id
    WHERE p.id = ?
  `).get(projectId);
  if (!p) return null;
  p.tools = db.prepare('SELECT tool FROM project_tools WHERE project_id = ?').all(projectId).map(r => r.tool);
  return p;
}

// ============================================
// UPDATES
// ============================================

// notifyTinkered: 作者主动通知"接走我 + 想试试"的人 (默认 false · 避免轰炸)
// alsoStuck: 同时把项目改为 stuck (spec §5.3 "卡了" 进展 → 召回过往关心者)
function addUpdate({ projectId, text, images, prompt, notifyTinkered, alsoStuck, seekingFeedback, feedbackAsk, at }, { currentUserId }) {
  if (!text || !text.trim()) throw new Error('记一笔不能空');
  const p = db.prepare('SELECT owner_id, name, status FROM projects WHERE id = ?').get(projectId);
  if (!p) throw new Error('项目不存在');
  if (p.owner_id !== currentUserId) throw new Error('只能给自己的项目记一笔');

  const updateId = 'u-' + Date.now() + Math.random().toString(36).slice(2, 6);
  const now = Date.now();
  // 可选回填时间(CLI 给真实 commit 时间用)· 限制不能未来 · 不能比项目还早
  let useAt = now;
  if (typeof at === 'number' && at > 0) {
    if (at <= now) useAt = at;
  }
  const willStuck = alsoStuck && p.status !== 'stuck';
  // 求反馈:勾了之后 · 存 feedback_ask 字段(可能为空字符串 = 求反馈但没具体问题)
  const feedbackVal = seekingFeedback ? (feedbackAsk || '').trim() : null;
  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO updates (id, project_id, text, prompt, at, feedback_ask) VALUES (?, ?, ?, ?, ?, ?)
    `).run(updateId, projectId, text.trim(), prompt || null, useAt, feedbackVal);

    if (Array.isArray(images)) {
      const insImg = db.prepare('INSERT INTO images (id, src, caption, created_at) VALUES (?, ?, ?, ?)');
      const insLink = db.prepare('INSERT INTO update_images (update_id, image_id, position) VALUES (?, ?, ?)');
      images.forEach((img, idx) => {
        if (!img || !img.src) return;
        const imgId = 'i-' + Date.now() + Math.random().toString(36).slice(2, 8);
        insImg.run(imgId, img.src, img.caption || null, now);
        insLink.run(updateId, imgId, idx);
      });
    }
    if (willStuck) {
      db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run('stuck', now, projectId);
    } else {
      db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId);
    }
  });
  txn();

  const anchor = 'update-' + updateId;

  // @ mention 通知
  for (const uid of extractMentions(text, currentUserId)) {
    notify({
      targetUserId: uid, fromUserId: currentUserId, type: 'mentioned',
      projectId, extra: text.trim().slice(0, 200), anchor,
    });
  }

  // 主动 broadcast 给关心者 (作者勾选 "通知接走过的人" 才发 · 不默认)
  // alsoStuck 时也广播 (= 卡住召回 · 跟 changeProjectStatus 行为一致 · 但用 stuckUpdate 区分)
  if (notifyTinkered || willStuck) {
    const wantToTryRows = db.prepare(
      `SELECT user_id FROM reactions WHERE project_id = ? AND type = 'wantToTry'`
    ).all(projectId);
    const tinkeredRows = db.prepare(
      `SELECT user_id FROM tinkered WHERE parent_project_id = ?`
    ).all(projectId);
    const targets = new Set([
      ...wantToTryRows.map(r => r.user_id),
      ...tinkeredRows.map(r => r.user_id),
    ]);
    targets.delete(currentUserId);
    const notifType = willStuck ? 'projectStuck' : 'ownerUpdate';
    const extra = willStuck ? '卡住了 · 也许你能搭把手' : text.trim().slice(0, 200);
    for (const uid of targets) {
      notify({
        targetUserId: uid, fromUserId: currentUserId, type: notifType,
        projectId, extra, anchor,
      });
    }
  }

  return { id: updateId, text: text.trim(), at: now, prompt: prompt || undefined, statusChanged: willStuck };
}

function editUpdate({ projectId, updateIdx, text, images, seekingFeedback, feedbackAsk }, { currentUserId }) {
  if (!text || !text.trim()) throw new Error('进展内容不能空');
  // 找到对应 update (updateIdx 是显示顺序 · 即 ORDER BY at DESC)
  const p = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(projectId);
  if (!p) throw new Error('项目不存在');
  if (p.owner_id !== currentUserId) throw new Error('只能编辑自己的进展');
  const updates = db.prepare('SELECT id FROM updates WHERE project_id = ? ORDER BY at DESC').all(projectId);
  const u = updates[updateIdx];
  if (!u) throw new Error('找不到这条进展');

  // 求反馈勾选(可在编辑里改变)
  const feedbackVal = seekingFeedback ? (feedbackAsk || '').trim() : null;
  const txn = db.transaction(() => {
    db.prepare('UPDATE updates SET text = ?, feedback_ask = ? WHERE id = ?').run(text.trim(), feedbackVal, u.id);
    // 图片 · 全删重建 (简单 · alpha 期可接受)
    db.prepare('DELETE FROM update_images WHERE update_id = ?').run(u.id);
    if (Array.isArray(images) && images.length > 0) {
      const insImg = db.prepare('INSERT INTO images (id, src, caption, created_at) VALUES (?, ?, ?, ?)');
      const insLink = db.prepare('INSERT INTO update_images (update_id, image_id, position) VALUES (?, ?, ?)');
      images.forEach((img, idx) => {
        if (!img || !img.src) return;
        const imgId = 'i-' + Date.now() + Math.random().toString(36).slice(2, 8);
        insImg.run(imgId, img.src, img.caption || null, Date.now());
        insLink.run(u.id, imgId, idx);
      });
    }
  });
  txn();
  return { ok: true };
}

function deleteUpdate({ projectId, updateIdx }, { currentUserId }) {
  const p = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(projectId);
  if (!p) throw new Error('项目不存在');
  if (p.owner_id !== currentUserId) throw new Error('只能删自己的进展');
  const updates = db.prepare('SELECT id FROM updates WHERE project_id = ? ORDER BY at DESC').all(projectId);
  const u = updates[updateIdx];
  if (!u) throw new Error('找不到这条进展');
  db.prepare('DELETE FROM updates WHERE id = ?').run(u.id); // cascade 清 images/method_used
  return { ok: true };
}

// ============================================
// REACTIONS
// ============================================

function reactToProject({ projectId, level }, { currentUserId }) {
  if (level !== 'wantToTry') throw new Error('未知反馈类型');
  const p = db.prepare('SELECT owner_id, name FROM projects WHERE id = ?').get(projectId);
  if (!p) throw new Error('项目不存在');

  const existing = db.prepare('SELECT 1 FROM reactions WHERE project_id = ? AND user_id = ? AND type = ?')
    .get(projectId, currentUserId, level);

  if (existing) {
    db.prepare('DELETE FROM reactions WHERE project_id = ? AND user_id = ? AND type = ?')
      .run(projectId, currentUserId, level);
    return { action: 'undo' };
  }
  db.prepare(`
    INSERT INTO reactions (project_id, user_id, type, at) VALUES (?, ?, ?, ?)
  `).run(projectId, currentUserId, level, Date.now());

  notify({
    targetUserId: p.owner_id, fromUserId: currentUserId, type: 'wantToTry',
    projectId,
  });

  return { action: 'add' };
}

function submitTinkered({ projectId, name, link }, { currentUserId }) {
  if (!name || !name.trim()) throw new Error('延伸版名字必填');
  if (!isValidUrl(link)) throw new Error('延伸版链接必须是 https://');
  const p = db.prepare('SELECT owner_id, name FROM projects WHERE id = ?').get(projectId);
  if (!p) throw new Error('项目不存在');

  const txn = db.transaction(() => {
    // 清 wantToTry (升级到 tinkered)
    db.prepare('DELETE FROM reactions WHERE project_id = ? AND user_id = ?')
      .run(projectId, currentUserId);
    // UNIQUE(parent_project_id, user_id) · 重复 INSERT 会 throw · 改用 INSERT OR REPLACE
    db.prepare(`
      INSERT OR REPLACE INTO tinkered (id, parent_project_id, user_id, name, link, at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      't-' + Date.now() + Math.random().toString(36).slice(2, 6),
      projectId, currentUserId, name.trim(), link.trim(), Date.now()
    );
  });
  txn();

  // 升级承诺 · 清掉之前给 owner 的 wantToTry 通知 · 否则 owner 同时看到 "想试试" + "接走了"
  clearNotif({ targetUserId: p.owner_id, fromUserId: currentUserId, type: 'wantToTry', projectId });

  const handle = db.prepare('SELECT handle FROM users WHERE id = ?').get(currentUserId)?.handle;
  notify({
    targetUserId: p.owner_id, fromUserId: currentUserId, type: 'tinkered',
    projectId, extra: name.trim(), anchor: handle ? 'tinkered-' + handle : null,
  });
  return { ok: true };
}

// 接走方撤回自己的延伸版 (项目下线 / 误操作)
function deleteTinkered({ projectId }, { currentUserId }) {
  const row = db.prepare(
    'SELECT 1 FROM tinkered WHERE parent_project_id = ? AND user_id = ?'
  ).get(projectId, currentUserId);
  if (!row) throw new Error('你没有接走过这个项目');
  db.prepare('DELETE FROM tinkered WHERE parent_project_id = ? AND user_id = ?')
    .run(projectId, currentUserId);
  // 同时清掉之前发给 owner 的 tinkered 通知 · 避免 owner 点开后找不到延伸版
  const p = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(projectId);
  if (p) {
    clearNotif({ targetUserId: p.owner_id, fromUserId: currentUserId, type: 'tinkered', projectId });
  }
  return { ok: true };
}

function markMethodUsed({ projectId, updateIdx, note }, { currentUserId }) {
  const p = db.prepare('SELECT owner_id, name FROM projects WHERE id = ?').get(projectId);
  if (!p) throw new Error('项目不存在');
  if (p.owner_id === currentUserId) throw new Error('不能给自己反馈');
  const updates = db.prepare('SELECT id FROM updates WHERE project_id = ? ORDER BY at DESC').all(projectId);
  const u = updates[updateIdx];
  if (!u) throw new Error('找不到这条进展');

  const existing = db.prepare('SELECT 1 FROM method_used WHERE update_id = ? AND user_id = ?')
    .get(u.id, currentUserId);

  if (existing) {
    db.prepare('DELETE FROM method_used WHERE update_id = ? AND user_id = ?').run(u.id, currentUserId);
    return { action: 'undo' };
  }
  db.prepare(`
    INSERT INTO method_used (update_id, user_id, note, at) VALUES (?, ?, ?, ?)
  `).run(u.id, currentUserId, (note || '').trim(), Date.now());

  const extra = (note && note.trim()) || ('用了「' + p.name + '」第 ' + (updateIdx + 1) + ' 条的方法');
  notify({
    targetUserId: p.owner_id, fromUserId: currentUserId, type: 'methodUsed',
    projectId, extra, anchor: 'update-' + u.id,
  });
  return { ok: true };
}

// ============================================
// NOTES
// ============================================

function addNote({ projectId, text, images, updateId }, { currentUserId }) {
  if (!text || !text.trim()) throw new Error('便签是空的 — 图片是辅助 · 文字才是核心');
  const p = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(projectId);
  if (!p) throw new Error('项目不存在');

  // 校验 updateId 必须属于这个项目 (避免跨项目错挂)
  let validUpdateId = null;
  if (updateId) {
    const u = db.prepare('SELECT id FROM updates WHERE id = ? AND project_id = ?').get(updateId, projectId);
    if (u) validUpdateId = updateId;
  }

  const noteId = 'n-' + Date.now() + Math.random().toString(36).slice(2, 6);
  const now = Date.now();

  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO notes (id, project_id, user_id, text, at, update_id) VALUES (?, ?, ?, ?, ?, ?)
    `).run(noteId, projectId, currentUserId, text.trim(), now, validUpdateId);

    if (Array.isArray(images)) {
      const insImg = db.prepare('INSERT INTO images (id, src, caption, created_at) VALUES (?, ?, ?, ?)');
      const insLink = db.prepare('INSERT INTO note_images (note_id, image_id, position) VALUES (?, ?, ?)');
      images.forEach((img, idx) => {
        if (!img || !img.src) return;
        const imgId = 'i-' + Date.now() + Math.random().toString(36).slice(2, 8);
        insImg.run(imgId, img.src, img.caption || null, now);
        insLink.run(noteId, imgId, idx);
      });
    }
  });
  txn();

  const anchor = 'note-' + noteId;

  // 通知 owner (自己留自己项目不通知)
  notify({
    targetUserId: p.owner_id, fromUserId: currentUserId, type: 'noted',
    projectId, extra: text.trim().slice(0, 200), anchor,
  });

  // @ mention · 排除 owner 避免重复
  for (const uid of extractMentions(text, currentUserId)) {
    if (uid === p.owner_id) continue;
    notify({
      targetUserId: uid, fromUserId: currentUserId, type: 'mentioned',
      projectId, extra: text.trim().slice(0, 200), anchor,
    });
  }

  return { user: 'self', text: text.trim(), at: now };
}

function deleteNote({ projectId, noteIdx }, { currentUserId }) {
  const notes = db.prepare('SELECT id, user_id FROM notes WHERE project_id = ? ORDER BY at DESC').all(projectId);
  const n = notes[noteIdx];
  if (!n) throw new Error('找不到这条便签');
  if (n.user_id !== currentUserId) throw new Error('只能撤回自己的便签');
  db.prepare('DELETE FROM notes WHERE id = ?').run(n.id);
  return { ok: true };
}

// ============================================
// NOTIFICATIONS
// ============================================

function markAllRead(_payload, { currentUserId }) {
  db.prepare(`UPDATE notifications SET read_at = ? WHERE target_user_id = ? AND read_at IS NULL`)
    .run(Date.now(), currentUserId);
  return { ok: true };
}

// 标记单条通知已读 (webapp 在点开后逐条标 · 不再一进通知页就全标)
function markNotifRead({ notifId }, { currentUserId }) {
  if (!notifId) throw new Error('notifId required');
  db.prepare(`
    UPDATE notifications SET read_at = ?
    WHERE id = ? AND target_user_id = ? AND read_at IS NULL
  `).run(Date.now(), notifId, currentUserId);
  return { ok: true };
}

module.exports = {
  // users
  editTagline, renameHandle,
  // projects
  addProject, editProject, changeProjectStatus, shipProject, exhibitProject,
  // updates
  addUpdate, editUpdate, deleteUpdate,
  // reactions
  reactToProject, submitTinkered, deleteTinkered, markMethodUsed,
  // notes
  addNote, deleteNote,
  // notifications
  markAllRead, markNotifRead,
};

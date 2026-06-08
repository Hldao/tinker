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
// 浏览器地址栏默认藏 https:// · 粘出来常常是裸的 example.com/x · server 兜底补 https://
function normalizeUrl(s) {
  if (!s) return s;
  s = s.trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/\S+\.\S+/.test(s)) return 'https://' + s;
  return s;
}

// v0.62: state.js 返回 image.src = "/api/image/{id}" · 不再是 data URL
// 当 webapp re-submit (比如改 ship 仪式) 时, src 是这种相对引用 · 不是新上传
// 此 helper 区分两种情况:
//   - data:image/... → 新上传 · INSERT 新 image 行 · 返回新 id
//   - /api/image/{id} → 引用已有图 · 不 INSERT · 复用 id (avoid 重复存)
// 返回 image_id (供 update_images / note_images 的 FK 引用) · 或 null 跳过
function resolveImageId(img) {
  if (!img || !img.src) return null;
  const src = String(img.src);
  // 已存在的图 · 直接复用
  const ref = src.match(/^\/api\/image\/(.+)$/);
  if (ref) {
    const exists = db.prepare('SELECT id FROM images WHERE id = ?').get(ref[1]);
    return exists ? exists.id : null;
  }
  // 新上传 · 必须是 data URL · 否则跳过
  if (!src.startsWith('data:')) return null;
  const imgId = 'i-' + Date.now() + Math.random().toString(36).slice(2, 8);
  db.prepare('INSERT INTO images (id, src, caption, created_at) VALUES (?, ?, ?, ?)')
    .run(imgId, src, img.caption || null, Date.now());
  return imgId;
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
  // productLink 可选 · 但如果填了必须是合法 URL(微信小程序 / 桌面应用 / 审核中的项目可以暂时空着)
  const link = normalizeUrl((productLink || '').trim());
  if (link && !isValidUrl(link)) throw new Error('如果填了 productLink, 得是 http(s):// 开头的可访问链接');

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
  const link = normalizeUrl((productLink || '').trim());
  if (link && !isValidUrl(link)) throw new Error('如果填了 productLink, 得是 http(s):// 开头的可访问链接');

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

// 写 / 改项目编年史 · ship 后挂在项目页头部
// timeline 是一段 markdown · 节点列表 + 一段总结 · 由 CLI 端 LLM 起草 · 用户编辑后 push
// 传 null 或空字符串 = 清空(不显示编年史)
function editProjectTimeline({ projectId, timeline }, { currentUserId }) {
  if (!projectId) throw new Error('projectId required');
  if (timeline != null && typeof timeline !== 'string') throw new Error('timeline 必须是 string');

  const p = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(projectId);
  if (!p) throw new Error('项目不存在');
  if (p.owner_id !== currentUserId) throw new Error('只能改自己的项目');

  const value = (timeline || '').trim() || null;
  if (value && value.length > 20000) throw new Error('timeline 过长(超过 20000 字符)');

  db.prepare('UPDATE projects SET timeline = ?, updated_at = ? WHERE id = ?')
    .run(value, Date.now(), projectId);

  return { projectId, timeline: value };
}

function changeProjectStatus({ projectId, newStatus }, { currentUserId }) {
  const p = db.prepare('SELECT owner_id, status, name, shipped_at FROM projects WHERE id = ?').get(projectId);
  if (!p) throw new Error('项目不存在');
  if (p.owner_id !== currentUserId) throw new Error('只能改自己项目的状态');

  const oldStatus = p.status;
  const now = Date.now();
  // 首次进 done / live · 记 shipped_at(以后再切不重置 · "ship 时刻"只算第一次)
  // v0.33: live 也算 ship 过 · 跟 done 一起进入"shipped_at 有值"的状态
  if (['done', 'live'].includes(newStatus) && !['done', 'live'].includes(oldStatus) && !p.shipped_at) {
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
  const wasShipped = p.status === 'done' || p.status === 'live';
  const isShipKind = kind === 'ship';

  const txn = db.transaction(() => {
    // 第一次进陈列馆 · 记 shipped_at (用作"首次陈列时间")
    // v0.33: ship kind 把 status 改成 'live' (上线 + 持续优化) · 不是 'done'
    // done 现在改成"作者主动停手"的状态 · ship 默认进 live
    if (isShipKind && !wasShipped) {
      db.prepare('UPDATE projects SET status = ?, shipped_at = ?, updated_at = ? WHERE id = ?')
        .run('live', p.shipped_at || now, now, projectId);
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
    // v0.62: 走 resolveImageId 助手 · 区分新上传 data: URL 跟 re-submit 的 /api/image/ 引用
    if (Array.isArray(images)) {
      const insLink = db.prepare('INSERT INTO update_images (update_id, image_id, position) VALUES (?, ?, ?)');
      images.forEach((img, idx) => {
        const imgId = resolveImageId(img);
        if (imgId) insLink.run(updateId, imgId, idx);
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

// 把某条 update pin 为陈列馆 reflection 代表 · updateId=null 解除 pin
function pinUpdateForShowcase({ projectId, updateId }, { currentUserId }) {
  if (!projectId) throw new Error('projectId required');
  const p = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(projectId);
  if (!p) throw new Error('项目不存在');
  if (p.owner_id !== currentUserId) throw new Error('只能 pin 自己项目的 update');
  // 校验 updateId (如果给了)
  if (updateId) {
    const u = db.prepare('SELECT id FROM updates WHERE id = ? AND project_id = ?').get(updateId, projectId);
    if (!u) throw new Error('找不到这条 update');
  }
  db.prepare('UPDATE projects SET pinned_update_id = ?, updated_at = ? WHERE id = ?')
    .run(updateId || null, Date.now(), projectId);
  return { ok: true, pinnedUpdateId: updateId || null };
}

// 暂时不在陈列馆出现 (作者自己藏作品) · hidden=true 隐藏, false 重新公开
function toggleShowcaseVisibility({ projectId, hidden }, { currentUserId }) {
  if (!projectId) throw new Error('projectId required');
  const p = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(projectId);
  if (!p) throw new Error('项目不存在');
  if (p.owner_id !== currentUserId) throw new Error('只能改自己项目的可见性');
  const v = hidden ? 1 : 0;
  db.prepare('UPDATE projects SET hidden_from_showcase = ?, updated_at = ? WHERE id = ?')
    .run(v, Date.now(), projectId);
  return { ok: true, hiddenFromShowcase: !!hidden };
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
function addUpdate({ projectId, text, images, prompt, notifyTinkered, alsoStuck, seekingFeedback, feedbackAsk, at, isMethod, scenario }, { currentUserId }) {
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
  // v0.13 contribute --from-file: 创建时就标方法 · 省一次 API 调用
  const methodFlag = isMethod ? 1 : 0;
  // v0.78 方法卡片 "使用场景" · 10-30 字人话描述 "这文档帮你跟 AI 合作时解决什么问题"
  const scenarioVal = scenario && scenario.trim() ? scenario.trim().slice(0, 100) : null;
  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO updates (id, project_id, text, prompt, at, feedback_ask, is_method, scenario) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(updateId, projectId, text.trim(), prompt || null, useAt, feedbackVal, methodFlag, scenarioVal);

    if (Array.isArray(images)) {
      const insLink = db.prepare('INSERT INTO update_images (update_id, image_id, position) VALUES (?, ?, ?)');
      images.forEach((img, idx) => {
        const imgId = resolveImageId(img);
        if (imgId) insLink.run(updateId, imgId, idx);
      });
    }
    if (willStuck) {
      db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run('stuck', now, projectId);
    } else {
      db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId);
    }
    // 同步进 FTS · 让方法库可以搜到 (v0.12)
    syncUpdateToFts(updateId);
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

  // 给 CLI 拼直链用 · 一次 join 拿全 (避免客户端二次拉)
  const linkInfo = db.prepare(`
    SELECT p.slug AS project_slug, p.name AS project_name, usr.handle AS owner_handle
    FROM projects p JOIN users usr ON usr.id = p.owner_id WHERE p.id = ?
  `).get(projectId);

  return {
    id: updateId,
    text: text.trim(),
    at: now,
    prompt: prompt || undefined,
    statusChanged: willStuck,
    projectSlug: linkInfo ? linkInfo.project_slug : null,
    projectName: linkInfo ? linkInfo.project_name : null,
    ownerHandle: linkInfo ? linkInfo.owner_handle : null,
  };
}

function editUpdate({ projectId, updateIdx, text, images, seekingFeedback, feedbackAsk, scenario }, { currentUserId }) {
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
  // v0.78 scenario 可选编辑 · undefined 表示不变 · null/空串表示清空 · 非空表示更新
  const scenarioProvided = scenario !== undefined;
  const scenarioVal = scenarioProvided && scenario && scenario.trim()
    ? scenario.trim().slice(0, 100)
    : null;
  const txn = db.transaction(() => {
    if (scenarioProvided) {
      db.prepare('UPDATE updates SET text = ?, feedback_ask = ?, scenario = ? WHERE id = ?').run(text.trim(), feedbackVal, scenarioVal, u.id);
    } else {
      db.prepare('UPDATE updates SET text = ?, feedback_ask = ? WHERE id = ?').run(text.trim(), feedbackVal, u.id);
    }
    // 图片 · 全删重建 link · resolveImageId 区分新上传跟引用已有
    db.prepare('DELETE FROM update_images WHERE update_id = ?').run(u.id);
    if (Array.isArray(images) && images.length > 0) {
      const insLink = db.prepare('INSERT INTO update_images (update_id, image_id, position) VALUES (?, ?, ?)');
      images.forEach((img, idx) => {
        const imgId = resolveImageId(img);
        if (imgId) insLink.run(u.id, imgId, idx);
      });
    }
    syncUpdateToFts(u.id);
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
  db.prepare('DELETE FROM updates_fts WHERE update_id = ?').run(u.id);
  db.prepare('DELETE FROM updates WHERE id = ?').run(u.id); // cascade 清 images/method_used
  return { ok: true };
}

// 把一条 update 写入 / 覆盖 FTS5 虚拟表
// content-rowid 不能复用 (text id) · 用 update_id 列定位 · 旧记录先 DELETE 再 INSERT
function syncUpdateToFts(updateId) {
  const row = db.prepare(`
    SELECT u.text, p.name AS project_name, usr.handle AS owner_handle
    FROM updates u
    JOIN projects p ON p.id = u.project_id
    JOIN users usr ON usr.id = p.owner_id
    WHERE u.id = ?
  `).get(updateId);
  if (!row) return;
  db.prepare('DELETE FROM updates_fts WHERE update_id = ?').run(updateId);
  db.prepare(`
    INSERT INTO updates_fts (text, project_name, owner_handle, update_id)
    VALUES (?, ?, ?, ?)
  `).run(row.text, row.project_name, row.owner_handle, updateId);
}

// 作者把自己一条 update 标为方法 · 让别人 borrow 时能拿到
// v0.81 methods 是 first-class entity · 不再是 updates 上的 flag
// 兼容路径: 旧 markAsMethod / unmarkMethod 仍可用 · 内部 proxy 到 new methods table
//
// v0.84 tag 规范化 helper · 用户输入清理 · 去重 · 限长
// 输入: 字符串数组 / undefined · 输出: JSON 数组 string 或 null
function normalizeTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return null;
  const cleaned = tags
    .map(t => typeof t === 'string' ? t.trim().replace(/^#+/, '').slice(0, 20) : '')
    .filter(Boolean);
  if (cleaned.length === 0) return null;
  const unique = [...new Set(cleaned)].slice(0, 8); // 最多 8 个 tag
  return JSON.stringify(unique);
}

// createMethod · 新建独立方法资产
function createMethod({ text, scenario, projectId, sourceUpdateId, sourceDocPath, title, tags }, { currentUserId }) {
  if (!text || !text.trim()) throw new Error('方法内容不能空');
  if (text.trim().length < 20) throw new Error('内容太短 · 至少写两句 (回头自己看也认得出)');
  // project 可选 · 但传了要校验是自己的
  if (projectId) {
    const p = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(projectId);
    if (!p) throw new Error('项目不存在');
    if (p.owner_id !== currentUserId) throw new Error('只能挂在自己的项目下');
  }
  // 如果指定了 sourceUpdateId · 防重复升格
  if (sourceUpdateId) {
    const existing = db.prepare('SELECT id FROM methods WHERE source_update_id = ?').get(sourceUpdateId);
    if (existing) return { ok: true, methodId: existing.id, alreadyExists: true };
  }
  const methodId = 'm-' + Date.now() + Math.random().toString(36).slice(2, 6);
  const now = Date.now();
  const scenarioVal = scenario && scenario.trim() ? scenario.trim().slice(0, 100) : null;
  const titleVal = title && title.trim() ? title.trim().slice(0, 100) : null;
  const tagsVal = normalizeTags(tags);
  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO methods (id, owner_id, title, scenario, text, at, updated_at, project_id, source_update_id, source_doc_path, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(methodId, currentUserId, titleVal, scenarioVal, text.trim(), now, now, projectId || null, sourceUpdateId || null, sourceDocPath || null, tagsVal);
    syncMethodToFts(methodId);
  });
  txn();
  return { ok: true, methodId };
}

function editMethod({ methodId, text, scenario, projectId, title, tags }, { currentUserId }) {
  if (!methodId) throw new Error('methodId 必填');
  const m = db.prepare('SELECT owner_id, project_id FROM methods WHERE id = ?').get(methodId);
  if (!m) throw new Error('找不到这条方法');
  if (m.owner_id !== currentUserId) throw new Error('只能改自己的方法');
  const txn = db.transaction(() => {
    const fields = [];
    const vals = [];
    if (text !== undefined) {
      if (!text || !text.trim() || text.trim().length < 20) throw new Error('内容太短');
      fields.push('text = ?'); vals.push(text.trim());
    }
    if (scenario !== undefined) {
      fields.push('scenario = ?');
      vals.push(scenario && scenario.trim() ? scenario.trim().slice(0, 100) : null);
    }
    if (projectId !== undefined) {
      if (projectId) {
        const p = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(projectId);
        if (!p) throw new Error('项目不存在');
        if (p.owner_id !== currentUserId) throw new Error('只能挂在自己的项目下');
      }
      fields.push('project_id = ?'); vals.push(projectId || null);
    }
    if (title !== undefined) {
      fields.push('title = ?');
      vals.push(title && title.trim() ? title.trim().slice(0, 100) : null);
    }
    if (tags !== undefined) {
      fields.push('tags = ?');
      vals.push(normalizeTags(tags));
    }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); vals.push(Date.now());
    vals.push(methodId);
    db.prepare(`UPDATE methods SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
    syncMethodToFts(methodId);
  });
  txn();
  return { ok: true };
}

function deleteMethod({ methodId }, { currentUserId }) {
  if (!methodId) throw new Error('methodId 必填');
  const m = db.prepare('SELECT owner_id FROM methods WHERE id = ?').get(methodId);
  if (!m) throw new Error('找不到这条方法');
  if (m.owner_id !== currentUserId) throw new Error('只能删自己的方法');
  db.prepare('DELETE FROM methods_fts WHERE method_id = ?').run(methodId);
  db.prepare('DELETE FROM methods WHERE id = ?').run(methodId);
  return { ok: true };
}

// 同步 method 到 FTS · 写入 / 编辑后都调
function syncMethodToFts(methodId) {
  const row = db.prepare(`
    SELECT m.text, m.scenario, u.handle AS owner_handle, p.name AS project_name
    FROM methods m
    JOIN users u ON u.id = m.owner_id
    LEFT JOIN projects p ON p.id = m.project_id
    WHERE m.id = ?
  `).get(methodId);
  if (!row) return;
  db.prepare('DELETE FROM methods_fts WHERE method_id = ?').run(methodId);
  db.prepare(`
    INSERT INTO methods_fts (text, scenario, owner_handle, project_name, method_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(row.text, row.scenario || '', row.owner_handle, row.project_name || '', methodId);
}

// 兼容路径: 旧 API · 内部 proxy 到 createMethod (从 update 升格)
function markAsMethod({ updateId }, { currentUserId }) {
  if (!updateId) throw new Error('updateId 必填');
  const u = db.prepare(`
    SELECT u.id, u.text, u.scenario, u.project_id, p.owner_id
    FROM updates u JOIN projects p ON p.id = u.project_id
    WHERE u.id = ?
  `).get(updateId);
  if (!u) throw new Error('找不到这条进展');
  if (u.owner_id !== currentUserId) throw new Error('只能把自己写的标成方法');
  // 调 createMethod · 从 update 复制 text + scenario · 记 source_update_id
  const r = createMethod({
    text: u.text,
    scenario: u.scenario,
    projectId: u.project_id,
    sourceUpdateId: u.id,
  }, { currentUserId });
  // 同时给 updates 加 flag (向后兼容旧 webapp 读 isMethod)
  db.prepare('UPDATE updates SET is_method = 1 WHERE id = ?').run(updateId);
  return { ok: true, updateId, methodId: r.methodId };
}

function unmarkMethod({ updateId }, { currentUserId }) {
  if (!updateId) throw new Error('updateId 必填');
  const u = db.prepare(`
    SELECT u.id, p.owner_id
    FROM updates u JOIN projects p ON p.id = u.project_id
    WHERE u.id = ?
  `).get(updateId);
  if (!u) throw new Error('找不到这条进展');
  if (u.owner_id !== currentUserId) throw new Error('只能改自己的标记');
  // 找升格出来的 method · 删它
  const m = db.prepare('SELECT id FROM methods WHERE source_update_id = ? AND owner_id = ?').get(updateId, currentUserId);
  if (m) {
    deleteMethod({ methodId: m.id }, { currentUserId });
  }
  // 同时清 updates 的 flag
  db.prepare('UPDATE updates SET is_method = 0 WHERE id = ?').run(updateId);
  return { ok: true };
}

// v0.12 experience tag · 跟 markAsMethod 同构 · 但语义不同:
// method = "可被借用的方法论" · 别人 borrow 时优先拿
// experience = "踩坑经验" · 给 AI 检索时优先拿 (帮其他 AI 少走弯路)
// 同一条 update 可同时是 method 和 experience · 互不冲突
function markAsExperience({ updateId }, { currentUserId }) {
  if (!updateId) throw new Error('updateId 必填');
  const u = db.prepare(`
    SELECT u.id, u.text, p.owner_id
    FROM updates u JOIN projects p ON p.id = u.project_id
    WHERE u.id = ?
  `).get(updateId);
  if (!u) throw new Error('找不到这条进展');
  if (u.owner_id !== currentUserId) throw new Error('只能把自己写的标成经验');
  if (!u.text || u.text.trim().length < 20) throw new Error('内容太短 · 经验池希望有点干货 (至少 20 字)');
  db.prepare('UPDATE updates SET is_experience = 1 WHERE id = ?').run(updateId);
  return { ok: true, updateId };
}

function unmarkExperience({ updateId }, { currentUserId }) {
  if (!updateId) throw new Error('updateId 必填');
  const u = db.prepare(`
    SELECT u.id, p.owner_id
    FROM updates u JOIN projects p ON p.id = u.project_id
    WHERE u.id = ?
  `).get(updateId);
  if (!u) throw new Error('找不到这条进展');
  if (u.owner_id !== currentUserId) throw new Error('只能改自己的标记');
  db.prepare('UPDATE updates SET is_experience = 0 WHERE id = ?').run(updateId);
  return { ok: true };
}

// v0.13 learning tag · Learning Sprint 第二个 lifecycle 产物
// learning = "上手指南" · 给其他人快速入门一个新技术 / SDK / API 用
// 跟 method (方法) / experience (踩坑) 是平行的三种 productTag
function markAsLearning({ updateId }, { currentUserId }) {
  if (!updateId) throw new Error('updateId 必填');
  const u = db.prepare(`
    SELECT u.id, u.text, p.owner_id
    FROM updates u JOIN projects p ON p.id = u.project_id
    WHERE u.id = ?
  `).get(updateId);
  if (!u) throw new Error('找不到这条进展');
  if (u.owner_id !== currentUserId) throw new Error('只能把自己写的标成上手指南');
  if (!u.text || u.text.trim().length < 20) throw new Error('内容太短 · 上手指南池希望有点干货 (至少 20 字)');
  db.prepare('UPDATE updates SET is_learning = 1 WHERE id = ?').run(updateId);
  return { ok: true, updateId };
}

function unmarkLearning({ updateId }, { currentUserId }) {
  if (!updateId) throw new Error('updateId 必填');
  const u = db.prepare(`
    SELECT u.id, p.owner_id
    FROM updates u JOIN projects p ON p.id = u.project_id
    WHERE u.id = ?
  `).get(updateId);
  if (!u) throw new Error('找不到这条进展');
  if (u.owner_id !== currentUserId) throw new Error('只能改自己的标记');
  db.prepare('UPDATE updates SET is_learning = 0 WHERE id = ?').run(updateId);
  return { ok: true };
}

// v0.13 decision tag · Design Loop 第三个 lifecycle 产物
// decision = "决策推演" · 给其他人学 product sense 用
// 跟 method / experience / learning 平行 · 但 method 已升 first-class · decision 仍是 update flag
function markAsDecision({ updateId }, { currentUserId }) {
  if (!updateId) throw new Error('updateId 必填');
  const u = db.prepare(`
    SELECT u.id, u.text, p.owner_id
    FROM updates u JOIN projects p ON p.id = u.project_id
    WHERE u.id = ?
  `).get(updateId);
  if (!u) throw new Error('找不到这条进展');
  if (u.owner_id !== currentUserId) throw new Error('只能把自己写的标成决策推演');
  if (!u.text || u.text.trim().length < 20) throw new Error('内容太短 · 决策池希望有点干货 (至少 20 字)');
  db.prepare('UPDATE updates SET is_decision = 1 WHERE id = ?').run(updateId);
  return { ok: true, updateId };
}

function unmarkDecision({ updateId }, { currentUserId }) {
  if (!updateId) throw new Error('updateId 必填');
  const u = db.prepare(`
    SELECT u.id, p.owner_id
    FROM updates u JOIN projects p ON p.id = u.project_id
    WHERE u.id = ?
  `).get(updateId);
  if (!u) throw new Error('找不到这条进展');
  if (u.owner_id !== currentUserId) throw new Error('只能改自己的标记');
  db.prepare('UPDATE updates SET is_decision = 0 WHERE id = ?').run(updateId);
  return { ok: true };
}

// v0.12 给 CLI 拉自己最近的 update · 不走 action 路径 · 直接 GET 暴露
// 限定 currentUserId 自己的 · 不暴露别人的
// kindFilter: 'all' (默认) / 'experience' / 'method' / 'ship' / 'stuck' / 'prototype'
function listMyUpdates({ currentUserId, limit = 10, kindFilter = 'all' }) {
  const cap = Math.max(1, Math.min(parseInt(limit, 10) || 10, 50));
  let where = 'p.owner_id = ?';
  const params = [currentUserId];
  if (kindFilter === 'experience') where += ' AND u.is_experience = 1';
  else if (kindFilter === 'method') where += ' AND u.is_method = 1';
  else if (kindFilter === 'learning') where += ' AND u.is_learning = 1';
  else if (kindFilter === 'decision') where += ' AND u.is_decision = 1';
  else if (kindFilter && ['ship', 'stuck', 'prototype'].includes(kindFilter)) {
    where += ' AND u.kind = ?';
    params.push(kindFilter);
  }
  params.push(cap);
  const rows = db.prepare(`
    SELECT u.id, u.text, u.at, u.kind, u.is_method, u.is_experience, u.is_learning, u.is_decision,
           p.id AS project_id, p.slug AS project_slug, p.name AS project_name,
           usr.handle AS owner_handle
    FROM updates u
    JOIN projects p ON p.id = u.project_id
    JOIN users usr ON usr.id = p.owner_id
    WHERE ${where}
    ORDER BY u.at DESC
    LIMIT ?
  `).all(...params);
  return {
    updates: rows.map(r => ({
      id: r.id,
      text: r.text,
      at: r.at,
      kind: r.kind || null,
      isMethod: !!r.is_method,
      isExperience: !!r.is_experience,
      isLearning: !!r.is_learning,
      isDecision: !!r.is_decision,
      projectId: r.project_id,
      projectSlug: r.project_slug,
      projectName: r.project_name,
      ownerHandle: r.owner_handle,
    })),
  };
}

// v0.81 搜方法库 (methods 表) + 踩坑经验 / 上手指南 (updates is_experience / is_learning)
// methods 是 first-class · query methods_fts
// experience / learning 仍在 updates 上 (后续可能也升格 · 这次只动 method)
//
// 返回 { hits: [{ id, kind, text, scenario, title, projectName, ownerHandle, at, score }] }
// kind: 'method' | 'experience' | 'learning'
function searchMethods({ q, limit = 10, methodsOnly = false, kindFilter, borrowerHandle = null }) {
  if (!q || !q.trim()) return { hits: [] };
  const ftsQ = q.trim().split(/\s+/).filter(Boolean).map(t => t.replace(/["*]/g, '')).filter(Boolean).join(' ');
  if (!ftsQ) return { hits: [] };

  const wantMethods = !kindFilter || kindFilter === 'method' || methodsOnly;
  const wantExperience = !kindFilter || kindFilter === 'experience';
  const wantLearning = !kindFilter || kindFilter === 'learning';
  const wantDecision = !kindFilter || kindFilter === 'decision';

  let allRows = [];

  // 1. methods 表 (first-class)
  if (wantMethods) {
    let methodRows = db.prepare(`
      SELECT m.id, m.text, m.scenario, m.title, m.at,
             p.name AS project_name, usr.handle AS owner_handle,
             bm25(methods_fts) AS score,
             'method' AS kind
      FROM methods_fts
      JOIN methods m ON m.id = methods_fts.method_id
      JOIN users usr ON usr.id = m.owner_id
      LEFT JOIN projects p ON p.id = m.project_id
      WHERE methods_fts MATCH ?
      ORDER BY score ASC, m.at DESC
      LIMIT ?
    `).all(ftsQ, limit);
    if (methodRows.length === 0) {
      // LIKE 兜底 (2 字 CJK) · 多词 AND
      const words = q.trim().split(/\s+/).filter(Boolean);
      const conds = words.map(() => '(m.text LIKE ? OR (m.scenario IS NOT NULL AND m.scenario LIKE ?))').join(' AND ');
      const params = [];
      words.forEach(w => { params.push('%' + w + '%'); params.push('%' + w + '%'); });
      methodRows = db.prepare(`
        SELECT m.id, m.text, m.scenario, m.title, m.at,
               p.name AS project_name, usr.handle AS owner_handle,
               0 AS score, 'method' AS kind
        FROM methods m
        JOIN users usr ON usr.id = m.owner_id
        LEFT JOIN projects p ON p.id = m.project_id
        WHERE ${conds}
        ORDER BY m.at DESC
        LIMIT ?
      `).all(...params, limit);
    }
    allRows.push(...methodRows);
  }

  // 2. updates 上仍是 flag 的 experience / learning / decision
  if (wantExperience || wantLearning || wantDecision) {
    const flagWhere = [];
    if (wantExperience) flagWhere.push('u.is_experience = 1');
    if (wantLearning) flagWhere.push('u.is_learning = 1');
    if (wantDecision) flagWhere.push('u.is_decision = 1');
    const whereSql = flagWhere.length > 0 ? 'AND (' + flagWhere.join(' OR ') + ')' : '';
    let flagRows = db.prepare(`
      SELECT u.id, u.text, u.scenario, NULL AS title, u.at,
             u.is_experience, u.is_learning, u.is_decision,
             p.name AS project_name, usr.handle AS owner_handle,
             bm25(updates_fts) AS score
      FROM updates_fts
      JOIN updates u ON u.id = updates_fts.update_id
      JOIN projects p ON p.id = u.project_id
      JOIN users usr ON usr.id = p.owner_id
      WHERE updates_fts MATCH ? ${whereSql}
      ORDER BY score ASC, u.at DESC
      LIMIT ?
    `).all(ftsQ, limit);
    if (flagRows.length === 0) {
      // v0.13 LIKE fallback 改成多词 AND · 让"方法 进展" 这种 2 字 CJK 拆词查询也能命中
      // (trigram 对 ≤2 字 CJK term 不匹配 · 只能 LIKE 兜底)
      const words = q.trim().split(/\s+/).filter(Boolean);
      const likeConds = words.map(() => 'u.text LIKE ?').join(' AND ');
      const likeParams = words.map(w => '%' + w + '%');
      const finalLikeWhere = likeConds ? 'AND (' + likeConds + ')' : '';
      flagRows = db.prepare(`
        SELECT u.id, u.text, u.scenario, NULL AS title, u.at,
               u.is_experience, u.is_learning, u.is_decision,
               p.name AS project_name, usr.handle AS owner_handle,
               0 AS score
        FROM updates u
        JOIN projects p ON p.id = u.project_id
        JOIN users usr ON usr.id = p.owner_id
        WHERE 1=1 ${whereSql} ${finalLikeWhere}
        ORDER BY u.at DESC
        LIMIT ?
      `).all(...likeParams, limit);
    }
    flagRows.forEach(r => {
      // 一条 update 可能同时多 flag · 这里取最稀缺优先 (decision > experience > learning > method)
      r.kind = r.is_decision ? 'decision'
            : r.is_experience ? 'experience'
            : r.is_learning ? 'learning'
            : 'method';
      allRows.push(r);
    });
  }

  // 排序 · 整体按 score asc / at desc · 截断 limit
  allRows.sort((a, b) => (a.score - b.score) || (b.at - a.at));
  allRows = allRows.slice(0, limit);

  // 借用反馈闭环: borrower 已登录 + 命中 method ≥1 条 · 记前 3 条 method
  // 老 update.is_method 现在 method 已迁出 · 只 log method 命中
  if (borrowerHandle && allRows.length > 0) {
    const excerpt = q.trim().slice(0, 80);
    const at = Date.now();
    const recent = at - 24 * 60 * 60 * 1000;
    const dedupe = db.prepare(`SELECT 1 FROM borrow_log WHERE method_id = ? AND borrower_handle = ? AND at > ?`);
    const ins = db.prepare(`
      INSERT INTO borrow_log (update_id, method_id, owner_handle, borrower_handle, query_excerpt, at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const methodHits = allRows.filter(r => r.kind === 'method').slice(0, 3);
    for (const r of methodHits) {
      if (r.owner_handle === borrowerHandle) continue;
      if (dedupe.get(r.id, borrowerHandle, recent)) continue;
      ins.run(null, r.id, r.owner_handle, borrowerHandle, excerpt, at);
    }
  }

  return {
    hits: allRows.map(r => ({
      // 向后兼容 CLI / webapp: 用 id 字段
      id: r.id,
      // 兼容老 CLI 用 updateId · 取自 id (无论 method 或 update)
      updateId: r.id,
      methodId: r.kind === 'method' ? r.id : null,
      kind: r.kind,
      text: r.text,
      scenario: r.scenario || null,
      title: r.title || null,
      projectName: r.project_name,
      ownerHandle: r.owner_handle,
      at: r.at,
      // 老 boolean 字段兼容
      isMethod: r.kind === 'method',
      isExperience: r.kind === 'experience',
      isLearning: r.kind === 'learning',
      score: r.score,
    })),
  };
}

// 给作者看自己的方法被借了几次 · 时间窗内 · 默认近 7 天
// v0.81: borrow_log 现在用 method_id · COALESCE 兼容老 update_id 数据
// 返回 { total, byUpdate: [{ updateId, projectName, excerpt, count, lastAt, lastBorrower }] }
function getBorrowsForOwner({ ownerHandle, sinceMs = null }) {
  if (!ownerHandle) return { total: 0, byUpdate: [] };
  const since = sinceMs || (Date.now() - 7 * 24 * 60 * 60 * 1000);
  // 用 COALESCE(method_id, update_id) 作为 key · 兼容新老 borrow_log 数据
  const rows = db.prepare(`
    SELECT COALESCE(bl.method_id, bl.update_id) AS ref_id,
           COUNT(*) AS cnt, MAX(bl.at) AS last_at,
           COALESCE(m.text, u.text) AS text,
           COALESCE(mp.name, up.name) AS project_name
    FROM borrow_log bl
    LEFT JOIN methods m ON m.id = bl.method_id
    LEFT JOIN projects mp ON mp.id = m.project_id
    LEFT JOIN updates u ON u.id = bl.update_id
    LEFT JOIN projects up ON up.id = u.project_id
    WHERE bl.owner_handle = ? AND bl.at > ?
    GROUP BY ref_id
    ORDER BY last_at DESC
    LIMIT 20
  `).all(ownerHandle, since);
  const lastBorrowerStmt = db.prepare(`
    SELECT borrower_handle FROM borrow_log
    WHERE COALESCE(method_id, update_id) = ? AND owner_handle = ? AND at > ?
    ORDER BY at DESC LIMIT 1
  `);
  const total = rows.reduce((s, r) => s + r.cnt, 0);
  return {
    total,
    byUpdate: rows.map(r => ({
      updateId: r.ref_id,
      projectName: r.project_name || '(已删)',
      excerpt: (r.text || '').slice(0, 60),
      count: r.cnt,
      lastAt: r.last_at,
      lastBorrower: lastBorrowerStmt.get(r.ref_id, ownerHandle, since)?.borrower_handle || null,
    })),
  };
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

function submitTinkered({ projectId, name, link, inspiredByUpdateId }, { currentUserId }) {
  if (!name || !name.trim()) throw new Error('你做的项目名字必填');
  link = normalizeUrl(link);
  if (!isValidUrl(link)) throw new Error('产物链接得是 http(s):// 开头的网址');
  const p = db.prepare('SELECT owner_id, name FROM projects WHERE id = ?').get(projectId);
  if (!p) throw new Error('项目不存在');

  // v0.12 新提交必填 inspiredByUpdateId · 颗粒度从项目细化到 update
  // 验证 update 真属于这个 parent project (防止伪造)
  if (!inspiredByUpdateId || !inspiredByUpdateId.trim()) {
    throw new Error('挑一条具体启发了你的进展 · 颗粒度精确到那一笔');
  }
  const insp = db.prepare('SELECT id, project_id FROM updates WHERE id = ?').get(inspiredByUpdateId.trim());
  if (!insp) throw new Error('启发源那条进展找不到 · 可能被删了');
  if (insp.project_id !== projectId) {
    throw new Error('启发源得是这个项目下的进展 · 不能跨项目');
  }

  const txn = db.transaction(() => {
    // 清 wantToTry (升级到 tinkered)
    db.prepare('DELETE FROM reactions WHERE project_id = ? AND user_id = ?')
      .run(projectId, currentUserId);
    // UNIQUE(parent_project_id, user_id) · 重复 INSERT 会 throw · 改用 INSERT OR REPLACE
    db.prepare(`
      INSERT OR REPLACE INTO tinkered (id, parent_project_id, user_id, name, link, at, inspired_by_update_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      't-' + Date.now() + Math.random().toString(36).slice(2, 6),
      projectId, currentUserId, name.trim(), link.trim(), Date.now(),
      inspiredByUpdateId.trim()
    );
  });
  txn();

  // 升级承诺 · 清掉之前给 owner 的 wantToTry 通知 · 否则 owner 同时看到 "想试试" + "因启发做了"
  clearNotif({ targetUserId: p.owner_id, fromUserId: currentUserId, type: 'wantToTry', projectId });

  // anchor 用 update-<id> · 原作者点通知能直接跳到那条启发了别人的具体进展
  notify({
    targetUserId: p.owner_id, fromUserId: currentUserId, type: 'tinkered',
    projectId, extra: name.trim(), anchor: 'update-' + inspiredByUpdateId.trim(),
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
      const insLink = db.prepare('INSERT INTO note_images (note_id, image_id, position) VALUES (?, ?, ?)');
      images.forEach((img, idx) => {
        const imgId = resolveImageId(img);
        if (imgId) insLink.run(noteId, imgId, idx);
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
  searchMethods, getBorrowsForOwner, // 不走 action 路径 · 直接 GET 暴露
  listMyUpdates, // 不走 action 路径 · 直接 GET 暴露 (CLI 用)
  // users
  editTagline, renameHandle,
  // projects
  addProject, editProject, editProjectTimeline, changeProjectStatus, shipProject, exhibitProject,
  pinUpdateForShowcase, toggleShowcaseVisibility,
  // updates
  addUpdate, editUpdate, deleteUpdate,
  // v0.81 methods first-class · 跟 updates 平级独立 entity
  createMethod, editMethod, deleteMethod,
  // method library (v0.12 兼容路径 · 内部 proxy 到 createMethod / deleteMethod)
  markAsMethod, unmarkMethod,
  // experience tag (v0.12) · 给 AI 检索经验 · 跟 method 同构但语义不同
  markAsExperience, unmarkExperience,
  // learning tag (v0.13) · 上手指南 · 给 AI 检索新技术入门
  markAsLearning, unmarkLearning,
  // decision tag (v0.13) · 决策推演 · 给 AI 检索 product sense
  markAsDecision, unmarkDecision,
  // reactions
  reactToProject, submitTinkered, deleteTinkered, markMethodUsed,
  // notes
  addNote, deleteNote,
  // notifications
  markAllRead, markNotifRead,
};

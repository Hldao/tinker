// state denormalizer · 从 SQL 抓数据 · 还原成 webapp 期望的 state shape
//
// 设计原则:
//   - 用尽量少的 query (N+1 反模式杀手 · 用批量 fetch + group by)
//   - 内部用 user_id (UUID) · 对外返 handle
//   - state shape 跟之前 JSON file 一致 · webapp 不改

const db = require('./db');

// ====================================================
// 主入口 · 返回完整 state (给 /api/state 用)
// ====================================================
function buildState({ targetUserId } = {}) {
  // 一次性抓所有 users · 建 id → handle 的映射
  const usersRows = db.prepare(`
    SELECT id, handle, name, tagline FROM users
  `).all();
  const idToHandle = {};
  const usersOut = {};
  for (const u of usersRows) {
    idToHandle[u.id] = u.handle;
    usersOut[u.handle] = { name: u.name || u.handle, tagline: u.tagline || '' };
  }

  // v0.20 给每个 user 带上挂靠的工作室 · 让个人页能渲染"挂靠 → /s/xxx"链接
  // 一次性 join 查 · 不 N+1 (workshop 数量很少)
  const studioRows = db.prepare(`
    SELECT sm.user_id, s.slug, s.name, s.tagline AS studioTagline, sm.role
    FROM studio_members sm
    JOIN studios s ON s.id = sm.studio_id
    ORDER BY sm.joined_at ASC
  `).all();
  for (const r of studioRows) {
    const handle = idToHandle[r.user_id];
    if (!handle || !usersOut[handle]) continue;
    if (!usersOut[handle].studios) usersOut[handle].studios = [];
    usersOut[handle].studios.push({ slug: r.slug, name: r.name, tagline: r.studioTagline, role: r.role });
  }

  // 抓所有项目 (包括 archive) · feed 由 webapp getFeedEvents 过滤 · workshop 的"做过的"区要显示 archive
  const projectsRows = db.prepare(`
    SELECT id, owner_id, slug, name, desc, product_link, status, shipped_at, github_link,
           pinned_update_id, hidden_from_showcase, created_at, updated_at
    FROM projects
    ORDER BY updated_at DESC
  `).all();

  // 批量抓所有 project 关联数据 · group by project_id
  const tools = groupBy(db.prepare('SELECT project_id, tool FROM project_tools').all(), 'project_id');
  const updatesRows = db.prepare('SELECT * FROM updates ORDER BY at DESC').all();
  const updatesByProject = groupBy(updatesRows, 'project_id');

  // 给 updates 上 images + usedBy
  const updateIds = updatesRows.map(u => u.id);
  const updateImagesMap = {};
  const usedByMap = {};
  if (updateIds.length > 0) {
    const placeholders = updateIds.map(() => '?').join(',');
    // v0.62: 不再拉 src (base64) 进主响应 · 只返 image_id · webapp 拼 /api/image/{id}
    // 主响应预计从 1.5MB 降到 30KB 以内 · 图片走单独 endpoint + 1 年缓存
    const imgRows = db.prepare(`
      SELECT ui.update_id, ui.position, i.id AS image_id, i.caption
      FROM update_images ui JOIN images i ON i.id = ui.image_id
      WHERE ui.update_id IN (${placeholders})
      ORDER BY ui.update_id, ui.position
    `).all(...updateIds);
    for (const r of imgRows) {
      if (!updateImagesMap[r.update_id]) updateImagesMap[r.update_id] = [];
      updateImagesMap[r.update_id].push({ src: '/api/image/' + r.image_id, caption: r.caption || '' });
    }
    const muRows = db.prepare(`
      SELECT update_id, user_id, note, at FROM method_used
      WHERE update_id IN (${placeholders})
      ORDER BY at DESC
    `).all(...updateIds);
    for (const r of muRows) {
      if (!usedByMap[r.update_id]) usedByMap[r.update_id] = [];
      usedByMap[r.update_id].push({ user: idToHandle[r.user_id], note: r.note || '', at: r.at });
    }
  }

  // notes + note_images
  const notesRows = db.prepare('SELECT * FROM notes ORDER BY at DESC').all();
  const notesByProject = groupBy(notesRows, 'project_id');
  const noteIds = notesRows.map(n => n.id);
  const noteImagesMap = {};
  if (noteIds.length > 0) {
    const placeholders = noteIds.map(() => '?').join(',');
    const imgRows = db.prepare(`
      SELECT ni.note_id, ni.position, i.id AS image_id, i.caption
      FROM note_images ni JOIN images i ON i.id = ni.image_id
      WHERE ni.note_id IN (${placeholders})
      ORDER BY ni.note_id, ni.position
    `).all(...noteIds);
    for (const r of imgRows) {
      if (!noteImagesMap[r.note_id]) noteImagesMap[r.note_id] = [];
      noteImagesMap[r.note_id].push({ src: '/api/image/' + r.image_id, caption: r.caption || '' });
    }
  }

  // reactions
  const reactionsByProject = groupBy(
    db.prepare('SELECT * FROM reactions').all(),
    'project_id'
  );

  // tinkered
  const tinkeredByParent = groupBy(
    db.prepare('SELECT * FROM tinkered ORDER BY at DESC').all(),
    'parent_project_id'
  );

  // v0.81 methods first-class · 跟 updates 平级独立 entity
  // 按 project group · 让 webapp 在项目页 "沉淀方法" 区直接读 p.methods
  // 没绑定项目的方法 (project_id IS NULL) 走 owner 维度 · 在 workshop 页用
  const methodsRows = db.prepare('SELECT * FROM methods ORDER BY at DESC').all();
  const methodsByProject = groupBy(methodsRows.filter(m => m.project_id), 'project_id');
  const methodsByOwner = groupBy(methodsRows, 'owner_id');

  // v0.84 每条 method 的被借次数 · 一次性 GROUP BY 算完 · 不 N+1
  // 让 hero / 方法库 / 工作室 都能按 borrowCount 排 · "经过验证的方法浮上来"
  const borrowCounts = {};
  db.prepare(`SELECT method_id, COUNT(*) AS cnt FROM borrow_log WHERE method_id IS NOT NULL GROUP BY method_id`).all()
    .forEach(r => { borrowCounts[r.method_id] = r.cnt; });

  // 组装 projects · webapp 期望的形状
  const projectsOut = projectsRows.map(p => {
    const projectUpdates = (updatesByProject[p.id] || []).map(u => {
      const out = { id: u.id, text: u.text, at: u.at };
      if (u.prompt) out.prompt = u.prompt;
      if (u.feedback_ask !== null && u.feedback_ask !== undefined) out.feedbackAsk = u.feedback_ask;
      if (u.kind) out.kind = u.kind;
      if (u.is_method) out.isMethod = true;
      if (u.is_experience) out.isExperience = true;
      if (u.is_learning) out.isLearning = true;
      if (u.is_decision) out.isDecision = true;
      if (u.scenario) out.scenario = u.scenario;
      const imgs = updateImagesMap[u.id];
      if (imgs && imgs.length > 0) out.images = imgs;
      const usedBy = usedByMap[u.id];
      if (usedBy && usedBy.length > 0) out.usedBy = usedBy;
      return out;
    });
    const projectNotes = (notesByProject[p.id] || []).map(n => {
      const out = { id: n.id, user: idToHandle[n.user_id], text: n.text, at: n.at };
      if (n.update_id) out.updateId = n.update_id;
      const imgs = noteImagesMap[n.id];
      if (imgs && imgs.length > 0) out.images = imgs;
      return out;
    });
    const projectReactions = reactionsByProject[p.id] || [];
    const wantToTry = projectReactions
      .filter(r => r.type === 'wantToTry')
      .map(r => idToHandle[r.user_id])
      .filter(Boolean);
    const tinkeredList = (tinkeredByParent[p.id] || []).map(t => ({
      user: idToHandle[t.user_id],
      name: t.name,
      link: t.link,
      at: t.at,
      inspiredByUpdateId: t.inspired_by_update_id || null,
    }));
    const projectMethods = (methodsByProject[p.id] || []).map(m => ({
      id: m.id,
      owner: idToHandle[m.owner_id],
      title: m.title || null,
      scenario: m.scenario || null,
      text: m.text,
      at: m.at,
      updatedAt: m.updated_at,
      projectId: m.project_id,
      sourceUpdateId: m.source_update_id || null,
      sourceDocPath: m.source_doc_path || null,
      borrowCount: borrowCounts[m.id] || 0,
      tags: m.tags ? (() => { try { return JSON.parse(m.tags); } catch { return []; } })() : [],
    }));
    return {
      id: p.id,
      owner: idToHandle[p.owner_id],
      slug: p.slug,
      name: p.name,
      desc: p.desc,
      productLink: p.product_link,
      status: p.status,
      updatedAt: p.updated_at || undefined,
      shippedAt: p.shipped_at || undefined,
      pinnedUpdateId: p.pinned_update_id || undefined,
      hiddenFromShowcase: !!p.hidden_from_showcase,
      githubLink: p.github_link || undefined,
      timeline: p.timeline || undefined,
      tools: (tools[p.id] || []).map(t => t.tool),
      updates: projectUpdates,
      notes: projectNotes,
      methods: projectMethods,
      reactions: { wantToTry, tinkered: tinkeredList },
    };
  });

  // notifications · 只返当前 user 的 (匿名 = [])
  let notificationsOut = [];
  if (targetUserId) {
    const notifRows = db.prepare(`
      SELECT n.id, n.target_user_id, n.from_user_id, n.type, n.project_id, n.extra, n.anchor,
             n.at, n.read_at,
             p.name AS project_name, p.slug AS project_slug, owner_u.handle AS project_owner
      FROM notifications n
      LEFT JOIN projects p ON p.id = n.project_id
      LEFT JOIN users owner_u ON owner_u.id = p.owner_id
      WHERE n.target_user_id = ?
      ORDER BY n.at DESC
      LIMIT 200
    `).all(targetUserId);
    notificationsOut = notifRows.map(n => ({
      id: n.id,
      target: idToHandle[n.target_user_id],
      fromUser: idToHandle[n.from_user_id],
      type: n.type,
      projectId: n.project_id,
      projectName: n.project_name,
      projectSlug: n.project_slug,
      projectOwner: n.project_owner,
      anchor: n.anchor,
      extra: n.extra,
      at: n.at,
      read: n.read_at !== null,
    }));
  }

  // v0.81 全站 methods 数组 · webapp 工作室页 / 全站方法库浏览页都从这里 filter
  // 字段跟 project.methods 一致 · 包括 v0.84 tags
  const methodsOut = methodsRows.map(m => ({
    id: m.id,
    owner: idToHandle[m.owner_id],
    title: m.title || null,
    scenario: m.scenario || null,
    text: m.text,
    at: m.at,
    updatedAt: m.updated_at,
    projectId: m.project_id || null,
    sourceUpdateId: m.source_update_id || null,
    sourceDocPath: m.source_doc_path || null,
    borrowCount: borrowCounts[m.id] || 0,
    tags: m.tags ? (() => { try { return JSON.parse(m.tags); } catch { return []; } })() : [],
  }));

  // starters + tools
  const starters = db.prepare('SELECT title, prompt, tool_name AS toolName, tool_url AS toolUrl, category FROM starters ORDER BY position').all();
  const availableTools = db.prepare('SELECT tool FROM available_tools ORDER BY position').all().map(r => r.tool);

  return {
    users: usersOut,
    projects: projectsOut,
    methods: methodsOut,
    notifications: notificationsOut,
    starters,
    availableTools,
  };
}

// helper: array → object grouped by key
function groupBy(arr, key) {
  const out = {};
  for (const item of arr) {
    const k = item[key];
    if (!out[k]) out[k] = [];
    out[k].push(item);
  }
  return out;
}

// helper: handle → user_id (按 handle 查 user · 给 actions 用)
function userIdFromHandle(handle) {
  const row = db.prepare('SELECT id FROM users WHERE handle = ?').get(handle);
  return row?.id || null;
}

module.exports = { buildState, userIdFromHandle };

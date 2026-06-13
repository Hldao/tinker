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
  // 一次性抓所有 users · 建 id → handle 的映射 (内部用 · 不暴露)
  const usersRows = db.prepare(`
    SELECT id, handle, name, tagline FROM users
  `).all();
  const idToHandle = {};

  // 隐私:usersOut 只放"被公开内容引用到的" handle · 纯潜水用户 (零项目/便签/方法/反馈) 不进 dump
  //   不然一个匿名 GET 就能拉走全站用户清单 (含从没发过东西的人的昵称+签名)。
  //   想按 handle/tagline 找工坊走 /api/workshops/search 服务端单查。
  const referencedIds = new Set();
  db.prepare('SELECT DISTINCT owner_id AS id FROM projects').all().forEach(r => referencedIds.add(r.id));
  db.prepare('SELECT DISTINCT user_id AS id FROM notes').all().forEach(r => referencedIds.add(r.id));
  db.prepare('SELECT DISTINCT resolved_by AS id FROM notes WHERE resolved_by IS NOT NULL').all().forEach(r => referencedIds.add(r.id));
  db.prepare('SELECT DISTINCT user_id AS id FROM method_used').all().forEach(r => referencedIds.add(r.id));
  db.prepare('SELECT DISTINCT user_id AS id FROM reactions').all().forEach(r => referencedIds.add(r.id));
  db.prepare('SELECT DISTINCT user_id AS id FROM tinkered').all().forEach(r => referencedIds.add(r.id));
  db.prepare('SELECT DISTINCT owner_id AS id FROM methods').all().forEach(r => referencedIds.add(r.id));
  if (targetUserId) referencedIds.add(targetUserId); // 请求者本人永远带上 · 自己的页要用

  const usersOut = {};
  for (const u of usersRows) {
    idToHandle[u.id] = u.handle;
    if (referencedIds.has(u.id)) {
      usersOut[u.handle] = { name: u.name || u.handle, tagline: u.tagline || '' };
    }
  }

  // 工作室挂靠关系 · 只给"请求者本人"带上 (隐私:别在全站 dump 里把每个人的工作室成员关系
  //   一把吐给匿名访问者 · 那会变成可批量爬的社交图)。
  // 看别人资料页时 · webapp 按需调 /api/users/:handle/studios-preview 单取 (一次一个 · 要知道 handle)。
  // 工作室聚合页 /api/studios/:slug 仍公开列成员 · 那是"专门访问某个工作室"的设计 · 不是批量。
  const myHandle = targetUserId ? idToHandle[targetUserId] : null;
  if (myHandle && usersOut[myHandle]) {
    const myStudioRows = db.prepare(`
      SELECT s.slug, s.name, s.tagline AS studioTagline, sm.role
      FROM studio_members sm
      JOIN studios s ON s.id = sm.studio_id
      WHERE sm.user_id = ?
      ORDER BY sm.joined_at ASC
    `).all(targetUserId);
    if (myStudioRows.length > 0) {
      usersOut[myHandle].studios = myStudioRows.map(r => ({ slug: r.slug, name: r.name, tagline: r.studioTagline, role: r.role }));
    }
  }

  // 抓所有项目 (包括 archive) · feed 由 webapp getFeedEvents 过滤 · workshop 的"做过的"区要显示 archive
  const projectsRows = db.prepare(`
    SELECT id, owner_id, slug, name, desc, product_link, status, shipped_at, github_link,
           pinned_update_id, hidden_from_showcase, studio_id, created_at, updated_at
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

  // 一等方法的「用了·跑通了」· 借用环的"还"那一半 (借了能回应) · 按 method_id 收
  const usedByMethod = {};
  db.prepare(`SELECT method_id, user_id, note, at FROM method_used WHERE method_id IS NOT NULL ORDER BY at DESC`).all()
    .forEach(r => {
      if (!usedByMethod[r.method_id]) usedByMethod[r.method_id] = [];
      usedByMethod[r.method_id].push({ user: idToHandle[r.user_id], note: r.note || '', at: r.at });
    });

  // 组装 projects · webapp 期望的形状
  const projectsOut = projectsRows.map(p => {
    // v1.0 瘦身: 首屏 update 只给预览 (前 400 字 + truncated 标记) · 全文走 /api/project/:id/updates
    // 全文是首屏体积大头 (103KB · 占整个 state 70%) · 且是独一无二内容 · 压缩救不了 · 只能懒加载
    const isOwner = !!targetUserId && p.owner_id === targetUserId;
    const projectUpdates = (updatesByProject[p.id] || []).map(u =>
      mapUpdateRow(u, updateImagesMap[u.id], usedByMap[u.id], { preview: true, includePrompt: isOwner })
    );
    const projectNotes = (notesByProject[p.id] || []).map(n => {
      const out = { id: n.id, user: idToHandle[n.user_id], text: n.text, at: n.at };
      if (n.update_id) out.updateId = n.update_id;
      if (n.resolved_at) { out.resolvedAt = n.resolved_at; out.resolvedBy = idToHandle[n.resolved_by] || null; }
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
    // v1.0 去重 · 方法全文只在顶层 methods[] 存一份 (单一真相)
    // 这里项目只挂 id 引用 · webapp 按 id 去 state.methods 取完整对象
    // 之前每条方法的 text 在 顶层 + 项目里各发一份 · 27KB 白白重复
    const projectMethodIds = (methodsByProject[p.id] || []).map(m => m.id);
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
      studioId: p.studio_id || undefined,
      tools: (tools[p.id] || []).map(t => t.tool),
      updates: projectUpdates,
      notes: projectNotes,
      methods: projectMethodIds,
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
    usedBy: usedByMethod[m.id] || [],
    tags: m.tags ? (() => { try { return JSON.parse(m.tags); } catch { return []; } })() : [],
  }));

  // starters + tools
  const starters = db.prepare('SELECT title, prompt, tool_name AS toolName, tool_url AS toolUrl, category FROM starters ORDER BY position').all();
  const availableTools = db.prepare('SELECT tool FROM available_tools ORDER BY position').all().map(r => r.tool);

  // v0.41 暴露所有 studio 列表 · 给 cli/webapp 项目归属 picker 用
  // 不含成员列表 (那个走 studioGet 单独拿) · 只给 id/slug/name 这层够用
  const studiosOut = db.prepare(`
    SELECT id, slug, name, tagline FROM studios ORDER BY created_at ASC
  `).all();

  return {
    users: usersOut,
    projects: projectsOut,
    methods: methodsOut,
    notifications: notificationsOut,
    studios: studiosOut,
    starters,
    availableTools,
  };
}

// ====================================================
// 单项目全量 updates · 给 /api/project/:id/updates 用 (懒加载)
// /api/state 里 update 只带预览 · 进项目详情页时按需拉这个拿全文
// 形状跟 buildState 的 projectUpdates 完全一致 (共用 mapUpdateRow)
// ====================================================
function buildProjectUpdates(projectId, { targetUserId } = {}) {
  const updatesRows = db.prepare('SELECT * FROM updates WHERE project_id = ? ORDER BY at DESC').all(projectId);
  if (updatesRows.length === 0) return [];
  // prompt 只给作者本人 · 跟 buildState 一致 (看请求者是不是这个项目的 owner)
  const proj = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(projectId);
  const isOwner = !!targetUserId && !!proj && proj.owner_id === targetUserId;
  const updateIds = updatesRows.map(u => u.id);
  const placeholders = updateIds.map(() => '?').join(',');

  const idToHandle = {};
  db.prepare('SELECT id, handle FROM users').all().forEach(u => { idToHandle[u.id] = u.handle; });

  const updateImagesMap = {};
  db.prepare(`
    SELECT ui.update_id, ui.position, i.id AS image_id, i.caption
    FROM update_images ui JOIN images i ON i.id = ui.image_id
    WHERE ui.update_id IN (${placeholders})
    ORDER BY ui.update_id, ui.position
  `).all(...updateIds).forEach(r => {
    if (!updateImagesMap[r.update_id]) updateImagesMap[r.update_id] = [];
    updateImagesMap[r.update_id].push({ src: '/api/image/' + r.image_id, caption: r.caption || '' });
  });

  const usedByMap = {};
  db.prepare(`
    SELECT update_id, user_id, note, at FROM method_used
    WHERE update_id IN (${placeholders})
    ORDER BY at DESC
  `).all(...updateIds).forEach(r => {
    if (!usedByMap[r.update_id]) usedByMap[r.update_id] = [];
    usedByMap[r.update_id].push({ user: idToHandle[r.user_id], note: r.note || '', at: r.at });
  });

  return updatesRows.map(u => mapUpdateRow(u, updateImagesMap[u.id], usedByMap[u.id], { preview: false, includePrompt: isOwner }));
}

// 搜工坊 · 给 /api/workshops/search 用 (替代前端从全量 state.users 本地过滤)
// 只返"有公开足迹的"用户 (≥1 项目或方法) · 纯潜水账号不出现 · 也不暴露全量名单
function searchWorkshops({ q, limit = 10 } = {}) {
  const query = String(q || '').trim().toLowerCase();
  if (!query) return [];
  const like = '%' + query + '%';
  const rows = db.prepare(`
    SELECT u.handle, u.name, u.tagline
    FROM users u
    WHERE (LOWER(u.handle) LIKE ? OR LOWER(IFNULL(u.tagline,'')) LIKE ? OR LOWER(IFNULL(u.name,'')) LIKE ?)
      AND (EXISTS (SELECT 1 FROM projects p WHERE p.owner_id = u.id)
           OR EXISTS (SELECT 1 FROM methods m WHERE m.owner_id = u.id))
    ORDER BY u.handle ASC
    LIMIT ?
  `).all(like, like, like, Math.min(limit, 30));
  return rows.map(r => ({ handle: r.handle, name: r.name || r.handle, tagline: r.tagline || '' }));
}

// 共享的 update 行 → webapp 形状映射 · buildState 和 buildProjectUpdates 共用 · 防形状漂移
// preview=true 时 text 只给前 N 字预览 + truncated 标记 (首屏瘦身用 · 全文走 /api/project/:id/updates)
const UPDATE_PREVIEW_CHARS = 400;
function mapUpdateRow(u, imgs, usedBy, { preview, includePrompt } = {}) {
  let text = u.text || '';
  let truncated = false;
  if (preview && text.length > UPDATE_PREVIEW_CHARS) {
    text = text.slice(0, UPDATE_PREVIEW_CHARS);
    truncated = true;
  }
  const out = { id: u.id, text, at: u.at };
  if (truncated) out.truncated = true;
  // prompt (AI 提示词原文) 只给作者本人 · 不进公开 dump (反"提示词博物馆" · 见产品立场)
  if (u.prompt && includePrompt) out.prompt = u.prompt;
  if (u.feedback_ask !== null && u.feedback_ask !== undefined) out.feedbackAsk = u.feedback_ask;
  if (u.kind) out.kind = u.kind;
  if (u.is_method) out.isMethod = true;
  if (u.is_experience) out.isExperience = true;
  if (u.is_learning) out.isLearning = true;
  if (u.is_decision) out.isDecision = true;
  if (u.is_seeking) out.isSeeking = true;
  if (u.scenario) out.scenario = u.scenario;
  if (imgs && imgs.length > 0) out.images = imgs;
  if (usedBy && usedBy.length > 0) out.usedBy = usedBy;
  return out;
}

// ====================================================
// 后端 update 全文搜索 · 给 /api/updates/search 用
// 懒加载后首屏没全文了 · 全站搜索框改走这个 · 不降级 (照样全文匹配)
// 只搜公开内容 (排除 archive 项目) · LIKE 子串匹配 (跟原前端 includes() 行为一致)
// ====================================================
function searchUpdates({ q, limit = 8 } = {}) {
  const query = String(q || '').trim();
  if (!query) return [];
  const idToHandle = {};
  db.prepare('SELECT id, handle FROM users').all().forEach(u => { idToHandle[u.id] = u.handle; });
  const rows = db.prepare(`
    SELECT u.id, u.text, u.at, u.kind, u.is_method, u.is_experience, u.is_learning, u.is_decision,
           u.scenario, p.owner_id, p.slug AS project_slug, p.name AS project_name
    FROM updates u
    JOIN projects p ON p.id = u.project_id
    WHERE p.status != 'archive'
      AND u.is_method = 0
      AND LOWER(u.text) LIKE '%' || LOWER(?) || '%'
    ORDER BY u.at DESC
    LIMIT ?
  `).all(query, Math.min(limit, 30));
  return rows.map(r => ({
    updateId: r.id,
    projectOwner: idToHandle[r.owner_id],
    projectSlug: r.project_slug,
    projectName: r.project_name,
    at: r.at,
    isExperience: !!r.is_experience,
    isLearning: !!r.is_learning,
    isDecision: !!r.is_decision,
    scenario: r.scenario || null,
    preview: (r.text || '').slice(0, 120),
  }));
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

module.exports = { buildState, userIdFromHandle, buildProjectUpdates, searchUpdates, searchWorkshops };

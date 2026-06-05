// Tinker server — action handlers
// 每个 action 接受 state + payload,直接 mutate state,return state
// index.js 调用 action 后 saveData() 持久化

// helper: 从文本中提取有效 @ 提及 (要求 user 存在于 state.users)
function extractMentions(state, text) {
  if (!text || !state.users) return [];
  const out = new Set();
  const re = /@([A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (state.users[m[1]]) out.add(m[1]);
  }
  return Array.from(out);
}

// helper: 创建通知 (含去重 — 同一 user 对同一 project 的同 type 通知只保留最新)
function addNotification(state, { target, fromUser, type, projectId, projectName, extra }) {
  if (!state.notifications) state.notifications = [];
  state.notifications = state.notifications.filter(n =>
    !(n.target === target && n.fromUser === fromUser && n.type === type && n.projectId === projectId)
  );
  state.notifications.unshift({
    id: 'n-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    target, fromUser, type, projectId, projectName,
    extra: extra || null,
    ago: '刚刚', read: false,
  });
}

// helper: URL 校验
function isValidUrl(s) {
  if (!s) return false;
  return /^https?:\/\/\S+\.\S+/i.test(s.trim());
}

// =============================================
// PROJECTS
// =============================================

function addProject(state, { currentUser = 'daodao', name, desc, productLink, status = 'active', tools = [] }) {
  if (!name || !name.trim()) throw new Error('项目得有个名字');
  if (!desc || !desc.trim()) throw new Error('描述不能为空');
  if (!isValidUrl(productLink)) throw new Error('需要 https:// 的可访问产物链接');
  const newProject = {
    id: 'p-' + Date.now(),
    owner: currentUser,
    name: name.trim(),
    slug: 'p-' + Date.now().toString(36),
    desc: desc.trim(),
    productLink: productLink.trim(),
    status,
    tools: Array.isArray(tools) ? tools : [],
    updates: [],
    reactions: { interested: [], wantToTry: [], tinkered: [] },
    notes: [],
  };
  state.projects.unshift(newProject);
  return newProject;
}

function changeProjectStatus(state, { projectId, newStatus, currentUser = 'daodao' }) {
  const p = state.projects.find(x => x.id === projectId);
  if (!p) throw new Error('项目不存在');
  if (p.owner !== currentUser) throw new Error('只能改自己项目的状态');
  const oldStatus = p.status;
  p.status = newStatus;
  // 跑通了 — 通知 wantToTry 的人
  if (oldStatus !== 'done' && newStatus === 'done') {
    (p.reactions.wantToTry || []).forEach(u => {
      if (u !== currentUser) {
        addNotification(state, {
          target: u, fromUser: p.owner, type: 'projectDone',
          projectId: p.id, projectName: p.name,
          extra: '你之前说过想试试 · 现在能用了',
        });
      }
    });
  }
  return p;
}

// =============================================
// UPDATES
// =============================================

function addUpdate(state, { projectId, text, images, prompt, currentUser = 'daodao' }) {
  const p = state.projects.find(x => x.id === projectId);
  if (!p) throw new Error('项目不存在');
  if (!text || !text.trim()) throw new Error('记一笔不能空');
  if (p.owner !== currentUser) throw new Error('只能给自己的项目记一笔');
  const update = { text: text.trim(), ago: '刚刚' };
  if (images && images.length > 0) update.images = images;
  if (prompt) update.prompt = prompt;
  p.updates.unshift(update);
  // @ 提及通知
  extractMentions(state, update.text).forEach(u => {
    if (u !== currentUser) {
      addNotification(state, {
        target: u, fromUser: currentUser, type: 'mentioned',
        projectId: p.id, projectName: p.name, extra: update.text,
      });
    }
  });
  return update;
}

function editUpdate(state, { projectId, updateIdx, text, images, currentUser = 'daodao' }) {
  const p = state.projects.find(x => x.id === projectId);
  if (!p) throw new Error('项目不存在');
  if (p.owner !== currentUser) throw new Error('只能编辑自己的进展');
  const u = p.updates[updateIdx];
  if (!u) throw new Error('找不到这条进展');
  if (!text || !text.trim()) throw new Error('进展内容不能空');
  u.text = text.trim();
  if (images && images.length > 0) u.images = images;
  else delete u.images;
  return u;
}

function deleteUpdate(state, { projectId, updateIdx, currentUser = 'daodao' }) {
  const p = state.projects.find(x => x.id === projectId);
  if (!p) throw new Error('项目不存在');
  if (p.owner !== currentUser) throw new Error('只能删自己的进展');
  if (!p.updates[updateIdx]) throw new Error('找不到这条进展');
  p.updates.splice(updateIdx, 1);
  return { ok: true };
}

// =============================================
// REACTIONS
// =============================================

function reactToProject(state, { projectId, level, currentUser = 'daodao' }) {
  const p = state.projects.find(x => x.id === projectId);
  if (!p) throw new Error('项目不存在');
  const wasWantToTry = p.reactions.wantToTry.includes(currentUser);
  if (level === 'wantToTry' && wasWantToTry) {
    p.reactions.wantToTry = p.reactions.wantToTry.filter(u => u !== currentUser);
    return { action: 'undo' };
  }
  if (level === 'wantToTry') {
    p.reactions.wantToTry.push(currentUser);
    if (p.owner !== currentUser) {
      addNotification(state, {
        target: p.owner, fromUser: currentUser, type: 'wantToTry',
        projectId: p.id, projectName: p.name,
      });
    }
    return { action: 'add' };
  }
  throw new Error('未知反馈类型');
}

function submitTinkered(state, { projectId, name, link, currentUser = 'daodao' }) {
  const p = state.projects.find(x => x.id === projectId);
  if (!p) throw new Error('项目不存在');
  if (!name || !name.trim()) throw new Error('延伸版名字必填');
  if (!isValidUrl(link)) throw new Error('延伸版链接必须是 https://');
  // 清掉这个用户的其他 reactions
  p.reactions.interested = p.reactions.interested.filter(u => u !== currentUser);
  p.reactions.wantToTry = p.reactions.wantToTry.filter(u => u !== currentUser);
  p.reactions.tinkered.push({ user: currentUser, name: name.trim(), link: link.trim() });
  if (p.owner !== currentUser) {
    addNotification(state, {
      target: p.owner, fromUser: currentUser, type: 'tinkered',
      projectId: p.id, projectName: p.name, extra: name.trim(),
    });
  }
  return { ok: true };
}

function markMethodUsed(state, { projectId, updateIdx, note, currentUser = 'daodao' }) {
  const p = state.projects.find(x => x.id === projectId);
  if (!p) throw new Error('项目不存在');
  if (p.owner === currentUser) throw new Error('不能给自己反馈');
  const u = p.updates[updateIdx];
  if (!u) throw new Error('找不到这条进展');
  const existing = (u.usedBy || []).find(x => x.user === currentUser);
  if (existing) {
    u.usedBy = u.usedBy.filter(x => x.user !== currentUser);
    return { action: 'undo' };
  }
  if (!u.usedBy) u.usedBy = [];
  u.usedBy.unshift({ user: currentUser, note: (note || '').trim(), ago: '刚刚' });
  const extra = (note && note.trim()) || ('用了「' + p.name + '」第 ' + (updateIdx + 1) + ' 条的方法');
  addNotification(state, {
    target: p.owner, fromUser: currentUser, type: 'methodUsed',
    projectId: p.id, projectName: p.name, extra,
  });
  return { ok: true };
}

// =============================================
// NOTES
// =============================================

function addNote(state, { projectId, text, images, currentUser = 'daodao' }) {
  const p = state.projects.find(x => x.id === projectId);
  if (!p) throw new Error('项目不存在');
  if (!text || !text.trim()) throw new Error('便签是空的 — 图片是辅助 · 文字才是核心');
  const note = { user: currentUser, text: text.trim(), ago: '刚刚' };
  if (images && images.length > 0) note.images = images;
  p.notes.unshift(note);
  // 给项目 owner 发 noted 通知 (排除作者本人)
  if (p.owner !== currentUser) {
    addNotification(state, {
      target: p.owner, fromUser: currentUser, type: 'noted',
      projectId: p.id, projectName: p.name, extra: note.text,
    });
  }
  // @ 提到的人 (排除作者 + 项目 owner 避免重复)
  extractMentions(state, note.text).forEach(u => {
    if (u !== currentUser && u !== p.owner) {
      addNotification(state, {
        target: u, fromUser: currentUser, type: 'mentioned',
        projectId: p.id, projectName: p.name, extra: note.text,
      });
    }
  });
  return note;
}

function deleteNote(state, { projectId, noteIdx, currentUser = 'daodao' }) {
  const p = state.projects.find(x => x.id === projectId);
  if (!p) throw new Error('项目不存在');
  const note = p.notes[noteIdx];
  if (!note) throw new Error('找不到这条便签');
  if (note.user !== currentUser) throw new Error('只能撤回自己的便签');
  p.notes.splice(noteIdx, 1);
  return { ok: true };
}

// =============================================
// NOTIFICATIONS
// =============================================

function markAllRead(state, { currentUser = 'daodao' }) {
  (state.notifications || []).forEach(n => {
    if (n.target === currentUser && !n.read) n.read = true;
  });
  return { ok: true };
}

// =============================================
// USERS / WORKSHOP
// =============================================

function editTagline(state, { tagline, currentUser = 'daodao' }) {
  if (!tagline || !tagline.trim()) throw new Error('一句话不能空着');
  if (!state.users[currentUser]) throw new Error('找不到你的工作室');
  state.users[currentUser].tagline = tagline.trim();
  return state.users[currentUser];
}

module.exports = {
  addProject, changeProjectStatus,
  addUpdate, editUpdate, deleteUpdate,
  reactToProject, submitTinkered, markMethodUsed,
  addNote, deleteNote,
  markAllRead,
  editTagline,
};

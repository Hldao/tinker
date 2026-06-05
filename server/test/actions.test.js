// Tinker actions — 基础 action 测试 (node:test · built-in · 0 依赖)

const test = require('node:test');
const assert = require('node:assert/strict');

const { getTestSeedData } = require('./fixtures');
const actions = require('../actions');

function freshState() { return getTestSeedData(); }

// ============================================
// setUserHandle
// ============================================
test('setUserHandle: 新 user 自动创建', () => {
  const s = freshState();
  const r = actions.setUserHandle(s, { handle: 'tester', tagline: '测试' });
  assert.equal(r.name, 'tester');
  assert.equal(r.tagline, '测试');
  assert.ok(s.users.tester);
});

test('setUserHandle: 已有 user 更新 tagline', () => {
  const s = freshState();
  actions.setUserHandle(s, { handle: 'daodao', tagline: '新 tagline' });
  assert.equal(s.users.daodao.tagline, '新 tagline');
});

test('setUserHandle: 非法 handle 拒绝', () => {
  const s = freshState();
  assert.throws(() => actions.setUserHandle(s, { handle: 'a b c' }));
  assert.throws(() => actions.setUserHandle(s, { handle: '@bad' }));
  assert.throws(() => actions.setUserHandle(s, { handle: '' }));
});

// ============================================
// addProject
// ============================================
test('addProject: 创建项目', () => {
  const s = freshState();
  const before = s.projects.length;
  const p = actions.addProject(s, {
    currentUser: 'daodao',
    name: '测试项目',
    desc: '一个测试',
    productLink: 'https://example.com',
    tools: ['Cursor'],
  });
  assert.ok(p.id);
  assert.equal(p.name, '测试项目');
  assert.equal(s.projects.length, before + 1);
  assert.equal(s.projects[0].id, p.id, '新项目放最前');
});

test('addProject: 无产物链接拒绝', () => {
  const s = freshState();
  assert.throws(() => actions.addProject(s, {
    name: 'x', desc: 'y', productLink: 'not-a-url',
  }), /产物链接/);
});

test('addProject: 空字段拒绝', () => {
  const s = freshState();
  assert.throws(() => actions.addProject(s, {
    name: '', desc: 'y', productLink: 'https://e.com',
  }));
});

// ============================================
// addUpdate
// ============================================
test('addUpdate: 添加进展 + at 时间戳', () => {
  const s = freshState();
  const before = Date.now();
  const u = actions.addUpdate(s, {
    projectId: 'p1',
    text: '测试进展',
    currentUser: 'daodao',
  });
  assert.equal(u.text, '测试进展');
  assert.ok(u.at >= before, 'at 是真实时间戳');
  const p = s.projects.find(x => x.id === 'p1');
  assert.equal(p.updates[0].text, '测试进展', '新进展在最前');
});

test('addUpdate: 非项目 owner 拒绝', () => {
  const s = freshState();
  assert.throws(() => actions.addUpdate(s, {
    projectId: 'p1', text: 'x', currentUser: 'zhangsan',
  }), /只能给自己/);
});

test('addUpdate: 空内容拒绝', () => {
  const s = freshState();
  assert.throws(() => actions.addUpdate(s, {
    projectId: 'p1', text: '   ', currentUser: 'daodao',
  }));
});

// ============================================
// addNote + @mention
// ============================================
test('addNote: 给别人项目留便签 + 通知 owner', () => {
  const s = freshState();
  const beforeNotifs = s.notifications.filter(n => n.target === 'zhangsan').length;
  actions.addNote(s, {
    projectId: 'p2', // @zhangsan owns p2
    text: '我觉得不错',
    currentUser: 'wangwu',
  });
  const p = s.projects.find(x => x.id === 'p2');
  assert.equal(p.notes[0].user, 'wangwu');
  // 应该通知 zhangsan
  const after = s.notifications.filter(n => n.target === 'zhangsan').length;
  assert.equal(after, beforeNotifs + 1);
});

test('addNote: @ 提及 → 通知 mentioned user', () => {
  const s = freshState();
  const beforeNotifs = s.notifications.filter(n => n.target === 'lisi').length;
  actions.addNote(s, {
    projectId: 'p2',
    text: '@lisi 你看看这个',
    currentUser: 'wangwu',
  });
  const after = s.notifications.filter(n => n.target === 'lisi').length;
  assert.equal(after, beforeNotifs + 1);
});

// ============================================
// reactToProject
// ============================================
test('reactToProject: 想试试 + 通知 owner', () => {
  const s = freshState();
  const beforeNotifs = s.notifications.filter(n => n.target === 'zhangsan' && n.type === 'wantToTry').length;
  actions.reactToProject(s, {
    projectId: 'p2', level: 'wantToTry', currentUser: 'wangwu',
  });
  const p = s.projects.find(x => x.id === 'p2');
  assert.ok(p.reactions.wantToTry.includes('wangwu'));
  const after = s.notifications.filter(n => n.target === 'zhangsan' && n.type === 'wantToTry').length;
  assert.equal(after, beforeNotifs + 1);
});

test('reactToProject: 重复点击 = 撤回', () => {
  const s = freshState();
  actions.reactToProject(s, { projectId: 'p2', level: 'wantToTry', currentUser: 'wangwu' });
  const r = actions.reactToProject(s, { projectId: 'p2', level: 'wantToTry', currentUser: 'wangwu' });
  assert.equal(r.action, 'undo');
  const p = s.projects.find(x => x.id === 'p2');
  assert.ok(!p.reactions.wantToTry.includes('wangwu'));
});

// ============================================
// changeProjectStatus → projectDone 通知
// ============================================
test('changeProjectStatus: active → done 时通知 wantToTry 用户', () => {
  const s = freshState();
  // p2 (zhangsan owns · daodao + lisi 已 wantToTry)
  const before = s.notifications.filter(n => n.target === 'daodao' && n.type === 'projectDone').length;
  actions.changeProjectStatus(s, {
    projectId: 'p2', newStatus: 'done', currentUser: 'zhangsan',
  });
  const after = s.notifications.filter(n => n.target === 'daodao' && n.type === 'projectDone').length;
  assert.equal(after, before + 1, 'daodao 是 wantToTry · 应收到 projectDone 通知');
});

// ============================================
// changeProjectStatus → projectStuck 通知 (A4 · spec §5.3)
// ============================================
test('changeProjectStatus: active → stuck 时通知 wantToTry + tinkered 用户', () => {
  const s = freshState();
  // p2 (zhangsan owns · daodao + lisi 已 wantToTry · wangwu 已 tinkered)
  const beforeDaodao = s.notifications.filter(n => n.target === 'daodao' && n.type === 'projectStuck').length;
  const beforeWangwu = s.notifications.filter(n => n.target === 'wangwu' && n.type === 'projectStuck').length;
  actions.changeProjectStatus(s, {
    projectId: 'p2', newStatus: 'stuck', currentUser: 'zhangsan',
  });
  const afterDaodao = s.notifications.filter(n => n.target === 'daodao' && n.type === 'projectStuck').length;
  const afterWangwu = s.notifications.filter(n => n.target === 'wangwu' && n.type === 'projectStuck').length;
  assert.equal(afterDaodao, beforeDaodao + 1, 'daodao 是 wantToTry · 应收到 projectStuck 通知');
  assert.equal(afterWangwu, beforeWangwu + 1, 'wangwu 是 tinkered · 应收到 projectStuck 通知');
});

test('changeProjectStatus: stuck → stuck 不重复触发通知', () => {
  const s = freshState();
  // 先把 p2 设为 stuck (会触发通知)
  actions.changeProjectStatus(s, { projectId: 'p2', newStatus: 'stuck', currentUser: 'zhangsan' });
  const mid = s.notifications.filter(n => n.target === 'daodao' && n.type === 'projectStuck').length;
  // 再把 stuck 设为 stuck 不应触发新通知
  actions.changeProjectStatus(s, { projectId: 'p2', newStatus: 'stuck', currentUser: 'zhangsan' });
  const after = s.notifications.filter(n => n.target === 'daodao' && n.type === 'projectStuck').length;
  assert.equal(after, mid, 'stuck → stuck 不应触发新通知');
});

// ============================================
// changeProjectStatus → projectUnstuck 通知 (stuck → active 解卡)
// ============================================
test('changeProjectStatus: stuck → active 时通知 wantToTry + tinkered 用户 (解卡)', () => {
  const s = freshState();
  // 先把 p2 设为 stuck
  actions.changeProjectStatus(s, { projectId: 'p2', newStatus: 'stuck', currentUser: 'zhangsan' });
  // 再切回 active · 应触发 projectUnstuck
  const beforeD = s.notifications.filter(n => n.target === 'daodao' && n.type === 'projectUnstuck').length;
  const beforeW = s.notifications.filter(n => n.target === 'wangwu' && n.type === 'projectUnstuck').length;
  actions.changeProjectStatus(s, { projectId: 'p2', newStatus: 'active', currentUser: 'zhangsan' });
  const afterD = s.notifications.filter(n => n.target === 'daodao' && n.type === 'projectUnstuck').length;
  const afterW = s.notifications.filter(n => n.target === 'wangwu' && n.type === 'projectUnstuck').length;
  assert.equal(afterD, beforeD + 1, 'daodao 是 wantToTry · 应收到 projectUnstuck');
  assert.equal(afterW, beforeW + 1, 'wangwu 是 tinkered · 应收到 projectUnstuck');
});

// ============================================
// editProject (改 name / desc / productLink / tools)
// ============================================
test('editProject: 改 owner 自己项目的 name + desc + link + tools', () => {
  const s = freshState();
  const before = s.projects.find(p => p.id === 'p2');
  const oldSlug = before.slug;
  const r = actions.editProject(s, {
    projectId: 'p2',
    name: '新名字',
    desc: '新描述',
    productLink: 'https://new-url.com',
    tools: ['Cursor', 'GPT-5'],
    currentUser: 'zhangsan',
  });
  assert.equal(r.name, '新名字');
  assert.equal(r.desc, '新描述');
  assert.equal(r.productLink, 'https://new-url.com');
  assert.deepEqual(r.tools, ['Cursor', 'GPT-5']);
  assert.equal(r.slug, oldSlug, 'slug 不变 · 分享 URL 不会失效');
  assert.equal(r.status, before.status, 'status 不变 · 走 changeProjectStatus 改');
});

test('editProject: 非 owner 拒绝', () => {
  const s = freshState();
  assert.throws(() => actions.editProject(s, {
    projectId: 'p2',
    name: '改', desc: '改', productLink: 'https://x.com',
    currentUser: 'wangwu', // p2 owner 是 zhangsan
  }), /只能改自己/);
});

test('editProject: 空 name / 非法 url 拒绝', () => {
  const s = freshState();
  assert.throws(() => actions.editProject(s, {
    projectId: 'p2', name: '', desc: 'x', productLink: 'https://x.com', currentUser: 'zhangsan',
  }));
  assert.throws(() => actions.editProject(s, {
    projectId: 'p2', name: 'x', desc: 'y', productLink: 'not-a-url', currentUser: 'zhangsan',
  }));
});

// ============================================
// A1 · interested 字段已砍 (migration · spec 3 级反馈)
// ============================================
test('addProject: 新项目 reactions 只有 wantToTry + tinkered (无 interested)', () => {
  const s = freshState();
  const p = actions.addProject(s, {
    currentUser: 'daodao',
    name: 'A1 test',
    desc: 'check reactions shape',
    productLink: 'https://example.com',
  });
  assert.deepEqual(Object.keys(p.reactions).sort(), ['tinkered', 'wantToTry']);
  assert.equal(p.reactions.interested, undefined, '不再有 interested 字段');
});

test('migration: 加载老数据时 interested 字段被自动剥离', () => {
  const { migrateState } = require('../seed');
  const oldData = {
    projects: [{
      id: 'old',
      reactions: { interested: ['a', 'b'], wantToTry: ['c'], tinkered: [] },
    }],
  };
  const migrated = migrateState(oldData);
  assert.equal(migrated.projects[0].reactions.interested, undefined);
  assert.deepEqual(migrated.projects[0].reactions.wantToTry, ['c']);
});

// ============================================
// markMethodUsed
// ============================================
test('markMethodUsed: 给别人 update 点 used + 通知作者', () => {
  const s = freshState();
  // 用 maomao (SEED 里 p2.updates[0].usedBy 没有 maomao · 干净状态)
  const before = s.notifications.filter(n => n.target === 'zhangsan' && n.type === 'methodUsed').length;
  actions.markMethodUsed(s, {
    projectId: 'p2',
    updateIdx: 0,
    note: '我用了 strict mode',
    currentUser: 'maomao',
  });
  const after = s.notifications.filter(n => n.target === 'zhangsan' && n.type === 'methodUsed').length;
  assert.equal(after, before + 1);
});

test('markMethodUsed: 给自己 update 点 used 拒绝', () => {
  const s = freshState();
  assert.throws(() => actions.markMethodUsed(s, {
    projectId: 'p2', updateIdx: 0, currentUser: 'zhangsan',
  }));
});

// ============================================
// submitTinkered (delivery proof)
// ============================================
test('submitTinkered: 必须挂自己项目 + URL · 通知 owner', () => {
  const s = freshState();
  actions.submitTinkered(s, {
    projectId: 'p2',
    name: '我的求职信版',
    link: 'https://example.com',
    currentUser: 'wangwu',
  });
  const p = s.projects.find(x => x.id === 'p2');
  assert.ok(p.reactions.tinkered.find(t => t.user === 'wangwu'));
  assert.ok(s.notifications.find(n => n.fromUser === 'wangwu' && n.type === 'tinkered'));
});

test('submitTinkered: 没有 URL 拒绝', () => {
  const s = freshState();
  assert.throws(() => actions.submitTinkered(s, {
    projectId: 'p2', name: '我做了', link: 'invalid',
  }));
});

// ============================================
// editTagline
// ============================================
test('editTagline: 改 owner 自己的 tagline', () => {
  const s = freshState();
  actions.editTagline(s, { tagline: '新的自我介绍', currentUser: 'daodao' });
  assert.equal(s.users.daodao.tagline, '新的自我介绍');
});

// ============================================
// markAllRead
// ============================================
test('markAllRead: 标记所有当前 user 的通知为已读', () => {
  const s = freshState();
  actions.markAllRead(s, { currentUser: 'daodao' });
  const stillUnread = s.notifications.filter(n => n.target === 'daodao' && !n.read);
  assert.equal(stillUnread.length, 0);
});

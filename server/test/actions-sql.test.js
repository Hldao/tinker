// SQL actions 测试 · 用 :memory: SQLite
// 跟 actions.test.js (老 actions.js / JSON 版) 并存 · Phase C 切完后会删老的

process.env.DB_FILE = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const a = require('../actions-sql');
const { buildState } = require('../state');

// ============================================
// 测试工具
// ============================================

function resetDb() {
  const tables = ['notifications', 'note_images', 'notes', 'tinkered', 'reactions',
    'method_used', 'update_images', 'updates', 'project_tools', 'projects',
    'images', 'sessions', 'auth_tokens', 'users', 'starters', 'available_tools'];
  for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
}

function makeUser(id, handle, email) {
  const now = Date.now();
  db.prepare(`INSERT INTO users (id, handle, email, name, tagline, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, handle, email || null, handle, '测试用户', now, now);
  return id;
}

function setupBasic() {
  resetDb();
  const daodao = makeUser('uid-daodao', 'daodao');
  const alice = makeUser('uid-alice', 'alice', 'a@b.com');
  const bob = makeUser('uid-bob', 'bob', 'b@b.com');
  return { daodao, alice, bob };
}

// ============================================
// addProject
// ============================================
test('addProject: 建项目 + tools', () => {
  const { daodao } = setupBasic();
  const p = a.addProject({
    name: 'Tinker', desc: 'GitHub 反着做', productLink: 'https://daogu.cc',
    tools: ['Claude Code', 'Node.js'],
  }, { currentUserId: daodao });
  assert.ok(p.id);
  assert.equal(p.name, 'Tinker');
  assert.equal(p.owner, 'daodao');
  assert.deepEqual(p.tools.sort(), ['Claude Code', 'Node.js']);
});

test('addProject: 没 URL 拒绝', () => {
  const { daodao } = setupBasic();
  assert.throws(() => a.addProject({
    name: 'x', desc: 'y', productLink: 'not-a-url',
  }, { currentUserId: daodao }), /产物链接/);
});

test('addProject: 空字段拒绝', () => {
  const { daodao } = setupBasic();
  assert.throws(() => a.addProject({
    name: '', desc: 'y', productLink: 'https://e.com',
  }, { currentUserId: daodao }));
});

// ============================================
// editProject
// ============================================
test('editProject: owner 改 name/desc/url/tools', () => {
  const { daodao } = setupBasic();
  const p = a.addProject({ name: '老名', desc: '老描述', productLink: 'https://old.com', tools: ['v0'] }, { currentUserId: daodao });
  const r = a.editProject({
    projectId: p.id, name: '新名', desc: '新描述',
    productLink: 'https://new.com', tools: ['Claude Code'],
  }, { currentUserId: daodao });
  assert.equal(r.name, '新名');
  assert.equal(r.desc, '新描述');
  assert.equal(r.productLink, 'https://new.com');
  assert.deepEqual(r.tools, ['Claude Code']);
  assert.equal(r.slug, p.slug, 'slug 不变');
});

test('editProject: 非 owner 拒绝', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'x', desc: 'y', productLink: 'https://e.com' }, { currentUserId: daodao });
  assert.throws(() => a.editProject({
    projectId: p.id, name: 'x', desc: 'y', productLink: 'https://x.com',
  }, { currentUserId: alice }), /只能改自己/);
});

// ============================================
// addUpdate
// ============================================
test('addUpdate: 加进展 + at 时间戳', () => {
  const { daodao } = setupBasic();
  const p = a.addProject({ name: 'x', desc: 'y', productLink: 'https://e.com' }, { currentUserId: daodao });
  const before = Date.now();
  const u = a.addUpdate({ projectId: p.id, text: '测试进展' }, { currentUserId: daodao });
  assert.equal(u.text, '测试进展');
  assert.ok(u.at >= before);
});

test('addUpdate: images 字段守门 · 非 image mime 拒绝', () => {
  const { daodao } = setupBasic();
  const p = a.addProject({ name: 'x', desc: 'y', productLink: 'https://e.com' }, { currentUserId: daodao });
  // bridge 密文借 image 槽传是历史踩坑 · 现在 server 端拒掉
  assert.throws(() => a.addUpdate({
    projectId: p.id, text: '🔐 加密提问',
    images: [{ src: 'data:application/octet-stream;base64,AAAA', caption: 'CC-ENC' }],
  }, { currentUserId: daodao }), /只收真图片/);
  // images 表应该没脏数据进来 (上面 throw 已经在 txn 里回滚)
  const dirtyCount = db.prepare(
    "SELECT count(*) AS c FROM images WHERE src LIKE 'data:application/octet-stream%'"
  ).get().c;
  assert.equal(dirtyCount, 0);
  // 真图片放过 · 走到 update_images link
  const u = a.addUpdate({
    projectId: p.id, text: '正常图',
    images: [{ src: 'data:image/png;base64,iVBORw0KGgo=', caption: '截图' }],
  }, { currentUserId: daodao });
  const linkCount = db.prepare(
    'SELECT count(*) AS c FROM update_images WHERE update_id = ?'
  ).get(u.id).c;
  assert.equal(linkCount, 1);
});

test('addUpdate: 非 owner 拒绝', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'x', desc: 'y', productLink: 'https://e.com' }, { currentUserId: daodao });
  assert.throws(() => a.addUpdate({
    projectId: p.id, text: 'x',
  }, { currentUserId: alice }), /只能给自己/);
});

test('addUpdate: @ mention 通知有效用户', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'x', desc: 'y', productLink: 'https://e.com' }, { currentUserId: daodao });
  a.addUpdate({ projectId: p.id, text: '@alice 看看这个 + @notexist' }, { currentUserId: daodao });
  const notifs = db.prepare(`SELECT type FROM notifications WHERE target_user_id = ?`).all('uid-alice');
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0].type, 'mentioned');
});

// ============================================
// reactToProject
// ============================================
test('reactToProject: wantToTry 通知 owner + 重复点撤回', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'x', desc: 'y', productLink: 'https://e.com' }, { currentUserId: daodao });
  const r1 = a.reactToProject({ projectId: p.id, level: 'wantToTry' }, { currentUserId: alice });
  assert.equal(r1.action, 'add');
  const notifs = db.prepare(`SELECT type FROM notifications WHERE target_user_id = ?`).all('uid-daodao');
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0].type, 'wantToTry');

  const r2 = a.reactToProject({ projectId: p.id, level: 'wantToTry' }, { currentUserId: alice });
  assert.equal(r2.action, 'undo');
  const rows = db.prepare(`SELECT 1 FROM reactions WHERE project_id = ? AND user_id = ?`).all(p.id, 'uid-alice');
  assert.equal(rows.length, 0);
});

// ============================================
// changeProjectStatus
// ============================================
test('changeProjectStatus: active → done 通知 wantToTry 用户', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'x', desc: 'y', productLink: 'https://e.com' }, { currentUserId: daodao });
  a.reactToProject({ projectId: p.id, level: 'wantToTry' }, { currentUserId: alice });
  a.changeProjectStatus({ projectId: p.id, newStatus: 'done' }, { currentUserId: daodao });
  const notifs = db.prepare(`SELECT type FROM notifications WHERE target_user_id = ? AND type = ?`)
    .all('uid-alice', 'projectDone');
  assert.equal(notifs.length, 1);
});

test('changeProjectStatus: active → stuck 通知 wantToTry + tinkered', () => {
  const { daodao, alice, bob } = setupBasic();
  const p = a.addProject({ name: 'x', desc: 'y', productLink: 'https://e.com' }, { currentUserId: daodao });
  a.reactToProject({ projectId: p.id, level: 'wantToTry' }, { currentUserId: alice });
  a.submitTinkered({ projectId: p.id, name: 'Bob 版', link: 'https://b.com' }, { currentUserId: bob });
  a.changeProjectStatus({ projectId: p.id, newStatus: 'stuck' }, { currentUserId: daodao });
  const aN = db.prepare(`SELECT 1 FROM notifications WHERE target_user_id = ? AND type = ?`).all('uid-alice', 'projectStuck');
  const bN = db.prepare(`SELECT 1 FROM notifications WHERE target_user_id = ? AND type = ?`).all('uid-bob', 'projectStuck');
  assert.equal(aN.length, 1);
  assert.equal(bN.length, 1);
});

test('changeProjectStatus: stuck → active 解卡通知', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'x', desc: 'y', productLink: 'https://e.com' }, { currentUserId: daodao });
  a.reactToProject({ projectId: p.id, level: 'wantToTry' }, { currentUserId: alice });
  a.changeProjectStatus({ projectId: p.id, newStatus: 'stuck' }, { currentUserId: daodao });
  a.changeProjectStatus({ projectId: p.id, newStatus: 'active' }, { currentUserId: daodao });
  const notifs = db.prepare(`SELECT type FROM notifications WHERE target_user_id = ? AND type = ?`)
    .all('uid-alice', 'projectUnstuck');
  assert.equal(notifs.length, 1);
});

// ============================================
// submitTinkered
// ============================================
test('submitTinkered: 通知 owner · 清掉 wantToTry', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'x', desc: 'y', productLink: 'https://e.com' }, { currentUserId: daodao });
  a.reactToProject({ projectId: p.id, level: 'wantToTry' }, { currentUserId: alice });
  a.submitTinkered({ projectId: p.id, name: 'Alice 版', link: 'https://alice.com' }, { currentUserId: alice });
  const reactions = db.prepare('SELECT 1 FROM reactions WHERE user_id = ?').all('uid-alice');
  assert.equal(reactions.length, 0, 'wantToTry 已清');
  const tinkered = db.prepare('SELECT name, link FROM tinkered WHERE user_id = ?').all('uid-alice');
  assert.equal(tinkered.length, 1);
  const notif = db.prepare(`SELECT 1 FROM notifications WHERE target_user_id = ? AND type = ?`).all('uid-daodao', 'tinkered');
  assert.equal(notif.length, 1);
});

test('submitTinkered: 没 URL 拒绝', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'x', desc: 'y', productLink: 'https://e.com' }, { currentUserId: daodao });
  assert.throws(() => a.submitTinkered({
    projectId: p.id, name: 'x', link: 'invalid',
  }, { currentUserId: alice }));
});

// ============================================
// markMethodUsed
// ============================================
test('markMethodUsed: 用了别人 update + 通知作者', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'x', desc: 'y', productLink: 'https://e.com' }, { currentUserId: daodao });
  a.addUpdate({ projectId: p.id, text: '我的方法' }, { currentUserId: daodao });
  a.markMethodUsed({ projectId: p.id, updateIdx: 0, note: '试了 OK' }, { currentUserId: alice });
  const notif = db.prepare(`SELECT 1 FROM notifications WHERE target_user_id = ? AND type = ?`).all('uid-daodao', 'methodUsed');
  assert.equal(notif.length, 1);
});

test('markMethodUsed: 自己 update 拒绝', () => {
  const { daodao } = setupBasic();
  const p = a.addProject({ name: 'x', desc: 'y', productLink: 'https://e.com' }, { currentUserId: daodao });
  a.addUpdate({ projectId: p.id, text: 'x' }, { currentUserId: daodao });
  assert.throws(() => a.markMethodUsed({
    projectId: p.id, updateIdx: 0,
  }, { currentUserId: daodao }));
});

// ============================================
// addNote
// ============================================
test('addNote: 留便签 + 通知 owner', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'x', desc: 'y', productLink: 'https://e.com' }, { currentUserId: daodao });
  a.addNote({ projectId: p.id, text: '我觉得不错' }, { currentUserId: alice });
  const notif = db.prepare(`SELECT 1 FROM notifications WHERE target_user_id = ? AND type = ?`).all('uid-daodao', 'noted');
  assert.equal(notif.length, 1);
});

test('addNote: @ 不重复 owner 通知', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'x', desc: 'y', productLink: 'https://e.com' }, { currentUserId: daodao });
  a.addNote({ projectId: p.id, text: '@daodao 看看' }, { currentUserId: alice });
  // daodao 应只有 1 个通知 (noted) · 不再因 @daodao 加一个 mentioned
  const all = db.prepare(`SELECT type FROM notifications WHERE target_user_id = ?`).all('uid-daodao');
  assert.equal(all.length, 1);
  assert.equal(all[0].type, 'noted');
});

// ============================================
// markAllRead
// ============================================
test('markAllRead: 标记 unread → read', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'x', desc: 'y', productLink: 'https://e.com' }, { currentUserId: daodao });
  a.reactToProject({ projectId: p.id, level: 'wantToTry' }, { currentUserId: alice });
  a.markAllRead({}, { currentUserId: daodao });
  const unread = db.prepare(`SELECT 1 FROM notifications WHERE target_user_id = ? AND read_at IS NULL`).all('uid-daodao');
  assert.equal(unread.length, 0);
});

// ============================================
// editTagline / renameHandle
// ============================================
test('editTagline: 改自己的 tagline', () => {
  const { daodao } = setupBasic();
  a.editTagline({ tagline: '新的一句话' }, { currentUserId: daodao });
  const u = db.prepare('SELECT tagline FROM users WHERE id = ?').get(daodao);
  assert.equal(u.tagline, '新的一句话');
});

test('renameHandle: 改自己的 handle · 不影响 owner 引用', () => {
  const { daodao } = setupBasic();
  const p = a.addProject({ name: 'x', desc: 'y', productLink: 'https://e.com' }, { currentUserId: daodao });
  a.renameHandle({ handle: 'daodao2' }, { currentUserId: daodao });
  const u = db.prepare('SELECT handle FROM users WHERE id = ?').get(daodao);
  assert.equal(u.handle, 'daodao2');
  // 项目 owner_id 不动
  const stillOwner = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(p.id);
  assert.equal(stillOwner.owner_id, daodao);
});

test('renameHandle: 撞已有 handle 拒绝', () => {
  const { daodao, alice } = setupBasic();
  assert.throws(() => a.renameHandle({ handle: 'alice' }, { currentUserId: daodao }), /被人用了/);
});

// ============================================
// buildState · 整合测试
// ============================================
test('buildState: 返回 webapp 期望的形状', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'P1', desc: 'D1', productLink: 'https://e.com', tools: ['Claude'] }, { currentUserId: daodao });
  a.addUpdate({ projectId: p.id, text: 'U1' }, { currentUserId: daodao });
  a.reactToProject({ projectId: p.id, level: 'wantToTry' }, { currentUserId: alice });
  a.addNote({ projectId: p.id, text: 'note from alice' }, { currentUserId: alice });

  const s = buildState({ targetUserId: daodao });
  assert.ok(s.users.daodao);
  assert.ok(s.users.alice);
  assert.equal(s.projects.length, 1);
  const proj = s.projects[0];
  assert.equal(proj.owner, 'daodao');
  assert.equal(proj.name, 'P1');
  assert.deepEqual(proj.tools, ['Claude']);
  assert.equal(proj.updates.length, 1);
  assert.equal(proj.notes.length, 1);
  assert.equal(proj.notes[0].user, 'alice');
  assert.deepEqual(proj.reactions.wantToTry, ['alice']);
  // daodao 收到 wantToTry + noted 两条通知
  assert.equal(s.notifications.length, 2);
});

test('buildState: 匿名 targetUserId=undefined · 通知为空', () => {
  const { daodao } = setupBasic();
  a.addProject({ name: 'P1', desc: 'D', productLink: 'https://e.com' }, { currentUserId: daodao });
  const s = buildState({});
  assert.equal(s.notifications.length, 0);
});

// ============================================
// v0.4 闭环修复
// ============================================
test('submitTinkered: 升级承诺 · 清掉 owner 的 wantToTry 通知', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'P', desc: 'D', productLink: 'https://e.com' }, { currentUserId: daodao });
  a.reactToProject({ projectId: p.id, level: 'wantToTry' }, { currentUserId: alice });
  // owner 看到 wantToTry 通知
  let notifs = db.prepare(`SELECT type FROM notifications WHERE target_user_id = ?`).all(daodao);
  assert.deepEqual(notifs.map(n => n.type).sort(), ['wantToTry']);
  // alice 升级成 tinkered
  a.submitTinkered({ projectId: p.id, name: '我的版', link: 'https://my.com' }, { currentUserId: alice });
  notifs = db.prepare(`SELECT type, anchor FROM notifications WHERE target_user_id = ?`).all(daodao);
  // 只剩 tinkered · wantToTry 被清掉了
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0].type, 'tinkered');
  assert.equal(notifs[0].anchor, 'tinkered-alice');
});

test('markMethodUsed: anchor 指向具体 update', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'P', desc: 'D', productLink: 'https://e.com' }, { currentUserId: daodao });
  const u = a.addUpdate({ projectId: p.id, text: 'first' }, { currentUserId: daodao });
  a.markMethodUsed({ projectId: p.id, updateIdx: 0 }, { currentUserId: alice });
  const n = db.prepare(`SELECT anchor FROM notifications WHERE target_user_id = ? AND type = 'methodUsed'`).get(daodao);
  assert.equal(n.anchor, 'update-' + u.id);
});

test('addNote: noted + mentioned 通知都有 note 锚点', () => {
  const { daodao, alice, bob } = setupBasic();
  const p = a.addProject({ name: 'P', desc: 'D', productLink: 'https://e.com' }, { currentUserId: daodao });
  a.addNote({ projectId: p.id, text: '@bob 看这个' }, { currentUserId: alice });
  const daodaoNotif = db.prepare(`SELECT anchor FROM notifications WHERE target_user_id = ?`).get(daodao);
  const bobNotif = db.prepare(`SELECT anchor FROM notifications WHERE target_user_id = ?`).get(bob);
  assert.match(daodaoNotif.anchor, /^note-/);
  assert.match(bobNotif.anchor, /^note-/);
  assert.equal(daodaoNotif.anchor, bobNotif.anchor); // 同一条便签
});

test('addUpdate: alsoStuck=true 同步把项目改成 stuck + 广播 projectStuck', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'P', desc: 'D', productLink: 'https://e.com' }, { currentUserId: daodao });
  a.reactToProject({ projectId: p.id, level: 'wantToTry' }, { currentUserId: alice });
  // 清掉 daodao 收到的 wantToTry 通知 (不影响测试)
  db.prepare('DELETE FROM notifications WHERE target_user_id = ?').run(daodao);
  const u = a.addUpdate({ projectId: p.id, text: '卡在登录', alsoStuck: true }, { currentUserId: daodao });
  assert.equal(u.statusChanged, true);
  const status = db.prepare('SELECT status FROM projects WHERE id = ?').get(p.id).status;
  assert.equal(status, 'stuck');
  // alice 收到 projectStuck 通知 · anchor 指向这条 update
  const n = db.prepare(`SELECT type, anchor FROM notifications WHERE target_user_id = ?`).get(alice);
  assert.equal(n.type, 'projectStuck');
  assert.equal(n.anchor, 'update-' + u.id);
});

test('addUpdate: alsoStuck 但已经是 stuck · 不重复通知', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({
    name: 'P', desc: 'D', productLink: 'https://e.com', status: 'stuck'
  }, { currentUserId: daodao });
  a.reactToProject({ projectId: p.id, level: 'wantToTry' }, { currentUserId: alice });
  db.prepare('DELETE FROM notifications').run();
  const u = a.addUpdate({ projectId: p.id, text: '还在卡', alsoStuck: true }, { currentUserId: daodao });
  assert.equal(u.statusChanged, false);
  const notifs = db.prepare(`SELECT type FROM notifications WHERE target_user_id = ?`).all(alice);
  assert.equal(notifs.length, 0);
});

test('addUpdate: notifyTinkered=true 主动广播 ownerUpdate', () => {
  const { daodao, alice, bob } = setupBasic();
  const p = a.addProject({ name: 'P', desc: 'D', productLink: 'https://e.com' }, { currentUserId: daodao });
  a.reactToProject({ projectId: p.id, level: 'wantToTry' }, { currentUserId: alice });
  a.submitTinkered({ projectId: p.id, name: 'B 版', link: 'https://b.com' }, { currentUserId: bob });
  db.prepare('DELETE FROM notifications').run();
  const u = a.addUpdate(
    { projectId: p.id, text: '跑通了大版本', notifyTinkered: true },
    { currentUserId: daodao }
  );
  const aliceN = db.prepare(`SELECT type, anchor FROM notifications WHERE target_user_id = ?`).get(alice);
  const bobN = db.prepare(`SELECT type, anchor FROM notifications WHERE target_user_id = ?`).get(bob);
  assert.equal(aliceN.type, 'ownerUpdate');
  assert.equal(bobN.type, 'ownerUpdate');
  assert.equal(aliceN.anchor, 'update-' + u.id);
});

test('editProject: 改 productLink 给关心者发 projectMoved 通知', () => {
  const { daodao, alice, bob } = setupBasic();
  const p = a.addProject({ name: 'P', desc: 'D', productLink: 'https://old.com' }, { currentUserId: daodao });
  a.reactToProject({ projectId: p.id, level: 'wantToTry' }, { currentUserId: alice });
  a.submitTinkered({ projectId: p.id, name: 'B 版', link: 'https://b.com' }, { currentUserId: bob });
  db.prepare('DELETE FROM notifications').run();
  a.editProject({
    projectId: p.id, name: 'P', desc: 'D', productLink: 'https://new.com',
  }, { currentUserId: daodao });
  const aliceN = db.prepare(`SELECT type, extra FROM notifications WHERE target_user_id = ?`).get(alice);
  const bobN = db.prepare(`SELECT type, extra FROM notifications WHERE target_user_id = ?`).get(bob);
  assert.equal(aliceN.type, 'projectMoved');
  assert.equal(aliceN.extra, 'https://new.com');
  assert.equal(bobN.type, 'projectMoved');
});

test('editProject: 没改 productLink 不发通知', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'P', desc: 'D', productLink: 'https://x.com' }, { currentUserId: daodao });
  a.reactToProject({ projectId: p.id, level: 'wantToTry' }, { currentUserId: alice });
  db.prepare('DELETE FROM notifications').run();
  a.editProject({
    projectId: p.id, name: 'P 改名', desc: 'D 改了', productLink: 'https://x.com',
  }, { currentUserId: daodao });
  const notifs = db.prepare(`SELECT type FROM notifications WHERE target_user_id = ?`).all(alice);
  assert.equal(notifs.length, 0);
});

test('deleteTinkered: 撤回延伸版 + 清掉 owner 的 tinkered 通知', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'P', desc: 'D', productLink: 'https://e.com' }, { currentUserId: daodao });
  a.submitTinkered({ projectId: p.id, name: 'A 版', link: 'https://a.com' }, { currentUserId: alice });
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM tinkered WHERE parent_project_id = ?`).get(p.id).n, 1
  );
  a.deleteTinkered({ projectId: p.id }, { currentUserId: alice });
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM tinkered WHERE parent_project_id = ?`).get(p.id).n, 0
  );
  const ownerNotifs = db.prepare(
    `SELECT type FROM notifications WHERE target_user_id = ? AND type = 'tinkered'`
  ).all(daodao);
  assert.equal(ownerNotifs.length, 0);
});

test('deleteTinkered: 没接走过 · 拒绝', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'P', desc: 'D', productLink: 'https://e.com' }, { currentUserId: daodao });
  assert.throws(() => a.deleteTinkered({ projectId: p.id }, { currentUserId: alice }), /没有接走过/);
});

test('markNotifRead: 标单条 · 不动别的', () => {
  const { daodao, alice, bob } = setupBasic();
  const p = a.addProject({ name: 'P', desc: 'D', productLink: 'https://e.com' }, { currentUserId: daodao });
  a.reactToProject({ projectId: p.id, level: 'wantToTry' }, { currentUserId: alice });
  a.reactToProject({ projectId: p.id, level: 'wantToTry' }, { currentUserId: bob });
  const aliceNotif = db.prepare(
    `SELECT id FROM notifications WHERE target_user_id = ? AND from_user_id = ?`
  ).get(daodao, alice);
  a.markNotifRead({ notifId: aliceNotif.id }, { currentUserId: daodao });
  const unread = db.prepare(
    `SELECT id FROM notifications WHERE target_user_id = ? AND read_at IS NULL`
  ).all(daodao);
  assert.equal(unread.length, 1);
});

test('buildState: 通知带 anchor + projectSlug + projectOwner', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'P', desc: 'D', productLink: 'https://e.com' }, { currentUserId: daodao });
  a.addNote({ projectId: p.id, text: '不错' }, { currentUserId: alice });
  const s = buildState({ targetUserId: daodao });
  const n = s.notifications[0];
  assert.equal(n.type, 'noted');
  assert.match(n.anchor, /^note-/);
  assert.equal(n.projectSlug, p.slug);
  assert.equal(n.projectOwner, 'daodao');
});

test('buildState: project.updates / notes 带 id 字段 (锚点用)', () => {
  const { daodao, alice } = setupBasic();
  const p = a.addProject({ name: 'P', desc: 'D', productLink: 'https://e.com' }, { currentUserId: daodao });
  const u = a.addUpdate({ projectId: p.id, text: 'first' }, { currentUserId: daodao });
  a.addNote({ projectId: p.id, text: 'cool' }, { currentUserId: alice });
  const s = buildState({ targetUserId: daodao });
  const proj = s.projects[0];
  assert.equal(proj.updates[0].id, u.id);
  assert.match(proj.notes[0].id, /^n-/);
});

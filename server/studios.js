// studios · 工作室一等公民
//
// 设计前提:
//   - 一个 user 可以加入多个 studio (实际上 99% 场景一对一 · 但不限制)
//   - project 还是 owner_id = user_id (作品归个人)
//   - 工作室聚合页通过 studio_members 关系拉所有成员的 projects / updates
//   - secret_hash = sha256(团队暗号) · server 用来验"是不是同 studio"
//     真暗号在客户端 · server 看到的永远是 hash 跟密文信封
//
// 邀请流程 (走 022 的桥 noti kind):
//   1) owner 跑 `tinker studio invite @maomao` · 客户端用 studio secret 加密一份邀请信封
//   2) 走 bridge.send → maomao 长轮询收到
//   3) maomao 跑 `tinker studio join` · 把暗号写本地 · 同时 POST /api/studios/join 注册成员关系

const db = require('./db');
const crypto = require('crypto');

function studioCreate({ slug, name, tagline, secretHash }, { currentUserId }) {
  if (!slug || !/^[a-z0-9-]{2,32}$/.test(slug)) throw new Error('slug 必须 2-32 位小写字母数字横线');
  if (!name || name.length > 64) throw new Error('name 必填 · 不超 64 字');
  if (!secretHash || !/^[a-f0-9]{64}$/.test(secretHash)) throw new Error('secretHash 必须是 64 位 hex (sha256)');

  const existing = db.prepare('SELECT id FROM studios WHERE slug = ?').get(slug);
  if (existing) throw new Error('slug 已被占用');

  const id = 'studio-' + crypto.randomBytes(8).toString('hex');
  const now = Date.now();

  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO studios (id, slug, name, tagline, secret_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, slug, name, tagline || null, secretHash, now, now);

    db.prepare(`
      INSERT INTO studio_members (studio_id, user_id, role, joined_at)
      VALUES (?, ?, 'owner', ?)
    `).run(id, currentUserId, now);
  });
  txn();

  return { id, slug, name, tagline: tagline || null };
}

// 加入工作室 · 客户端必须先知道暗号 (从邀请桥消息里解出来) · 这里只验 hash 匹配
function studioJoin({ slug, secretHash }, { currentUserId }) {
  if (!slug || !secretHash) throw new Error('slug + secretHash 必填');

  const studio = db.prepare('SELECT id, name, secret_hash FROM studios WHERE slug = ?').get(slug);
  if (!studio) throw new Error('工作室不存在');
  if (studio.secret_hash !== secretHash) throw new Error('暗号不对');

  const already = db.prepare(
    'SELECT 1 FROM studio_members WHERE studio_id = ? AND user_id = ?'
  ).get(studio.id, currentUserId);
  if (already) return { id: studio.id, name: studio.name, alreadyMember: true };

  db.prepare(`
    INSERT INTO studio_members (studio_id, user_id, role, joined_at)
    VALUES (?, ?, 'member', ?)
  `).run(studio.id, currentUserId, Date.now());

  return { id: studio.id, name: studio.name, alreadyMember: false };
}

function studioLeave({ studioId }, { currentUserId }) {
  const row = db.prepare(
    'SELECT role FROM studio_members WHERE studio_id = ? AND user_id = ?'
  ).get(studioId, currentUserId);
  if (!row) throw new Error('你不在这个工作室里');

  // owner 退出前要确保还有别的成员 · 或者改成转让 (Phase 2)
  if (row.role === 'owner') {
    const otherCount = db.prepare(
      "SELECT COUNT(*) AS c FROM studio_members WHERE studio_id = ? AND user_id != ?"
    ).get(studioId, currentUserId).c;
    if (otherCount === 0) {
      throw new Error('你是唯一 owner · 没人继承 · 先邀请别人加入再退');
    }
  }

  db.prepare('DELETE FROM studio_members WHERE studio_id = ? AND user_id = ?')
    .run(studioId, currentUserId);

  return { left: true };
}

// 获取一个 studio 的聚合数据 (公开 · 不要求登录)
function studioGet({ slug }) {
  const studio = db.prepare(`
    SELECT id, slug, name, tagline, created_at AS createdAt
    FROM studios WHERE slug = ?
  `).get(slug);
  if (!studio) return null;

  const members = db.prepare(`
    SELECT u.id, u.handle, u.name, u.tagline, sm.role, sm.joined_at AS joinedAt
    FROM studio_members sm
    JOIN users u ON u.id = sm.user_id
    WHERE sm.studio_id = ?
    ORDER BY sm.joined_at ASC
  `).all(studio.id);

  // v0.41 只显示 studio_id 显式挂上来的项目 · 不再聚合"成员的所有项目"
  // 个人作品 (studio_id IS NULL) 不会出现在工作室页 · 需要 user 主动 attribute 才上来
  const projects = db.prepare(`
    SELECT p.id, p.slug, p.name, p.desc, p.status, p.owner_id AS ownerId,
           u.handle AS ownerHandle, p.updated_at AS updatedAt
    FROM projects p
    JOIN users u ON u.id = p.owner_id
    WHERE p.studio_id = ?
    ORDER BY p.updated_at DESC
  `).all(studio.id);

  return { ...studio, members, projects };
}

// 列出某个 user 挂靠的所有 studio (用于个人主页"挂靠 → X"显示)
function studiosForUser(userId) {
  return db.prepare(`
    SELECT s.id, s.slug, s.name, s.tagline, sm.role
    FROM studio_members sm
    JOIN studios s ON s.id = sm.studio_id
    WHERE sm.user_id = ?
    ORDER BY sm.joined_at ASC
  `).all(userId);
}

// v0.38 工坊页厚卡用 · 每间挂靠工作室 + 成员预览 + 项目计数 + 最近 3 条跨成员动静
function studiosForUserWithPreview(userId) {
  const studios = studiosForUser(userId);
  return studios.map(s => {
    const members = db.prepare(`
      SELECT u.handle, u.name, sm.role, sm.joined_at AS joinedAt
      FROM studio_members sm
      JOIN users u ON u.id = sm.user_id
      WHERE sm.studio_id = ?
      ORDER BY sm.joined_at ASC
    `).all(s.id);

    const memberIds = db.prepare(
      'SELECT user_id FROM studio_members WHERE studio_id = ?'
    ).all(s.id).map(r => r.user_id);

    let projectCount = 0, inFlightCount = 0, doneCount = 0, recentUpdates = [];
    if (memberIds.length > 0) {
      const ph = memberIds.map(() => '?').join(',');
      const counts = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status IN ('active','stuck') THEN 1 ELSE 0 END) AS inFlight,
          SUM(CASE WHEN status IN ('done','archive') THEN 1 ELSE 0 END) AS done
        FROM projects WHERE owner_id IN (${ph})
      `).get(...memberIds);
      projectCount = counts.total || 0;
      inFlightCount = counts.inFlight || 0;
      doneCount = counts.done || 0;

      // 最近 3 条 update · 跨成员 timeline · 过滤掉 isMethod
      recentUpdates = db.prepare(`
        SELECT up.id, up.kind, up.at, up.text,
               p.slug AS projectSlug, p.name AS projectName,
               u.handle AS ownerHandle
        FROM updates up
        JOIN projects p ON p.id = up.project_id
        JOIN users u ON u.id = p.owner_id
        WHERE p.owner_id IN (${ph}) AND (up.is_method IS NULL OR up.is_method = 0)
        ORDER BY up.at DESC
        LIMIT 3
      `).all(...memberIds);
    }

    return {
      id: s.id,
      slug: s.slug,
      name: s.name,
      tagline: s.tagline,
      role: s.role,
      memberCount: members.length,
      members,
      projectCount,
      inFlightCount,
      doneCount,
      recentUpdates,
    };
  });
}

// 列所有 studio (列表页)
function studiosList() {
  return db.prepare(`
    SELECT s.id, s.slug, s.name, s.tagline, s.created_at AS createdAt,
           (SELECT COUNT(*) FROM studio_members WHERE studio_id = s.id) AS memberCount
    FROM studios s
    ORDER BY s.created_at DESC
  `).all();
}

// 校验 user 是不是 studio 成员 (bridge 升级会用)
function isMember(studioId, userId) {
  return !!db.prepare(
    'SELECT 1 FROM studio_members WHERE studio_id = ? AND user_id = ?'
  ).get(studioId, userId);
}

// 校验 user 是不是 studio owner
function isOwner(studioId, userId) {
  const row = db.prepare(
    "SELECT role FROM studio_members WHERE studio_id = ? AND user_id = ?"
  ).get(studioId, userId);
  return !!(row && row.role === 'owner');
}

// owner 邀请别人 · 客户端已经算好 tokenHash + secretCipher (e2e · server 看不到 token)
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
function studioCreateInvite({ studioId, targetHandle, tokenHash, secretCipher }, { currentUserId }) {
  if (!studioId || !targetHandle || !tokenHash || !secretCipher) {
    throw new Error('studioId / targetHandle / tokenHash / secretCipher 都必填');
  }
  if (!/^[a-f0-9]{64}$/.test(tokenHash)) throw new Error('tokenHash 必须是 64 位 hex');
  if (!isOwner(studioId, currentUserId)) throw new Error('只有 owner 能邀请别人');

  const handle = targetHandle.replace(/^@/, '');
  const target = db.prepare('SELECT id, handle FROM users WHERE handle = ?').get(handle);
  if (!target) throw new Error('找不到 @' + handle + ' · 让 ta 先注册');

  if (isMember(studioId, target.id)) {
    throw new Error('@' + handle + ' 已经在工作室里了');
  }

  const expiresAt = Date.now() + INVITE_TTL_MS;
  try {
    db.prepare(`
      INSERT INTO studio_invites (token_hash, studio_id, target_user_id, secret_cipher, invited_by, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(tokenHash, studioId, target.id, secretCipher, currentUserId, expiresAt, Date.now());
  } catch (e) {
    // tokenHash 冲突 (token 已用过) — 概率极低 · 让客户端重试
    if (String(e.message).includes('UNIQUE')) throw new Error('token 冲突 · 重新跑 invite');
    throw e;
  }

  return { targetHandle: handle, expiresAt };
}

// maomao 调 · 用 token 兑换 invite · 加成员 + 返 secretCipher 让 client 解 secret
function studioAcceptInvite({ tokenHash }, { currentUserId }) {
  if (!tokenHash || !/^[a-f0-9]{64}$/.test(tokenHash)) throw new Error('tokenHash 必须是 64 位 hex');

  const invite = db.prepare(`
    SELECT i.token_hash, i.studio_id, i.target_user_id, i.secret_cipher, i.expires_at,
           s.slug, s.name
    FROM studio_invites i
    JOIN studios s ON s.id = i.studio_id
    WHERE i.token_hash = ?
  `).get(tokenHash);
  if (!invite) throw new Error('邀请不存在 / 已用过 · token 不对?');
  if (invite.target_user_id !== currentUserId) {
    throw new Error('这个邀请不是给你的 (限定了接收者)');
  }
  if (invite.expires_at < Date.now()) {
    db.prepare('DELETE FROM studio_invites WHERE token_hash = ?').run(tokenHash);
    throw new Error('邀请过期了 · 让对方重新跑 invite');
  }

  const txn = db.transaction(() => {
    // 加成员
    const already = db.prepare(
      'SELECT 1 FROM studio_members WHERE studio_id = ? AND user_id = ?'
    ).get(invite.studio_id, currentUserId);
    if (!already) {
      db.prepare(`
        INSERT INTO studio_members (studio_id, user_id, role, joined_at)
        VALUES (?, ?, 'member', ?)
      `).run(invite.studio_id, currentUserId, Date.now());
    }
    // 删 invite (一次性)
    db.prepare('DELETE FROM studio_invites WHERE token_hash = ?').run(tokenHash);
  });
  txn();

  return {
    studioId: invite.studio_id,
    slug: invite.slug,
    name: invite.name,
    secretCipher: invite.secret_cipher,
  };
}

// 同 studio 的兄弟成员 handle 列表 (邀请别人时找队友用)

// 同 studio 的兄弟成员 handle 列表 (邀请别人时找队友用)
function siblingHandles(studioId, exceptUserId) {
  return db.prepare(`
    SELECT u.handle
    FROM studio_members sm
    JOIN users u ON u.id = sm.user_id
    WHERE sm.studio_id = ? AND sm.user_id != ?
  `).all(studioId, exceptUserId).map(r => r.handle);
}

module.exports = {
  studioCreate,
  studioJoin,
  studioLeave,
  studioGet,
  studiosForUser,
  studiosForUserWithPreview,
  studiosList,
  studioCreateInvite,
  studioAcceptInvite,
  isMember,
  isOwner,
  siblingHandles,
};

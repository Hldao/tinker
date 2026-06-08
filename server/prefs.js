// v0.35 · 通知偏好闭环 · web + cli + 桥共享一份 server 数据
// 字段语义见 migrations/050_user_prefs.sql

const db = require('./db');

const DEFAULT_PREFS = {
  mutedUntil: null,
  quietStart: null,
  quietEnd: null,
  cliDisabledKinds: [],
  webMuteWeak: false,
};

function rowToPrefs(row) {
  if (!row) return { ...DEFAULT_PREFS };
  let kinds = [];
  try { kinds = JSON.parse(row.cli_disabled_kinds || '[]'); }
  catch { kinds = []; }
  return {
    mutedUntil: row.muted_until,
    quietStart: row.quiet_start || null,
    quietEnd: row.quiet_end || null,
    cliDisabledKinds: Array.isArray(kinds) ? kinds : [],
    webMuteWeak: !!row.web_mute_weak,
    updatedAt: row.updated_at,
  };
}

function getPrefs(userId) {
  const row = db.prepare('SELECT * FROM user_prefs WHERE user_id = ?').get(userId);
  return rowToPrefs(row);
}

function setPrefs(userId, partial) {
  const current = getPrefs(userId);
  const next = {
    mutedUntil: partial.mutedUntil !== undefined ? partial.mutedUntil : current.mutedUntil,
    quietStart: partial.quietStart !== undefined ? partial.quietStart : current.quietStart,
    quietEnd:   partial.quietEnd   !== undefined ? partial.quietEnd   : current.quietEnd,
    cliDisabledKinds: Array.isArray(partial.cliDisabledKinds)
      ? partial.cliDisabledKinds.filter(s => typeof s === 'string').slice(0, 64)
      : current.cliDisabledKinds,
    webMuteWeak: partial.webMuteWeak !== undefined ? !!partial.webMuteWeak : current.webMuteWeak,
  };
  // 校验时间格式 HH:MM
  const isHHMM = (s) => s === null || /^([0-1]\d|2[0-3]):([0-5]\d)$/.test(s);
  if (!isHHMM(next.quietStart) || !isHHMM(next.quietEnd)) {
    throw new Error('夜间时段格式不对 · 要 HH:MM');
  }
  if (next.mutedUntil !== null && (typeof next.mutedUntil !== 'number' || next.mutedUntil < 0)) {
    throw new Error('mutedUntil 要是时间戳或 null');
  }
  const now = Date.now();
  db.prepare(`
    INSERT INTO user_prefs
      (user_id, muted_until, quiet_start, quiet_end, cli_disabled_kinds, web_mute_weak, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      muted_until = excluded.muted_until,
      quiet_start = excluded.quiet_start,
      quiet_end = excluded.quiet_end,
      cli_disabled_kinds = excluded.cli_disabled_kinds,
      web_mute_weak = excluded.web_mute_weak,
      updated_at = excluded.updated_at
  `).run(
    userId,
    next.mutedUntil,
    next.quietStart,
    next.quietEnd,
    JSON.stringify(next.cliDisabledKinds),
    next.webMuteWeak ? 1 : 0,
    now,
  );
  return getPrefs(userId);
}

// 当前是否处于"勿扰"窗口 (mutedUntil 没过期 + quietHours 命中 任一即静默)
function isQuietNow(prefs, nowDate) {
  const now = nowDate || new Date();
  if (prefs.mutedUntil && prefs.mutedUntil > now.getTime()) return true;
  if (!prefs.quietStart || !prefs.quietEnd) return false;
  const [sh, sm] = prefs.quietStart.split(':').map(Number);
  const [eh, em] = prefs.quietEnd.split(':').map(Number);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (startMin === endMin) return false;
  if (startMin < endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  // 跨午夜 · 比如 23:00 - 07:00
  return nowMin >= startMin || nowMin < endMin;
}

// 综合判断 · CLI 触发器单类是否该屏蔽
function shouldSuppressKind(prefs, kind, nowDate) {
  if (isQuietNow(prefs, nowDate)) return { suppress: true, reason: 'quiet' };
  if (prefs.cliDisabledKinds.includes(kind)) return { suppress: true, reason: 'kind-disabled' };
  return { suppress: false };
}

module.exports = {
  getPrefs,
  setPrefs,
  isQuietNow,
  shouldSuppressKind,
  DEFAULT_PREFS,
};

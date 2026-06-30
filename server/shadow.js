// 影子只读问答(网页版)· 服务器端
// 拉某人共享的进展 → 用便宜模型(Haiku)替 ta 汇报。
// 轻度功能 · 成本极低(几分钱)· 服务器自付。钥匙走环境变量 SHADOW_LLM_KEY。
// 没配钥匙时返回 NO_LLM_KEY · 前端友好提示 · 不崩。
const db = require('./db');

const SHADOW_MODEL = process.env.SHADOW_LLM_MODEL || 'claude-haiku-4-5';
const SHADOW_KEY = process.env.SHADOW_LLM_KEY || process.env.ANTHROPIC_API_KEY || '';

// 拉某 handle 共享的进展 · 只读 · 只取公开记录(隐私边界:数据库里本就是共享的)
function gatherContext(handle) {
  return db.prepare(`
    SELECT u.text AS text, u.at AS at, p.name AS project, p.status AS status
    FROM updates u
    JOIN projects p ON u.project_id = p.id
    JOIN users  usr ON p.owner_id = usr.id
    WHERE usr.handle = ?
    ORDER BY u.at DESC
    LIMIT 25
  `).all(handle).filter(r => (r.text || '').trim().length > 0);
}

function buildPrompt(handle, name, items, question) {
  const ctx = items.map(it => {
    const when = new Date(it.at).toLocaleDateString('zh-CN');
    return `- (${when} · ${it.project} · ${it.status}) ${(it.text || '').replace(/\s+/g, ' ').slice(0, 300)}`;
  }).join('\n');
  return `你是 @${handle}${name ? '(' + name + ')' : ''} 的"影子" · 基于 ta 在捣鼓上记录的进展替 ta 回答别人的问题。

ta 最近的进展记录(越靠上越新):
${ctx}

有人问:${question}

要求:
- 只根据上面的记录回答 · 记录里没有的别编 · 不确定就说"ta 最近没记到这个"
- 像在替 ta 汇报进度 · 简洁口语 · 纯中文 · 别堆术语
- 直接说结论 · 别复述问题 · 2-5 句话`;
}

async function askShadow({ handle, question }) {
  const h = String(handle || '').replace(/^@/, '').trim();
  const q = String(question || '').trim().slice(0, 500);
  if (!h || !q) return { ok: false, error: 'handle / question 必填' };

  const u = db.prepare('SELECT handle, name FROM users WHERE handle = ?').get(h);
  if (!u) return { ok: false, error: '找不到 @' + h };

  const items = gatherContext(h);
  if (items.length === 0) {
    return { ok: true, handle: h, answer: null, note: 'no-progress', basedOn: 0 };
  }

  if (!SHADOW_KEY) {
    return { ok: false, error: 'NO_LLM_KEY', message: '服务器还没配影子的 LLM 钥匙(SHADOW_LLM_KEY)' };
  }

  const prompt = buildPrompt(h, u.name || u.handle, items, q);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': SHADOW_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: SHADOW_MODEL, max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || ('LLM ' + res.status));
  const answer = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  return { ok: true, handle: h, answer, basedOn: items.length };
}

module.exports = { askShadow, gatherContext };

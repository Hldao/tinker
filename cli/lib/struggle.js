// Tinker 踩坑全周期状态机 · v0.12
//
// 把踩坑从"瞬间事件"变成"有时序的过程"。
// 三阶段:入坑 (struggling) → 过程 (signals 累积) → 出坑 (resolved + autopsy)
//
// 状态机:
//   none → struggling → resolved → none
//   静默原则:struggling 时不打扰 · 让用户专心 debug · 只后台收集 dossier
//   退出后 5min 内 ai-debug-breakthrough 触发器命中 · 引导用户看自动整理的草稿
//
// 数据存储:
//   state.currentStruggle      指向当前 struggle (内存中状态机)
//   ~/.tinker/struggles/<id>.json  完整 dossier (持久化 · 30 天清理)
//
// 这是 cli/bin/tinker.js 的辅助模块 · cmdCheck 在每次 git hook 时调用入口

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.tinker');
const STRUGGLES_DIR = path.join(CONFIG_DIR, 'struggles');

// 入坑信号词 · 用户跟 AI 反复挣扎的语言特征
// 中英混 · 因为 vibe coder 经常代码英文 + 抱怨中文
const FAIL_SIGNS = /(还是不行|不行啊|又报错|又试|怎么还是|奇怪|为什么不|不对啊|失败|报错|debug|没用|没生效|没反应|还是不通|又挂了|又错|又崩|又掉|还报|这次还|to no avail|still failing|same error)/gi;

// 出坑信号词 · 破局那一刻的语言特征
const CRACK_SIGNS = /(终于|搞定了|找到了|原来是|原来这样|通了|可以了|成了|破了|奏效|生效了|懂了|是这个|对了|过了|fixed it|got it|finally works|that was it)/i;

// 入坑阈值:30 分钟窗口内失败信号 >= 3 + 跨度 >= 15 分钟
const ENTER_WINDOW_MS = 30 * 60 * 1000;
const ENTER_MIN_SIGNALS = 3;
const ENTER_MIN_SPAN_MS = 15 * 60 * 1000;

// 出坑超时:8 小时无新信号当作放弃
const ABANDON_TIMEOUT_MS = 8 * 60 * 60 * 1000;

// 扫 ~/.claude/projects/ 最近 minutesBack 分钟的 user message
// 优先匹配 cwd 编码的项目目录 · 不存在 fallback parent
// 返回 { userMessages, failCount, crackHit, span, scanned }
function scanClaudeRecent({ minutesBack = 30, cwd = process.cwd() } = {}) {
  const claudeBase = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeBase)) {
    return { userMessages: [], failCount: 0, crackHit: false, span: 0, scanned: 0 };
  }

  // 试两层 (cwd / parent) · 避免扫全 base 跨项目误报
  const cwdEncoded = cwd.replace(/\//g, '-');
  const parentEncoded = path.dirname(cwd).replace(/\//g, '-');
  const searchDirs = [
    path.join(claudeBase, cwdEncoded),
    path.join(claudeBase, parentEncoded),
  ].filter(p => fs.existsSync(p));
  if (searchDirs.length === 0) {
    return { userMessages: [], failCount: 0, crackHit: false, span: 0, scanned: 0 };
  }

  const windowMs = minutesBack * 60 * 1000;
  const now = Date.now();
  const userMessages = [];
  let scanned = 0;

  function walkConv(dir) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walkConv(full);
        else if (e.name.endsWith('.jsonl')) {
          try {
            const stat = fs.statSync(full);
            if (now - stat.mtimeMs > windowMs) continue;
            scanned++;
            if (scanned > 30) return;  // 安全阀
            const lines = fs.readFileSync(full, 'utf-8').split('\n').filter(Boolean);
            for (const line of lines) {
              try {
                const obj = JSON.parse(line);
                if (obj.type !== 'user' || !obj.message) continue;
                const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
                if (!ts || now - ts > windowMs) continue;
                let text = '';
                if (typeof obj.message.content === 'string') text = obj.message.content;
                else if (Array.isArray(obj.message.content)) {
                  text = obj.message.content
                    .filter(c => c.type === 'text' && c.text)
                    .map(c => c.text)
                    .join('\n');
                }
                text = (text || '').trim();
                if (!text || text.startsWith('/') || text.length < 8) continue;
                userMessages.push({ text, ts });
              } catch {}
            }
          } catch {}
        }
      }
    } catch {}
  }
  searchDirs.forEach(d => walkConv(d));

  userMessages.sort((a, b) => a.ts - b.ts);
  const joined = userMessages.map(m => m.text).join('\n');
  const failMatches = joined.match(FAIL_SIGNS) || [];
  const failCount = failMatches.length;
  const lastChunk = userMessages.slice(-5).map(m => m.text).join('\n');
  const crackHit = CRACK_SIGNS.test(lastChunk);
  const span = userMessages.length >= 2
    ? userMessages[userMessages.length - 1].ts - userMessages[0].ts
    : 0;

  return { userMessages, failCount, crackHit, span, scanned };
}

// 从 dossier signals 推 topic (1-2 词)
// 不调 LLM · 用滑动窗口 + 频率统计 + subsumed 去重
// 输入:dossier.signals · 输出:'阿里云 邮件' / 'supabase auth' / null

// 常规停用词 (中文虚词 + 英文虚词)
const STOP_WORDS = new Set([
  // 中文虚词 / 代词 / 助词
  '我', '你', '他', '她', '它', '这', '那', '是', '的', '了', '在', '有', '又', '还',
  '都', '也', '就', '把', '上', '下', '里', '为', '吧', '吗', '呢', '哈', '嗯',
  '啊', '哦', '呀', '能', '让', '会', '可', '不', '没', '比', '到', '要', '从',
  // 中文 2 字 noise (滑窗常见噪音)
  '怎么', '什么', '为什么', '一下', '一次', '一直', '一遍', '这个', '那个', '不是',
  '没有', '可以', '应该', '需要', '已经', '正在', '又是', '都是', '只是', '感觉',
  '试试', '继续', '不知', '知道', '现在', '今天', '昨天',
  // 英文虚词
  'try', 'fix', 'wip', 'test', 'and', 'the', 'a', 'an', 'is', 'are', 'or',
  'to', 'of', 'for', 'on', 'in', 'with', 'by', 'at', 'as', 'it', 'this', 'that',
  'still', 'again', 'really', 'just', 'maybe', 'now', 'so', 'me', 'my',
  'you', 'your', 'we', 'our', 'they', 'their', 'i', 'do', 'does', 'did',
  'have', 'has', 'had', 'be', 'been', 'being', 'will', 'would', 'should', 'can',
  'could', 'not', 'no', 'yes', 'how', 'why', 'when', 'where', 'what',
]);

// 失败 / 破局信号词完整集合 (跟 FAIL_SIGNS / CRACK_SIGNS 同源)
// 不能作为 topic · 都是抱怨 / 庆祝词
const SIGNAL_NOISE = new Set([
  '还是不行', '不行啊', '又报错', '又试', '怎么还是', '奇怪', '为什么不',
  '不对啊', '失败', '报错', 'debug', '没用', '没生效', '没反应',
  '还是不通', '又挂了', '又错', '又崩', '又掉', '还报', '这次还',
  '终于', '搞定了', '搞定', '找到了', '原来是', '原来这样', '通了',
  '可以了', '成了', '破了', '奏效', '生效了', '懂了', '是这个', '对了', '过了',
  '又是', '还是', '又试', '为什', '不行', '不通', '又报', '没生', '没反',
  '怎么', '原来', '搞定', '可以', '生效', '通了', '不对', '没用',
]);

// 滑窗会切出 FAIL/CRACK 词的派生子串 · 比如 "还是不" 是 "还是不行" 的 3 字子串
// 用 prefix / suffix 集合过滤掉这些派生噪音
const NOISE_PREFIXES = ['还是', '又是', '怎么', '又试', '又报', '又错', '又挂', '没生', '没反', '为什', '不知', '搞定', '原来', '终于', '可以', '生效'];
const NOISE_SUFFIXES = ['不行', '不通', '失败', '报错', '没用', '没生效', '没反应', '搞砸', '挂了', '崩了'];

function isSignalNoise(t) {
  if (SIGNAL_NOISE.has(t)) return true;
  for (const p of NOISE_PREFIXES) {
    if (t.length >= p.length + 1 && t.startsWith(p)) return true;
  }
  for (const s of NOISE_SUFFIXES) {
    if (t.length >= s.length + 1 && t.endsWith(s)) return true;
  }
  return false;
}

function inferTopic(signals) {
  if (!Array.isArray(signals) || signals.length === 0) return null;
  const allText = signals.map(s => s.text || s.snippet || s.msg || '').join(' ');

  // 中文:滑动窗口提 2-5 字 substring · 必须全是 CJK 字符
  // 2-5 字覆盖大部分中文概念 (微信小程序 / 阿里云 / 订阅消息 等)
  const cnTokens = [];
  for (let i = 0; i < allText.length; i++) {
    for (let len = 2; len <= 5 && i + len <= allText.length; len++) {
      const sub = allText.slice(i, i + len);
      if (/^[一-龥]+$/.test(sub) && !STOP_WORDS.has(sub) && !isSignalNoise(sub)) {
        cnTokens.push(sub);
      }
    }
  }

  // 英文:连续字母数字 · ≥3 字符
  const enTokens = (allText.match(/[a-zA-Z][a-zA-Z0-9]{2,}/g) || [])
    .map(t => t.toLowerCase())
    .filter(t => !STOP_WORDS.has(t) && !isSignalNoise(t));

  if (cnTokens.length + enTokens.length === 0) return null;

  // 频率统计
  const freq = new Map();
  [...cnTokens, ...enTokens].forEach(t => freq.set(t, (freq.get(t) || 0) + 1));

  // 排序: 频率 desc · 长度 desc (信息密度高的优先)
  const sortAndDedup = (cands) => {
    cands.sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return b[0].length - a[0].length;
    });
    // subsumed 去重 · 如果 "阿里" 跟 "阿里云" 同频率 · "阿里" 是 "阿里云" 的 substring · 丢
    // 实现:走一遍 · 凡是被已选项包含且频率 ≤ 已选项的 · 丢
    const kept = [];
    for (const [tok, ct] of cands) {
      const subsumed = kept.some(([kt, kc]) => kt !== tok && kt.includes(tok) && kc >= ct);
      if (!subsumed) kept.push([tok, ct]);
    }
    return kept;
  };

  const cnSorted = sortAndDedup([...freq.entries()].filter(([t]) => /^[一-龥]+$/.test(t)));
  const enSorted = sortAndDedup([...freq.entries()].filter(([t]) => /^[a-z]/i.test(t)));

  // 取 top 1 中文 + top 1 英文 (中英搭配最佳)
  const pick = [];
  if (cnSorted[0]) pick.push(cnSorted[0][0]);
  if (enSorted[0]) pick.push(enSorted[0][0]);

  // 兜底 · 如果只有一个语种 · 取 top 2 同语种
  if (pick.length < 2) {
    const pool = pick[0] && /^[一-龥]/.test(pick[0]) ? cnSorted : enSorted;
    if (pool[1] && !pick.includes(pool[1][0])) pick.push(pool[1][0]);
  }

  return pick.filter(Boolean).join(' ') || null;
}

// 状态机评估 · cmdCheck 每次跑都调
// 返回 { transition, newStruggle?, dossier? }
//   transition: 'none' | 'enter' | 'continue' | 'resolve' | 'abandon'
function evaluateStruggleState(state, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const now = Date.now();
  const cur = state.currentStruggle;

  // CASE A · 没在 struggling
  if (!cur) {
    // 用户明确关过 struggle 跟踪 · 直接退
    if (state.struggleOptOutUntil && state.struggleOptOutUntil > now) {
      return { transition: 'none' };
    }
    const recent = scanClaudeRecent({ minutesBack: 30, cwd });
    const meets = recent.failCount >= ENTER_MIN_SIGNALS && recent.span >= ENTER_MIN_SPAN_MS;
    if (!meets) return { transition: 'none' };
    return {
      transition: 'enter',
      pendingStruggle: {
        id: 'struggle-' + new Date(now).toISOString().slice(0, 16).replace(/[-T:]/g, ''),
        startedAt: now,
        topic: null,
        signals: recent.userMessages.slice(-5).map(m => ({
          at: m.ts,
          type: 'claude_fail',
          text: m.text.slice(0, 200),
        })),
        resolved: false,
        consented: false,  // 用户还没同意 · cmdCheck 那边 prompt
      },
    };
  }

  // CASE B · 在 struggling · 看要不要出
  if (!cur.resolved) {
    const recent = scanClaudeRecent({ minutesBack: 30, cwd });
    if (recent.crackHit) {
      return { transition: 'resolve' };
    }
    // 8h 无新信号 · 放弃
    const lastSignalAt = cur.signals && cur.signals.length > 0
      ? cur.signals[cur.signals.length - 1].at
      : cur.startedAt;
    if (now - lastSignalAt > ABANDON_TIMEOUT_MS) {
      return { transition: 'abandon' };
    }
    return { transition: 'continue', recent };
  }

  // CASE C · 已 resolved · 等待 autopsy 完成 + 草稿被消费
  return { transition: 'none' };
}

// 持久化 dossier 到 ~/.tinker/struggles/<id>.json
function saveDossier(struggle) {
  try {
    fs.mkdirSync(STRUGGLES_DIR, { recursive: true });
    const file = path.join(STRUGGLES_DIR, struggle.id + '.json');
    fs.writeFileSync(file, JSON.stringify(struggle, null, 2));
  } catch (e) { /* 容错 · 不影响主流程 */ }
}

function loadDossier(id) {
  try {
    const file = path.join(STRUGGLES_DIR, id + '.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch { return null; }
}

// 列出最近 N 个 dossier (给 goodnight / tinker struggle status 用)
function listDossiers({ limit = 5 } = {}) {
  try {
    if (!fs.existsSync(STRUGGLES_DIR)) return [];
    return fs.readdirSync(STRUGGLES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(STRUGGLES_DIR, f), 'utf-8')); }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  } catch { return []; }
}

// 30 天清理 · 顺手在 cmdCheck 调一下
function cleanOldDossiers({ keepDays = 30 } = {}) {
  try {
    if (!fs.existsSync(STRUGGLES_DIR)) return;
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    fs.readdirSync(STRUGGLES_DIR).forEach(f => {
      try {
        const full = path.join(STRUGGLES_DIR, f);
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {}
    });
  } catch {}
}

// 给 dossier append 一条 signal · 自动 saveDossier
function appendSignal(struggle, signal) {
  if (!struggle || !signal) return struggle;
  struggle.signals = struggle.signals || [];
  struggle.signals.push({ at: Date.now(), ...signal });
  saveDossier(struggle);
  return struggle;
}

module.exports = {
  CONFIG_DIR,
  STRUGGLES_DIR,
  FAIL_SIGNS,
  CRACK_SIGNS,
  scanClaudeRecent,
  inferTopic,
  evaluateStruggleState,
  saveDossier,
  loadDossier,
  listDossiers,
  cleanOldDossiers,
  appendSignal,
};

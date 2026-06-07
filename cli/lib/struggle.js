// Tinker lifecycle 全周期状态机 · v0.13
//
// v0.12 起 把"踩坑"从瞬间事件升级成有时序的过程。
// v0.13 抽象成 lifecycle 框架 · struggle 是第一个 instance · learning 是第二个。
//
// 每个 lifecycle 实例:
//   - 入口信号 (enter): regex 匹配 Claude 对话 · 满足条件进入 active
//   - 过程: cmdCheck 每次 hook 顺手 append signal 到 dossier
//   - 出口信号 (resolve): regex 匹配最近对话 · 触发 autopsy
//   - autopsy: LLM 看 dossier + fix commit · 起草草稿到 .tinker/drafts/
//   - 产出: tinker push <file> --as-<tag> 一键发 + 自动标
//
// 状态机:
//   none → active (struggling/learning) → resolved → none
//   静默原则:active 时不打扰 · 让用户专心做 · 只后台收集 dossier
//   退出后 5min 内 ai-X-breakthrough 触发器命中 · 引导用户看草稿
//
// 数据存储:
//   state.currentStruggle    历史字段名 · 现在通用承载任意 lifecycle 的 active situation
//                            含 .lifecycleType ('struggle' / 'learning') · 默认 'struggle'
//   ~/.tinker/struggles/     历史目录名 · 现在通用 dossier 存储

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.tinker');
const STRUGGLES_DIR = path.join(CONFIG_DIR, 'struggles');

// ============================================
// 第一部分 · 信号词模式 (lifecycle-specific)
// ============================================

// Struggle (踩坑) · 失败信号 + 破局信号
const STRUGGLE_FAIL = /(还是不行|不行啊|又报错|又试|怎么还是|奇怪|为什么不|不对啊|失败|报错|debug|没用|没生效|没反应|还是不通|又挂了|又错|又崩|又掉|还报|这次还|to no avail|still failing|same error)/gi;
const STRUGGLE_CRACK = /(终于|搞定了|找到了|原来是|原来这样|通了|可以了|成了|破了|奏效|生效了|懂了|是这个|对了|过了|fixed it|got it|finally works|that was it)/i;

// Learning (学新东西) · 探索信号 + 理解信号
const LEARNING_EXPLORE = /(怎么用|怎么配|是什么|怎么写|怎么开始|入门|新手|什么意思|怎么搞|怎么调|区别是|有什么差|tutorial|getting started|hello world|how does|how to use|how do i|what is|what's the|getting familiar|new to|just started)/gi;
const LEARNING_UNDERSTAND = /(终于会了|搞懂了|学会了|大概懂了|明白怎么用|看懂了|理解了|入门了|上手了|hello world (?:跑通|出来|成了)|now i (?:get it|understand)|finally (?:get|got) it|makes sense now|now i know how|now i can)/i;

// Design Loop (产品决策推演) · 权衡信号 + 决策信号
// vibe coder 跟 AI 来回推演 "X vs Y / 应该不应该 / 为什么选 Z" 的典型语言
const DESIGN_EXPLORE = /(考虑|应该|应不应|是不是|是否|怎么决定|觉得|我想|权衡|比较|对比|哪个|哪种|跟.{1,5}有什么差|有什么区别|要不要|该不该|是这样吗|这样行吗|是个|的话|那么|要么|或者|应不应该|这俩|两个|三个|思考|推演|想清楚|理一下|该|可以|这种)/gi;
const DESIGN_DECIDE = /(做吧|决定|选|推|定下来|就这样|这么办|去做|开搞|拍板|那就|搞定吧|先做|这样定了|按这个|认了|定了|决心|算了不做|不做了|砍掉|砍了|留着|保留|去掉)/i;

const ENTER_WINDOW_MS = 30 * 60 * 1000;
const ABANDON_TIMEOUT_STRUGGLE_MS = 8 * 60 * 60 * 1000;
const ABANDON_TIMEOUT_LEARNING_MS = 12 * 60 * 60 * 1000;
const ABANDON_TIMEOUT_DESIGN_MS = 6 * 60 * 60 * 1000;  // 推演往往集中 · 6h 无新信号放弃

function countMatches(text, regex) {
  if (!text) return 0;
  return (text.match(regex) || []).length;
}

// ============================================
// 第二部分 · LIFECYCLE_CONFIGS · 框架配置
// ============================================

const LIFECYCLE_CONFIGS = {
  struggle: {
    name: 'struggle',
    label: '踩坑',
    productTag: 'experience',
    productLabel: '踩坑经验',
    draftPrefix: 'experience',
    triggerKind: 'ai-debug-breakthrough',
    abandonTimeoutMs: ABANDON_TIMEOUT_STRUGGLE_MS,
    canEnter(scan) {
      const failCount = countMatches(scan.text, STRUGGLE_FAIL);
      return failCount >= 3 && scan.span >= 15 * 60 * 1000;
    },
    canExit(scan) {
      return STRUGGLE_CRACK.test(scan.lastChunk);
    },
    matchSignal(text) {
      return STRUGGLE_FAIL.test(text);
    },
  },
  learning: {
    name: 'learning',
    label: '学新东西',
    productTag: 'learning',
    productLabel: '上手指南',
    draftPrefix: 'learning',
    triggerKind: 'ai-learning-breakthrough',
    abandonTimeoutMs: ABANDON_TIMEOUT_LEARNING_MS,
    canEnter(scan) {
      const exploreCount = countMatches(scan.text, LEARNING_EXPLORE);
      const failCount = countMatches(scan.text, STRUGGLE_FAIL);
      return exploreCount >= 4 && scan.span >= 20 * 60 * 1000 && failCount < 3;
    },
    canExit(scan) {
      return LEARNING_UNDERSTAND.test(scan.lastChunk);
    },
    matchSignal(text) {
      return LEARNING_EXPLORE.test(text);
    },
  },
  'design-loop': {
    name: 'design-loop',
    label: '产品决策推演',
    productTag: 'decision',
    productLabel: '决策推演',
    draftPrefix: 'decision',
    triggerKind: 'ai-design-breakthrough',
    abandonTimeoutMs: ABANDON_TIMEOUT_DESIGN_MS,
    canEnter(scan) {
      const exploreCount = countMatches(scan.text, DESIGN_EXPLORE);
      const failCount = countMatches(scan.text, STRUGGLE_FAIL);
      const learnCount = countMatches(scan.text, LEARNING_EXPLORE);
      // design-loop 信号:权衡/考虑词密集 + 失败词低 (不是 debug) + 探索词低 (不是 learning)
      // 阈值高一些:推演词容易跟"思考类"对话混淆 · 设 >= 8 才进
      return exploreCount >= 8 && scan.span >= 30 * 60 * 1000 && failCount < 3 && learnCount < 4;
    },
    canExit(scan) {
      return DESIGN_DECIDE.test(scan.lastChunk);
    },
    matchSignal(text) {
      return DESIGN_EXPLORE.test(text);
    },
  },
};

// 优先级:struggle > learning > design-loop
// 同时满足时按这个序选 (debug 最需要陪伴 · 学习其次 · 推演不打扰)
const LIFECYCLE_PRIORITY = ['struggle', 'learning', 'design-loop'];

// ============================================
// 第三部分 · 通用工具
// ============================================

function scanClaudeRecent({ minutesBack = 30, cwd = process.cwd() } = {}) {
  const claudeBase = path.join(os.homedir(), '.claude', 'projects');
  const empty = { userMessages: [], text: '', lastChunk: '', span: 0, scanned: 0,
                  failCount: 0, crackHit: false };
  if (!fs.existsSync(claudeBase)) return empty;

  const cwdEncoded = cwd.replace(/\//g, '-');
  const parentEncoded = path.dirname(cwd).replace(/\//g, '-');
  const searchDirs = [
    path.join(claudeBase, cwdEncoded),
    path.join(claudeBase, parentEncoded),
  ].filter(p => fs.existsSync(p));
  if (searchDirs.length === 0) return empty;

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
            if (scanned > 30) return;
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
  const text = userMessages.map(m => m.text).join('\n');
  const lastChunk = userMessages.slice(-5).map(m => m.text).join('\n');
  const span = userMessages.length >= 2
    ? userMessages[userMessages.length - 1].ts - userMessages[0].ts
    : 0;
  // 兼容字段 (老调用方读 failCount / crackHit)
  const failCount = countMatches(text, STRUGGLE_FAIL);
  const crackHit = STRUGGLE_CRACK.test(lastChunk);

  return { userMessages, text, lastChunk, span, scanned, failCount, crackHit };
}

// ============================================
// 第四部分 · Topic 推断
// ============================================

const STOP_WORDS = new Set([
  '我', '你', '他', '她', '它', '这', '那', '是', '的', '了', '在', '有', '又', '还',
  '都', '也', '就', '把', '上', '下', '里', '为', '吧', '吗', '呢', '哈', '嗯',
  '啊', '哦', '呀', '能', '让', '会', '可', '不', '没', '比', '到', '要', '从',
  '怎么', '什么', '为什么', '一下', '一次', '一直', '一遍', '这个', '那个', '不是',
  '没有', '可以', '应该', '需要', '已经', '正在', '又是', '都是', '只是', '感觉',
  '试试', '继续', '不知', '知道', '现在', '今天', '昨天',
  'try', 'fix', 'wip', 'test', 'and', 'the', 'a', 'an', 'is', 'are', 'or',
  'to', 'of', 'for', 'on', 'in', 'with', 'by', 'at', 'as', 'it', 'this', 'that',
  'still', 'again', 'really', 'just', 'maybe', 'now', 'so', 'me', 'my',
  'you', 'your', 'we', 'our', 'they', 'their', 'i', 'do', 'does', 'did',
  'have', 'has', 'had', 'be', 'been', 'being', 'will', 'would', 'should', 'can',
  'could', 'not', 'no', 'yes', 'how', 'why', 'when', 'where', 'what',
]);

const SIGNAL_NOISE = new Set([
  '还是不行', '不行啊', '又报错', '又试', '怎么还是', '奇怪', '为什么不',
  '不对啊', '失败', '报错', 'debug', '没用', '没生效', '没反应',
  '还是不通', '又挂了', '又错', '又崩', '又掉', '还报', '这次还',
  '终于', '搞定了', '搞定', '找到了', '原来是', '原来这样', '通了',
  '可以了', '成了', '破了', '奏效', '生效了', '懂了', '是这个', '对了', '过了',
  '又是', '还是', '又试', '为什', '不行', '不通', '又报', '没生', '没反',
  '怎么', '原来', '搞定', '可以', '生效', '通了', '不对', '没用',
  '怎么用', '怎么配', '是什么', '怎么写', '入门', '新手', '什么意思',
  '怎么搞', '怎么调', '区别是', '搞懂了', '学会了', '看懂了', '理解了',
  '上手了', '入门了',
]);

const NOISE_PREFIXES = ['还是', '又是', '怎么', '又试', '又报', '又错', '又挂', '没生', '没反', '为什', '不知', '搞定', '原来', '终于', '可以', '生效', '搞懂', '学会', '看懂', '上手'];
const NOISE_SUFFIXES = ['不行', '不通', '失败', '报错', '没用', '没生效', '没反应', '搞砸', '挂了', '崩了', '懂了', '会了'];

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

  const cnTokens = [];
  for (let i = 0; i < allText.length; i++) {
    for (let len = 2; len <= 5 && i + len <= allText.length; len++) {
      const sub = allText.slice(i, i + len);
      if (/^[一-龥]+$/.test(sub) && !STOP_WORDS.has(sub) && !isSignalNoise(sub)) {
        cnTokens.push(sub);
      }
    }
  }

  const enTokens = (allText.match(/[a-zA-Z][a-zA-Z0-9]{2,}/g) || [])
    .map(t => t.toLowerCase())
    .filter(t => !STOP_WORDS.has(t) && !isSignalNoise(t));

  if (cnTokens.length + enTokens.length === 0) return null;

  const freq = new Map();
  [...cnTokens, ...enTokens].forEach(t => freq.set(t, (freq.get(t) || 0) + 1));

  const sortAndDedup = (cands) => {
    cands.sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return b[0].length - a[0].length;
    });
    const kept = [];
    for (const [tok, ct] of cands) {
      const subsumed = kept.some(([kt, kc]) => kt !== tok && kt.includes(tok) && kc >= ct);
      if (!subsumed) kept.push([tok, ct]);
    }
    return kept;
  };

  const cnSorted = sortAndDedup([...freq.entries()].filter(([t]) => /^[一-龥]+$/.test(t)));
  const enSorted = sortAndDedup([...freq.entries()].filter(([t]) => /^[a-z]/i.test(t)));

  const pick = [];
  if (cnSorted[0]) pick.push(cnSorted[0][0]);
  if (enSorted[0]) pick.push(enSorted[0][0]);
  if (pick.length < 2) {
    const pool = pick[0] && /^[一-龥]/.test(pick[0]) ? cnSorted : enSorted;
    if (pool[1] && !pick.includes(pool[1][0])) pick.push(pool[1][0]);
  }
  return pick.filter(Boolean).join(' ') || null;
}

// ============================================
// 第五部分 · 通用状态机
// ============================================

function evaluateLifecycleState(state, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const now = Date.now();
  const cur = state.currentStruggle;

  if (cur) {
    const lifecycleType = cur.lifecycleType || 'struggle';
    const config = LIFECYCLE_CONFIGS[lifecycleType];
    if (!config) {
      // 不识别的 type · 当作 struggle 兼容
      state.currentStruggle = { ...cur, lifecycleType: 'struggle' };
      return evaluateLifecycleState(state, opts);
    }

    if (cur.resolved) {
      return { transition: 'none', lifecycleType };
    }

    const recent = scanClaudeRecent({ minutesBack: 30, cwd });
    if (config.canExit(recent)) {
      return { transition: 'resolve', lifecycleType, recent };
    }
    const lastSignalAt = cur.signals && cur.signals.length > 0
      ? cur.signals[cur.signals.length - 1].at
      : cur.startedAt;
    if (now - lastSignalAt > config.abandonTimeoutMs) {
      return { transition: 'abandon', lifecycleType };
    }
    return { transition: 'continue', lifecycleType, recent };
  }

  if (state.struggleOptOutUntil && state.struggleOptOutUntil > now) {
    return { transition: 'none' };
  }
  const recent = scanClaudeRecent({ minutesBack: 30, cwd });
  for (const type of LIFECYCLE_PRIORITY) {
    const config = LIFECYCLE_CONFIGS[type];
    if (config.canEnter(recent)) {
      const id = type + '-' + new Date(now).toISOString().slice(0, 16).replace(/[-T:]/g, '');
      return {
        transition: 'enter',
        lifecycleType: type,
        pendingSituation: {
          id,
          lifecycleType: type,
          startedAt: now,
          topic: null,
          signals: recent.userMessages.slice(-5)
            .filter(m => config.matchSignal(m.text))
            .map(m => ({
              at: m.ts,
              type: type === 'struggle' ? 'claude_fail' : 'claude_explore',
              text: m.text.slice(0, 200),
            })),
          resolved: false,
          consented: false,
        },
      };
    }
  }
  return { transition: 'none' };
}

// ============================================
// 第六部分 · Dossier 持久化
// ============================================

function saveDossier(situation) {
  try {
    fs.mkdirSync(STRUGGLES_DIR, { recursive: true });
    const file = path.join(STRUGGLES_DIR, situation.id + '.json');
    fs.writeFileSync(file, JSON.stringify(situation, null, 2));
  } catch {}
}

function loadDossier(id) {
  try {
    const file = path.join(STRUGGLES_DIR, id + '.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch { return null; }
}

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

function appendSignal(situation, signal) {
  if (!situation || !signal) return situation;
  situation.signals = situation.signals || [];
  situation.signals.push({ at: Date.now(), ...signal });
  saveDossier(situation);
  return situation;
}

// ============================================
// 第七部分 · 公开 API
// ============================================

module.exports = {
  CONFIG_DIR,
  STRUGGLES_DIR,
  // 历史兼容信号词
  FAIL_SIGNS: STRUGGLE_FAIL,
  CRACK_SIGNS: STRUGGLE_CRACK,
  STRUGGLE_FAIL,
  STRUGGLE_CRACK,
  LEARNING_EXPLORE,
  LEARNING_UNDERSTAND,
  DESIGN_EXPLORE,
  DESIGN_DECIDE,
  // 框架配置
  LIFECYCLE_CONFIGS,
  LIFECYCLE_PRIORITY,
  // 工具
  scanClaudeRecent,
  inferTopic,
  // 状态机
  evaluateLifecycleState,
  evaluateStruggleState: evaluateLifecycleState,  // 兼容旧 API 名
  // dossier
  saveDossier,
  loadDossier,
  listDossiers,
  cleanOldDossiers,
  appendSignal,
};

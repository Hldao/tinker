#!/usr/bin/env node
/**
 * tinker — 在 coding 时一句话发布到捣鼓
 *
 * 命令:
 *   tinker login                       # 配置 server URL + handle + (可选) LLM
 *   tinker config                      # 看当前配置
 *   tinker projects | ls               # 列我的活跃项目
 *
 *   tinker push                        # 交互式 · 选项目 · 写一句 · 推
 *   tinker push -m "..."               # 直接推一条
 *   tinker push --since 1h             # 抓最近 1 小时 git 历史作为建议
 *   tinker push --auto                 # LLM 自动生成内容并推 (无交互)
 *   tinker push --since 1h --auto      # LLM 总结 1 小时进展并推
 *
 *   tinker draft                       # 用 LLM 生成一句建议 (默认 1h history)
 *   tinker draft --since 30m           # 自定义时间窗
 *
 *   tinker hook install                # 装 git post-commit hook
 *   tinker hook uninstall              # 卸 hook
 *
 * --since 支持: 30m / 2h / 1d / today / yesterday / 任意 git 能理解的格式
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

const CONFIG_DIR = path.join(os.homedir(), '.tinker');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
// v0.12 踩坑全周期状态机 · lazy 加载避免影响主 CLI 启动速度
let _struggleModule;
function getStruggleModule() {
  if (!_struggleModule) _struggleModule = require('../lib/struggle');
  return _struggleModule;
}

// =============================================
// 工具 — 颜色 / log
// =============================================
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', vermilion: '\x1b[38;5;166m',
  moss: '\x1b[38;5;28m', sepia: '\x1b[38;5;243m',
};
function log(s) { process.stdout.write(s + '\n'); }
function dim(s) { return C.dim + s + C.reset; }
function bold(s) { return C.bold + s + C.reset; }
function vermilion(s) { return C.vermilion + s + C.reset; }
function moss(s) { return C.moss + s + C.reset; }
function sepia(s) { return C.sepia + s + C.reset; }
function err(s) { process.stderr.write(C.red + '✗ ' + s + C.reset + '\n'); }
function ok(s) { log(moss('✓ ') + s); }

// JSON 模式输出 helper · 给 AI agent 用 · 错误也走 JSON 走 stdout + exit 1
// 所有 --json 命令统一用这两个 · 不要走 log/err 文本输出
function outputJson(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function errJson(msg, code, extra) {
  const out = { ok: false, error: msg, code: code || 'ERROR' };
  if (extra) Object.assign(out, extra);
  outputJson(out);
  process.exit(1);
}

// =============================================
// Config
// =============================================
function loadConfig() {
  // 优先级:env var > config 文件 · 让 AI agent / CI / 远程跑都能用
  // TINKER_TOKEN / TINKER_SERVER / TINKER_HANDLE 三个 env 都支持
  let cfg = null;
  if (fs.existsSync(CONFIG_FILE)) {
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch (e) {}
  }
  if (process.env.TINKER_TOKEN || process.env.TINKER_SERVER || process.env.TINKER_HANDLE) {
    cfg = cfg || {};
    if (process.env.TINKER_TOKEN) cfg.token = process.env.TINKER_TOKEN;
    if (process.env.TINKER_SERVER) cfg.serverUrl = process.env.TINKER_SERVER.replace(/\/$/, '');
    if (process.env.TINKER_HANDLE) cfg.handle = process.env.TINKER_HANDLE;
    if (!cfg.serverUrl) cfg.serverUrl = DEFAULT_SERVER_URL;
  }
  return cfg;
}
function saveConfig(cfg) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
// 默认 / 兜底 server URL (alpha 期生产 IP) · 旧 config 的 ngrok 地址会失效 · 这是 fallback
const DEFAULT_SERVER_URL = 'http://120.26.46.217:8788';

function mustHaveConfig(opts) {
  const requireToken = !opts || opts.requireToken !== false;
  const cfg = loadConfig();
  if (!cfg) {
    err('还没配置 · 跑 ' + vermilion('tinker login'));
    process.exit(1);
  }
  if (requireToken && !cfg.token) {
    err('config 是老版的 · 没有钥匙(token)');
    log(sepia('  原因:v0.1 alpha 时代用 handle 信任登录 · 现在改 Bearer token · 不兼容'));
    log(sepia('  解法:'));
    log(sepia('    1. 浏览器到 ') + vermilion(DEFAULT_SERVER_URL + '/#/w/<你的 handle>'));
    log(sepia('    2. 在工作室 tagline 旁点 "CLI 钥匙" · 生成一把(只显示一次 · 复制下来)'));
    log(sepia('    3. 跑 ' + vermilion('tinker login') + ' · 粘上钥匙'));
    process.exit(1);
  }
  if (cfg.serverUrl && /ngrok/.test(cfg.serverUrl)) {
    log(sepia('  ⚠ config 里的 server 还是 ngrok 临时地址 · 大概率已经死了 · 跑 ') + vermilion('tinker login') + sepia(' 会换成新的'));
  }
  return cfg;
}

// =============================================
// API client
// =============================================
function authHeaders(cfg) {
  if (!cfg.token) return { 'Content-Type': 'application/json' };
  return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.token };
}

// 统一 fetch 包装 · 把 404/401/403/网络错误翻成 actionable 中文提示
async function safeFetch(cfg, path, init) {
  let res;
  try {
    res = await fetch(cfg.serverUrl + path, init);
  } catch (e) {
    throw new Error('连不上 server (' + cfg.serverUrl + ') · 网络不通或地址变了 · 跑 `tinker login` 重新配 server + 钥匙');
  }
  if (!res.ok) {
    // 看响应体 · 但 404 时 server 可能返 HTML
    let bodyErr = '';
    try {
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('json')) {
        const data = await res.json();
        bodyErr = data.error || '';
      }
    } catch (e) { /* swallow */ }
    if (res.status === 404) {
      throw new Error('404 · server 找不到这个接口 · 可能 config 里 server 地址旧了 · 跑 `tinker login` 重新配');
    }
    if (res.status === 401) {
      throw new Error('401 · 钥匙过期或不对 · 跑 `tinker login` 重新粘一把新的');
    }
    if (res.status === 403) {
      throw new Error('403 · 这把钥匙没权限做这件事 (比如 API token 不能管理 token)');
    }
    if (res.status === 429) {
      throw new Error('429 · 请求太频繁 · 等 1 分钟再试');
    }
    throw new Error('server ' + res.status + ' · ' + (bodyErr || '(没具体错误信息)'));
  }
  return res;
}

async function apiState(cfg) {
  const res = await safeFetch(cfg, '/api/state', { headers: authHeaders(cfg) });
  return res.json();
}
async function apiMe(cfg) {
  const res = await safeFetch(cfg, '/api/auth/me', { headers: authHeaders(cfg) });
  return res.json();
}
async function apiAction(cfg, type, payload) {
  const res = await safeFetch(cfg, '/api/action', {
    method: 'POST',
    headers: authHeaders(cfg),
    body: JSON.stringify({ type, payload }),
  });
  return res.json();
}

// =============================================
// Git helpers
// =============================================
function inGitRepo() {
  try { execSync('git rev-parse --git-dir', { stdio: 'ignore' }); return true; }
  catch (e) { return false; }
}
function gitOneCommit() {
  if (!inGitRepo()) return '';
  try {
    return execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
  } catch (e) { return ''; }
}
function parseSinceForGit(spec) {
  if (!spec) return '1 hour ago';
  const s = spec.trim();
  let m;
  if ((m = s.match(/^(\d+)m$/))) return `${m[1]} minutes ago`;
  if ((m = s.match(/^(\d+)h$/))) return `${m[1]} hours ago`;
  if ((m = s.match(/^(\d+)d$/))) return `${m[1]} days ago`;
  if (s === 'today') return 'midnight';
  if (s === 'yesterday') return '24 hours ago';
  return s; // git 能理解的其他格式
}
function gitHistorySince(spec) {
  if (!inGitRepo()) return null;
  const gitSince = parseSinceForGit(spec);
  try {
    const log = execSync(
      `git log --since="${gitSince}" --pretty=format:"%h %s" --no-merges`,
      { encoding: 'utf-8' }
    ).trim();
    const stat = execSync(
      `git log --since="${gitSince}" --shortstat --pretty=format:"" --no-merges`,
      { encoding: 'utf-8' }
    ).trim();
    // 当前未 commit 的 changes summary
    let pendingStat = '';
    try {
      pendingStat = execSync('git diff --shortstat', { encoding: 'utf-8' }).trim();
    } catch (e) {}
    return { log, stat, pendingStat, since: gitSince };
  } catch (e) { return null; }
}

// =============================================
// LLM
// =============================================
// 默认 Tinker 工艺人日志 voice · 用户可以在项目里 .tinker/voice.md 覆盖
const DEFAULT_VOICE = `Tinker(中文名:捣鼓)是给 vibe coder 的工作室社区,进展 voice 是工匠的工作日志,不是 release note,不是 changelog,不是产品发布会。

最重要的反直觉:不要总结所有事。挑一个具体的转向或具体的发现讲清楚就够。

==================
对作者自己写 vs 对 LLM 代写 · 这条规则有两种走法
==================
- 作者自己写:挑心里咯噔一下的事讲,把那一刻的想法说清楚。
- LLM 代写:只在 commit / git history 里能找到具体转向锚点时才讲转向。
  如果作者没说怎么想,你 (LLM) 不要硬猜情绪。
  不要编"咯噔""卡得厉害""突然意识到""服气""纠结"这种内心活动。
  没锚点时,退一步:只描述实际发生的事,加一句可复用的 takeaway,不编情绪。

字数:控制在 150 到 280 字之间。宁可少,不要长。

==================
一个真实的好例子(模仿这种节奏):
==================
没怎么写代码,但产品改了不少。

把"动静"和"陈列馆"合成一个屏了,叫"工坊"。陈列馆的进门规矩也松了,你写了一笔进展,作品就自动在那儿。

不过更关键的转向,是想明白 Tinker 真正值钱的是命令行,不是网页。

我们用 AI 做东西的人,大部分时间在终端里。最值得记的那个想法常常是 commit 完那十几秒冒出来的,等我打开网页那股劲就过了。所以给命令行加了一个能力:commit 完它自己判断要不要问你一笔。

规矩定死:永远是"要不要"不是命令,不打分,不告诉别人你卡了,觉得烦随时关。

接下来想接 AI 帮起草。

为什么这是好例子:开头一句话状态总览,然后一个具体改动,然后一个"咯噔一下"的转向,接着把这个转向讲清楚,结尾一句话规矩或下一步。有节奏,有反思,有边界感。

==================
一个坏例子(避免这种)
==================
把触发机制跑通了一版 v0.2,5 处优化收尾。卡在 "捣鼓" 歧义上——试了只匹配动词形,避开产品名误触;又试了把词升格成 BRAND_MENTION 品牌信号才稳住。接着扩了触发器组合:BREAKTHROUGH / TINKER / DISCOVERY 加上 FRUSTRATED 破防。UI 那边同步推了 v0.68。

为什么这是坏例子:版本号当锚点、ALL_CAPS 代码标识符当名词、em-dash、罗列动作没反思、读起来像 PM 周报。

==================
硬性禁用清单(违反一条就重来):
==================
1. 不要用 ALL_CAPS 英文标识符当中文名词。代码里叫 BRAND_MENTION,中文写"品牌信号"或就用具体说什么的话。
2. 不要在正文里堆版本号(v0.62 / v0.63 这种)。一条 update 里出现 1 次以上版本号就太多了。
3. 不要用中圆点(·)做句中分隔。用逗号、顿号、句号。
4. 不要用 em-dash(——、—)。中文写作里几乎不用这个。
5. 不要"第一...第二...接着...同时..."这种枚举结构。改用自然过渡:"不过""然后"。
6. 不要"feature add""bug fix""完成了 X 模块""推了一版"这种 changelog 词。
7. 不写"今天/最近/这段时间"开头。平台显示时间,作者不重复。
8. 不写"很有意思""值得记""有意义"这种自我评价。读者自己感受。
9. 不要 markdown 块级元素(# 标题 / - 列表 / > 引用)。inline 的 **粗体** 和 \`代码\` 可以。
10. LLM 代写时,不写"咯噔""服气""卡得厉害""突然意识到""纠结"这种作者内心活动。git history 里没写就不许编。作者自己写时这条不限制。
11. 不写"Tinker 真正值钱的是命令行""主战场转向 X""用户根本不是 Y 是 Z"这种立场宣告。除非作者明确说过,LLM 不允许替作者下产品方向定论。

==================
鼓励的写法
==================
- 短句优先,普通句号断开
- 第一句话给个状态概览("没怎么写代码,但..." / "改了一下 X" / "加了一个东西")
- 选一个最值得说的事讲透,不是全部 commit 列一遍
- "为什么"比"做了什么"重要
- 实事求是。git 没说的别替作者编
- 末尾留一句 takeaway 或可复用的小判断,不强求,但有的话其他人 (或其他 AI) 看了能学到东西
  例:"AI 没作者视角,让它替你想会走偏,让它替你整理可以"
  例:"这种决策几个月后想不起来当时为什么这么做,要写下来"
  例:"卡住可以发,只要还在试就行"

==================
实事求是规则(最重要 · 你做不到就直接返回 candidates 空数组)
==================
- 只写 git history 里真正发生的事,commit message 里没写的别瞎编
- 别替作者捏造情绪("卡了一晚上""试了三次")
- 别凭空说时间("一个月前""半年前")
- 提团队/朋友时不确定性别用名字带过

最严重的捏造类型(绝对不要写):
1. "结果发现 / 实际跑下来 / 我观察到" 这种事后反思 — 你只看到了 commit,不知道后续真实发生了什么
2. "agent 比真人 X / 这种模式很常见" 这种凭空数据论断 — 你没有数据
3. "可复用的 takeaway / 可以总结为 / 这告诉我们" 这种 consultant 收尾 — LLM 偷懒填补结尾的常见模板,真人写日志不会这样收
4. "出乎意料 / 没想到" — 你不知道作者预期是什么
5. 把作者没在 commit message 里说的设计原因当成既定事实写出来

作者能写的反思只有这三种:
- 设计意图("我加了 X 是想让 Y 更容易")
- 当前判断("我觉得这个方向是对的,因为...")
- 下一步打算("接下来想做 Z")

不能写的伪反思:
- 事后效果观察(没数据)
- 用户反应(没跟真用户聊过)
- 跟其他产品对比(LLM 不知道竞品)`;

const DRAFT_PROMPT_TEMPLATE = `${'$'}{voice}

${'$'}{fingerprint}

${'$'}{goodSamples}

${'$'}{rejectSamples}

==================
任务
==================
看下面的 git 历史和当前未 commit 改动,挑一个最值得说的角度,起草一条进展。

注意:
- 只起草 1 条,不是 1-3 条。LLM 写多了反而都平庸。
- 这一条要符合上面所有规则,尤其是字数(150-280 字)和硬性禁用清单。
- 如果上面给了 fingerprint / 真实样本,优先 mimic 那种节奏和语言习惯,而不是单纯按规则避雷。
- 如果 git 全是 typo / 格式调整 / 自动 lint / 没真实信号,返回 { "candidates": [] }。
- 写完之前自检一遍:有没有 ALL_CAPS 标识符?有没有版本号?有没有中圆点(·)?有没有 em-dash?有没有"接着...然后..."?有的话重写。

输出严格 JSON(只输出 JSON 本体,不要 markdown 代码块):
{
  "candidates": [
    { "text": "...", "rationale": "一句话说为什么挑这个角度,不会发布" }
  ]
}

==================
Git 时间窗:${'$'}{since}

Git commits:
${'$'}{history}

${'$'}{pending}`;

function loadVoice() {
  // 在当前 cwd 往上找 .tinker/voice.md
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    const f = path.join(dir, '.tinker', 'voice.md');
    if (fs.existsSync(f)) {
      try { return fs.readFileSync(f, 'utf-8').trim(); } catch (e) {}
    }
    dir = path.dirname(dir);
  }
  return DEFAULT_VOICE;
}

// v0.4 Phase 3 · 读 .tinker/voice-fingerprint.md (cmdVoiceAnalyze 生成的)
// 没有就返回空串 · 不强求 (alpha 期 pool 薄时 fingerprint 不存在很正常)
function loadFingerprint() {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    const f = path.join(dir, '.tinker', 'voice-fingerprint.md');
    if (fs.existsSync(f)) {
      try {
        const raw = fs.readFileSync(f, 'utf-8').trim();
        if (!raw) return '';
        return `==================
voice fingerprint · 作者真实风格画像 (优先 mimic 这个 · 比 voice 硬规则准)
==================
${raw}`;
      } catch {}
    }
    dir = path.dirname(dir);
  }
  return '';
}

// v0.4 Phase 3 · 从 ~/.tinker/style-pool/good/ 抽 N 篇最近的 good sample
// 默认 3 篇 · 不够就有几篇用几篇 · 完全没就返回空串
function loadGoodSamples(n = 3) {
  const dir = path.join(CONFIG_DIR, 'style-pool', 'good');
  if (!fs.existsSync(dir)) return '';
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse();
  } catch { return ''; }
  if (files.length === 0) return '';
  const picked = files.slice(0, n);
  const texts = picked.map(f => {
    const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
    const m = raw.match(/---\s*\n[\s\S]*?\n---\s*\n([\s\S]+)$/);
    return m ? m[1].trim() : raw.trim();
  }).filter(Boolean);
  if (texts.length === 0) return '';
  const joined = texts.map((t, i) => `### 真实样本 ${i + 1}\n${t}`).join('\n\n');
  return `==================
作者最近发过的 ${texts.length} 篇真实 update (学这种节奏 / 句法 / 词汇)
==================
${joined}`;
}

// v0.4 Phase 4 · 读 ~/.tinker/style-pool/reject-diff/*.json (LLM 草稿被作者改的 case)
// 给 LLM 看 "AI 起草版" vs "作者改后版" 的对比 · 学怎么避免类似错
function loadRejectSamples(n = 2) {
  const dir = path.join(CONFIG_DIR, 'style-pool', 'reject-diff');
  if (!fs.existsSync(dir)) return '';
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
  } catch { return ''; }
  if (files.length === 0) return '';
  const picked = files.slice(0, n);
  const diffs = picked.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch { return null; }
  }).filter(Boolean);
  if (diffs.length === 0) return '';
  const joined = diffs.map((d, i) => `### 改稿 ${i + 1}
[AI 起草版]
${d.llmDraft || ''}

[作者改后版]
${d.finalText || ''}`).join('\n\n');
  return `==================
AI 起草过的草稿 · 作者改成下面这样了 (避免起草版那种 tell · 学改后版怎么写)
==================
${joined}`;
}

async function llmDraft(cfg, gitContext) {
  if (!cfg.llm || !cfg.llm.apiKey) {
    throw new Error('LLM 没配置 · 重新跑 ' + vermilion('tinker login') + ' 配一下');
  }
  const provider = cfg.llm.provider || 'anthropic';
  const apiKey = cfg.llm.apiKey;
  const history = gitContext.log || '(没有 commit)';
  const pending = gitContext.pendingStat
    ? `当前未 commit 的改动:\n${gitContext.pendingStat}` : '';
  const voice = loadVoice();
  // v0.4 Phase 3 · 加 fingerprint + few-shot 真实样本 + 改稿对比
  // 三个都有就全用 · 空就跳过 (DEFAULT_VOICE 保底)
  const fingerprint = loadFingerprint();
  const goodSamples = loadGoodSamples(3);
  const rejectSamples = loadRejectSamples(2);
  const prompt = DRAFT_PROMPT_TEMPLATE
    .replaceAll('${voice}', voice)
    .replaceAll('${fingerprint}', fingerprint)
    .replaceAll('${goodSamples}', goodSamples)
    .replaceAll('${rejectSamples}', rejectSamples)
    .replaceAll('${since}', gitContext.since)
    .replaceAll('${history}', history)
    .replaceAll('${pending}', pending);

  let rawText;
  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.llm.model || 'claude-sonnet-4-5-20250929',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || 'Anthropic API ' + res.status);
    rawText = data.content[0].text.trim();
    recordLLMUsage(provider, data.usage && (data.usage.input_tokens + data.usage.output_tokens), 'draft');
  } else if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.llm.model || 'gpt-4o-mini',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || 'OpenAI API ' + res.status);
    rawText = data.choices[0].message.content.trim();
    recordLLMUsage(provider, data.usage && data.usage.total_tokens, 'draft');
  } else if (provider === 'deepseek') {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.llm.model || 'deepseek-chat',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || 'DeepSeek API ' + res.status);
    rawText = data.choices[0].message.content.trim();
    recordLLMUsage(provider, data.usage && data.usage.total_tokens, 'draft');
  } else {
    throw new Error('不支持的 LLM provider: ' + provider);
  }

  // 容错:有时 LLM 会用 ```json 包起来 · 剥掉
  rawText = rawText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  let parsed;
  try { parsed = JSON.parse(rawText); }
  catch (e) {
    throw new Error('LLM 返回的不是合法 JSON:\n' + rawText.slice(0, 200));
  }
  if (!parsed.candidates || !Array.isArray(parsed.candidates)) {
    throw new Error('LLM 返回结构不对 · 应该有 candidates 数组');
  }
  return parsed.candidates;
}

// v0.64 · prompt 流程里用的简版 · 拿单条草稿当 input 默认值
// 没配 LLM / 调用失败 都返回 null · 调用方走原本的空 input 路径
// 默认时间窗 1 小时 · UI session 时传 session 起始时间更精准
//
// validate / 重写循环:
// 1. LLM 起草 · sanitize 一遍
// 2. 跑 validateDraft 检测"伪数据论断"(用户没收集过的)
// 3. 有违规就让 LLM 重写一次 · 把违规句指给它
// 4. 重写还有违规 → 返 null · 用户手敲 (宁可没草稿也不放伪论断进 update)
async function llmQuickDraft(cfg, opts = {}) {
  if (!cfg || !cfg.llm || !cfg.llm.apiKey) return null;
  try {
    const sinceSpec = opts.sinceMinutes ? `${opts.sinceMinutes}m` : '1h';
    const gitCtx = gitHistorySince(sinceSpec);
    if (!gitCtx || !gitCtx.log) return null;

    const candidates = await llmDraft(cfg, gitCtx);
    if (!candidates || candidates.length === 0) return null;
    let draft = sanitizeDraft(candidates[0].text || null);
    if (!draft) return null;

    // Round 1 检测
    const violations = validateDraft(draft);
    if (violations.length === 0) return draft;

    // Round 2 · 让 LLM 拿着违规重写一次
    const reworked = await llmRework(cfg, gitCtx, draft, violations);
    if (!reworked) return null;
    const reworkedClean = sanitizeDraft(reworked);
    if (!reworkedClean) return null;
    const reworkViolations = validateDraft(reworkedClean);
    if (reworkViolations.length > 0) return null; // 还是违规 · 放弃
    return reworkedClean;
  } catch (e) {
    return null;  // 静默失败 · 不打断 prompt 流程
  }
}

// 用 LLM 重写一次 · 指明违规给它 · 让它拿走那几句
async function llmRework(cfg, gitCtx, badDraft, violations) {
  if (!cfg.llm || !cfg.llm.apiKey) return null;
  const provider = cfg.llm.provider || 'anthropic';
  const apiKey = cfg.llm.apiKey;
  const prompt = `你刚才写的草稿里有"伪数据论断"——作者没收集过这种数据 · 你凭空编了。

你的草稿:
"""
${badDraft}
"""

检测到的违规:
${violations.map(v => '- ' + v).join('\n')}

重写一次 · 拿走违规那几句 · 保留其他能讲清设计意图的部分。
如果拿走后剩下的太少 / 没意思 · 直接返回 { "candidates": [] }。

输出严格 JSON:
{ "candidates": [ { "text": "...", "rationale": "..." } ] }`;

  try {
    let rawText;
    if (provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.llm.model || 'claude-sonnet-4-5-20250929', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!r.ok) return null;
      const d = await r.json();
      rawText = d.content[0].text.trim();
    } else if (provider === 'deepseek') {
      const r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.llm.model || 'deepseek-chat', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!r.ok) return null;
      const d = await r.json();
      rawText = d.choices[0].message.content.trim();
    } else if (provider === 'openai') {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.llm.model || 'gpt-4o-mini', max_tokens: 1500, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
      });
      if (!r.ok) return null;
      const d = await r.json();
      rawText = d.choices[0].message.content.trim();
    } else return null;

    rawText = rawText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(rawText);
    if (!parsed.candidates || parsed.candidates.length === 0) return null;
    return parsed.candidates[0].text || null;
  } catch { return null; }
}

// 检测草稿里的"伪数据论断" · 返违规清单
// 设计:这些 pattern 100% 需要数据才能说 · git 里没数据 = LLM 在编
// v2 修正了两处假阳性:
//   - "比之前" "比过去" 是合理设计观察 · 不挡
//   - 单独 % 是合理进度数 (完成度 70% 之类) · 不挡 · 只挡靠近效果性动词的
function validateDraft(text) {
  if (!text) return [];
  const violations = [];

  // 用户反应类 (没问过用户)
  if (/用户\s*(更|不)?\s*(喜欢|偏好|反映|说|觉得|想要|认为)/.test(text)) {
    violations.push('"用户喜欢/反映/觉得 X" — 没问过用户');
  }

  // 跟"真人 / 人工 / 手动" 做对比类 · 这三个真的需要 benchmark
  // 把"之前 / 过去 / 普通 / 原来" 去掉 · 那些是合理设计观察 ("比之前简化了")
  if (/(比|超过|远胜|低于|高于|不如)\s*(真人|人工|手动)/.test(text)) {
    violations.push('"X 比 Y 好/差" 对比 — 没 benchmark');
  }

  // 跑下来 / 测下来 / 对比下来 (隐含实验)
  if (/(实际|真实|真)\s*(跑|测|对比|跟|看)\s*(下来|过|完)/.test(text)) {
    violations.push('"实际跑/测下来" — 没数据');
  }

  // 命中率 / 准确率 这类必须有数字的
  if (/(成功率|准确率|命中率|转化率|留存率|完成率|响应率)/.test(text)) {
    violations.push('"成功率/准确率" — 没指标');
  }

  // 效果性数字 · 只挡靠近评估动词的 %
  // 命中条件:前 8 字 / 后 8 字内有效果词 · 单独的 "完成度 70%" 不挡
  const EFFECT_WORDS = '快|慢|提升|降低|减少|增加|多|少|增长|下降|上升';
  const effectPctRe = new RegExp(`(${EFFECT_WORDS})\\s*了?\\s*\\d+\\s*%|\\d+\\s*%\\s*(${EFFECT_WORDS})`, 'g');
  if (effectPctRe.test(text)) {
    violations.push('"X 了 Y%" — 效果论断没 benchmark');
  }
  // 单独 % 不再挡 · "完成度 70%" / "10% 改了 a 文件" 之类是合理的

  // 结果发现 / 出乎意料 / 数据显示 (经典 LLM 收尾)
  if (/结果发现|出乎意料|数据显示|意外发现/.test(text)) {
    violations.push('"结果发现/出乎意料/数据显示" — 这种事后观察 LLM 不该写');
  }

  return violations;
}

// === LLM token 用量记录 (给 tinker goodnight / config 用) ===
const LLM_USAGE_FILE = path.join(CONFIG_DIR, 'llm-usage.json');
function recordLLMUsage(provider, tokens, kind) {
  if (!tokens) return;
  try {
    let history = [];
    try { history = JSON.parse(fs.readFileSync(LLM_USAGE_FILE, 'utf-8')); } catch {}
    if (!Array.isArray(history)) history = [];
    history.push({ at: Date.now(), provider, tokens, kind: kind || 'unknown' });
    // 只保留最近 1000 条 · 防止文件越来越大
    if (history.length > 1000) history = history.slice(-1000);
    fs.writeFileSync(LLM_USAGE_FILE, JSON.stringify(history, null, 2));
  } catch {}
}
function getTodayLLMUsage() {
  try {
    const history = JSON.parse(fs.readFileSync(LLM_USAGE_FILE, 'utf-8'));
    if (!Array.isArray(history)) return [];
    const tk = todayKey();
    return history.filter(h => {
      const d = new Date(h.at);
      return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') === tk;
    });
  } catch { return []; }
}

// 草稿后处理 · 抹掉最常见的 LLM tell
// 设计原则:只动那些 99% 是 AI 写作 tell 的东西 (em-dash · 堆中圆点 · "今天" 开头)
// 不动正常的中文标点 · 不擅自重写句子
function sanitizeDraft(text) {
  if (!text) return null;
  let t = text.trim();

  // em-dash 几乎全是 AI tell · 转成逗号
  t = t.replace(/——+/g, '，');
  t = t.replace(/[­‐‑‒–—―]+/g, '，');

  // 句中堆 · 的兜底:正文里超过 2 次 · 间隔分隔的全换成逗号
  const midDotCount = (t.match(/(?<=[^\s])·(?=[^\s])/g) || []).length;
  if (midDotCount > 2) {
    t = t.replace(/(?<=[^\s])·(?=[^\s])/g, '，');
  }

  // "今天 / 最近 / 这段时间" 开头是 LLM 戒不掉的习惯 · 平台已显示时间 · 直接砍
  // 砍掉之后首字母不强求大写 · 中文不需要
  t = t.replace(/^\s*(今天|最近|这段时间|这几天|昨天|这两天)\s*[，,。\s]+\s*/, '');

  // 多个连续标点折叠
  t = t.replace(/，{2,}/g, '，');
  t = t.replace(/。{2,}/g, '。');

  // trim 末尾的标点
  t = t.replace(/[，、；]\s*$/, '。');

  return t.trim();
}

// =============================================
// commands
// =============================================
async function cmdLogin() {
  const { input, select, password } = require('@inquirer/prompts');
  log(vermilion('\n  tinker login') + sepia('   · 一次性配置'));
  log(sepia('  ━━━━━━━━━━━━━━━━━━━━━━━'));
  const serverUrl = await input({
    message: 'server URL',
    default: 'http://120.26.46.217:8788',
  });
  log('');
  log(sepia('  到 ' + vermilion(serverUrl.replace(/\/$/, '') + '/#/w/<你的handle>') + sepia(' · 点 "CLI 钥匙" 生成一把')));
  log(sepia('  钥匙以 ' + vermilion('tk_') + sepia(' 开头 · 只显示一次 · 错过就重新生成') + '\n'));
  const token = await password({
    message: '粘贴钥匙(以 tk_ 开头)',
    validate: (v) => /^tk_/.test(v.trim()) || '钥匙应该以 tk_ 开头',
  });
  const cfg = { serverUrl: serverUrl.replace(/\/$/, ''), token: token.trim() };
  // 校验:用这把钥匙读一下 /me · 看是谁
  log(sepia('  ' + dim('验证钥匙...')));
  try {
    const me = await apiMe(cfg);
    if (!me) throw new Error('钥匙没认到任何账号');
    cfg.handle = me.handle;
    cfg.userId = me.id;
    ok('认到了 — ' + bold('@' + me.handle));
  } catch (e) {
    err('钥匙无效:' + (e.message || ''));
    process.exit(1);
  }

  // 可选: LLM
  const wantLLM = await select({
    message: '配置 LLM? (用于 tinker draft)',
    choices: [
      { name: '先不配 · 之后再说', value: false },
      { name: '配一下', value: true },
    ],
    default: false,
  });

  if (wantLLM) {
    const provider = await select({
      message: 'LLM provider',
      choices: [
        { name: 'Anthropic Claude (推荐 · 跟产品哲学一致)', value: 'anthropic' },
        { name: 'OpenAI GPT', value: 'openai' },
        { name: 'DeepSeek (国内友好)', value: 'deepseek' },
      ],
      default: 'anthropic',
    });
    const apiKey = await password({
      message: 'LLM API key',
      validate: (v) => v.trim().length > 0 || '不能空',
    });
    cfg.llm = { provider, apiKey: apiKey.trim() };
  }

  saveConfig(cfg);
  ok('配置保存到 ' + sepia(CONFIG_FILE));
  log(dim('  下一步: ') + vermilion('tinker draft') + sepia(' 起草 · ') + vermilion('tinker push <draft.md>') + sepia(' 发布'));
}

async function cmdConfig(opts = {}) {
  const cfg = loadConfig();
  if (opts.json) {
    if (!cfg) { errJson('还没配置 · 先跑 tinker login', 'NO_CONFIG'); return; }
    outputJson({
      ok: true,
      serverUrl: cfg.serverUrl,
      handle: cfg.handle || null,
      tokenSet: !!cfg.token,
      tokenSuffix: cfg.token ? cfg.token.slice(-4) : null,
      llm: cfg.llm ? { provider: cfg.llm.provider, configured: true } : { configured: false },
      configFile: CONFIG_FILE,
    });
    return;
  }
  if (!cfg) { err('还没配置 · 先跑 ' + vermilion('tinker login')); process.exit(1); }
  log(sepia('\n  current config:'));
  log('    server     ' + bold(cfg.serverUrl));
  log('    handle     ' + bold('@' + (cfg.handle || '(未知 · 没填)')));
  log('    token      ' + (cfg.token ? bold('tk_…' + cfg.token.slice(-4)) : sepia('(未配置)')));
  if (cfg.llm) {
    log('    llm        ' + bold(cfg.llm.provider) + sepia(' (key: ****' + cfg.llm.apiKey.slice(-4) + ')'));
  } else {
    log('    llm        ' + sepia('(未配置)'));
  }
  log(sepia('    file       ' + CONFIG_FILE));
  // 警告区
  const warnings = [];
  if (!cfg.token) warnings.push('钥匙没配 · v0.1 alpha 时代的旧 config · 跑 ' + vermilion('tinker login') + sepia(' 配新钥匙'));
  if (cfg.serverUrl && /ngrok/.test(cfg.serverUrl)) warnings.push('server 还是 ngrok 临时地址 · 大概率已经死了 · 跑 ' + vermilion('tinker login') + sepia(' 换成生产地址'));
  if (warnings.length > 0) {
    log('');
    log(sepia('  ⚠ 注意:'));
    warnings.forEach(w => log(sepia('    · ' + w)));
  }
  log('');
}

async function cmdProjects(opts = {}) {
  const cfg = mustHaveConfig();
  const state = await apiState(cfg);
  const me = cfg.handle;
  const mine = state.projects.filter(p => p.owner === me);

  if (opts.json) {
    outputJson({
      ok: true,
      handle: me,
      projects: mine.map(p => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        desc: p.desc,
        status: p.status,
        productLink: p.productLink || null,
        updateCount: (p.updates || []).length,
        lastUpdateAt: p.updates && p.updates[0] ? p.updates[0].at : null,
        shippedAt: p.shippedAt || null,
        hiddenFromShowcase: !!p.hiddenFromShowcase,
        url: cfg.serverUrl + '/#/p/' + me + '/' + p.slug,
      })),
    });
    return;
  }

  if (mine.length === 0) {
    log(sepia('\n  你还没有项目 · 去 ' + cfg.serverUrl + ' 开张工作室\n'));
    return;
  }
  log('');
  mine.forEach(p => {
    const status = p.status === 'active' ? moss('● 在做')
                 : p.status === 'stuck' ? vermilion('● 卡住')
                 : p.status === 'done' ? moss('✓ 跑通了')
                 : sepia('● ' + p.status);
    log('  ' + bold(p.name) + '  ' + status);
    log('  ' + sepia(p.desc));
    log('  ' + sepia('  id: ' + p.id + ' · ' + p.updates.length + ' 条进展\n'));
  });
}

async function cmdDraft(opts) {
  const cfg = mustHaveConfig();
  const since = opts.since || '1h';
  if (!inGitRepo()) {
    err('不在 git 仓库 · draft 需要 git 历史作为上下文');
    process.exit(1);
  }
  const history = gitHistorySince(since);
  if (!history || (!history.log && !history.pendingStat)) {
    err('git 历史是空的 · 这段时间没 commit 也没改动');
    process.exit(1);
  }
  log(sepia('\n  分析 git 历史 (since ' + history.since + ')...'));
  if (history.log) log(sepia('  ' + history.log.split('\n').slice(0, 5).join('\n  ')));
  if (history.pendingStat) log(sepia('  pending: ' + history.pendingStat));
  log('');
  log(sepia('  起草中(走 ' + (cfg.llm?.provider || 'anthropic') + ')...'));
  let candidates;
  try {
    candidates = await llmDraft(cfg, history);
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
  if (candidates.length === 0) {
    log('');
    log(sepia('  这段时间 LLM 觉得没什么值得发的。等下次有真东西再来。'));
    log('');
    return;
  }

  // 写到 .tinker/drafts/YYYY-MM-DD-HHMM.md
  const draftsDir = path.join(process.cwd(), '.tinker', 'drafts');
  if (!fs.existsSync(draftsDir)) fs.mkdirSync(draftsDir, { recursive: true });
  const now = new Date();
  const stamp = now.getFullYear() + '-' +
    String(now.getMonth()+1).padStart(2,'0') + '-' +
    String(now.getDate()).padStart(2,'0') + '-' +
    String(now.getHours()).padStart(2,'0') +
    String(now.getMinutes()).padStart(2,'0');
  const draftFile = path.join(draftsDir, stamp + '.md');

  // v0.4 bug 修复:cmdDraft 之前漏调 sanitize · LLM 的 em-dash 等 tell 没被清掉
  candidates.forEach(c => { if (c && c.text) c.text = sanitizeDraft(c.text); });
  const md = renderDraftMarkdown({
    candidates, since: history.since, commits: (history.log||'').split('\n').filter(Boolean).length, handle: cfg.handle,
  });
  fs.writeFileSync(draftFile, md);

  // v0.4 Phase 4 · 记最新 LLM 草稿 · 让 cmdResolve 跟用户改后版本比较 · 收集 reject-diff
  try {
    const lastDraft = {
      at: Date.now(),
      text: (candidates[0] && candidates[0].text) || '',
      projectId: null,  // 跨命令不一定知道 projectId · cmdResolve 凭 pending 判断
      since: history.since,
    };
    fs.writeFileSync(path.join(CONFIG_DIR, 'last-llm-draft.json'), JSON.stringify(lastDraft, null, 2));
  } catch {}

  log('');
  ok('起草了 ' + bold(candidates.length + '') + ' 条候选 → ' + sepia(path.relative(process.cwd(), draftFile)));
  log('');
  candidates.forEach((c, i) => {
    log(vermilion('  候选 ' + (i+1)));
    const preview = (c.text || '').replace(/\n/g,' ').slice(0, 80);
    log('    ' + preview + (c.text.length > 80 ? '…' : ''));
    log(sepia('    自评: ') + sepia(c.rationale || ''));
    log('');
  });
  log(sepia('  下一步:'));
  log(sepia('    1) 打开 ') + bold(path.relative(process.cwd(), draftFile)) + sepia(' · 删掉不想发的段落'));
  log(sepia('    2) ') + vermilion('tinker push ' + path.relative(process.cwd(), draftFile)));
  log('');
}

function renderDraftMarkdown({ candidates, since, commits, handle }) {
  const lines = [];
  lines.push('# Tinker 草稿 · @' + (handle || '') + ' · ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
  lines.push('');
  lines.push('— 时间窗 since `' + since + '` · 包含 ' + commits + ' 个 commit');
  lines.push('— 删掉不想发的整个候选段落(从 `## 候选 N` 到下一个 `---`)·然后跑 `tinker push <这个文件>`');
  lines.push('— 自评行 (以 `> 自评:` 开头) 不会被发到 Tinker · 是给你筛选用的');
  lines.push('');
  lines.push('---');
  lines.push('');
  candidates.forEach((c, i) => {
    lines.push('## 候选 ' + (i+1));
    lines.push('');
    lines.push((c.text || '').trim());
    lines.push('');
    lines.push('> 自评: ' + (c.rationale || ''));
    lines.push('');
    lines.push('---');
    lines.push('');
  });
  return lines.join('\n');
}

function parseDraftMarkdown(md) {
  // 切割 ## 候选 N 段 · 提取每段的 text(去掉自评行)
  const candidates = [];
  const sections = md.split(/^##\s+候选\s+\d+\s*$/m).slice(1);  // 第一个是 header 前的内容
  for (const sec of sections) {
    // 砍到 --- 之前 · 去掉 > 自评: 行
    const upToHr = sec.split(/^---\s*$/m)[0];
    const noEval = upToHr.replace(/^>\s*自评:.*$/gm, '').trim();
    if (noEval) candidates.push({ text: noEval });
  }
  return candidates;
}

async function cmdPush(opts) {
  const cfg = mustHaveConfig();

  // 如果传了文件路径 · 走"从草稿发"路径
  if (opts.draftFile) {
    return cmdPushFromDraft(cfg, opts);
  }

  const state = await apiState(cfg);
  const me = cfg.handle;
  const mine = state.projects.filter(p => p.owner === me && ['active', 'stuck'].includes(p.status));
  if (mine.length === 0) {
    err('你没有 active/stuck 的项目 · 去 ' + cfg.serverUrl + ' 开一个');
    process.exit(1);
  }

  // 选项目
  let projectId;
  if (opts.projectId) {
    projectId = opts.projectId;
  } else if (mine.length === 1) {
    projectId = mine[0].id;
    log(sepia('  自动选了唯一一个项目: ') + bold(mine[0].name));
  } else {
    const { select } = require('@inquirer/prompts');
    projectId = await select({
      message: '推到哪个项目?',
      choices: mine.map(p => ({
        name: p.name + sepia('  ' + p.desc.slice(0, 40)),
        value: p.id,
      })),
    });
  }

  let pushText = opts.text;
  if (!pushText) {
    const { input } = require('@inquirer/prompts');
    const suggestion = gitOneCommit();
    pushText = await input({ message: '一句进展', default: suggestion || undefined });
  }
  pushText = (pushText || '').trim();
  if (!pushText) { err('内容不能空'); process.exit(1); }

  // 推 · server 从 token 拿身份 · 不需要 currentUser
  // v0.11 idempotency: --idem-key X 时 · 同 key 24h 内重复调直接返缓存
  try {
    const result = await withIdempotency(opts.idemKey, async () => {
      const r = await apiAction(cfg, 'addUpdate', { projectId, text: pushText });
      recordPushAt(projectId);
      return r;
    });
    const p = mine.find(x => x.id === projectId);
    log('');
    if (result && result.cacheHit) {
      ok('已 push (幂等命中 · 同 key 之前发过)');
    } else {
      ok('记上了 — ' + bold(p.name));
    }
    log(sepia('  内容: ') + pushText);
    // v0.12: 用 server 返的 projectSlug + ownerHandle 拼项目页 URL
    // (webapp hash routing 不支持从 URL 传 anchor · 但项目页打开最新 update 就在顶)
    const slug = (result && result.projectSlug) || p.slug;
    const handle = (result && result.ownerHandle) || cfg.handle;
    if (slug && handle) {
      log(sepia('  去看: ') + cfg.serverUrl + '/#/p/' + handle + '/' + slug);
    } else {
      log(sepia('  去看: ') + cfg.serverUrl + '/');
    }
    if (result && result.id) {
      log(sepia('  update id: ') + result.id);
    }
    log('');
  } catch (e) { err(e.message); process.exit(1); }
}

// 从草稿文件发布 · tinker push <file> [--only=1,3]
async function cmdPushFromDraft(cfg, opts) {
  const file = opts.draftFile;
  if (!fs.existsSync(file)) { err('找不到草稿:' + file); process.exit(1); }
  const md = fs.readFileSync(file, 'utf-8');

  // v0.13 检测 autopsy 草稿 · 支持 experience / learning / decision 三种 productTag
  // autopsy 草稿是单一 markdown · 没 "## 候选 N" 切割 · 整篇当 text
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n+([\s\S]*)$/);
  let productTag = null;
  if (opts.asExperience) productTag = 'experience';
  else if (opts.asLearning) productTag = 'learning';
  else if (opts.asDecision) productTag = 'decision';
  else if (fmMatch) {
    if (/as_experience:\s*true/i.test(fmMatch[1])) productTag = 'experience';
    else if (/as_learning:\s*true/i.test(fmMatch[1])) productTag = 'learning';
    else if (/as_decision:\s*true/i.test(fmMatch[1])) productTag = 'decision';
  }
  if (productTag) {
    return cmdPushExperienceDraft(cfg, opts, fmMatch ? fmMatch[2].trim() : md.trim(), productTag);
  }

  const candidates = parseDraftMarkdown(md);
  if (candidates.length === 0) {
    err('草稿里没有候选(可能都被删了)');
    process.exit(1);
  }
  // 解析 --only=1,3
  let selected = candidates.map((_, i) => i);
  if (opts.only) {
    const want = new Set(opts.only.split(',').map(x => parseInt(x.trim(), 10) - 1));
    selected = selected.filter(i => want.has(i));
  }
  if (selected.length === 0) { err('--only 选了空集合 · 没东西可发'); process.exit(1); }

  log(sepia('\n  从草稿发布 · 选中 ' + selected.length + ' 条 / 共 ' + candidates.length + ' 条候选'));

  // 拿项目列表 · 让用户选
  const state = await apiState(cfg);
  const me = cfg.handle;
  const mine = state.projects.filter(p => p.owner === me && ['active', 'stuck'].includes(p.status));
  if (mine.length === 0) { err('你没有 active/stuck 的项目'); process.exit(1); }

  let projectId;
  if (opts.projectId) {
    projectId = opts.projectId;
  } else if (mine.length === 1) {
    projectId = mine[0].id;
    log(sepia('  自动选了唯一一个项目: ') + bold(mine[0].name));
  } else {
    const { select } = require('@inquirer/prompts');
    projectId = await select({
      message: '发到哪个项目?',
      choices: mine.map(p => ({
        name: p.name + sepia('  ' + p.desc.slice(0, 40)),
        value: p.id,
      })),
    });
  }

  // 确认
  const { confirm } = require('@inquirer/prompts');
  const p = mine.find(x => x.id === projectId);
  log('');
  selected.forEach(i => {
    log(vermilion('  候选 ' + (i+1)));
    const preview = candidates[i].text.replace(/\n/g, ' ').slice(0, 80);
    log('    ' + preview + (candidates[i].text.length > 80 ? '…' : ''));
  });
  log('');
  const yes = await confirm({ message: '发到「' + p.name + '」?', default: true });
  if (!yes) { log(sepia('  取消了')); return; }

  let posted = 0;
  for (const i of selected) {
    try {
      await apiAction(cfg, 'addUpdate', { projectId, text: candidates[i].text });
      recordPushAt(projectId);
      posted++;
      log(moss('  ✓ ') + sepia('候选 ' + (i+1) + ' 发了'));
    } catch (e) {
      log(C.red + '  ✗ ' + C.reset + sepia('候选 ' + (i+1) + ' 失败: ' + e.message));
    }
  }
  log('');
  ok('发了 ' + bold(posted + '') + ' 条到 ' + bold(p.name));
  log(sepia('  去看: ') + cfg.serverUrl + '/');
  log('');
}

// v0.12 experience 草稿一键发 · 单 update + 自动 markAsExperience
// text 已经去掉 frontmatter · 用户在 confirm 前能预览
async function cmdPushExperienceDraft(cfg, opts, text, productTag = 'experience') {
  const PRODUCT_LABELS = { experience: '踩坑经验', learning: '上手指南', decision: '决策推演' };
  const ACTION_MAP = { experience: 'markAsExperience', learning: 'markAsLearning', decision: 'markAsDecision' };
  const CMD_MAP = { experience: 'tinker mark-experience', learning: 'tinker mark-learning', decision: 'tinker mark-decision' };
  const productLabel = PRODUCT_LABELS[productTag] || '踩坑经验';
  if (!text || text.length < 20) { err('草稿内容太短 · ' + productLabel + ' 池要求 ≥ 20 字'); process.exit(1); }
  const state = await apiState(cfg);
  const me = cfg.handle;
  const mine = state.projects.filter(p => p.owner === me && ['active', 'stuck'].includes(p.status));
  if (mine.length === 0) { err('你没有 active/stuck 的项目'); process.exit(1); }

  let projectId;
  if (opts.projectId) {
    projectId = opts.projectId;
  } else if (mine.length === 1) {
    projectId = mine[0].id;
    log(sepia('  自动选了唯一一个项目: ') + bold(mine[0].name));
  } else {
    const { select } = require('@inquirer/prompts');
    projectId = await select({
      message: '发到哪个项目?',
      choices: mine.map(p => ({
        name: p.name + sepia('  ' + p.desc.slice(0, 40)),
        value: p.id,
      })),
    });
  }
  const p = mine.find(x => x.id === projectId);

  // 预览 + 确认 (除非 --yes)
  log('');
  log(sepia('  ' + productLabel + '草稿预览 (前 10 行):'));
  log(sepia('  ─────────'));
  text.split('\n').slice(0, 10).forEach(line => log('  ' + line));
  log(sepia('  ─────────'));
  log('');
  if (!opts.yes) {
    const { confirm } = require('@inquirer/prompts');
    const yes = await confirm({
      message: `发到「${p.name}」并标为${productLabel}?`,
      default: true,
    });
    if (!yes) { log(sepia('  取消了')); return; }
  }

  // 发 + 自动 mark · v0.13 phase 2 完整版
  try {
    const res = await apiAction(cfg, 'addUpdate', { projectId, text });
    recordPushAt(projectId);
    const updateId = res && (res.id || (res.result && res.result.id));
    if (updateId) {
      const markAction = ACTION_MAP[productTag] || 'markAsExperience';
      const manualCmd = CMD_MAP[productTag] || 'tinker mark-experience';
      try {
        await apiAction(cfg, markAction, { updateId });
      } catch (e) {
        log(sepia('  ⚠ mark ' + productTag + ' 失败: ' + e.message + ' · 手动跑 ') + vermilion(`${manualCmd} ${updateId}`));
      }
    }
    log('');
    ok('发了 + 标为' + productLabel + ' — ' + bold(p.name));
    if (updateId) log(sepia('  update id: ') + updateId);
    const slug = (res && res.projectSlug) || p.slug;
    const handle = (res && res.ownerHandle) || cfg.handle;
    if (slug && handle) {
      log(sepia('  去看: ') + cfg.serverUrl + '/#/p/' + handle + '/' + slug);
    }
    log('');
  } catch (e) { err(e.message); process.exit(1); }
}

// 标记项目卡住 + 记一条 "卡在 X" · 触发 server A4 通知 wantToTry + tinkered 用户
async function cmdStuck(opts) {
  const cfg = mustHaveConfig();
  const state = await apiState(cfg);
  const me = cfg.handle;
  // 卡住命令只对 active 项目有意义 (stuck 项目再 stuck 没意义 · done/archive 也不该用 stuck)
  const mine = state.projects.filter(p => p.owner === me && p.status === 'active');
  if (mine.length === 0) {
    err('你没有 active 的项目可以标卡住 · 去 ' + cfg.serverUrl + ' 看看');
    process.exit(1);
  }

  // 选项目
  let projectId;
  if (opts.projectId) {
    projectId = opts.projectId;
  } else if (mine.length === 1) {
    projectId = mine[0].id;
    log(sepia('  自动选了唯一一个项目: ') + bold(mine[0].name));
  } else {
    const { select } = require('@inquirer/prompts');
    projectId = await select({
      message: '哪个项目卡住了?',
      choices: mine.map(p => ({
        name: p.name + sepia('  ' + p.desc.slice(0, 40)),
        value: p.id,
      })),
    });
  }

  // 决定卡住描述 (-m 给了 / 交互问)
  let stuckText = opts.text;
  if (!stuckText) {
    const { input } = require('@inquirer/prompts');
    stuckText = await input({
      message: '卡在哪? (一句话 · 越具体越容易被人接上)',
      default: undefined,
    });
  }
  stuckText = (stuckText || '').trim();
  if (!stuckText) { err('得说一下卡在哪 · 不然别人没法帮上忙'); process.exit(1); }

  // server 端要求 commit 文字本身没规定 prefix · 这里加 "卡在 " 让时间线读起来一致
  if (!stuckText.startsWith('卡')) stuckText = '卡在 ' + stuckText;

  const p = mine.find(x => x.id === projectId);

  // 两步操作 · 顺序: 先改 status (触发 A4 通知) · 再记 commit (出现在时间线)
  // server 从 Bearer token 拿身份 · 不需要 currentUser
  try {
    await apiAction(cfg, 'changeProjectStatus', { projectId, newStatus: 'stuck' });
    await apiAction(cfg, 'addUpdate', { projectId, text: stuckText });
    recordPushAt(projectId);
    log('');
    ok('标了卡住 — ' + bold(p.name));
    log(sepia('  写的是: ') + stuckText);
    const watcherCount = (p.reactions.wantToTry?.length || 0) + (p.reactions.tinkered?.length || 0);
    if (watcherCount > 0) {
      log(sepia('  通知了 ') + bold(watcherCount + '') + sepia(' 个想试试 / 延伸过你项目的人 · 也许能搭把手'));
    } else {
      log(sepia('  还没人想试试或延伸过 · 但写出来比闷着强'));
    }
    log(sepia('  去看: ') + cfg.serverUrl + '/');
    log('');
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
}

// 把本地图片转 base64 data URL,作为 ship images 的一员
function imageFromPath(filePath) {
  if (!fs.existsSync(filePath)) throw new Error('找不到图: ' + filePath);
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase() || 'png';
  const mime = ext === 'jpg' ? 'image/jpeg' : 'image/' + ext;
  return [{ src: 'data:' + mime + ';base64,' + buf.toString('base64'), caption: '' }];
}

// 调 microlink.io 抓 URL 截图 → 下载 → 转 base64 data URL
// 免费 50 次/天, 不需要 API key, 16:9 viewport 跟陈列馆 figure 匹配
// 参数取舍:
// - viewport 1280x720 (16:9 桌面) · deviceScaleFactor=2 → 高清 retina
// - waitUntil=networkidle0 · 等到没有网络请求才截 (SPA 必备)
// - waitForTimeout=2500 · 多等 2.5s 让懒加载图片 / 字体 / 入场动画落地
// - JPEG quality 85 · 文件大小 / 清晰度的甜蜜点
async function screenshotUrl(url) {
  const params = new URLSearchParams({
    url,
    screenshot: 'true',
    type: 'jpeg',
    'viewport.width': '1280',
    'viewport.height': '720',
    'viewport.deviceScaleFactor': '2',
    waitUntil: 'networkidle0',
    waitForTimeout: '2500',
    'screenshot.quality': '85',
    meta: 'false',
  });
  const api = 'https://api.microlink.io/?' + params.toString();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000); // 45s 超时 (deviceScale=2 + wait 更长 · 多留余地)
  let json;
  try {
    const res = await fetch(api, { signal: ctl.signal });
    if (!res.ok) throw new Error('microlink ' + res.status);
    json = await res.json();
  } finally { clearTimeout(timer); }
  // 关键检查:目标页面本身的 HTTP 状态(microlink 会忠实截下 404 / 403 错误页 → 一片空白)
  const upstreamStatus = json && json.data && json.data.statusCode;
  if (upstreamStatus && upstreamStatus >= 400) {
    throw new Error('productLink 返回 ' + upstreamStatus + ',八成是死链或私有页');
  }
  const shotUrl = json && json.data && json.data.screenshot && json.data.screenshot.url;
  if (!shotUrl) throw new Error('microlink 没返回截图 URL');
  const imgRes = await fetch(shotUrl);
  if (!imgRes.ok) throw new Error('下载截图 ' + imgRes.status);
  const arrBuf = await imgRes.arrayBuffer();
  const sizeKB = Math.round(arrBuf.byteLength / 1024);
  // 过小的截图通常是错误页或空白,< 4KB 直接拒绝
  if (sizeKB < 4) {
    throw new Error('截图只有 ' + sizeKB + 'KB,基本是空白页');
  }
  const base64 = Buffer.from(arrBuf).toString('base64');
  return { images: [{ src: 'data:image/jpeg;base64,' + base64, caption: '自动抓的首页截图' }], sizeKB };
}

async function cmdShip(opts) {
  const cfg = mustHaveConfig();
  const state = await apiState(cfg);
  const me = cfg.handle;
  // 完工只对当前不是 done 的项目有意义
  const mine = state.projects.filter(p => p.owner === me && p.status !== 'done' && p.status !== 'archive');
  if (mine.length === 0) {
    err('你没有可以完工的项目 (都已 done 或 archive 了),去 ' + cfg.serverUrl + ' 看看');
    process.exit(1);
  }

  let projectId;
  if (opts.projectId) {
    projectId = opts.projectId;
  } else if (mine.length === 1) {
    projectId = mine[0].id;
    log(sepia('  自动选了唯一一个项目: ') + bold(mine[0].name));
  } else {
    const { select } = require('@inquirer/prompts');
    projectId = await select({
      message: '哪个项目完工了?',
      choices: mine.map(p => ({
        name: p.name + sepia('  ' + p.desc.slice(0, 40)),
        value: p.id,
      })),
    });
  }

  let reflection = opts.text;
  if (!reflection) {
    const { input } = require('@inquirer/prompts');
    reflection = await input({
      message: '写一句完工感想 (会进时间线,也进陈列馆代表这件作品)',
      default: undefined,
    });
  }
  reflection = (reflection || '').trim();
  if (!reflection) { err('完工感想不能空,说一句也行'); process.exit(1); }

  // --feedback-ask "..." 启用求反馈 + 写问题,--no-feedback 关求反馈
  let seekingFeedback = true;
  let feedbackAsk = '';
  if (opts.noFeedback) seekingFeedback = false;
  if (opts.feedbackAsk) feedbackAsk = opts.feedbackAsk;

  const p = mine.find(x => x.id === projectId);

  // 决定 images:
  //   --image <path>  : 用本地图(优先)
  //   --no-screenshot : 不带图
  //   默认            : microlink 抓 productLink 截图当封面
  let images;
  let coverNote = '';
  if (opts.image) {
    try {
      images = imageFromPath(opts.image);
      coverNote = '本地图 ' + opts.image;
    } catch (e) {
      log(sepia('  ⚠ ') + e.message + sepia(',这次不带图发'));
    }
  } else if (!opts.noScreenshot && p.productLink) {
    log(sepia('  抓首页截图 ') + dim('(microlink.io,如果失败也会继续 ship)') + '...');
    try {
      const r = await screenshotUrl(p.productLink);
      images = r.images;
      coverNote = '首页截图 ' + r.sizeKB + 'KB';
    } catch (e) {
      log(sepia('  ⚠ 截图失败:') + e.message + sepia(',这次不带图发'));
    }
  }

  try {
    await apiAction(cfg, 'shipProject', { projectId, reflection, seekingFeedback, feedbackAsk, images });
    recordPushAt(projectId);
    const wt = (p.reactions && p.reactions.wantToTry) ? p.reactions.wantToTry.length : 0;
    log('');
    ok(vermilion('✦ 完工 ') + '— ' + bold(p.name));
    log(sepia('  感想: ') + reflection.slice(0, 80) + (reflection.length > 80 ? '…' : ''));
    if (coverNote) log(sepia('  封面: ') + coverNote);
    if (seekingFeedback) log(sepia('  求反馈: ') + (feedbackAsk || '勾上了,没填具体问题'));
    if (wt > 0) log(sepia('  已通知 ') + bold(wt + '') + sepia(' 个想试试的人'));
    log(sepia('  陈列馆: ') + cfg.serverUrl + '/#/showcase');
    log('');
  } catch (e) { err(e.message); process.exit(1); }
}

// 一键更新到 git 最新版 · 适用于按"装 CLI 一键命令"那条进展装的人
// 装的时候 git clone 到 ~/.tinker-src · update 就是 pull + 重新 npm install -g
const SRC_DIR = path.join(os.homedir(), '.tinker-src');

// === 版本检测 · 不强求更新 · 只在背景里查一下并提示 ===
const UPDATE_CACHE_FILE = path.join(CONFIG_DIR, 'update-status.json');
const GITHUB_REPO = 'Hldao/tinker';

// 拿本地 CLI 源码的 git SHA · 不存在(直接 npm 安装)返 null
function getInstalledSha() {
  try {
    if (fs.existsSync(path.join(SRC_DIR, '.git'))) {
      return execSync('git rev-parse HEAD', { cwd: SRC_DIR, encoding: 'utf-8' }).trim();
    }
  } catch {}
  return null;
}

// 从 GitHub 拉最新 main commit · 计算 behindBy (本地落后多少 commit)
async function fetchRemoteStatus() {
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/commits/main`, {
      headers: { 'User-Agent': 'tinker-cli', 'Accept': 'application/vnd.github+json' },
    });
    if (!r.ok) return null;
    const data = await r.json();
    const latestSha = data.sha;
    const latestMsg = (data.commit && data.commit.message || '').split('\n')[0];
    const latestDate = data.commit && data.commit.author && data.commit.author.date;

    const installedSha = getInstalledSha();
    let behindBy = 0;
    if (installedSha && installedSha !== latestSha) {
      // GitHub compare API · 算 ahead_by (从我方到 latest 多少 commit)
      const cr = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/compare/${installedSha}...${latestSha}`, {
        headers: { 'User-Agent': 'tinker-cli', 'Accept': 'application/vnd.github+json' },
      });
      if (cr.ok) {
        const cd = await cr.json();
        behindBy = cd.ahead_by || 0;
      }
    }
    return { checkedAt: Date.now(), latestSha, latestMsg, latestDate, installedSha, behindBy };
  } catch {
    return null;
  }
}

// 后台异步刷新 cache · fire and forget
function spawnUpdateCheckAsync() {
  try {
    const { spawn } = require('child_process');
    const child = spawn(process.argv[0], [process.argv[1], 'update', '--check-only'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {}
}

// 从 cache 读 update 状态 · 在合适时机 (≥ 5 commit 落后 或 ≥ 7 天没更新) 显示提示
function showUpdateBannerIfNeeded() {
  let cache;
  try { cache = JSON.parse(fs.readFileSync(UPDATE_CACHE_FILE, 'utf-8')); } catch { return; }
  if (!cache.behindBy || cache.behindBy < 1) return;
  // 显示阈值: 落后 5+ commit · 或 落后 7+ 天 (latestDate 比 checkedAt 早就是稳定状态 · 不算)
  const daysOld = cache.latestDate ? Math.floor((Date.now() - new Date(cache.latestDate).getTime()) / 86400000) : 0;
  const shouldShow = cache.behindBy >= 5 || daysOld >= 7;
  if (!shouldShow) return;

  log('');
  log(sepia('  ── ') + vermilion('CLI 有更新') + sepia(' ──'));
  log(sepia('  落后 ') + bold(cache.behindBy + ' 个 commit') + sepia(' · 最新: ') + sepia(cache.latestMsg.slice(0, 50)));
  log(sepia('  跑 ') + vermilion('tinker update') + sepia(' 升级 · 不急'));
  log('');
}

async function cmdUpdate(opts = {}) {
  // --check-only · 只刷新 update cache · 不真的升级 (后台 spawn 用)
  if (opts.checkOnly) {
    // cache TTL 24h · 在 TTL 内直接退 · 不打 GitHub API
    try {
      const cache = JSON.parse(fs.readFileSync(UPDATE_CACHE_FILE, 'utf-8'));
      if (Date.now() - cache.checkedAt < 24 * 60 * 60 * 1000) return;
    } catch {}
    const status = await fetchRemoteStatus();
    if (status) {
      try {
        if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
        fs.writeFileSync(UPDATE_CACHE_FILE, JSON.stringify(status, null, 2));
      } catch {}
    }
    return;
  }
  return cmdUpdateReal();
}

async function cmdUpdateReal() {
  log('');
  if (!fs.existsSync(SRC_DIR)) {
    err('找不到 ' + sepia(SRC_DIR) + err('  这意味着你不是按官方一键命令装的'));
    log('');
    log(sepia('  如果你忘了当时怎么装的,可以重新跑一遍一键命令清装:'));
    log('  ' + vermilion('git clone https://github.com/Hldao/tinker.git ~/.tinker-src && npm install -g ~/.tinker-src/cli'));
    log('');
    process.exit(1);
  }

  log(sepia('  拉最新代码 (git pull)...'));
  let pullOut;
  try {
    pullOut = execSync('git pull --ff-only', { cwd: SRC_DIR, encoding: 'utf-8' });
  } catch (e) {
    err('git pull 失败:' + (e.message || ''));
    log(sepia('  可能是网络问题,或者本地修改了文件 · 自己 cd 进 ' + SRC_DIR + ' 看看'));
    process.exit(1);
  }

  if (pullOut.includes('Already up to date')) {
    log(moss('  ✓ 已经是最新的 · 不用重装'));
    log('');
    return;
  }
  log(sepia('  ' + pullOut.split('\n').slice(0, 4).join('\n  ')));

  log(sepia('  重装 CLI (npm install -g)...'));
  try {
    execSync('npm install -g ' + path.join(SRC_DIR, 'cli'), { stdio: 'inherit' });
  } catch (e) {
    err('npm install 失败');
    log(sepia('  如果是权限问题,可能要 sudo · 或者改 npm prefix 到 ~/.npm-global'));
    process.exit(1);
  }

  log('');
  ok('CLI 升级完成');
  // 最近几条更新内容(粗略)
  try {
    const recent = execSync('git log --since="7 days ago" --pretty=format:"  %s" -n 8 cli/', { cwd: SRC_DIR, encoding: 'utf-8' }).trim();
    if (recent) {
      log(sepia('  最近 CLI 的几个改动:'));
      log(sepia(recent));
    }
  } catch (e) {}
  log('');
  log(sepia('  跑 ') + vermilion('tinker help') + sepia(' 看看新命令'));
  log('');
}

// =============================================
// v0.63 PROACTIVE PROMPT 框架
// post-commit hook 装上之后 · 每次 commit 自动跑 tinker check
// check 评估触发器 · 满足条件才出 prompt · 否则安静退出
// 默认全 opt-in · 不打分 · 不推送给别人 · 不烦人
// =============================================

const PROMPT_STATE_FILE = path.join(CONFIG_DIR, 'prompt-state.json');
const HOOK_BEGIN = '# >>> tinker-hook-v2 >>>';
const HOOK_END = '# <<< tinker-hook-v2 <<<';
const HOOK_BLOCK = `${HOOK_BEGIN}
# 装/改/卸: tinker hook install | uninstall
command -v tinker >/dev/null 2>&1 && tinker check --from-hook || true
${HOOK_END}
`;

function loadPromptState() {
  try {
    if (!fs.existsSync(PROMPT_STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(PROMPT_STATE_FILE, 'utf-8'));
  } catch { return {}; }
}
function savePromptState(s) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(PROMPT_STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) { /* 容错 · 失败不影响 */ }
}
function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

// 记录最近一次 push 到 Tinker 的时间 (按项目) · 给触发器 C "长时间未发" 用
function recordPushAt(projectId) {
  if (!projectId) return;
  const state = loadPromptState();
  state.lastPushAtByProject = state.lastPushAtByProject || {};
  state.lastPushAtByProject[projectId] = Date.now();
  savePromptState(state);
}

function loadRepoConfig() {
  // 项目级 config · 告诉 check 这个 repo 关联哪个 Tinker 项目
  const f = path.join(process.cwd(), '.tinker', 'repo.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return null; }
}
function saveRepoConfig(obj) {
  const dir = path.join(process.cwd(), '.tinker');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'repo.json'), JSON.stringify(obj, null, 2));
}

async function cmdHookInstall() {
  if (!inGitRepo()) { err('不在 git 仓库'); process.exit(1); }
  const cfg = mustHaveConfig();

  // 先让用户选 · 这个 repo 关联哪个 Tinker 项目
  let repoCfg = loadRepoConfig();
  if (!repoCfg) {
    const state = await apiState(cfg);
    const mine = state.projects.filter(p => p.owner === cfg.handle);
    if (mine.length === 0) {
      err('你在 Tinker 上还没项目 · 先去 ' + cfg.serverUrl + ' 开张');
      process.exit(1);
    }
    const { select } = require('@inquirer/prompts');
    const projectId = mine.length === 1 ? mine[0].id : await select({
      message: '这个 git 仓库对应哪个 Tinker 项目?',
      choices: mine.map(p => ({ name: p.name + sepia('  ' + (p.desc||'').slice(0, 40)), value: p.id })),
    });
    const picked = mine.find(p => p.id === projectId);
    repoCfg = { projectId, projectName: picked.name, installedAt: Date.now() };
    saveRepoConfig(repoCfg);
    ok('记下了 · 这个 repo = ' + bold(picked.name));
  }

  // 记到 ~/.tinker/repos.json · 给 drift 检测用 (扫所有注册的 repo 算今日活动分布)
  registerRepoForDrift(process.cwd(), repoCfg);

  // 装 hook · 不暴力覆盖 · 用 marker 块附加 · 兼容用户已有 hook
  const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf-8' }).trim();
  const hookFile = path.join(gitDir, 'hooks', 'post-commit');
  let content = '';
  if (fs.existsSync(hookFile)) {
    content = fs.readFileSync(hookFile, 'utf-8');
    // 移除旧 marker 块 (重装)
    content = content.replace(new RegExp(HOOK_BEGIN + '[\\s\\S]*?' + HOOK_END + '\\n?', 'g'), '');
    content = content.replace(/^\s*#\s*tinker post-commit hook[\s\S]*?(?=\n#|\n[a-zA-Z]|$)/m, '');
  } else {
    content = '#!/bin/sh\n';
  }
  content = content.trimEnd() + '\n\n' + HOOK_BLOCK;
  fs.writeFileSync(hookFile, content);
  fs.chmodSync(hookFile, 0o755);

  ok('hook 装好了 · 触发器是: ' + sepia('60 分钟内累 3+ commit'));
  log('');
  log(sepia('  默认: 静默 · 满足触发条件才会出来问'));
  log(sepia('  关:    ') + vermilion('tinker hook uninstall'));
  log(sepia('  静音: ') + vermilion('tinker mute 1h') + sepia(' / ') + vermilion('tinker mute today'));
}

// v0.13 装 Claude Code SessionStart compact hook
// 当用户跑 /compact · Claude Code 触发 SessionStart 事件 (matcher: compact)
// 我们的 hook 跑 tinker situation backfill --type design-loop --hours 4 --quiet
// 后台起草草稿到 .tinker/drafts/ · 用户在新 session 第一眼能看到
async function cmdClaudeHookInstall(opts = {}) {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch (e) {
      err('~/.claude/settings.json 解析失败:' + e.message + ' · 手动修一下再来');
      process.exit(1);
    }
  } else {
    // .claude 目录已经存在 (用户用 Claude Code 必然有) · 但 settings.json 可能没建
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  }

  settings.hooks = settings.hooks || {};
  settings.hooks.SessionStart = settings.hooks.SessionStart || [];

  // 检测是否已有 compact matcher · 避免重复装
  const existingIdx = settings.hooks.SessionStart.findIndex(h => h && h.matcher === 'compact');
  // 命令:每个 lifecycle 都试一遍 (design-loop 优先 · 不命中再 learning · 都不命中静默退)
  // 用 || true 让 hook 失败不影响 Claude Code 新 session 启动
  const cmd = 'tinker situation backfill --type design-loop --hours 4 --quiet 2>/dev/null || tinker situation backfill --type learning --hours 4 --quiet 2>/dev/null || true';
  const newHook = {
    matcher: 'compact',
    hooks: [{ type: 'command', command: cmd }],
  };

  if (existingIdx >= 0) {
    // 已有 compact matcher · 看是不是我们自己的 (含 tinker situation backfill 字串)
    const cur = settings.hooks.SessionStart[existingIdx];
    const isOurs = cur.hooks && cur.hooks.some(h => h.command && h.command.includes('tinker situation'));
    if (isOurs) {
      settings.hooks.SessionStart[existingIdx] = newHook;
      log(sepia('  已存在 Tinker compact hook · 更新一下'));
    } else {
      // 别人的 hook · 我们附加进 hooks 数组而不是覆盖
      cur.hooks = cur.hooks || [];
      cur.hooks.push({ type: 'command', command: cmd });
      log(sepia('  已有别的 compact hook · 我们附加进去 · 不覆盖'));
    }
  } else {
    settings.hooks.SessionStart.push(newHook);
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  log('');
  ok('Claude Code compact hook 装好了');
  log(sepia('  下次跑 /compact · Tinker 会自动:'));
  log(sepia('    1. 扫这段对话的过去 4 小时'));
  log(sepia('    2. 推断是 design-loop 还是 learning'));
  log(sepia('    3. LLM 起草工作日志气质的草稿'));
  log(sepia('    4. 写到 .tinker/drafts/'));
  log(sepia('  你在新 session 第一眼就能看见草稿路径'));
  log('');
  log(sepia('  关:    ') + vermilion('tinker hook uninstall-claude'));
}

function cmdClaudeHookUninstall() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) { log(sepia('  没装 · 直接退')); return; }
  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); }
  catch { err('settings.json 解析失败 · 手动看一下'); process.exit(1); }

  const before = JSON.stringify(settings);
  const list = (settings.hooks && settings.hooks.SessionStart) || [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].matcher !== 'compact') continue;
    list[i].hooks = (list[i].hooks || []).filter(h => !(h.command || '').includes('tinker situation'));
    if (list[i].hooks.length === 0) list.splice(i, 1);
  }

  if (JSON.stringify(settings) === before) {
    log(sepia('  没找到 Tinker compact hook · 没动'));
    return;
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  ok('Claude Code compact hook 删了');
}

function cmdHookUninstall() {
  if (!inGitRepo()) { err('不在 git 仓库'); process.exit(1); }
  const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf-8' }).trim();
  const hookFile = path.join(gitDir, 'hooks', 'post-commit');
  if (!fs.existsSync(hookFile)) { log(sepia('  没装 hook · 直接退')); return; }
  let content = fs.readFileSync(hookFile, 'utf-8');
  const before = content;
  content = content.replace(new RegExp(HOOK_BEGIN + '[\\s\\S]*?' + HOOK_END + '\\n?', 'g'), '');
  // 老版本兜底 (v1 暴力 hook)
  content = content.replace(/^.*tinker post-commit hook[\s\S]*?esac\s*\n/m, '');
  content = content.trimEnd();
  if (content === before.trimEnd()) {
    log(sepia('  没找到 tinker 的 hook 块 · 别人的 hook 不动'));
    return;
  }
  if (content === '#!/bin/sh' || content === '') {
    fs.unlinkSync(hookFile);
  } else {
    fs.writeFileSync(hookFile, content + '\n');
  }
  ok('hook 移除了');
}

// === 触发器评估 ===
// 每个返回 { fired, priority, msg }; priority 大的优先 (高信号触发器盖低信号)
// 优先级表:
//   B keyword 100  · "我刚说我跑通了" 是最强信号
//   D first   60  · 早安式 · 不可错过
//   C silence 50  · 累了 commit 但没 push · 提醒
//   A cumul   30  · 默认 background · 防止整天不知不觉

// A · 60 min 内累积 commit 数 >= 阈值
function triggerCumulativeCommits(opts = {}, state) {
  // v0.2 #6: 一天只触发一次低优先级 · 防 first-commit / silence / cumulative 互相撞车
  if (state && state.lowFiredTodayKey === todayKey()) return { fired: false };
  const windowMin = opts.windowMin || 60;
  const threshold = opts.threshold || 3;
  try {
    const out = execSync(
      `git log --since="${windowMin} minutes ago" --no-merges --pretty=format:"%h"`,
      { encoding: 'utf-8' }
    ).trim();
    const count = out ? out.split('\n').length : 0;
    if (count >= threshold) {
      return { fired: true, priority: 30, count, reason: 'cumulative', msg: `今天累了 ${count} 个 commit (近 ${windowMin} 分钟)` };
    }
    return { fired: false };
  } catch { return { fired: false }; }
}

// B · 最近一条 commit 标题 (第一行) 含关键词 · 高信号
// 只看标题不看 body · body 里提到关键词 (比如"about 页讲的是卡住") 不算作者卡住
// 优先级:
//   FRUSTRATED 95 · 炸毛 / 破防 · 文案和选项跟其他都不一样
//   BREAKTHROUGH 95 · 顿悟时刻 · 最值得记
//   SHIP/STUCK/PROTOTYPE 100 · 显式仪式信号
//   FIX 80 · 修好了 · 说说这个坑
//   TINKER 70 · 在捣鼓 · 一句话说一下
//   DISCOVERY 70 · 学到 / 发现
function triggerKeywordMatch() {
  try {
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    if (!title) return { fired: false };
    // v0.2 #4: 加 commit body 第一行扫描 · 捕获"为什么这么改"的信号
    let bodyFirstLine = '';
    try {
      const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
      bodyFirstLine = (body.split('\n')[0] || '').trim();
    } catch {}
    const scanText = title + (bodyFirstLine ? '\n' + bodyFirstLine : '');
    const titleSnippet = '"' + title.slice(0, 50) + '"';

    // 检查顺序很重要 · 同时命中时早的先返回 · 跟 priority 不是一个概念
    // 排序逻辑:
    //   FRUSTRATED 第一 · 情绪信号最优先 · v0.2 priority 95 → 101 · 真的最高
    //   SHIP / STUCK / PROTOTYPE · 显式仪式词 · 信号最直接 priority 100
    //   BREAKTHROUGH · "终于明白" 不含跑通 · 没被 SHIP 吃掉才到这 95
    //   DECISION · v0.2 新加 · 工具链选型 priority 85 · 比 fix 长期价值高
    //   FIX / TINKER / DISCOVERY · 弱信号最后

    // FRUSTRATED (炸毛 / 破防) · 文案 / 选项跟其他都不一样 · v0.2 priority 101 真的最高
    const FRUSTRATED_WORDS = /(\bfuck(?:ing|in')?\b|\bshit\b|\bdamn\b|\bwtf\b|\bhell\b|\bf+k\b|我操|卧槽|妈的|尼玛|\btmd\b|\btm\b|靠|崩了|炸了|废了|服了|醉了|无语|算了|弃了|不做了|不想做了|给爷整不会|不会了|不行了|\bgive up\b|\bdone with\b|\bover it\b|\bfed up\b|我傻|我蠢|智障|脑残|\bsb\b|我有病|累死|烦死|头大|头疼)/i;
    if (FRUSTRATED_WORDS.test(scanText)) {
      return { fired: true, priority: 101, reason: 'keyword-frustrated', kind: 'frustrated', msg: `气头上的 commit: ${dim(titleSnippet)}`, suggestion: '不打分。不告诉别人。看你想怎么处理。' };
    }

    // SHIP (仪式信号 · 完工) · 优先级 100 · 同时命中时盖过 BREAKTHROUGH
    const SHIP_WORDS = /(\bship(?:ped|s|it)?\b|\bdone\b|\bmerged?\b|\bdeployed?\b|\breleased?\b|\blaunch(?:ed)?\b|\brolled out\b|完工|跑通|发布|上线|上架|完成|\bfinished?\b)/i;
    if (SHIP_WORDS.test(scanText)) {
      return { fired: true, priority: 100, reason: 'keyword-ship', kind: 'ship', msg: `像完工的 commit: ${dim(titleSnippet)}`, suggestion: '要不要进陈列馆 · 写一句感想' };
    }

    // STUCK (技术性卡住 · 不像 FRUSTRATED 那么情绪化)
    const STUCK_WORDS = /(\bstuck\b|卡住|卡了|卡在|\bhotfix\b|\bbroken\b|挂了|不对劲|出问题|报错了|\bblocker\b)/i;
    if (STUCK_WORDS.test(scanText)) {
      return { fired: true, priority: 100, reason: 'keyword-stuck', kind: 'stuck', msg: `像卡住的 commit: ${dim(titleSnippet)}`, suggestion: '要不要标卡住 · 让在意的人看到' };
    }

    // PROTOTYPE
    const PROTO_WORDS = /(\bprototype\b|原型|\bmockup\b|\bdemo\b)/i;
    if (PROTO_WORDS.test(scanText)) {
      return { fired: true, priority: 100, reason: 'keyword-prototype', kind: 'prototype', msg: `像原型节点的 commit: ${dim(titleSnippet)}`, suggestion: '要不要把原型挂上 · 顺便发一笔' };
    }

    // BREAKTHROUGH · "终于明白 / 想清楚了" · 没被 SHIP 吃掉的顿悟时刻
    const BREAKTHROUGH_WORDS = /(终于(?:明白|搞清|搞定|想通|懂了)|搞清楚了|想清楚了|想通了|想明白了|顿悟|\baha\b|\bfinally\b(?!\s+(?:ship|done|done))|\bclicked\b|\bgot it\b)/i;
    if (BREAKTHROUGH_WORDS.test(scanText)) {
      return { fired: true, priority: 95, reason: 'keyword-breakthrough', kind: 'progress', msg: `像顿悟的 commit: ${dim(titleSnippet)}`, suggestion: '这种十秒钟很难复现 · 一笔留下来吧' };
    }

    // v0.2 #1 DECISION · 工具链选型 · 长期记得起来比 fix 重要
    // 关键词刻意精确: 必须是"动词性决策" · 不抓 npm install / pip install 这种日常依赖
    // 中文"装(了|上)" 是精确决策动词 · 英文用 adopt/migrate/switch to 等明确决策动词
    const DECISION_WORDS = /(\badopt(?:ed|ing)?\b|\bswitch(?:ed|ing)?\s+to\b|\bmov(?:e|ed|ing)\s+to\b|\bmigrat(?:e|ed|ing)\s+to\b|\bstop\s+using\b|\bdeprecat(?:e|ed|ing)\b|装(?:了|上)|装上|换成|改用|不再用|不用了|切到|切换到|引入(?:了)?|选了|定下来|决定用|采用|放弃(?:了)?|移除(?:了)?|去掉了|改回|降级|升级)/i;
    if (DECISION_WORDS.test(scanText)) {
      return { fired: true, priority: 85, reason: 'keyword-decision', kind: 'decision', msg: `像工具链决策的 commit: ${dim(titleSnippet)}`, suggestion: '这种决策几个月后自己都想不起为什么 · 记一笔吧' };
    }

    // FIX
    const FIX_WORDS = /(\bfix(?:ed|es|ing)?\b|\bpatch(?:ed)?\b|修好|修了|搞定|解决了|处理了)/i;
    if (FIX_WORDS.test(scanText)) {
      return { fired: true, priority: 80, reason: 'keyword-fix', kind: 'progress', msg: `修好的 commit: ${dim(titleSnippet)}`, suggestion: '要不要写一笔 · 说说这个坑' };
    }

    // BRAND_MENTION · "捣鼓" / "Tinker" 出现 = 品牌 engagement 信号
    // 设计:全世界除了 Tinker 社区谁会写"捣鼓" · 一旦出现就大概率关于我们:
    //   - 贡献者在改 Tinker 代码 (feat(捣鼓): ...)
    //   - 用户在用 Tinker 视角做事 ("捣鼓 X" 描述工作)
    //   - 引用 Tinker 文化 ("跟捣鼓上的 X 一样")
    // 所以不过滤 · 不只匹配动词形 · 任何"捣鼓"出现都触发 · prompt 主动认歧义
    // 优先级 75 比泛 TINKER 高一档 · 但低于 100 不抢仪式
    const BRAND_WORDS = /(捣鼓|\btinker\b)/i;
    if (BRAND_WORDS.test(scanText)) {
      return { fired: true, priority: 75, reason: 'keyword-brand', kind: 'brand', msg: `commit 里有"捣鼓": ${dim(titleSnippet)}`, suggestion: '这是关于 Tinker 的什么?' };
    }

    // TINKER (泛 · 在玩 · active exploration) · 不含"捣鼓"·已经被上一段抓走
    const TINKER_WORDS = /(玩了|玩玩|弄了|搞了|折腾|试了|试试|试了试|试一下|\bplay(?:ing|ed)?\b|\btinker(?:ing|ed)?\b|\bexperiment(?:ing|ed)?\b|\btr(?:y|ying|ied)\b)/i;
    if (TINKER_WORDS.test(scanText)) {
      return { fired: true, priority: 70, reason: 'keyword-tinker', kind: 'progress', msg: `在捣鼓: ${dim(titleSnippet)}`, suggestion: '一句话说一下你在玩什么?' };
    }

    // DISCOVERY (发现 / 学到)
    const DISCOVERY_WORDS = /(发现|意识到|原来|才知道|学到|学了|理解了|\blearned\b|\brealized?\b|\bdiscovered?\b|\bturns out\b)/i;
    if (DISCOVERY_WORDS.test(scanText)) {
      return { fired: true, priority: 70, reason: 'keyword-discovery', kind: 'progress', msg: `像学到东西的 commit: ${dim(titleSnippet)}`, suggestion: '学到 / 发现了什么? 给别人看看' };
    }

    return { fired: false };
  } catch { return { fired: false }; }
}

// C · 长时间没发 update + 累了 commit · 需要 state 里有 lastPushAt 才能判断
// === 幂等性 · 给 AI agent 重试不重复 push ===
// 客户端缓存 · 24h TTL · 同 key 直接返之前的响应
const IDEM_CACHE_FILE = path.join(CONFIG_DIR, 'idem-cache.json');
const IDEM_TTL_MS = 24 * 60 * 60 * 1000;
function loadIdemCache() {
  try { return JSON.parse(fs.readFileSync(IDEM_CACHE_FILE, 'utf-8')) || {}; } catch { return {}; }
}
function saveIdemCache(cache) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(IDEM_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {}
}
function idemGet(key) {
  if (!key) return null;
  const cache = loadIdemCache();
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.at > IDEM_TTL_MS) {
    delete cache[key];
    saveIdemCache(cache);
    return null;
  }
  return entry.response;
}
function idemSet(key, response) {
  if (!key) return;
  const cache = loadIdemCache();
  // 清掉过期的 (顺手)
  const now = Date.now();
  for (const k of Object.keys(cache)) {
    if (now - cache[k].at > IDEM_TTL_MS) delete cache[k];
  }
  cache[key] = { at: now, response };
  saveIdemCache(cache);
}
// 包装 API 动作 · key 重复直接返缓存
async function withIdempotency(key, fn) {
  if (!key) return fn();
  const cached = idemGet(key);
  if (cached) return { ...cached, idempotent: true, cacheHit: true };
  const result = await fn();
  idemSet(key, result);
  return result;
}

// === drift 检测 · 跨 repo · 用户说在做 A 但实际在折腾 B ===
// 数据来源: ~/.tinker/repos.json · 所有 tinker hook install 过的 repo
// 算法: 拉所有注册 repo 今天 commit 数 · 如果当前 repo 占比 < 30% 且有别的 > 50% · 触发
const REPOS_REGISTRY_FILE = path.join(CONFIG_DIR, 'repos.json');
function loadReposRegistry() {
  try { return JSON.parse(fs.readFileSync(REPOS_REGISTRY_FILE, 'utf-8')) || {}; }
  catch { return {}; }
}
function saveReposRegistry(reg) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(REPOS_REGISTRY_FILE, JSON.stringify(reg, null, 2));
  } catch {}
}
function registerRepoForDrift(repoPath, repoCfg) {
  const reg = loadReposRegistry();
  reg[repoPath] = {
    projectId: repoCfg.projectId,
    projectName: repoCfg.projectName,
    registeredAt: Date.now(),
  };
  saveReposRegistry(reg);
}
function triggerCrossRepoDrift(state, currentRepoCfg) {
  if (state && state.lowFiredTodayKey === todayKey()) return { fired: false };
  if (!currentRepoCfg) return { fired: false };
  const reg = loadReposRegistry();
  const regPaths = Object.keys(reg);
  if (regPaths.length < 2) return { fired: false };  // 只有 1 个 repo 没法 drift
  const cwd = process.cwd();
  const since = (() => { const d = new Date(); d.setHours(4, 0, 0, 0); return d.toISOString().slice(0, 10) + ' 04:00'; })();
  // 算每个 registered repo 今日 commit 数
  const counts = {};
  let total = 0;
  for (const p of regPaths) {
    try {
      if (!fs.existsSync(path.join(p, '.git'))) continue;
      const out = execSync(`git log --since="${since}" --no-merges --pretty=format:"%h"`, { cwd: p, encoding: 'utf-8' }).trim();
      const c = out ? out.split('\n').length : 0;
      counts[p] = c;
      total += c;
    } catch { counts[p] = 0; }
  }
  if (total < 3) return { fired: false };  // 总量太小不算
  const currentCount = counts[cwd] || 0;
  const currentRatio = currentCount / total;
  if (currentRatio >= 0.30) return { fired: false };  // 当前 repo 占比够 · 没 drift
  // 找占比最高的别的 repo
  let other = null, otherCount = 0;
  for (const [p, c] of Object.entries(counts)) {
    if (p !== cwd && c > otherCount) { other = p; otherCount = c; }
  }
  if (!other || otherCount / total < 0.50) return { fired: false };
  const otherInfo = reg[other];
  return {
    fired: true,
    priority: 65,
    reason: 'cross-repo-drift',
    kind: 'progress',
    msg: `今天主要在 ${dim('"' + (otherInfo.projectName || path.basename(other)) + '"')} 干活 (${otherCount}/${total} commits) · 这边 ${currentRepoCfg.projectName} 只占 ${currentCount}/${total}`,
    suggestion: `要不切到那边发一笔 · 还是这边其实没动 (那这一笔可能不发就好)`,
  };
}

function triggerLongSilence(state, repoCfg) {
  if (!repoCfg) return { fired: false };
  // v0.2 #6: 一天只触发一次低优先级
  if (state && state.lowFiredTodayKey === todayKey()) return { fired: false };
  const last = (state.lastPushAtByProject || {})[repoCfg.projectId];
  if (!last) return { fired: false };  // 第一次 install · 不算 silence
  const HOURS = 24;
  if (Date.now() - last < HOURS * 60 * 60 * 1000) return { fired: false };
  // 这段时间有 commit 才算
  try {
    const out = execSync(
      `git log --since="${Math.floor((Date.now() - last) / 1000)} seconds ago" --no-merges --pretty=format:"%h"`,
      { encoding: 'utf-8' }
    ).trim();
    const count = out ? out.split('\n').length : 0;
    if (count === 0) return { fired: false };
    const hours = Math.floor((Date.now() - last) / 3600 / 1000);
    return { fired: true, priority: 50, reason: 'silence', count, hours, msg: `${hours} 小时没发进展了 · 这段时间累了 ${count} 个 commit` };
  } catch { return { fired: false }; }
}

// v0.5 高价值瞬间触发器 · 不只识别 commit 模式 · 识别"对社区有沉淀价值的瞬间"

// 巧妙修复 · fix 关键词 + diff 小 + commit body 长
// 作者花时间解释"为什么这么修" 但代码只动几行 · 大概率是巧妙修法
// 对社区价值 ★★★ · 别人撞到同样坑能直接学
function triggerCleverFix() {
  try {
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    const scanText = title + '\n' + body;
    const FIX_WORDS_LOCAL = /(\bfix(?:ed|es|ing)?\b|\bpatch(?:ed)?\b|\bworkaround\b|修好|修了|搞定|解决了|处理了|绕过|绕开)/i;
    if (!FIX_WORDS_LOCAL.test(scanText)) return { fired: false };
    // body 必须够长 (作者花时间解释)
    if (body.length < 100) return { fired: false };
    // diff 净改动 < 30 行
    let ins = 0, del = 0;
    try {
      const statOut = execSync('git diff HEAD~1 HEAD --shortstat 2>/dev/null', { encoding: 'utf-8' }).trim();
      const insMatch = statOut.match(/(\d+) insertion/);
      const delMatch = statOut.match(/(\d+) deletion/);
      ins = insMatch ? parseInt(insMatch[1], 10) : 0;
      del = delMatch ? parseInt(delMatch[1], 10) : 0;
    } catch {}
    const netChange = ins + del;
    if (netChange === 0 || netChange > 30) return { fired: false };
    const titleSnippet = '"' + title.slice(0, 50) + '"';
    return {
      fired: true,
      priority: 90,
      reason: 'clever-fix',
      kind: 'clever-fix',
      msg: `像巧妙修法的 commit (${netChange} 行改动 · body ${body.length} 字): ${dim(titleSnippet)}`,
      suggestion: '这个修法看起来挺巧 · 别人撞到类似坑能学',
    };
  } catch { return { fired: false }; }
}

// 减法决策 · 删 >> 加 或 含"砍/删/不用了/撤回/revert"
// 工程师圈极少见 · 减掉东西比加东西难 · 这种经验稀缺
// 对社区价值 ★★★ · 最反直觉的决策
function triggerSubtraction() {
  try {
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    const scanText = title + '\n' + (body.split('\n')[0] || '');
    // 关键词模式
    const SUBTRACTION_WORDS = /(\bremov(?:e|ed|ing)\b|\bdrop(?:ped|ping)?\b|\bdelet(?:e|ed|ing)\b|\brevert(?:ed|ing)?\b|\bcleanup\b|\bsimplif(?:y|ied|ication)\b|砍(?:了|掉)|删了|不用了|撤回|去掉了|移除|简化|抽掉)/i;
    const wordMatch = SUBTRACTION_WORDS.test(scanText);
    // diff stats (删 > 加 × 3 且至少删 30 行避免微小 cleanup 误触)
    let ins = 0, del = 0;
    try {
      const statOut = execSync('git diff HEAD~1 HEAD --shortstat 2>/dev/null', { encoding: 'utf-8' }).trim();
      const insMatch = statOut.match(/(\d+) insertion/);
      const delMatch = statOut.match(/(\d+) deletion/);
      ins = insMatch ? parseInt(insMatch[1], 10) : 0;
      del = delMatch ? parseInt(delMatch[1], 10) : 0;
    } catch {}
    const statMatch = del > ins * 3 && del > 30;
    if (!wordMatch && !statMatch) return { fired: false };
    const titleSnippet = '"' + title.slice(0, 50) + '"';
    return {
      fired: true,
      priority: 85,
      reason: 'subtraction',
      kind: 'subtraction',
      msg: `像减法决策的 commit (删 ${del} · 加 ${ins}): ${dim(titleSnippet)}`,
      suggestion: '减了不少 · 说说为什么砍掉这些 · 减法决策最难学',
    };
  } catch { return { fired: false }; }
}

// AI 边界经验 · 含 AI 工具名 + 含边界词
// vibe coder 最需要的经验:这个 AI 在什么场景行/不行 · 怎么绕
// 对社区价值 ★★★ · alpha 期最贵的"手艺"
function triggerAiLimit() {
  try {
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    const scanText = title + '\n' + body;
    // AI 工具名 · 大小写不敏感
    const AI_TOOL_WORDS = /(\bclaude(?:\s*code)?\b|\bcursor\b|\bcopilot\b|\bdeepseek\b|\bchatgpt\b|\bgpt[-]?4?o?\b|\bgemini\b|\bbolt\b|\blovable\b|\bv0\b|\breplit\b|\bwindsurf\b|\btrae\b)/i;
    // 边界词 · 表明 AI 这次有局限
    const LIMIT_WORDS = /(绕过|没想到|不行|失败|局限|还得自己|手写|搞错|搞不定|搞砸|装大佬|乱编|说反|理解错|脑补|hallucinat|made\s*up|got\s*confused|infinite\s*loop|too\s*many\s*token|context\s*limit|忽略了|漏掉|蒙了|犟|拗|改了\s*\d+\s*[次回轮版])/i;
    const toolMatch = AI_TOOL_WORDS.test(scanText);
    const limitMatch = LIMIT_WORDS.test(scanText);
    if (!toolMatch || !limitMatch) return { fired: false };
    const titleSnippet = '"' + title.slice(0, 50) + '"';
    return {
      fired: true,
      priority: 85,
      reason: 'ai-limit',
      kind: 'ai-limit',
      msg: `像 AI 边界经验的 commit: ${dim(titleSnippet)}`,
      suggestion: 'AI 这次的边界经验 · 别人会用得上 · vibe coder 最需要这种',
    };
  } catch { return { fired: false }; }
}

// v0.7 又 7 个高价值瞬间触发器 · 补足"对社区有沉淀价值的瞬间"

// 重启 · 项目沉默 7+ 天后第一条 commit
// 跟 silence (22h 没发但有 commit) 不同 · 这是"放弃后回来"的经验
// 对社区价值 ★★ · 别人也常有这种时刻
function triggerRestart() {
  try {
    const out = execSync('git log -2 --pretty=%ct', { encoding: 'utf-8' }).trim();
    const lines = out.split('\n');
    if (lines.length < 2) return { fired: false };  // 第一条 commit 不算
    const now = parseInt(lines[0], 10) * 1000;
    const prev = parseInt(lines[1], 10) * 1000;
    const gap = now - prev;
    if (gap < 7 * 24 * 60 * 60 * 1000) return { fired: false };
    const days = Math.floor(gap / 86400000);
    return {
      fired: true,
      priority: 80,
      reason: 'restart',
      kind: 'restart',
      msg: `沉了 ${days} 天后又动了 · 这条是回来后第一个 commit`,
      suggestion: '回来了 · 说说这段时间想清楚了什么 / 为什么回来',
    };
  } catch { return { fired: false }; }
}

// 工具组合发现 · commit msg 含 2+ AI 工具名 + 创作词
// 手艺组合是 vibe coder 最珍贵的事 · 单工具好用大家都会 · 组合才是手艺
// v0.13 触发器: 这次 commit 改了 docs/*.md 类的文档
// vibe coder 的文档基本都是 AI 写给 AI 看的 · 直接建议 contribute --auto
// 让 LLM 挑段 · 用户一句 "好" 就发了 · 不用打开文件
//
// 不触发的情况:
// - 改的是 README / CHANGELOG / LICENSE 这种太通用的
// - md 总改动行数 <30 (typo 修复不值得整段 contribute)
function triggerDocsEdit() {
  try {
    // git show 列文件 · 对 initial commit 也工作 (diff-tree 在 root commit 返空)
    const files = execSync('git show --name-only --format= HEAD', { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
    const COMMON_DOCS = /^(README|CHANGELOG|LICENSE|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|AUTHORS)\.md$/i;
    const mdFiles = files.filter(f => /\.md$/i.test(f) && !COMMON_DOCS.test(path.basename(f)));
    if (mdFiles.length === 0) return { fired: false };
    // 看改动 size · typo 不值得 contribute
    const stat = execSync('git show --stat=200 HEAD -- ' + mdFiles.map(f => '"' + f + '"').join(' '), { encoding: 'utf-8' }).trim();
    const totalChanged = (stat.match(/(\d+) (?:insertions?|deletions?)/g) || [])
      .reduce((s, m) => s + parseInt(m.match(/(\d+)/)[1], 10), 0);
    if (totalChanged < 30) return { fired: false };
    const target = mdFiles[0];
    return {
      fired: true,
      priority: 78,
      reason: 'docs-edit',
      kind: 'docs-contribute',
      msg: `改了 ${dim(target)}${mdFiles.length > 1 ? ' (+' + (mdFiles.length - 1) + ' 个 md)' : ''} · +/- ${totalChanged} 行`,
      suggestion: '让 AI 帮挑一段分享出去 · ' + vermilion('tinker contribute --from-file ' + target + ' --auto'),
    };
  } catch { return { fired: false }; }
}

function triggerToolCombo() {
  try {
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    const scanText = title + '\n' + body;
    const AI_TOOLS = ['claude', 'cursor', 'copilot', 'deepseek', 'chatgpt', 'gpt', 'gemini', 'bolt', 'lovable', 'replit', 'windsurf', 'trae', 'v0', 'kimi', '通义', '豆包', '文心'];
    const found = [];
    AI_TOOLS.forEach(t => {
      const re = new RegExp('\\b' + t + '(?:\\s*code)?\\b', 'i');
      if (re.test(scanText)) found.push(t);
    });
    if (found.length < 2) return { fired: false };
    const CREATIVE_WORDS = /(做了|加了|写了|配合|一起|搭配|换\s*用|改用|结合|串|接)/i;
    if (!CREATIVE_WORDS.test(scanText)) return { fired: false };
    const titleSnippet = '"' + title.slice(0, 50) + '"';
    return {
      fired: true,
      priority: 80,
      reason: 'tool-combo',
      kind: 'tool-combo',
      msg: `用了 ${found.join(' + ')} · ${dim(titleSnippet)}`,
      suggestion: '工具组合是 vibe coder 最贵的手艺 · 这个组合怎么搭的',
    };
  } catch { return { fired: false }; }
}

// 跨项目借鉴 · commit 含"借鉴 / 仿照 / 像 X 那样" 等
// 手艺谱系信号 · vibe coder 之间学手艺的网状
function triggerCrossProject() {
  try {
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    const scanText = title + '\n' + body;
    const REF_WORDS = /(借鉴|仿照|模仿|参考|学(?:了|过|的是)|像\s*\S+\s*(?:那样|一样|的做法)|套了\s*\S+\s*的|拿\s*\S+\s*的|从\s*\S+\s*学|copy(?:ed|ing)?\s+from|inspired\s+by)/i;
    if (!REF_WORDS.test(scanText)) return { fired: false };
    const titleSnippet = '"' + title.slice(0, 50) + '"';
    return {
      fired: true,
      priority: 75,
      reason: 'cross-project',
      kind: 'cross-project',
      msg: `像借鉴别人作品的 commit: ${dim(titleSnippet)}`,
      suggestion: '借鉴谁的什么 · 怎么改用到自己项目',
    };
  } catch { return { fired: false }; }
}

// 长 commit body 兜底 · body > 200 字 + 其他触发器都没命中
// 作者花时间写 = 觉得值得记 · 简单粗暴但有效
// priority 65 · 比其他都低 · 只在其他都没命中时兜底
function triggerLongBody() {
  try {
    const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    if (body.length < 200) return { fired: false };
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const titleSnippet = '"' + title.slice(0, 50) + '"';
    return {
      fired: true,
      priority: 65,
      reason: 'long-body',
      kind: 'long-body',
      msg: `这条 commit 你写了 ${body.length} 字 · 用心了: ${dim(titleSnippet)}`,
      suggestion: '作者花时间写的事一般值得记 · 顺手发一笔吧',
    };
  } catch { return { fired: false }; }
}

// 测试 / 验证发现 · commit 加了测试文件 + commit msg 含验证词
// 别人不用再重复实验 · 验证 == 缩短全社区的探索时间
function triggerTestVerify() {
  try {
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    const scanText = title + '\n' + (body.split('\n')[0] || '');
    const VERIFY_WORDS = /(试了|验证|跑通|测试|确认|实测|实验|检验|\btest(?:ed|s)?\b|\bverify\b|\bconfirm\b)/i;
    if (!VERIFY_WORDS.test(scanText)) return { fired: false };
    let hasTestFile = false;
    try {
      const files = execSync('git diff --name-only HEAD~1 HEAD 2>/dev/null', { encoding: 'utf-8' }).trim();
      const TEST_FILE_RE = /(^|\/)tests?\/|_test\.[a-z]+$|\.test\.[a-z]+$|\.spec\.[a-z]+$|^test_[^\/]+\.[a-z]+$/i;
      hasTestFile = files.split('\n').some(f => TEST_FILE_RE.test(f));
    } catch {}
    if (!hasTestFile) return { fired: false };
    const titleSnippet = '"' + title.slice(0, 50) + '"';
    return {
      fired: true,
      priority: 75,
      reason: 'test-verify',
      kind: 'test-verify',
      msg: `加了测试 · 验证了什么: ${dim(titleSnippet)}`,
      suggestion: '别人不用再重复 · 说说这次验证了什么 + 结果',
    };
  } catch { return { fired: false }; }
}

// 命名 / 概念灵感 · commit 含改名词 或 文件改名
// 命名是创造力的体现 · 重要的命名值得记
function triggerNaming() {
  try {
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    const scanText = title + '\n' + body;
    const NAME_WORDS = /(改名|改叫|重命名|改成叫|换个名|叫\s*\S+\s*不叫|名字\s*改|\brename(?:d|ing)?\b)/i;
    const wordMatch = NAME_WORDS.test(scanText);
    let renamedFiles = false;
    try {
      const status = execSync('git diff --name-status HEAD~1 HEAD 2>/dev/null', { encoding: 'utf-8' }).trim();
      renamedFiles = /^R\d+\s/m.test(status);
    } catch {}
    if (!wordMatch && !renamedFiles) return { fired: false };
    const titleSnippet = '"' + title.slice(0, 50) + '"';
    return {
      fired: true,
      priority: 70,
      reason: 'naming',
      kind: 'naming',
      msg: `像改名 / 重命名的 commit: ${dim(titleSnippet)}`,
      suggestion: '命名是创造力 · 为什么换这个名 / 之前哪里不对',
    };
  } catch { return { fired: false }; }
}

// 反向选择 · 撤回的勇气 · 跟 subtraction 不同
// subtraction = 砍掉东西 (减法决策)
// reversal = 撤回决定 (回退 / 改回 / 走不通 / 想错了)
// 这种"承认走错了"的经验 · 比 ship 更稀缺
function triggerReversal() {
  try {
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    const scanText = title + '\n' + body;
    const REVERSAL_WORDS = /(\brevert(?:ed|ing)?\b|\bundo(?:ne)?\b|\broll\s*back\b|撤回|回退|改回|还原|放弃了|认怂|认输|这条路不通|走不通|想错了|想反了|算了不|删掉那条|走错路|绕了弯路)/i;
    if (!REVERSAL_WORDS.test(scanText)) return { fired: false };
    const titleSnippet = '"' + title.slice(0, 50) + '"';
    return {
      fired: true,
      priority: 85,
      reason: 'reversal',
      kind: 'reversal',
      msg: `像撤回 / 改回的 commit: ${dim(titleSnippet)}`,
      suggestion: '撤回需要勇气 · 说说一开始为什么选 X / 后来为什么改回',
    };
  } catch { return { fired: false }; }
}

// v0.12 跨上下文触发器 · v0.13 升级成 lifecycle 通用 (struggle + learning)
// 命中条件:state.currentStruggle 刚 resolved (5min 内) + 当前 commit 形态匹配 lifecycle 收尾词
// 对社区价值 ★★★★ · vibe coder 时代最稀缺的"踩坑经验" / "上手指南"
function triggerAiDebugBreakthrough() {
  try {
    const state = loadPromptState();
    const cur = state.currentStruggle;
    if (!cur || !cur.resolved || !cur.justResolvedAt) return { fired: false };
    if (Date.now() - cur.justResolvedAt > 5 * 60 * 1000) return { fired: false };

    const lifecycleType = cur.lifecycleType || 'struggle';
    const isLearning = lifecycleType === 'learning';
    const isDesignLoop = lifecycleType === 'design-loop';
    const struggleMod = (() => { try { return require('../lib/struggle'); } catch { return null; } })();
    const config = struggleMod && struggleMod.LIFECYCLE_CONFIGS[lifecycleType];

    // 当前 commit 必须匹配收尾形态
    // struggle: fix 类 + diff < 50 行 (长 debug 最终小修复的特征)
    // learning: done / setup / wired up / 跑通了 类 + diff 不限大小 (新东西从 0 开始就是大改)
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const body = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    const scanText = title + '\n' + body;

    if (isLearning) {
      // learning 出口词:跑通 / 配通 / hello world / 接通 / 初次 / 第一个 / 入门完成
      const LEARNING_DONE = /(跑通|配通|接通|hello\s*world|跑起来|跑出来|搞通|搞懂|入门完成|第一个.*跑|setup.*done|wired up|integrated|got it working|first.*working)/i;
      if (!LEARNING_DONE.test(scanText)) return { fired: false };
    } else if (isDesignLoop) {
      // design-loop 没有特定 commit 形态约束 · 推演不一定 commit code
      // 状态机已经看 Claude 对话的"决策词" 判断 resolved · 这里不再约束
    } else {
      const FIX_WORDS = /(\bfix(?:ed|es|ing)?\b|\bpatch(?:ed)?\b|\bworkaround\b|修好|修了|搞定|搞通|跑通|通了|解决了|绕过|绕开)/i;
      if (!FIX_WORDS.test(scanText)) return { fired: false };

      let ins = 0, del = 0;
      try {
        const statOut = execSync('git diff HEAD~1 HEAD --shortstat 2>/dev/null', { encoding: 'utf-8' }).trim();
        const insMatch = statOut.match(/(\d+) insertion/);
        const delMatch = statOut.match(/(\d+) deletion/);
        ins = insMatch ? parseInt(insMatch[1], 10) : 0;
        del = delMatch ? parseInt(delMatch[1], 10) : 0;
      } catch {}
      const netChange = ins + del;
      if (netChange === 0 || netChange > 50) return { fired: false };
    }

    // 检查 autopsy 草稿是否就绪 · prefix 跟 lifecycle 一致
    const draftDir = path.join(process.cwd(), '.tinker', 'drafts');
    const draftPrefix = config ? config.draftPrefix : 'experience';
    let draftReady = null;
    if (fs.existsSync(draftDir)) {
      const drafts = fs.readdirSync(draftDir)
        .filter(f => f.startsWith(draftPrefix + '-') && f.endsWith('.md'));
      if (drafts.length > 0) {
        const newest = drafts
          .map(f => ({ f, mtime: fs.statSync(path.join(draftDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)[0];
        if (newest.mtime >= (cur.endedAt || cur.justResolvedAt)) {
          draftReady = newest.f;
        }
      }
    }

    const spanHours = cur.endedAt && cur.startedAt
      ? Math.max(0.1, Math.round((cur.endedAt - cur.startedAt) / 360000) / 10)
      : '?';
    const topic = cur.topic || (isLearning ? '这次学的东西' : '这次折腾');
    const titleSnippet = '"' + title.slice(0, 50) + '"';
    const sigCount = (cur.signals || []).length;
    const triggerKind = config ? config.triggerKind : 'ai-debug-breakthrough';
    const productTag = config ? config.productTag : 'experience';
    const msg = isLearning
      ? `「${topic}」上手了 · 跨 ${spanHours}h · ${sigCount} 条信号 · 完成: ${dim(titleSnippet)}`
      : isDesignLoop
      ? `「${topic}」推演定下来了 · 跨 ${spanHours}h · ${sigCount} 条信号`
      : `「${topic}」破局了 · 跨 ${spanHours}h · ${sigCount} 条信号 · 修复: ${dim(titleSnippet)}`;

    return {
      fired: true,
      priority: 92,
      reason: triggerKind,
      kind: triggerKind,
      msg,
      suggestion: draftReady
        ? `草稿已自动整理: .tinker/drafts/${draftReady} · tinker push <file> --as-${productTag} 一键发`
        : (isLearning
            ? '这次上手过程写出来能帮到下一个人 · 草稿后台整理中'
            : isDesignLoop
            ? '这次推演沉淀下来给后人学 product sense 用 · 草稿后台整理中'
            : '这种坑写出来能帮到下一个人 · 包括其他 AI · 草稿后台整理中'),
      autopsyDraft: draftReady ? path.join(draftDir, draftReady) : null,
      struggleId: cur.id,
      lifecycleType,
      productTag,
    };
  } catch { return { fired: false }; }
}

// D · 当天首次 commit · 早安式
function triggerFirstCommitOfDay(state) {
  // v0.2 #6: 一天只触发一次低优先级 · 避免 first-commit 被后续 cumulative 抢走
  if (state && state.lowFiredTodayKey === todayKey()) return { fired: false };
  try {
    // "今天" 从凌晨 4 点开始算 · 跟 mute 'today' 的语义对齐 · 熬夜 coder 友好
    const d = new Date(); d.setHours(4, 0, 0, 0);
    const since = `${d.toISOString().slice(0, 10)} 04:00`;
    const out = execSync(
      `git log --since="${since}" --no-merges --pretty=format:"%h"`,
      { encoding: 'utf-8' }
    ).trim();
    const count = out ? out.split('\n').length : 0;
    if (count !== 1) return { fired: false }; // 不是首条不触发
    return { fired: true, priority: 60, reason: 'first-commit', msg: '早 · 今天首条 commit', suggestion: '想了想要做什么了吗? 写一笔规划自己听' };
  } catch { return { fired: false }; }
}

// === UI session 管理 ===
// 设计:一波 UI 改动当成一个 session 整体看 · 不每个 commit 都问
// 起点: 第一个 UI commit (无 session 时) · 抓 BEFORE 快照 · 静默
// 结束: 60min 时间窗 / 6 个 UI commit / 当前 commit 含 ship/done/完工 任一
// 当前 commit 非 UI / 在 session 中: 静默 · 继续等结束
// UI 文件判定 · 要么明确路径 (webapp/, components/, pages/, views/, frontend/, ui/, styles/, client/)
// 要么明确 UI 后缀 (HTML / CSS / SCSS / LESS / .tsx / .jsx / .vue / .svelte / .astro)
// 不匹配光秃秃的 .js / .ts (它们更多是后端 / CLI / 工具代码)
const UI_FILE_PATTERN = /(^|\/)(webapp|components|pages|views|frontend|ui|styles|client)\/|\.html?$|\.css$|\.scss$|\.sass$|\.less$|\.styl$|\.tsx$|\.jsx$|\.vue$|\.svelte$|\.astro$/i;
const UI_MSG_PATTERN = /(\bui\b|\bstyle\b|\bcss\b|\bvisual\b|样式|排版|视觉|界面|布局|配色|按钮|字体|颜色|动效|交互|UI)/i;
const SESSION_END_KEYWORDS = /(\bship(?:ped|s|it)?\b|\bdone\b|\bdeployed?\b|\breleased?\b|完工|跑通|上线|发布)/i;

function commitIsUi() {
  // 用 git diff 拿这次 commit 的文件 · 任一 match UI_FILE_PATTERN 就算
  try {
    const files = execSync('git diff --name-only HEAD^ HEAD 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (files && files.split('\n').some(f => UI_FILE_PATTERN.test(f))) return true;
  } catch {}
  // 补救:commit msg 直接说了 UI
  try {
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    return UI_MSG_PATTERN.test(title);
  } catch { return false; }
}

function evaluateUiSession(state, cfg) {
  const now = Date.now();
  const isUi = commitIsUi();
  const session = state.uiSession;
  let title = '';
  try { title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim(); } catch {}

  // 无 session
  if (!session) {
    if (!isUi) return { fired: false };  // 啥也不做
    // 启动 session · 抓 before 快照 · 静默
    let sha = ''; try { sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim(); } catch {}
    const snapPath = takeBeforeSnapshot(cfg, sha);  // 同步阻塞 (~3-5s) · 可以接受 (在 hook 里)
    state.uiSession = {
      startedAt: now,
      startCommitHash: sha,
      lastUiCommitAt: now,
      commitCount: 1,
      beforeSnapshotPath: snapPath,
    };
    return { fired: false, sessionStarted: true };
  }

  // 有 session · 评估是否该结束
  const elapsed = now - session.startedAt;
  const timeExpired = elapsed > 60 * 60 * 1000;
  const tooMany = session.commitCount >= 6;
  const shipKeyword = SESSION_END_KEYWORDS.test(title);
  const shouldEnd = timeExpired || tooMany || shipKeyword;

  if (!shouldEnd) {
    // 继续 session
    if (isUi) {
      session.commitCount++;
      session.lastUiCommitAt = now;
    }
    return { fired: false };
  }

  // session 结束 · 触发 prompt
  const minutes = Math.round(elapsed / 60000);
  let reason = '到时间了';
  if (tooMany) reason = '改得有点多了';
  if (shipKeyword) reason = '看起来在收尾';
  return {
    fired: true,
    priority: 75,
    reason: 'ui-session-end',
    kind: 'ui-session',
    session,
    msg: `这一波 UI 改了 ${session.commitCount} 个 commit (${minutes} 分钟前开始 · ${reason})`,
    suggestion: '想发一笔总结吗? 我会自动等 deploy 完贴 before/after 对比图',
  };
}

// microlink 抓 prod 当前样子 · 存到 ~/.tinker/snapshots/
// 返回保存的文件路径 · 失败返回 null
function takeBeforeSnapshot(cfg, sha) {
  if (!cfg || !cfg.serverUrl) return null;
  const snapDir = path.join(CONFIG_DIR, 'snapshots');
  try { fs.mkdirSync(snapDir, { recursive: true }); } catch {}
  const fname = path.join(snapDir, (sha || Date.now()) + '-before.jpg');
  try {
    const params = new URLSearchParams({
      url: cfg.serverUrl,
      screenshot: 'true', type: 'jpeg',
      'viewport.width': '1280', 'viewport.height': '720',
      'viewport.deviceScaleFactor': '2',
      waitUntil: 'networkidle0', waitForTimeout: '2500',
      'screenshot.quality': '85', meta: 'false',
    });
    // 同步抓 (curl 走 bash) · hook 阻塞 5 秒内可接受
    const json = JSON.parse(execSync(`curl -sS "https://api.microlink.io/?${params.toString()}"`, { encoding: 'utf-8' }));
    const shotUrl = json.data && json.data.screenshot && json.data.screenshot.url;
    if (!shotUrl) return null;
    execSync(`curl -sS -o "${fname}" "${shotUrl}"`, { encoding: 'utf-8' });
    return fname;
  } catch { return null; }
}

// 启动 detached 后台进程 · 等 deploy 完成 + 抓 after + editUpdate 贴图
// 任务以 JSON 文件传给子进程 (避开 argv 长度 / 转义麻烦)
function spawnDeployWatcher(task) {
  const { spawn } = require('child_process');
  const watchDir = path.join(CONFIG_DIR, 'watch');
  try { fs.mkdirSync(watchDir, { recursive: true }); } catch {}
  const taskFile = path.join(watchDir, 'task-' + Date.now() + '.json');
  fs.writeFileSync(taskFile, JSON.stringify(task));
  // 调 tinker 自己的 watch 子命令 · 把 taskFile 路径传过去
  const child = spawn(process.argv[0], [process.argv[1], 'watch', taskFile], {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
  });
  child.unref();
}

// `tinker watch <taskFile>` · 子进程实际跑的逻辑
async function cmdWatch(taskFile) {
  if (!taskFile || !fs.existsSync(taskFile)) {
    err('watch task file 不存在: ' + taskFile);
    process.exit(1);
  }
  const task = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));
  const logFile = path.join(CONFIG_DIR, 'watch', 'log.txt');
  const wlog = (s) => { try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${s}\n`); } catch {} };
  wlog(`watch start · updateId=${task.updateId}`);

  // poll /api/health · 找 deploy 重启信号 (uptime 突然变小)
  let lastUptime = null;
  let detectedReset = false;
  let stableAfterReset = 0;
  let pollResult = null;
  for (let i = 0; i < 80; i++) {  // 80 * 30s = 40 分钟最长等待
    try {
      const r = await fetch(task.serverUrl + '/api/health');
      const j = await r.json();
      const u = j.uptime || 0;
      if (lastUptime !== null && u < lastUptime && u < 60) {
        detectedReset = true;
        stableAfterReset = 0;
        wlog(`detected deploy reset (uptime ${lastUptime} → ${u})`);
      }
      if (detectedReset) {
        stableAfterReset = u;
        if (u > 40) { pollResult = 'ok'; break; }  // 重启后稳定运行 40s · deploy 完成
      }
      lastUptime = u;
    } catch (e) { wlog('poll err: ' + e.message); }
    await new Promise(r => setTimeout(r, 30000));
  }
  if (pollResult !== 'ok') {
    wlog('deploy not detected within 40min · 放弃');
    try { fs.unlinkSync(taskFile); } catch {}
    return;
  }

  // 抓 after 快照
  wlog('snapping after');
  let afterPath = null;
  try {
    const snapDir = path.join(CONFIG_DIR, 'snapshots');
    try { fs.mkdirSync(snapDir, { recursive: true }); } catch {}
    afterPath = path.join(snapDir, task.updateId + '-after.jpg');
    const params = new URLSearchParams({
      url: task.serverUrl,
      screenshot: 'true', type: 'jpeg',
      'viewport.width': '1280', 'viewport.height': '720',
      'viewport.deviceScaleFactor': '2',
      waitUntil: 'networkidle0', waitForTimeout: '3000',
      'screenshot.quality': '85', meta: 'false',
    });
    const json = JSON.parse(execSync(`curl -sS "https://api.microlink.io/?${params.toString()}"`, { encoding: 'utf-8' }));
    const shotUrl = json.data && json.data.screenshot && json.data.screenshot.url;
    if (!shotUrl) throw new Error('no shot url');
    execSync(`curl -sS -o "${afterPath}" "${shotUrl}"`, { encoding: 'utf-8' });
  } catch (e) {
    wlog('snap after fail: ' + e.message);
    try { fs.unlinkSync(taskFile); } catch {}
    return;
  }

  // 读 before + after · 编 data URL · editUpdate
  wlog('editUpdate attach images');
  try {
    const beforeBuf = fs.readFileSync(task.beforeSnapshotPath);
    const afterBuf = fs.readFileSync(afterPath);
    const beforeUrl = 'data:image/jpeg;base64,' + beforeBuf.toString('base64');
    const afterUrl = 'data:image/jpeg;base64,' + afterBuf.toString('base64');
    // editUpdate 用 updateIdx (排序里 ORDER BY at DESC · 最新的是 0)
    // 当前这条刚 push · 应该就是 0
    const r = await fetch(task.serverUrl + '/api/action', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + task.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'editUpdate',
        payload: {
          projectId: task.projectId,
          updateIdx: 0,
          text: task.text,
          images: [
            { src: beforeUrl, caption: '改之前' },
            { src: afterUrl, caption: '改之后' },
          ],
          seekingFeedback: false,
          feedbackAsk: '',
        },
      }),
    });
    if (r.ok) { wlog('attach ok'); } else { wlog('attach failed: ' + r.status); }
  } catch (e) {
    wlog('attach err: ' + e.message);
  }

  try { fs.unlinkSync(taskFile); } catch {}
  wlog('watch end');
}

// 把所有触发器汇总 · 选 priority 最高的那个
// v0.12 详细版 · 返回所有命中 + winner · 用于 tinker triggers 自检
// evaluateAllTriggers 是兼容老 API 的薄包装
function evaluateAllTriggersDetailed(state, repoCfg, cfg) {
  const uiResult = evaluateUiSession(state, cfg);
  const results = [
    triggerKeywordMatch(),
    triggerAiDebugBreakthrough(),
    triggerDocsEdit(),
    triggerCleverFix(),
    triggerSubtraction(),
    triggerAiLimit(),
    triggerRestart(),
    triggerToolCombo(),
    triggerCrossProject(),
    triggerTestVerify(),
    triggerNaming(),
    triggerReversal(),
    triggerLongBody(),
    triggerFirstCommitOfDay(state),
    triggerLongSilence(state, repoCfg),
    triggerCumulativeCommits({}, state),
    triggerCrossRepoDrift(state, repoCfg),
  ].filter(r => r.fired);
  if (uiResult.fired) results.push(uiResult);
  results.sort((a, b) => b.priority - a.priority);
  return {
    winner: results[0] || null,
    allFired: results,
  };
}

function evaluateAllTriggers(state, repoCfg, cfg) {
  return evaluateAllTriggersDetailed(state, repoCfg, cfg).winner;
}

// v0.12 踩坑全周期状态机入口 · cmdCheck 在评估触发器前调
// 静默原则: 用户正在 debug 不该被打扰 · enter/continue 全部静默
// resolve 切状态 + spawn autopsy 后台跑 · 不阻塞 hook
function updateStruggleState(state, { fromHook } = {}) {
  try {
    const struggle = getStruggleModule();
    const evalResult = struggle.evaluateLifecycleState(state, { cwd: process.cwd() });

    if (evalResult.transition === 'enter') {
      // 进入 active · 静默标记 (alpha 期默认 consent=true · tinker struggle off 可关)
      const s = evalResult.pendingSituation;
      s.consented = true;
      s.topic = struggle.inferTopic(s.signals);
      state.currentStruggle = s;
      struggle.saveDossier(s);
      return;
    }

    if (evalResult.transition === 'continue') {
      // 在 active 中 · 顺手 append 当前 commit 信号
      const lifecycleType = state.currentStruggle.lifecycleType || 'struggle';
      const config = struggle.LIFECYCLE_CONFIGS[lifecycleType] || struggle.LIFECYCLE_CONFIGS.struggle;
      try {
        const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
        struggle.appendSignal(state.currentStruggle, {
          type: 'wip_commit',
          sha: execSync('git log -1 --pretty=%H', { encoding: 'utf-8' }).trim().slice(0, 8),
          text: title.slice(0, 200),
        });
      } catch {}
      // 同时记录最近的 Claude 信号 (顺手刷 dossier · 让 autopsy 有料)
      if (evalResult.recent && evalResult.recent.userMessages.length > 0) {
        const signalType = lifecycleType === 'struggle' ? 'claude_fail' : 'claude_explore';
        const seen = new Set((state.currentStruggle.signals || [])
          .filter(s => s.type === signalType)
          .map(s => s.at));
        evalResult.recent.userMessages.slice(-3).forEach(m => {
          if (!seen.has(m.ts) && config.matchSignal(m.text)) {
            struggle.appendSignal(state.currentStruggle, {
              at: m.ts, type: signalType, text: m.text.slice(0, 200),
            });
          }
        });
      }
      // 推断 topic (信号更多了重推一次)
      if (!state.currentStruggle.topic || state.currentStruggle.signals.length % 5 === 0) {
        state.currentStruggle.topic = struggle.inferTopic(state.currentStruggle.signals);
        struggle.saveDossier(state.currentStruggle);
      }
      return;
    }

    if (evalResult.transition === 'resolve') {
      // 出坑 / 学会 · 标 resolved + 记 justResolvedAt (给 breakthrough 触发器用)
      state.currentStruggle.resolved = true;
      state.currentStruggle.endedAt = Date.now();
      state.currentStruggle.justResolvedAt = Date.now();
      if (!state.currentStruggle.topic) {
        state.currentStruggle.topic = struggle.inferTopic(state.currentStruggle.signals) || '未命名';
      }
      struggle.saveDossier(state.currentStruggle);
      // 后台 spawn autopsy · 不阻塞 hook · 传 lifecycle type
      spawnAutopsyAsync(state.currentStruggle.id, state.currentStruggle.lifecycleType || 'struggle');
      return;
    }

    if (evalResult.transition === 'abandon') {
      state.currentStruggle = null;
      return;
    }
    // transition === 'none' · 什么都不做
  } catch (e) {
    if (!fromHook) {
      console.error('[lifecycle] ' + e.message);
    }
  }
}

// 后台 detached child 跑 autopsy · 不阻塞 hook
// 用 process.execPath + __filename + 隐藏 args · 子进程跑 cmdAutopsy
// lifecycleType 默认 'struggle' (兼容老 dossier)
function spawnAutopsyAsync(situationId, lifecycleType = 'struggle') {
  try {
    const child = spawn(process.execPath, [__filename, '__autopsy', situationId, lifecycleType], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
    });
    child.unref();
  } catch { /* 容错 */ }
}

// v0.12 记录今日触发器命中分布 · 给 tinker triggers + goodnight 用
// 只记 winner · 因为这是最有意义的"今天替我做了什么"
// 跨天 (todayKey 变化) 自动清零
function recordTriggerWinner(state, winner, suppressedByCooldown) {
  const tk = todayKey();
  if (!state.todayTriggerHits || state.todayTriggerHits.date !== tk) {
    state.todayTriggerHits = { date: tk, winners: {} };
  }
  if (!winner) return;
  const k = winner.kind || winner.reason || 'unknown';
  if (!state.todayTriggerHits.winners[k]) {
    state.todayTriggerHits.winners[k] = { count: 0, suppressed: 0 };
  }
  state.todayTriggerHits.winners[k].count++;
  if (suppressedByCooldown) state.todayTriggerHits.winners[k].suppressed++;
}

async function cmdCheck(opts) {
  if (!inGitRepo()) {
    if (!opts.fromHook) err('不在 git 仓库');
    return;
  }
  const fromHook = !!opts.fromHook;
  const state = loadPromptState();
  const now = Date.now();

  // 后台异步刷新 update cache · 不阻塞主流程
  // (cache TTL 24h · 重复跑也只在过期时真发 GitHub 请求 · 浪费小)
  spawnUpdateCheckAsync();

  // 顺手清理 30 天前的 struggle dossier · 失败容错
  // 调用频率高 (每次 hook) · cleanOldDossiers 内部判 mtime 不重读不必要文件 · 几乎零成本
  try { getStruggleModule().cleanOldDossiers({ keepDays: 30 }); } catch {}

  // v0.13: 静默逻辑分层 (用户语义对齐)
  //   mutedUntil / dismissedTodayKey = 全局静音 (用户明确表达"不要打扰我") · 早 return
  //   laterUntilByReason = per-reason 延后 (用户语义是"这一类我懒得写") · 移到 evaluate 后
  // 这样: 用户对 ai-limit 选"1 小时后再问" · subtraction (不同 reason) 仍能触发
  if (state.mutedUntil && state.mutedUntil > now) {
    if (!fromHook) log(sepia('  现在静音中 · 到 ' + new Date(state.mutedUntil).toLocaleString()));
    return;
  }
  if (state.dismissedTodayKey === todayKey()) {
    if (!fromHook) log(sepia('  今天已经选了不发 · 明天再问'));
    return;
  }
  // 冷却 30 分钟 · 同一段时间不重复 prompt
  // 例外: keyword 触发的高信号 (commit message 含 ship/done 等) 不受冷却约束
  // 因为那是用户刚刚明确说"我做完了某件事" · 不能错过

  // 知道是哪个项目
  const repoCfg = loadRepoConfig();
  if (!repoCfg) {
    if (!fromHook) log(sepia('  这个 repo 还没绑定 Tinker 项目 · 先跑 ') + vermilion('tinker hook install'));
    return;
  }
  // 顺手登记到 drift registry · 即使老用户没重装 hook 也能用 drift 检测
  registerRepoForDrift(process.cwd(), repoCfg);

  // v0.12 踩坑全周期状态机 · 在评估触发器前先更新 struggle 状态
  // 静默原则:enter/continue 时不打扰用户 (用户正在 debug 不该被弹窗)
  // resolve 时仅切状态 · ai-debug-breakthrough 触发器会从 state 看到并 prompt
  updateStruggleState(state, { fromHook });

  // 评估所有触发器 · 选最高 priority
  const cfgForUi = (() => { try { return mustHaveConfig(); } catch { return null; } })();
  const result = evaluateAllTriggers(state, repoCfg, cfgForUi);
  // UI session 评估可能写了 state (启动 session) · 即使没 fire 也存一下
  savePromptState(state);
  if (!result) {
    if (!fromHook) log(sepia('  当前没有触发器命中 · 安静'));
    return;
  }

  // v0.13: per-reason 延后 · 用户对这一类已说"稍后" · 但不同 reason 仍能突破
  const laterByReason = state.laterUntilByReason || {};
  if (laterByReason[result.reason] && laterByReason[result.reason] > now) {
    if (!fromHook) log(sepia('  这类 (' + result.reason + ') 延后到 ' + new Date(laterByReason[result.reason]).toLocaleString()));
    return;
  }

  // 冷却:30 分钟内已经 prompt 过 + 不是 keyword 级 (priority < 100) 不再 prompt
  const suppressedByCooldown = state.lastPromptedAt && (now - state.lastPromptedAt) < 30 * 60 * 1000 && result.priority < 100;
  // v0.12 不管最后是否 prompt · 都记 winner 到今日 hits (给 goodnight + tinker triggers 看)
  recordTriggerWinner(state, result, suppressedByCooldown);
  savePromptState(state);
  if (suppressedByCooldown) {
    return;
  }

  // prompt 出来 · v0.3 --json mode 跳过人类可读输出 · 只输出 JSON
  if (!opts.json) {
    log('');
    log(sepia('  ── ') + vermilion('tinker') + sepia(' ──'));
    log('  ' + bold(result.msg) + sepia(' · 在 ') + vermilion(repoCfg.projectName));
    if (result.suggestion) log('  ' + sepia(result.suggestion));
    log('');
  }

  // 根据触发器类型 · 默认动作不一样:
  //   keyword=frustrated → 特殊:不说"想发一笔"·三选 [标卡住 / 喘口气 / 没事接着搞]
  //   keyword=ship → "进陈列馆" (走 shipProject) 排第一
  //   keyword=stuck → "标卡住" 排第一
  //   其他 → "发一笔" 排第一
  const choices = [];
  if (result.kind === 'frustrated') {
    // 破防时刻 · 文案 / 选项跟其他都不一样 · 不要产品语言
    choices.push({ name: '⚠ 标卡住 · 让在意你的人看到', value: 'stuck-quiet' });
    choices.push({ name: '暂停 30 分钟 · 出去走走', value: 'mute-30m' });
    choices.push({ name: '没事 · 我接着搞', value: 'skip-once' });
  } else if (result.kind === 'ui-session') {
    // UI session 结束 · 想发一笔 + 自动贴对比图 (第二个 commit 加 deploy watcher)
    choices.push({ name: '发一笔 · 自动贴 before / after 对比图', value: 'ui-push' });
    choices.push({ name: '只发一笔 · 不要对比图', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'brand') {
    // 品牌信号 · "捣鼓" / Tinker 出现 · 主动认歧义 · 让用户挑哪种意思
    // v0.2 #3: 两个选项 value 区分 · 让 input prompt 文案匹配语境
    choices.push({ name: '是 Tinker 项目本身的进展 · 发一笔', value: 'push-brand-self' });
    choices.push({ name: '是用 Tinker 做事情的反思 · 发一笔', value: 'push-brand-meta' });
    choices.push({ name: '巧合 · 跟 Tinker 没关系 · 跳过', value: 'skip-once' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
  } else if (result.kind === 'decision') {
    // v0.2 #1: 工具链选型决策 · 长期价值高 · 让用户记下来
    choices.push({ name: '记决策 · 写一笔', value: 'push-decision' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'clever-fix') {
    // v0.5: 巧妙修复 · 别人能学的真东西
    choices.push({ name: '记这个修法 · 写一笔', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'subtraction') {
    // v0.5: 减法决策 · 工程师圈最难学的事
    choices.push({ name: '说说为什么砍 · 写一笔', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'ai-limit') {
    // v0.5: AI 边界经验 · alpha 期最贵的"手艺"
    choices.push({ name: '记 AI 边界 · 写一笔', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'restart') {
    // v0.7: 项目沉默后回归 · 放弃后重启的经验
    choices.push({ name: '记回归 · 说说为什么回来', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'tool-combo') {
    // v0.7: 工具组合发现 · 手艺组合
    choices.push({ name: '记这个组合搭法 · 写一笔', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'cross-project') {
    // v0.7: 跨项目借鉴 · 手艺谱系
    choices.push({ name: '记这次借鉴 · 写一笔', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'test-verify') {
    // v0.7: 测试 / 验证发现 · 别人不用再重复
    choices.push({ name: '记这次验证 · 写一笔', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'naming') {
    // v0.7: 命名 / 重命名 · 创造力体现
    choices.push({ name: '记这次改名 · 写一笔', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'reversal') {
    // v0.7: 撤回的勇气 · 承认走错了
    choices.push({ name: '记这次撤回 · 写一笔', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'long-body') {
    // v0.7: 长 body 兜底 · 作者花时间写
    choices.push({ name: '顺手发一笔', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'ship') {
    choices.push({ name: '✦ 进陈列馆 · 写一句完工感想', value: 'ship' });
    choices.push({ name: '只发一笔普通进展', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'stuck') {
    choices.push({ name: '⚠ 标卡住 · 写在哪里卡了', value: 'stuck' });
    choices.push({ name: '只发一笔普通进展', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'prototype') {
    choices.push({ name: '◐ 进陈列馆 · 作为原型', value: 'prototype' });
    choices.push({ name: '只发一笔普通进展', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else {
    choices.push({ name: '发 · 现在写一句', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  }

  // v0.3 --json mode · 给 AI agent 用 · 不弹 select · 输出 JSON + 写 pending
  // 让 Claude Code / Cursor 等无 TTY 的环境也能驱动 tinker
  if (opts.json) {
    // 持久化触发上下文 · 供后续 tinker resolve 用
    const pending = {
      at: now,
      kind: result.kind,
      reason: result.reason,  // v0.13: 给 --ai mode 的 later 选项做 per-reason 静默
      priority: result.priority,
      msg: stripAnsi(result.msg),
      suggestion: result.suggestion || '',
      projectId: repoCfg.projectId,
      projectName: repoCfg.projectName,
      commitTitle: (() => { try { return execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim(); } catch { return ''; } })(),
      session: result.session || null,  // ui-session 时携带 before snapshot path 等
    };
    savePending(pending);
    // 写 state · 标记已 prompt · 防重复触发
    state.lastPromptedAt = now;
    if (result.priority < 70) state.lowFiredTodayKey = todayKey();
    savePromptState(state);
    // 输出结构化 JSON 给调用方解析
    const out = {
      fired: true,
      kind: result.kind,
      priority: result.priority,
      msg: stripAnsi(result.msg),
      suggestion: result.suggestion || '',
      context: repoCfg.projectName,
      choices: choices.map(c => ({ id: c.value, label: stripAnsi(c.name) })),
    };
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }

  const { select, input } = require('@inquirer/prompts');
  let choice;
  try {
    choice = await select({ message: '怎么处理?', choices });
  } catch { choice = 'later'; }

  state.lastPromptedAt = now;
  // v0.2 #6: 低优先级触发器 (first-commit/silence/cumulative) 命中后 · 当天不再问
  // priority < 70: first-commit 60 / silence 50 / cumulative 30
  if (result.priority < 70) {
    state.lowFiredTodayKey = todayKey();
  }

  const cfg = mustHaveConfig();

  // 起草助手 · 有 LLM 就预填一句 · 没 LLM 直接走原本的空 input
  async function promptForText(message, sinceMinutes) {
    let draft = null;
    if (cfg.llm && cfg.llm.apiKey) {
      log(sepia('  起草中...'));
      draft = await llmQuickDraft(cfg, { sinceMinutes });
      if (draft) log(sepia('  ✦ LLM 起草了一句 · 改改或直接回车'));
      else log(sepia('  (LLM 没给出草稿 · 自己写吧)'));
    }
    return (await input({ message, default: draft || undefined })).trim();
  }

  if (choice === 'ui-push') {
    // UI session 结束 + 想要对比图
    // 1. 用户写一句总结
    // 2. push update
    // 3. 启动 detached watcher · 等 deploy 完抓 after · editUpdate 贴图
    // before 路径来自 result.session.beforeSnapshotPath
    const session = result.session;
    state.uiSession = null;  // 清掉 · 让下一波 UI 启动新 session
    savePromptState(state);
    const sinceMin = Math.max(60, Math.round((Date.now() - session.startedAt) / 60000) + 10);
    const text = await promptForText('一句话总结这波 UI 改动', sinceMin);
    if (!text) { log(sepia('  没写内容 · 跳过')); return; }
    const pushResult = await apiAction(cfg, 'addUpdate', { projectId: repoCfg.projectId, text });
    const updateId = pushResult && (pushResult.result?.id || pushResult.id);
    state.lastPushAtByProject = state.lastPushAtByProject || {};
    state.lastPushAtByProject[repoCfg.projectId] = Date.now();
    savePromptState(state);
    ok('发出去了 → ' + cfg.serverUrl + '/#/p/' + cfg.handle + '/');
    savePoolSample(buildPendingForSample(repoCfg, result), 'ui-push', text, cfg.handle);

    // 启动后台 watcher · 等 deploy 后抓 after + editUpdate 贴图
    if (updateId && session && session.beforeSnapshotPath) {
      spawnDeployWatcher({
        updateId,
        projectId: repoCfg.projectId,
        text,
        beforeSnapshotPath: session.beforeSnapshotPath,
        serverUrl: cfg.serverUrl,
        token: cfg.token,
        startedAt: Date.now(),
      });
      log(sepia('  后台监控 deploy 中 · deploy 完会自动给那条 update 贴上 before/after 对比图'));
    } else {
      log(sepia('  before 快照丢了 · 这次没贴对比图 (后续会修)'));
    }
  } else if (choice === 'push' || choice === 'push-brand-self' || choice === 'push-brand-meta' || choice === 'push-decision') {
    savePromptState(state);
    // v0.2 #1 #3: input prompt 文案随 kind 切换 · 让用户写对语境
    let msg = '一句话进展 (会发到 ' + repoCfg.projectName + ')';
    if (choice === 'push-brand-self') {
      msg = 'Tinker 项目本身这次改了什么 (会发到 ' + repoCfg.projectName + ')';
    } else if (choice === 'push-brand-meta') {
      msg = '用 Tinker 这件事的反思 (会发到 ' + repoCfg.projectName + ')';
    } else if (choice === 'push-decision') {
      msg = '这次决策的简述 (装/换/选了什么 · 为什么 · 会发到 ' + repoCfg.projectName + ')';
    }
    const text = await promptForText(msg, 60);
    if (!text) { log(sepia('  没写内容 · 跳过')); return; }
    await apiAction(cfg, 'addUpdate', { projectId: repoCfg.projectId, text });
    state.lastPushAtByProject = state.lastPushAtByProject || {};
    state.lastPushAtByProject[repoCfg.projectId] = Date.now();
    savePromptState(state);
    savePoolSample(buildPendingForSample(repoCfg, result), choice, text, cfg.handle);
    const okMsg = choice === 'push-decision' ? '✓ 决策记下来了 → ' : '发出去了 → ';
    ok(okMsg + cfg.serverUrl + '/#/p/' + cfg.handle + '/');
  } else if (choice === 'ship' || choice === 'prototype') {
    savePromptState(state);
    const verb = choice === 'ship' ? '完工感想' : '原型说明';
    const text = await promptForText(verb + ' (会进陈列馆代表 ' + repoCfg.projectName + ')', 60);
    if (!text) { log(sepia('  没写内容 · 跳过')); return; }
    await apiAction(cfg, 'exhibitProject', {
      projectId: repoCfg.projectId,
      kind: choice,
      statement: text,
      seekingFeedback: true,
    });
    state.lastPushAtByProject = state.lastPushAtByProject || {};
    state.lastPushAtByProject[repoCfg.projectId] = Date.now();
    savePromptState(state);
    savePoolSample(buildPendingForSample(repoCfg, result), choice, text, cfg.handle);
    ok((choice === 'ship' ? '✦ 完工 · 已进陈列馆' : '◐ 原型 · 已进陈列馆'));
  } else if (choice === 'stuck') {
    savePromptState(state);
    const text = await promptForText('卡在哪 (会标项目 stuck + 通知关心你的人)', 60);
    if (!text) { log(sepia('  没写内容 · 跳过')); return; }
    await apiAction(cfg, 'changeProjectStatus', { projectId: repoCfg.projectId, newStatus: 'stuck' });
    await apiAction(cfg, 'addUpdate', { projectId: repoCfg.projectId, text });
    state.lastPushAtByProject = state.lastPushAtByProject || {};
    state.lastPushAtByProject[repoCfg.projectId] = Date.now();
    savePromptState(state);
    savePoolSample(buildPendingForSample(repoCfg, result), choice, text, cfg.handle);
    ok('⚠ 卡住了 · 已通知');
  } else if (choice === 'stuck-quiet') {
    // 破防触发后选了标卡住 · 文本默认走 commit 标题 · 不强求作者再写一句 · 那时候不该再要求
    savePromptState(state);
    const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    const fallback = '卡住了 · 这条 commit 没顺下来: ' + title;
    const text = (await input({ message: '写一句 · 或回车用 commit 标题', default: fallback })).trim() || fallback;
    await apiAction(cfg, 'changeProjectStatus', { projectId: repoCfg.projectId, newStatus: 'stuck' });
    await apiAction(cfg, 'addUpdate', { projectId: repoCfg.projectId, text });
    recordPushAt(repoCfg.projectId);
    savePoolSample(buildPendingForSample(repoCfg, result), choice, text, cfg.handle);
    ok('⚠ 卡住了 · 已通知关心你的人');
  } else if (choice === 'mute-30m') {
    state.mutedUntil = now + 30 * 60 * 1000;
    savePromptState(state);
    log(sepia('  30 分钟不再问 · 出去走走'));
  } else if (choice === 'skip-once') {
    // 这一次不动 · 不静音不延后 · 让作者继续 · 但下个触发器还是能问
    state.lastPromptedAt = now;
    savePromptState(state);
    log(sepia('  好 · 接着搞'));
  } else if (choice === 'later') {
    // v0.13: per-reason 延后 · 不同 reason 仍能突破
    state.laterUntilByReason = state.laterUntilByReason || {};
    state.laterUntilByReason[result.reason] = now + 60 * 60 * 1000;
    savePromptState(state);
    log(sepia('  这一类 (' + result.reason + ') 1 小时后再问 · 别的 commit 仍会提醒'));
  } else if (choice === 'skip-today') {
    state.dismissedTodayKey = todayKey();
    savePromptState(state);
    log(sepia('  今天不再问 · 明天见'));
  } else if (choice === 'mute') {
    state.mutedUntil = now + 24 * 60 * 60 * 1000;
    savePromptState(state);
    log(sepia('  静音 24 小时 · 用 ') + vermilion('tinker mute off') + sepia(' 解除'));
  }
}

// `tinker llm [set|off|status]` · 单独配 LLM key · 不用重跑整个 login
async function cmdLlm(sub, opts = {}) {
  const cfg = loadConfig();
  if (!cfg) {
    if (opts.json) { errJson('还没配置 · 先跑 tinker login', 'NO_CONFIG'); return; }
    err('还没配置 · 先跑 ' + vermilion('tinker login')); process.exit(1);
  }

  if (sub === 'off' || sub === 'clear') {
    delete cfg.llm;
    saveConfig(cfg);
    if (opts.json) { outputJson({ ok: true, cleared: true }); return; }
    ok('LLM 配置已清掉 · prompt 流程回到手敲模式');
    return;
  }

  if (sub === 'usage') {
    // 看 Tinker 自己用 LLM 的 token 累积 · 跟 goodnight 解耦 (不混进日总结)
    let history = [];
    try { history = JSON.parse(fs.readFileSync(LLM_USAGE_FILE, 'utf-8')); } catch {}
    if (!Array.isArray(history)) history = [];
    const today = getTodayLLMUsage();
    const total = history.reduce((s, h) => s + (h.tokens || 0), 0);
    const todayTokens = today.reduce((s, h) => s + (h.tokens || 0), 0);
    const byKind = {};
    history.forEach(h => { byKind[h.kind] = (byKind[h.kind] || 0) + h.tokens; });

    if (opts.json) {
      outputJson({
        ok: true,
        today: { tokens: todayTokens, calls: today.length },
        total: { tokens: total, calls: history.length },
        byKind,
        note: '这是 Tinker 自己消耗的 token · 不包含 Cursor / Claude Code 等编程工具',
      });
      return;
    }

    if (history.length === 0) {
      log(sepia('  还没记录过 LLM 用量'));
      return;
    }
    log('');
    log(sepia('  Tinker 自己用 LLM 的 token (起草 / 重写 / voice 分析 / narrate 等)'));
    log(sepia('  ━━━━━━━━━━━━━━━━━━━━━━━'));
    log(sepia('    今日: ') + bold(todayTokens.toLocaleString() + ' tokens') + sepia(' · ') + sepia(today.length + ' 次调用'));
    log(sepia('    累计: ') + bold(total.toLocaleString() + ' tokens') + sepia(' · ') + sepia(history.length + ' 次调用'));
    log(sepia('  按 kind 分:'));
    Object.entries(byKind).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => {
      log(sepia('    · ' + k.padEnd(15)) + bold(n.toLocaleString().padStart(8)));
    });
    log('');
    log(sepia('  说明: 这是 Tinker 自己消耗的 token (起草 / 总结自己用) · 不包含你在 Cursor / Claude Code 等编程工具里的 token'));
    return;
  }

  if (sub === 'status' || (sub === undefined && cfg.llm && cfg.llm.apiKey)) {
    if (!cfg.llm || !cfg.llm.apiKey) {
      log(sepia('  LLM 没配置 · 跑 ') + vermilion('tinker llm set') + sepia(' 来配'));
      return;
    }
    log('');
    log(sepia('  LLM 配置:'));
    log(sepia('    provider ') + vermilion(cfg.llm.provider || 'anthropic'));
    log(sepia('    model    ') + sepia(cfg.llm.model || '(provider 默认)'));
    log(sepia('    key      ') + sepia(cfg.llm.apiKey.slice(0, 8) + '...' + cfg.llm.apiKey.slice(-4)));
    log('');
    log(sepia('  重新配: ') + vermilion('tinker llm set'));
    log(sepia('  清掉:  ') + vermilion('tinker llm off'));
    return;
  }

  // set (or 没配过 · sub === undefined 也走这里)
  const { input, select, password } = require('@inquirer/prompts');
  log('');
  log(sepia('  配 LLM · 给 prompt 自动起草用'));
  log(sepia('  ━━━━━━━━━━━━━━━━━━━━━━━'));
  const provider = await select({
    message: 'LLM provider',
    choices: [
      { name: 'Anthropic Claude (推荐 · 跟产品哲学一致)', value: 'anthropic' },
      { name: 'DeepSeek (国内友好 · 便宜)', value: 'deepseek' },
      { name: 'OpenAI GPT', value: 'openai' },
    ],
    default: cfg.llm?.provider || 'anthropic',
  });
  const apiKey = await password({
    message: 'API key (不会显示)',
    validate: (v) => v.trim().length > 0 || '不能空',
  });
  cfg.llm = { provider, apiKey: apiKey.trim() };
  saveConfig(cfg);
  ok('LLM 配好了 · 下次 prompt 选"发"就能看到自动起草');
}

// 解 Claude Code 的 jsonl session 文件 · 拉今天的 token 用量
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
// 每条 assistant message 都有 usage + timestamp · 按今日 (4am 算一天) 过滤
function getClaudeCodeUsageToday(opts = {}) {
  const claudeRoot = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeRoot)) return null;

  // 默认"今天" 4am 起 · daysBack 支持周/月扫
  const daysBack = opts.daysBack || 1;
  const dayStart = (() => {
    const d = new Date();
    d.setDate(d.getDate() - (daysBack - 1));
    d.setHours(4, 0, 0, 0);
    return d.getTime();
  })();
  const now = Date.now();

  const byModel = {};
  let totalMessages = 0;
  let sessionFiles = new Set();

  try {
    const projDirs = fs.readdirSync(claudeRoot).filter(d => {
      try { return fs.statSync(path.join(claudeRoot, d)).isDirectory(); } catch { return false; }
    });
    for (const projDir of projDirs) {
      const fullProjDir = path.join(claudeRoot, projDir);
      let files;
      try { files = fs.readdirSync(fullProjDir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const fullPath = path.join(fullProjDir, f);
        // 文件 mtime 在今天 4am 之前 · 整个文件跳过
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs < dayStart) continue;
        } catch { continue; }
        // 流式逐行扫 · 大文件 (10MB+) 也能跑
        let content;
        try { content = fs.readFileSync(fullPath, 'utf-8'); } catch { continue; }
        const lines = content.split('\n');
        let sawTodayMessage = false;
        for (const line of lines) {
          if (!line || line[0] !== '{') continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          if (obj.type !== 'assistant' || !obj.message || !obj.message.usage) continue;
          const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
          if (ts < dayStart || ts > now) continue;
          const model = obj.message.model || 'unknown';
          // 跳过 Claude Code 内部 synthetic / system 消息 · 不是真实 LLM 调用
          if (model === '<synthetic>' || model.startsWith('<')) continue;
          sawTodayMessage = true;
          totalMessages++;
          const u = obj.message.usage;
          if (!byModel[model]) byModel[model] = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 };
          byModel[model].input += u.input_tokens || 0;
          byModel[model].cacheCreate += u.cache_creation_input_tokens || 0;
          byModel[model].cacheRead += u.cache_read_input_tokens || 0;
          byModel[model].output += u.output_tokens || 0;
        }
        if (sawTodayMessage) sessionFiles.add(fullPath);
      }
    }
  } catch { return null; }

  if (totalMessages === 0) return { messages: 0, models: {}, sessions: 0, totalUsd: 0, totalRmb: 0 };

  // 估算成本 · USD per million tokens
  // Anthropic 官网公开定价 (2026 标准 200K context 版本):
  //   Opus 4: $15 input / $75 output · cache write 1.25x input · cache read 10% input
  //   Sonnet 4: $3 input / $15 output
  //   Haiku 4: $0.8 input / $4 output
  // 1M context 版本 (claude-opus-4-7 / claude-sonnet-4-6 等带 "1m" / 高版本号) 标准 2x:
  //   Opus 1M: $30 input / $150 output
  // 这里按 model 名字推断 · 不准时按 standard 算 · 用户可以认为是 "下限估算"
  const PRICING = {
    opus: { input: 15, output: 75, cacheCreate: 18.75, cacheRead: 1.5 },
    opus1m: { input: 30, output: 150, cacheCreate: 37.5, cacheRead: 3.0 },
    sonnet: { input: 3, output: 15, cacheCreate: 3.75, cacheRead: 0.3 },
    sonnet1m: { input: 6, output: 30, cacheCreate: 7.5, cacheRead: 0.6 },
    haiku: { input: 0.8, output: 4, cacheCreate: 1, cacheRead: 0.08 },
  };
  function priceFor(modelStr) {
    const s = (modelStr || '').toLowerCase();
    // claude-opus-4-7 / claude-opus-4-8 等高版本走 1M 价 (1M context premium)
    if (s.includes('opus')) {
      const m = s.match(/opus-(\d+)-(\d+)/);
      if (m && parseInt(m[2], 10) >= 5) return PRICING.opus1m;
      return PRICING.opus;
    }
    if (s.includes('sonnet')) {
      const m = s.match(/sonnet-(\d+)-(\d+)/);
      if (m && parseInt(m[2], 10) >= 5) return PRICING.sonnet1m;
      return PRICING.sonnet;
    }
    if (s.includes('haiku')) return PRICING.haiku;
    return PRICING.sonnet; // 兜底
  }
  let totalUsd = 0;
  for (const [model, u] of Object.entries(byModel)) {
    const p = priceFor(model);
    totalUsd += (u.input * p.input + u.output * p.output + u.cacheCreate * p.cacheCreate + u.cacheRead * p.cacheRead) / 1000000;
  }
  // 汇率按 7.2 估算 (人民币)
  const totalRmb = totalUsd * 7.2;

  return {
    messages: totalMessages,
    models: byModel,
    sessions: sessionFiles.size,
    totalUsd: totalUsd,
    totalRmb: totalRmb,
  };
}

// `tinker goodnight` · 今日总结 · 给 sleepy 时刻收个尾
// 也被 GOODNIGHT 关键词触发器命中时自动出现
async function cmdGoodnight(opts = {}) {
  const cfg = opts.json
    ? (loadConfig() || (errJson('还没配置 · 先跑 tinker login', 'NO_CONFIG'), null))
    : mustHaveConfig();
  if (!cfg) return;

  // 时间范围:--week 7 天 · --month 30 天 · --days N 自定义 · 默认今日
  const daysBack = opts.month ? 30 : opts.week ? 7 : (opts.daysBack || 1);
  const periodLabel = daysBack >= 30 ? '近 30 天' : daysBack >= 7 ? '近 7 天' : '今日';
  const isMultiDay = daysBack > 1;

  // 1. git commits in range (cwd 是 git repo 的话)
  let gitCommits = [];
  let gitStat = null;
  if (inGitRepo()) {
    try {
      const since = (() => {
        const d = new Date();
        d.setDate(d.getDate() - (daysBack - 1));
        d.setHours(4, 0, 0, 0);
        return d.toISOString().slice(0, 10) + ' 04:00';
      })();
      gitCommits = execSync(`git log --since="${since}" --no-merges --pretty=format:"%h|%s|%ai"`, { encoding: 'utf-8' })
        .trim().split('\n').filter(Boolean).map(l => {
          const [sha, msg, at] = l.split('|');
          return { sha, msg, at };
        });
      const stat = execSync(`git log --since="${since}" --no-merges --shortstat --pretty=format:""`, { encoding: 'utf-8' }).trim();
      // shortstat 每条 commit 一行 · 全部累加
      let files = 0, ins = 0, del = 0;
      stat.split('\n').forEach(line => {
        const m = line.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
        if (m) { files += +m[1] || 0; ins += +m[2] || 0; del += +m[3] || 0; }
      });
      gitStat = { files, ins, del };
    } catch {}
  }

  // 2. updates pushed to Tinker (按范围)
  let todayUpdates = [];
  try {
    const state = await apiState(cfg);
    // 范围起始: 当前时间往回 daysBack 天 · 凌晨 4 点
    const rangeStart = (() => { const d = new Date(); d.setDate(d.getDate() - (daysBack - 1)); d.setHours(4, 0, 0, 0); return d.getTime(); })();
    for (const p of state.projects) {
      if (p.owner !== cfg.handle) continue;
      for (const u of (p.updates || [])) {
        if (u.at >= rangeStart) todayUpdates.push({ projectName: p.name, text: u.text, at: u.at, kind: u.kind });
      }
    }
  } catch {}

  // 3. LLM token 用量
  const usage = getTodayLLMUsage();
  const totalTokens = usage.reduce((sum, u) => sum + (u.tokens || 0), 0);
  const usageByKind = {};
  usage.forEach(u => { usageByKind[u.kind] = (usageByKind[u.kind] || 0) + u.tokens; });

  // 4. 时间跨度
  let firstAt = null, lastAt = null;
  if (gitCommits.length > 0) {
    firstAt = new Date(gitCommits[gitCommits.length - 1].at);
    lastAt = new Date(gitCommits[0].at);
  }

  // Claude Code 今日 token (已统一拉了 · JSON 也要用)
  const ccUsageEarly = getClaudeCodeUsageToday({ daysBack });

  // JSON 输出 (AI agent 用 · 跳过人类可读)
  if (opts.json) {
    const projectCounts = {};
    todayUpdates.forEach(u => { projectCounts[u.projectName] = (projectCounts[u.projectName] || 0) + 1; });
    outputJson({
      ok: true,
      date: new Date().toISOString().slice(0, 10),
      coding: {
        commits: gitCommits.length,
        spanHours: firstAt && lastAt ? +((lastAt - firstAt) / 3600 / 1000).toFixed(2) : null,
        files: gitStat ? gitStat.files : 0,
        ins: gitStat ? gitStat.ins : 0,
        del: gitStat ? gitStat.del : 0,
        firstCommit: gitCommits.length > 0 ? gitCommits[gitCommits.length - 1].msg : null,
        lastCommit: gitCommits.length > 0 ? gitCommits[0].msg : null,
      },
      claudeCode: ccUsageEarly && ccUsageEarly.messages > 0 ? {
        messages: ccUsageEarly.messages,
        sessions: ccUsageEarly.sessions,
        models: ccUsageEarly.models,
        estimatedUsd: +ccUsageEarly.totalUsd.toFixed(2),
        estimatedRmb: +ccUsageEarly.totalRmb.toFixed(2),
      } : null,
      tinker: {
        updates: todayUpdates.length,
        byProject: projectCounts,
      },
    });
    return;
  }

  // 输出
  log('');
  const titleText = daysBack === 1 ? '晚安 · 今日总结' : daysBack === 7 ? '周总结 · ' + periodLabel : daysBack === 30 ? '月总结 · ' + periodLabel : '总结 · ' + periodLabel;
  log(sepia('  ── ') + vermilion(titleText) + sepia(' ── ') + sepia(new Date().toLocaleDateString()));
  log('');

  log('  ' + bold('Coding'));
  if (gitCommits.length === 0) {
    log(sepia('    今天没在这个 repo commit · 是去别的项目了 / 还是没动手'));
  } else {
    log(sepia('    commit ') + bold(gitCommits.length + ' 个') + sepia(' · 跨 ') + bold(((lastAt - firstAt) / 3600 / 1000).toFixed(1) + ' 小时'));
    if (gitStat) log(sepia('    动了 ') + bold(gitStat.files + ' 个文件') + sepia(' · +') + moss(gitStat.ins) + sepia(' / -') + vermilion(gitStat.del));
    log(sepia('    第一条: ') + sepia(gitCommits[gitCommits.length - 1].msg.slice(0, 60)));
    log(sepia('    最后一条: ') + sepia(gitCommits[0].msg.slice(0, 60)));
  }
  log('');

  // Claude Code 今日 token 用量 (复用上面 ccUsageEarly · 避免重新扫一遍 jsonl)
  const ccUsage = ccUsageEarly;
  if (ccUsage && ccUsage.messages > 0) {
    log('  ' + bold('Coding 跟 AI'));
    log(sepia('    Claude Code ') + bold(ccUsage.messages + ' 条 assistant') + sepia(' · 跨 ') + bold(ccUsage.sessions + ' 个 session'));
    // 按 model 分行
    for (const [model, u] of Object.entries(ccUsage.models)) {
      const totalInput = u.input + u.cacheCreate + u.cacheRead;
      log(sepia('      · ') + model + sepia(' · 入 ') + sepia(totalInput.toLocaleString()) + sepia(' (') + sepia('cache 读 ' + u.cacheRead.toLocaleString()) + sepia(') · 出 ') + sepia(u.output.toLocaleString()));
    }
    log(sepia('    估算成本 $') + bold(ccUsage.totalUsd.toFixed(2)) + sepia(' ≈ ¥') + bold(ccUsage.totalRmb.toFixed(2)) + sepia(' (粗略 · 实际看 Anthropic console)'));
    log('');
  }

  log('  ' + bold('Tinker'));
  if (todayUpdates.length === 0) {
    log(sepia('    今天没发任何 update'));
  } else {
    log(sepia('    push ') + bold(todayUpdates.length + ' 条 update'));
    const projectCounts = {};
    todayUpdates.forEach(u => { projectCounts[u.projectName] = (projectCounts[u.projectName] || 0) + 1; });
    Object.entries(projectCounts).forEach(([name, n]) => log(sepia('      · ') + name + sepia(' ×') + bold(n)));
  }

  // 反馈闭环 (v0.12): 自己的方法被别人借了几次
  // 沉默是金 · 0 次完全不显示 · 不让这段变成压力
  try {
    const days = daysBack >= 30 ? 30 : daysBack >= 7 ? 7 : 1;
    const r = await safeFetch(cfg, '/api/method/borrows-for-me?days=' + days, { headers: authHeaders(cfg) });
    const borrows = await r.json();
    if (borrows && borrows.total > 0) {
      log('');
      const periodWord = days >= 30 ? '近 30 天' : days >= 7 ? '近 7 天' : '今天';
      log(sepia('    你的方法被借 ') + bold(borrows.total + ' 次') + sepia(' · ') + sepia(periodWord));
      borrows.byUpdate.slice(0, 3).forEach(b => {
        const by = b.lastBorrower ? '@' + b.lastBorrower : '(匿名)';
        log(sepia('      · ') + b.projectName + sepia(' · ') + b.excerpt.slice(0, 32) + sepia('... · ×') + bold(b.count) + sepia(' · 最近 ') + by);
      });
    }
  } catch {}

  // v0.12 触发器今日 (从 prompt-state.json) · 让作者看见触发器系统在后台做了什么
  // 0 命中沉默不显示 · 跟方法被借同样的"压力友好"原则
  try {
    const ps = loadPromptState();
    const tk = todayKey();
    if (ps.todayTriggerHits && ps.todayTriggerHits.date === tk) {
      const ws = ps.todayTriggerHits.winners || {};
      const kinds = Object.keys(ws).sort((a, b) => ws[b].count - ws[a].count);
      if (kinds.length > 0) {
        log('');
        log(sepia('    触发器 (后台默默工作):'));
        kinds.forEach(k => {
          const w = ws[k];
          const supStr = w.suppressed > 0 ? sepia(' (其中 ' + w.suppressed + ' 次被冷却拦)') : '';
          log(sepia('      · ') + k + sepia(' ×') + bold(w.count) + supStr);
        });
        log(sepia('    要看为什么没 prompt: ') + vermilion('tinker triggers'));
      }
    }
  } catch {}

  // v0.12 踩坑跟踪今日 · 透明展示状态机在后台干了什么
  try {
    const struggleMod = getStruggleModule();
    const ps = loadPromptState();
    const todayStart = (() => { const d = new Date(); d.setHours(4, 0, 0, 0); return d.getTime(); })();
    const recent = struggleMod.listDossiers({ limit: 20 })
      .filter(d => d.startedAt >= todayStart);
    const cur = ps.currentStruggle;
    const isCurrentToday = cur && cur.startedAt >= todayStart;
    if (recent.length > 0 || isCurrentToday) {
      log('');
      log(sepia('    踩坑跟踪 (Tinker 替你记的现场):'));
      if (isCurrentToday) {
        log(sepia('      · ') + bold('正在跟踪') + sepia(' · ') + (cur.topic || '(未推断)')
          + sepia(' · ') + (cur.signals || []).length + ' 信号'
          + (cur.resolved ? moss(' · 已破局') : vermilion(' · 还在折腾')));
      }
      recent.filter(d => !cur || d.id !== cur.id).forEach(d => {
        const when = new Date(d.startedAt).toTimeString().slice(0, 5);
        log(sepia('      · ') + when + sepia(' · ') + (d.topic || '(无)')
          + sepia(' · ') + (d.signals || []).length + ' 信号'
          + (d.resolved ? moss(' · 破局') : sepia(' · 未完')));
      });
      log(sepia('    要看具体或关闭: ') + vermilion('tinker struggle'));
    }
  } catch {}
  log('');

  // Tinker 自己用 LLM 帮起草 / 分析 / narrate 的 token 用量是自指 · 不在晚安里显示
  // 想看就跑 tinker llm usage (单独命令)

  if (cfg.llm && cfg.llm.apiKey && (gitCommits.length > 0 || todayUpdates.length > 0) && !opts.narrate) {
    log(sepia('  让 AI 帮你 narrate 一下? 想要就跑 ') + vermilion('tinker goodnight --narrate'));
    log('');
  }

  if (opts.narrate && cfg.llm && cfg.llm.apiKey) {
    log(sepia('  AI 总结中...'));
    const commitsLine = gitCommits.slice(0, 12).map(c => '- ' + c.msg).join('\n');
    const updatesLine = todayUpdates.slice(0, 6).map(u => '- (' + u.projectName + ') ' + u.text.slice(0, 80)).join('\n');
    const prompt = `今天的 git commits:\n${commitsLine}\n\n今天发到 Tinker 的 updates:\n${updatesLine || '(无)'}\n\n用一段话 (80-150 字) 替作者收个尾 · 准备睡觉 · 语气朋友式 · 不总结 · 给一句你觉得最值得说的 · 一句"明天接着搞"那种话。不要"总结今天"那种 PM 周报开头。`;
    try {
      const r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.llm.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-chat', max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
      });
      if (r.ok) {
        const d = await r.json();
        recordLLMUsage(cfg.llm.provider, d.usage && d.usage.total_tokens, 'goodnight');
        log('');
        log('  ' + bold('AI 帮你说一句:'));
        const cleaned = sanitizeDraft(d.choices[0].message.content.trim()) || '';
        log(sepia('  ') + cleaned.replace(/\n/g, '\n  '));
        log('');
      }
    } catch {}
  }

  // v0.88 给 maybe-goodnight 用 · 标记今天已收尾 · 让对话触发器今晚不再 prompt
  // 仅今日范围 · --week / --month 不算今日收尾
  if (daysBack === 1) {
    const ps = loadPromptState();
    ps.lastGoodnightDate = todayKey();
    savePromptState(ps);
  }

  log(sepia('  晚安。'));
  log('');
}

// v0.88 `tinker maybe-goodnight` · 静默检查"今天值得收尾吗"
// 给 Claude Code user-prompt-submit-hook 调用 · 听到"晚安/收工"等词时跑这个
// 命中条件 → stdout 输出一行 reminder 给 hook 注入对话
// 不命中 → 静默退出 · stdout 空
function cmdMaybeGoodnight() {
  // 今日已 goodnight 过 → 静默
  const ps = loadPromptState();
  if (ps.lastGoodnightDate === todayKey()) return;
  // 不在 git repo → 静默 · 没法判断今日活动
  if (!inGitRepo()) return;
  // 今日 commit 数 (本地今日 4am 起算 · todayKey 返回本地日期 · 不走 toISOString UTC 坑)
  let commitCount = 0;
  try {
    const since = `${todayKey()} 04:00`;
    const out = execSync(`git log --since="${since}" --no-merges --oneline`, { encoding: 'utf-8' }).toString().trim();
    commitCount = out ? out.split('\n').length : 0;
  } catch { return; }
  if (commitCount === 0) return;
  // 命中 · 输出 reminder 给 hook 注入到 Claude Code 对话
  process.stdout.write(`用户今天在当前 repo commit 了 ${commitCount} 次但还没跑 tinker goodnight 收尾 · 用户刚说了收工类的话 · 可以主动提醒一下\n`);
}

// v0.12 `tinker struggle` · 看 / 关 / 重新激活 当前 struggle 状态
// 信任建设:让用户能看见 Tinker 在后台跟踪什么 · 能一键关
async function cmdStruggle(sub, opts = {}) {
  const struggleMod = getStruggleModule();
  const state = loadPromptState();
  const now = Date.now();

  const action = (sub || 'status').toLowerCase();

  if (action === 'status') {
    const cur = state.currentStruggle;
    if (opts.json) {
      const optedOut = state.struggleOptOutUntil && state.struggleOptOutUntil > now;
      const recent = struggleMod.listDossiers({ limit: 5 });
      return outputJson({
        ok: true,
        currentStruggle: cur ? {
          id: cur.id,
          topic: cur.topic,
          startedAt: cur.startedAt,
          endedAt: cur.endedAt || null,
          signalCount: (cur.signals || []).length,
          resolved: !!cur.resolved,
        } : null,
        optedOut: !!optedOut,
        optedOutUntil: optedOut ? state.struggleOptOutUntil : null,
        recent: recent.map(d => ({
          id: d.id, topic: d.topic, signals: (d.signals || []).length,
          resolved: !!d.resolved, startedAt: d.startedAt, endedAt: d.endedAt || null,
        })),
      });
    }
    log('');
    log(bold('Tinker 踩坑跟踪状态'));
    log('');
    if (state.struggleOptOutUntil && state.struggleOptOutUntil > now) {
      log(sepia('  跟踪已关 · 到 ' + new Date(state.struggleOptOutUntil).toLocaleString()));
      log(sepia('  重新开启: ') + vermilion('tinker struggle on'));
      log('');
      return;
    }
    if (!cur) {
      log(sepia('  当前没在跟踪任何 struggle · 安静'));
    } else {
      const span = Math.round((now - cur.startedAt) / 60000);
      log(sepia('  当前 struggle:'));
      log(sepia('    id     ') + cur.id);
      log(sepia('    话题   ') + bold(cur.topic || '(未推断)'));
      log(sepia('    起始   ') + new Date(cur.startedAt).toLocaleString() + sepia(` (${span} 分钟前)`));
      log(sepia('    信号   ') + bold((cur.signals || []).length + ' 条'));
      log(sepia('    状态   ') + (cur.resolved ? moss('已破局 (等草稿就绪 + 发)') : vermilion('还在折腾')));
    }
    const recent = struggleMod.listDossiers({ limit: 5 });
    const others = recent.filter(d => !cur || d.id !== cur.id);
    if (others.length > 0) {
      log('');
      log(sepia('  最近 ' + others.length + ' 段 (已存档):'));
      others.forEach(d => {
        const when = new Date(d.startedAt).toISOString().slice(0, 10);
        log(sepia('    · ') + when + sepia(' · ') + (d.topic || '(无)')
          + sepia(' · ') + (d.signals || []).length + ' 信号'
          + (d.resolved ? moss(' · 破局') : vermilion(' · 未完')));
      });
    }
    log('');
    log(sepia('  关闭跟踪 (24h): ') + vermilion('tinker struggle off'));
    log('');
    return;
  }

  if (action === 'off') {
    state.struggleOptOutUntil = now + 24 * 60 * 60 * 1000;
    state.currentStruggle = null;  // 顺手清掉
    savePromptState(state);
    if (opts.json) return outputJson({ ok: true, optedOutUntil: state.struggleOptOutUntil });
    log(sepia('  跟踪关了 · 到 ' + new Date(state.struggleOptOutUntil).toLocaleString()));
    log(sepia('  重新开启: ') + vermilion('tinker struggle on'));
    return;
  }

  if (action === 'on') {
    state.struggleOptOutUntil = null;
    savePromptState(state);
    if (opts.json) return outputJson({ ok: true });
    log(sepia('  跟踪开了'));
    return;
  }

  if (action === 'reset') {
    // v0.13 清掉当前 currentStruggle · 让状态机下次 cmdCheck 重新评估
    // 用于:lifecycle 类型误判时手动 reset (比如本来是 design-loop 被识别成 learning)
    const previousId = state.currentStruggle ? state.currentStruggle.id : null;
    state.currentStruggle = null;
    savePromptState(state);
    if (opts.json) return outputJson({ ok: true, cleared: previousId });
    if (previousId) {
      log(sepia('  清掉了: ') + bold(previousId));
      log(sepia('  下次 git commit 触发 hook 时会重新评估 · 也可以现在跑 ') + vermilion('tinker check'));
    } else {
      log(sepia('  当前没在跟踪 · 没什么可清'));
    }
    return;
  }

  if (opts.json) return errJson('用法: tinker struggle [status|off|on|reset]', 'BAD_ARG');
  err('用法: tinker struggle [status|off|on|reset]');
}

// v0.12 Breakthrough Autopsy
// 后台 detached child 调用 · tinker __autopsy <struggleId>
// 把 dossier 整理成四段 markdown · 写到 <repo>/.tinker/drafts/experience-<topic>.md
// 不阻塞主 hook · 失败容错 (fallback 到 template-based)
// v0.13 backfill 命令 · 用户主动回溯过往推演 / 学习 / 踩坑
// tinker situation backfill --type design-loop --hours 6
// 扫最近 N 小时 Claude 对话 · 构造 resolved dossier · 同步起草草稿
async function cmdSituationBackfill(opts) {
  const struggleMod = getStruggleModule();
  const hours = parseInt(opts.hours, 10) || 4;
  const type = opts.type || 'design-loop';
  const config = struggleMod.LIFECYCLE_CONFIGS[type];
  if (!config) {
    if (opts.quiet) return;  // hook 调用时安静失败 · 不卡 Claude Code
    err('不支持的 lifecycle 类型: ' + type + ' · 可用: ' + Object.keys(struggleMod.LIFECYCLE_CONFIGS).join(' / '));
    process.exit(1);
  }

  if (!opts.quiet) {
    log('');
    log(bold('━━━ tinker situation backfill ━━━'));
    log(sepia('  类型: ') + config.label + sepia(' · 时间窗: ') + hours + sepia(' 小时'));
    log('');
  }

  // 扫整个 N 小时 · cwd 跟 parent 都试
  const scan = struggleMod.scanClaudeRecent({ minutesBack: hours * 60, cwd: process.cwd() });
  if (scan.userMessages.length < 5) {
    if (opts.quiet) return;
    err('扫到只 ' + scan.userMessages.length + ' 条 user message · 太少 · 调大 --hours 试试');
    process.exit(1);
  }

  // 信号:匹配该 lifecycle 的 matchSignal
  const signalType = type === 'struggle' ? 'claude_fail' :
                     type === 'learning' ? 'claude_explore' :
                     type === 'design-loop' ? 'claude_debate' : 'claude';
  const signals = scan.userMessages
    .filter(m => config.matchSignal(m.text))
    .map(m => ({ at: m.ts, type: signalType, text: m.text.slice(0, 200) }));

  if (signals.length < 3) {
    if (opts.quiet) return;
    err('信号数 ' + signals.length + ' 太少 · 这段时间可能不是 ' + config.label + ' · 试别的 --type');
    process.exit(1);
  }

  const now = Date.now();
  const dossier = {
    id: type + '-backfill-' + new Date(now).toISOString().slice(0, 16).replace(/[-T:]/g, ''),
    lifecycleType: type,
    startedAt: scan.userMessages[0].ts,
    endedAt: scan.userMessages[scan.userMessages.length - 1].ts,
    justResolvedAt: now,
    resolved: true,
    consented: true,
    backfilled: true,
    signals,
    topic: struggleMod.inferTopic(signals),
  };
  struggleMod.saveDossier(dossier);

  if (!opts.quiet) {
    log(sepia('  扫到: ') + bold(scan.userMessages.length + ' 条 user message'));
    log(sepia('  信号: ') + bold(signals.length + ' 条匹配'));
    log(sepia('  话题推断: ') + bold(dossier.topic || '(未推)'));
    log(sepia('  dossier id: ') + dossier.id);
    log('');
    log(sepia('  起草中 (调 LLM · 可能需要 10-20 秒)...'));
    log('');
  }

  // 同步跑 autopsy · 不 spawn 因为用户主动等结果
  // hook 场景下也同步等 · 因为 SessionStart 后用户会立刻看新 Claude session · 草稿要就绪
  try {
    await cmdAutopsy(dossier.id, type);
  } catch (e) {
    if (opts.quiet) return;  // hook 场景失败安静吞 · 不卡 Claude Code
    throw e;
  }

  // 找新写的草稿 (按 mtime 排序)
  const draftDir = path.join(process.cwd(), '.tinker', 'drafts');
  if (fs.existsSync(draftDir)) {
    const drafts = fs.readdirSync(draftDir)
      .filter(f => f.endsWith('.md') && f.startsWith(config.draftPrefix + '-'));
    if (drafts.length > 0) {
      const newest = drafts
        .map(f => ({ f, mtime: fs.statSync(path.join(draftDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0];
      const draftPath = path.join('.tinker/drafts', newest.f);
      if (opts.quiet) {
        // quiet 模式仍输出一行 · 给 Claude Code 用户看
        log(moss('  ✓ Tinker 起草了 ' + config.label + '草稿: ') + draftPath);
        log(sepia('     发: ') + vermilion(`tinker push ${draftPath} --as-${config.productTag}`));
      } else {
        log(moss('  ✓ 草稿就绪: ') + draftPath);
        log('');
        log(sepia('  改完一键发: ') + vermilion(`tinker push ${draftPath} --as-${config.productTag}`));
        log(sepia('  或者打开看一眼:'));
        log(sepia('    ') + vermilion('cat ' + draftPath));
      }
    }
  }
  if (!opts.quiet) log('');
}

async function cmdAutopsy(situationId, lifecycleTypeArg) {
  const struggle = getStruggleModule();
  const dossier = struggle.loadDossier(situationId);
  if (!dossier) return;  // 静默退出 · detached 不让用户看到错误

  // v0.13 lifecycle 框架 · type 来源优先: 显式参数 > dossier 字段 > 'struggle' (兼容老 dossier)
  const lifecycleType = lifecycleTypeArg || dossier.lifecycleType || 'struggle';
  const config = struggle.LIFECYCLE_CONFIGS[lifecycleType] || struggle.LIFECYCLE_CONFIGS.struggle;

  const draftDir = path.join(process.cwd(), '.tinker', 'drafts');
  fs.mkdirSync(draftDir, { recursive: true });

  // 文件名:experience-<safe-topic>-<short-id>.md / learning-<safe-topic>-<short-id>.md
  const safeTopic = (dossier.topic || 'unknown')
    .replace(/[\s\\/:*?"<>|]+/g, '-')
    .slice(0, 30);
  const shortId = dossier.id.slice(-6);
  const draftFile = path.join(draftDir, `${config.draftPrefix}-${safeTopic}-${shortId}.md`);

  // 收集 git 上下文 (突破那一刻的 fix / done commit)
  let fixTitle = '', fixBody = '', fixDiff = '';
  try {
    fixTitle = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
    fixBody = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim();
    fixDiff = execSync('git diff HEAD~1 HEAD --stat 2>/dev/null', { encoding: 'utf-8' }).trim().slice(0, 500);
  } catch {}

  // 组织 signals 时序 (按时间排序)
  const sortedSignals = (dossier.signals || []).slice().sort((a, b) => a.at - b.at);
  const signalLines = sortedSignals.slice(0, 20).map(s => {
    const when = new Date(s.at).toISOString().slice(11, 16);
    if (s.type === 'wip_commit') return `[${when}] commit · ${s.text || s.sha || ''}`;
    if (s.type === 'claude_fail') return `[${when}] 对话 · ${(s.text || '').slice(0, 100)}`;
    if (s.type === 'claude_explore') return `[${when}] 问 AI · ${(s.text || '').slice(0, 100)}`;
    return `[${when}] ${s.type} · ${(s.text || s.snippet || '').slice(0, 100)}`;
  }).join('\n');

  // 拉 voice 上下文
  const cfg = loadConfig();
  const hasLLM = cfg && cfg.llm && cfg.llm.apiKey;
  let voiceContext = '';
  try {
    const fp = loadFingerprint();
    if (fp) voiceContext = fp.slice(0, 1000);
  } catch {}

  const ctx = {
    topic: dossier.topic || '未命名',
    lifecycleType,
    spanHours: dossier.endedAt
      ? Math.max(0.1, Math.round((dossier.endedAt - dossier.startedAt) / 360000) / 10)
      : '?',
    signalLines, fixTitle, fixBody, fixDiff, voiceContext,
  };

  let markdown;
  if (hasLLM) {
    try {
      markdown = await llmAutopsy(cfg, ctx);
    } catch (e) {
      markdown = templateAutopsy({ dossier, lifecycleType, signalLines, fixTitle, fixBody });
    }
  } else {
    markdown = templateAutopsy({ dossier, lifecycleType, signalLines, fixTitle, fixBody });
  }

  // frontmatter · 标记 lifecycle type + product tag (给 push --as-X 用)
  const frontmatter = [
    '---',
    `situation_id: ${dossier.id}`,
    `lifecycle_type: ${lifecycleType}`,
    `topic: ${dossier.topic || ''}`,
    `started_at: ${new Date(dossier.startedAt).toISOString()}`,
    `ended_at: ${dossier.endedAt ? new Date(dossier.endedAt).toISOString() : ''}`,
    `signals: ${(dossier.signals || []).length}`,
    `as_${config.productTag}: true`,
    `generated_by: ${hasLLM ? 'llm' : 'template'}`,
    '---',
    '',
  ].join('\n');

  fs.writeFileSync(draftFile, frontmatter + markdown);
}

// LLM 调用 · 直接返 markdown · 不解析 JSON
// v0.13 按 lifecycleType 切 prompt 模板:struggle 写"踩坑经验" · learning 写"上手指南"
async function llmAutopsy(cfg, ctx) {
  const provider = cfg.llm.provider || 'anthropic';
  const apiKey = cfg.llm.apiKey;

  const lifecycleType = ctx.lifecycleType || 'struggle';
  const isLearning = lifecycleType === 'learning';
  const isDesignLoop = lifecycleType === 'design-loop';

  const taskLine = isLearning
    ? '你的任务: 把这次学新东西的过程整理成一篇能帮其他 vibe coder 快速上手的指南。'
    : isDesignLoop
    ? '你的任务: 把这次产品决策推演整理成一篇能帮其他 vibe coder 学 product sense 的样本。'
    : '你的任务: 把这次踩坑过程整理成一篇能帮其他 vibe coder 少踩坑的经验贴。';

  const infoLabel = isLearning ? '这次学习信息' : isDesignLoop ? '这次推演信息' : '这次踩坑信息';
  const commitLabel = isLearning ? '关键完成那一笔 commit' : isDesignLoop ? '相关 commit (推演不一定 commit 代码)' : '突破那一笔 commit';

  const designLoopTemplate = `工作日志气质 · 一段连贯的散文 · 不用 ## 标题切段 · 不用 bullet 列表 ·
段落之间用空行隔开 · 长度 200-400 字。

像作者平时写的进展那样:第一段直接说"刚理清楚一件事 / 想明白了..." 然后顺着叙述。

要包含的内容 (但用散文连起来 · 不是分点):
  1. 这次理清的核心问题是什么 (具体 · 不是 meta · 来自 signals 反复出现的具体业务名词)
  2. 真实考虑过的几种路径 (用"想过 X · 也想过 Y · 还试过 Z" 这种自然语言)
  3. 各自的权衡 (引用 signals 里出现过的具体约束 · 比如"alpha 期"  "vibe coder 新手")
  4. 最后选了什么 · 决定性理由

参考已有 update 气质 (作者自己写过的):
  "邮箱登录从代码到能真发出去 · 中间和阿里云邮件服务纠缠了 6 个小时。
   重设了 3 次密码、改了 2 次端口、查了 5 个怀疑点(账号未实名?账号余额?...) · 全部排除。
   ...
   问题在我们用的邮件库默认走 PLAIN 认证 · 阿里云只认 LOGIN。两行配置改完立刻通。"

  这是踩坑的真实 voice · 决策推演也用这种工作日志连贯叙事的气质。`;

  const learningTemplate = `工作日志气质 · 一段连贯的散文 · 不用 ## 标题切段 · 不用 bullet 列表 ·
段落之间用空行隔开 · 长度 200-400 字。

像作者写真实学习笔记那样:开头直接说"今天/这段时间把 X 大概搞清楚了" 然后顺着叙述。

要包含 (用散文连起来 · 不是分点):
  1. 想学什么具体技术 (来自 signals 的具体 SDK / API / 框架名)
  2. 几个核心概念是怎么想清楚的 (用散文描述心智模型 · 不列表)
  3. 入门时踩到的坑 (教程不会告诉的事 · 用"试了 X 发现 Y" 的叙事)
  4. 最后怎么跑通的 (含关键配置 / 代码片段 · 但用 inline 引号嵌进散文 · 不用 code block)

参考已有 update 气质:作者写阿里云邮件那段就是范例 · 保留具体错误码 / 配置名 ·
但全部用连贯散文 · 不用 markdown 装饰。`;

  const struggleTemplate = `工作日志气质 · 一段连贯的散文 · 不用 ## 标题切段 · 不用 bullet 列表 ·
段落之间用空行隔开 · 长度 200-400 字。

参考作者真实写过的踩坑总结 (照这个 voice 写):
  "邮箱登录从代码到能真发出去 · 中间和阿里云邮件服务纠缠了 6 个小时。
   重设了 3 次密码、改了 2 次端口、查了 5 个怀疑点(账号未实名?账号余额?...) · 全部排除。
   问题在我们用的邮件库默认走 PLAIN 认证 · 阿里云只认 LOGIN。两行配置改完立刻通。"

要包含 (用散文连起来 · 不是分点):
  1. 撞到什么具体问题 (含错误码 / 平台 / 表现)
  2. 试过的几条路 (用"试了 X 不行 · 又改了 Y 还是不行" 这种自然叙事)
  3. 最后发现的真正原因 (具体到平台限制 / 配置细节)
  4. 怎么解决的 (含关键配置 · 用 inline 引号嵌进散文 · 不要 code block)`;

  const outputTemplate = isDesignLoop ? designLoopTemplate : isLearning ? learningTemplate : struggleTemplate;

  const sceneSpecificConstraints = isLearning ? [
    '- ★ 工作日志气质 · 不是教程/文档气质 (这是 update 进展 · 不是方法库)',
    '  不用 ## 标题 · 不用 bullet 列表 · 不用 code block · 一段段散文',
    '- 用作者真实 voice · 自然段落 + 中文标点',
    '- 写给"也在想学这东西" 的读者 · 是工作笔记不是教程',
    '- 真实保留你撞过的具体陷阱 (跟教程的差异 · 自己摸过的边)',
    '- 含关键技术细节 (具体 SDK 版本 / API 名 / 配置) · 但用 inline 引号嵌进散文',
    '- 200-400 字 · 不必长 · 工作日志就该克制',
  ] : isDesignLoop ? [
    '- ★ 工作日志气质 · 不是文档/说明书气质',
    '  不用 ## 标题 · 不用 bullet · 一段一段连贯叙事',
    '- ★ 主题必须来自 signals 实际讨论的具体事 · 不是 meta 抽象',
    '  反例: "决策怎么沉淀给别人复用"  "推演机制怎么打造"  这种 meta 元话题不可接受',
    '  正例: "方法跟进展项目是什么关系"  "接走该不该改名启发"  "borrow 搜什么池"',
    '- 用作者真实 voice (从 fingerprint 学) · 自然段落 + 中文标点',
    '- 真实保留考虑过但拒绝的方案 · 但用"想过 X 也试过 Y" 散文连',
    '- 权衡引用 signals 里的具体约束 (alpha 期 / 用户量 / 信息密度 / 自动化优先)',
    '- 不下"正确答案" 定论 · 决策有上下文 · 别人换上下文可能选别的',
    '- 200-400 字 · 不必长 · 工作日志就该克制',
  ] : [
    '- ★ 工作日志气质 · 不是教程/文档气质 (这是 update 进展 · 不是方法库)',
    '  不用 ## 标题 · 不用 bullet 列表 · 不用 code block · 一段段散文',
    '- 用作者真实 voice · 自然段落 + 中文标点',
    '- 不替作者编情绪 · "终于" 这种词只在 commit msg 真说过时用',
    '- 保留具体平台名 / 错误码 / 配置 (这些是检索的钩子) · 但用 inline 引号嵌进散文',
    '- 200-400 字 · 工作日志就该克制 · 不必长',
  ];

  const prompt = `${taskLine}

==================
作者 voice 上下文 (照这个气质写)
==================
${ctx.voiceContext || '(暂无 voice fingerprint · 用工艺人日志气质 · 中文 · 不堆中圆点 / em-dash / italic / ALL_CAPS)'}

==================
${infoLabel}
==================
话题: ${ctx.topic}
跨度: ${ctx.spanHours} 小时

时序信号 (按时间排序 · 节选):
${ctx.signalLines || '(无)'}

${commitLabel}:
title: ${ctx.fixTitle}
body: ${ctx.fixBody || '(无 body)'}
diff: ${ctx.fixDiff || '(无 diff)'}

==================
输出
==================
严格按这四段 markdown 输出 · 每段标题用 ##:

${outputTemplate}

约束:
- 用作者真实 voice
- 不堆中圆点 (·) · 不堆 em-dash · 不堆 italic · 不 ALL_CAPS
${sceneSpecificConstraints.join('\n')}
- 不要写"总结" 或 "结论" 段 · 四段就是全部
- 不要任何 LLM 自我介绍 · 直接出正文`;

  let rawText;
  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.llm.model || 'claude-sonnet-4-5-20250929',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || 'API ' + res.status);
    rawText = data.content[0].text.trim();
    recordLLMUsage(provider, data.usage && (data.usage.input_tokens + data.usage.output_tokens), 'autopsy');
  } else if (provider === 'deepseek') {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.llm.model || 'deepseek-chat',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || 'API ' + res.status);
    rawText = data.choices[0].message.content.trim();
    recordLLMUsage(provider, data.usage && data.usage.total_tokens, 'autopsy');
  } else if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.llm.model || 'gpt-4o-mini',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || 'API ' + res.status);
    rawText = data.choices[0].message.content.trim();
    recordLLMUsage(provider, data.usage && data.usage.total_tokens, 'autopsy');
  } else {
    throw new Error('不支持的 LLM provider: ' + provider);
  }

  // sanitize · 去 em-dash / 多余中圆点 / ANSI / 代码块包裹
  rawText = rawText.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '');
  if (typeof sanitizeDraft === 'function') {
    rawText = sanitizeDraft(rawText);
  }
  return rawText;
}

// LLM 失败时的 fallback · 不调任何 API · 直接拼时序
// v0.13 按 lifecycleType 切段落
function templateAutopsy({ dossier, lifecycleType = 'struggle', signalLines, fixTitle, fixBody }) {
  const isLearning = lifecycleType === 'learning';
  const isDesignLoop = lifecycleType === 'design-loop';
  const productTag = isDesignLoop ? 'decision' : isLearning ? 'learning' : 'experience';

  if (isDesignLoop) {
    return `## 我在想什么

(待补 · 看下面时序自己写一句这次推演的核心问题)

## 考虑过哪几种方案

(待补 · 列你真实推演过的所有路径 · 不是事后修饰)

${signalLines || '(信号不足 · 自己回忆补一下)'}

## 各自权衡

(待补 · 每个方案的优缺点 / 适用边界 · 这一段最有 product sense 价值)

## 选了哪种 · 为什么

(待补 · 最终决策 + 决定性理由)
${fixTitle ? '\\n相关 commit:\\n' + fixTitle : ''}

---

(LLM 没起草 · 这是 template 兜底 · 自己改完就发 · \`tinker push <这个文件> --as-${productTag}\`)
`;
  }

  if (isLearning) {
    return `(LLM 没起草 · template 兜底 · 把下面信息组成一段工作日志气质的连贯散文 · 不用 markdown 标题)

最近这段时间在搞 (具体技术 / SDK / 框架 · 看下面信号补)。

试着摸了一遍 · 几个核心概念是 (待补)。

入门时撞到的坑:
${signalLines || '(信号不足 · 自己回忆补一下)'}

最后跑通的方式:
${fixTitle}
${fixBody ? '\\n' + fixBody : ''}

---

(LLM 没起草 · 这是 template 兜底 · 改成连贯散文再发 · \`tinker push <这个文件> --as-${productTag}\`)
`;
  }

  return `(LLM 没起草 · template 兜底 · 把下面信息组成一段工作日志气质的连贯散文 · 不用 markdown 标题)

这次撞到 (待补 · 具体平台 / 错误码 / 表现 · 看下面信号)。

试了几条路:
${signalLines || '(信号不足 · 自己回忆补一下)'}

最后发现真正原因 · 解法是:
${fixTitle}
${fixBody ? '\\n' + fixBody : ''}

---

(LLM 没起草 · 这是 template 兜底 · 改成连贯散文再发 · \`tinker push <这个文件> --as-${productTag}\`)
`;
}

// `tinker session status | end` · 看 / 强制结束 当前 UI session
async function cmdSession(sub, opts = {}) {
  const state = loadPromptState();
  const session = state.uiSession;

  if (opts.json) {
    if (sub === 'end') {
      if (!session) { outputJson({ ok: true, ended: false, note: '没有 session 在进行' }); return; }
      session.startedAt = Date.now() - 61 * 60 * 1000;
      state.uiSession = session;
      savePromptState(state);
      outputJson({ ok: true, ended: true });
      return;
    }
    // status (默认)
    if (!session) {
      outputJson({ ok: true, active: false });
      return;
    }
    const elapsed = Math.round((Date.now() - session.startedAt) / 60000);
    outputJson({
      ok: true,
      active: true,
      startedAt: session.startedAt,
      startCommitHash: session.startCommitHash,
      commitCount: session.commitCount,
      elapsedMinutes: elapsed,
      beforeSnapshotPath: session.beforeSnapshotPath || null,
      endConditions: {
        timeWindowMinutesLeft: Math.max(0, 60 - elapsed),
        commitsLeft: Math.max(0, 6 - session.commitCount),
        timeExpired: elapsed >= 60,
        tooMany: session.commitCount >= 6,
      },
    });
    return;
  }

  if (sub === 'status' || !sub) {
    if (!session) {
      log(sepia('  当前没有 UI session 进行中'));
      log(sepia('  会在下一次改 webapp/* / *.html / *.css / .tsx 之类的文件时启动'));
      return;
    }
    const elapsed = Math.round((Date.now() - session.startedAt) / 60000);
    log('');
    log(sepia('  UI session 进行中:'));
    log(sepia('    起点  ') + new Date(session.startedAt).toLocaleString() + sepia(' · ') + bold(elapsed + ' 分钟前'));
    log(sepia('    起始 commit ') + sepia(session.startCommitHash.slice(0, 8)));
    log(sepia('    累积 ') + bold(session.commitCount + ' 个 UI commit'));
    log(sepia('    before 快照 ') + (session.beforeSnapshotPath ? sepia(session.beforeSnapshotPath) : sepia('(没存上)')));
    log('');
    log(sepia('  结束条件 (满足任一):'));
    log(sepia('    · 60 min 时间窗') + (elapsed >= 60 ? bold(' (已超 · 下次 commit 会触发)') : sepia(` · 还剩 ${60 - elapsed} 分钟`)));
    log(sepia('    · 累 6 commit') + (session.commitCount >= 6 ? bold(' (已超 · 下次 commit 会触发)') : sepia(` · 还差 ${6 - session.commitCount}`)));
    log(sepia('    · commit msg 写 ship/done/完工'));
    log('');
    log(sepia('  强制结束: ') + vermilion('tinker session end'));
    return;
  }
  if (sub === 'end') {
    if (!session) { log(sepia('  没有 session 在进行 · 没事可结束')); return; }
    // 直接把 session 时间往回拨 · 让下一次 check 评估为已结束
    session.startedAt = Date.now() - 61 * 60 * 1000;
    state.uiSession = session;
    savePromptState(state);
    ok('session 标记为结束 · 下次 commit 时会触发 prompt');
    log(sepia('  想立刻看到 prompt 不等下次 commit · 跑 ') + vermilion('tinker check'));
    return;
  }
  err('用法: tinker session [status|end]');
  process.exit(1);
}

// v0.3 pending file · 给 --json 模式持久化 prompt 状态 · 后续 tinker resolve 用
function pendingPath() { return path.join(CONFIG_DIR, 'pending.json'); }
function savePending(p) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(pendingPath(), JSON.stringify(p, null, 2));
}
function loadPending() {
  if (!fs.existsSync(pendingPath())) return null;
  try { return JSON.parse(fs.readFileSync(pendingPath(), 'utf-8')); } catch { return null; }
}
function clearPending() {
  if (fs.existsSync(pendingPath())) { try { fs.unlinkSync(pendingPath()); } catch {} }
}
// strip ANSI 颜色码 · JSON 里不该带终端控制符
function stripAnsi(s) { return (s || '').toString().replace(/\x1b\[[0-9;]*m/g, ''); }

// v0.4 Phase 4 · 检测作者改稿 · 保存 reject-diff 给未来 LLM 学习
// LLM 草稿放在 ~/.tinker/last-llm-draft.json (cmdDraft 生成时写)
// 跟 cmdResolve 实际发出的 text 比较 · 不一样就 save 一条 diff
function saveRejectDiffIfChanged(pending, choice, finalText) {
  if (!finalText || !finalText.trim()) return;
  try {
    const lastDraftFile = path.join(CONFIG_DIR, 'last-llm-draft.json');
    if (!fs.existsSync(lastDraftFile)) return;  // 没起草过 LLM 草稿 · 不算改稿
    const lastDraft = JSON.parse(fs.readFileSync(lastDraftFile, 'utf-8'));
    if (!lastDraft || !lastDraft.text) return;
    // 30 分钟超时 · 太久就不算同一次
    if (Date.now() - lastDraft.at > 30 * 60 * 1000) return;
    const draftText = lastDraft.text.trim();
    const final = finalText.trim();
    if (draftText === final) return;  // 没改 · 不算 reject
    // 改了 · 但不能差太多 (否则可能根本是手写的不是基于草稿改) · 用 length ratio 判断
    const lenRatio = Math.min(draftText.length, final.length) / Math.max(draftText.length, final.length);
    if (lenRatio < 0.3) return;  // 长度差超过 3 倍 · 不算同一条的改稿
    const dir = path.join(CONFIG_DIR, 'style-pool', 'reject-diff');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const out = {
      at: new Date().toISOString(),
      choice,
      project: (pending && pending.projectName) || '',
      commit: (pending && pending.commitTitle) || '',
      llmDraft: draftText,
      finalText: final,
    };
    fs.writeFileSync(path.join(dir, `${stamp}-${choice}.json`), JSON.stringify(out, null, 2));
    // 用完即删 · 防止同一草稿被多次 reject
    try { fs.unlinkSync(lastDraftFile); } catch {}
  } catch {}
}

// 给 cmdCheck (interactive mode) 用 · 构造一个 pending-like 对象给 savePoolSample
// 让交互模式手敲的 update 也进 style-pool · 跟 cmdResolve (AI 模式) 的样本平等收集
function buildPendingForSample(repoCfg, result) {
  let commitTitle = '';
  try { commitTitle = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim(); } catch {}
  return {
    projectId: repoCfg && repoCfg.projectId,
    projectName: repoCfg && repoCfg.projectName,
    kind: result && result.kind,
    commitTitle,
  };
}

// v0.4 Phase 1 · 静默收集 voice sample 到 ~/.tinker/style-pool/good/
// 每次成功 push (从 cmdResolve 或 cmdCheck) 时调一次 · 累积作者真实风格样本
// 之后 tinker voice analyze 会读这个池子总结 fingerprint
function savePoolSample(pending, choice, text, handle) {
  if (!text || !text.trim()) return;
  try {
    const dir = path.join(CONFIG_DIR, 'style-pool', 'good');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const file = path.join(dir, `${stamp}-${choice}.md`);
    const meta = [
      '---',
      `handle: ${handle || ''}`,
      `at: ${new Date().toISOString()}`,
      `choice: ${choice}`,
      `kind: ${(pending && pending.kind) || ''}`,
      `project: ${(pending && pending.projectName) || ''}`,
      `commit: ${(pending && pending.commitTitle) || ''}`,
      '---',
    ].join('\n');
    fs.writeFileSync(file, `${meta}\n\n${text.trim()}\n`);
  } catch {
    // 静默失败 · 不打扰主流程
  }
}

// v0.3 cmdResolve · 接受外部 (AI agent) 决定的 choice + 可选 text · 执行 pending 动作
// 用法:
//   tinker resolve push-decision --message "装了 fnm 替代 nvm · 启动快多了"
//   tinker resolve ship -m "..."
//   tinker resolve stuck -m "..."
//   tinker resolve later        # 不需要 text
//   tinker resolve skip-today
//   tinker resolve mute
//   tinker resolve mute-30m
//   tinker resolve skip-once
async function cmdResolve(choice, opts) {
  if (!choice) { err('用法: tinker resolve <choice-id> [-m "文本"]'); process.exit(1); }
  const pending = loadPending();
  if (!pending) { err('没有待处理的提示 (pending.json) · 先跑 tinker check --json'); process.exit(1); }
  const text = (opts && opts.text || '').trim();
  const state = loadPromptState();
  const now = Date.now();
  state.lastPromptedAt = now;

  // 文本类动作:需要 -m "..."
  const needsText = ['push', 'push-brand-self', 'push-brand-meta', 'push-decision', 'ship', 'prototype', 'stuck', 'stuck-quiet'];
  if (needsText.includes(choice) && !text) {
    err('这个动作需要文本: tinker resolve ' + choice + ' -m "一句话"');
    process.exit(1);
  }

  try {
    if (choice === 'push' || choice === 'push-brand-self' || choice === 'push-brand-meta' || choice === 'push-decision') {
      const cfg = mustHaveConfig();
      await apiAction(cfg, 'addUpdate', { projectId: pending.projectId, text });
      state.lastPushAtByProject = state.lastPushAtByProject || {};
      state.lastPushAtByProject[pending.projectId] = now;
      savePoolSample(pending, choice, text, cfg.handle);
      saveRejectDiffIfChanged(pending, choice, text);
      const okMsg = choice === 'push-decision' ? '✓ 决策记下来了' : '发出去了';
      ok(okMsg);
    } else if (choice === 'ship' || choice === 'prototype') {
      const cfg = mustHaveConfig();
      await apiAction(cfg, 'exhibitProject', {
        projectId: pending.projectId,
        kind: choice,
        statement: text,
        seekingFeedback: true,
      });
      state.lastPushAtByProject = state.lastPushAtByProject || {};
      state.lastPushAtByProject[pending.projectId] = now;
      savePoolSample(pending, choice, text, cfg.handle);
      saveRejectDiffIfChanged(pending, choice, text);
      ok(choice === 'ship' ? '✦ 完工 · 已进陈列馆' : '◐ 原型 · 已进陈列馆');
    } else if (choice === 'stuck' || choice === 'stuck-quiet') {
      const cfg = mustHaveConfig();
      await apiAction(cfg, 'changeProjectStatus', { projectId: pending.projectId, newStatus: 'stuck' });
      await apiAction(cfg, 'addUpdate', { projectId: pending.projectId, text });
      state.lastPushAtByProject = state.lastPushAtByProject || {};
      state.lastPushAtByProject[pending.projectId] = now;
      savePoolSample(pending, choice, text, cfg.handle);
      saveRejectDiffIfChanged(pending, choice, text);
      ok('⚠ 卡住了 · 已通知关心你的人');
    } else if (choice === 'later') {
      // v0.13: per-reason 延后 · 用 pending.reason · 兜底 '_default' (老 pending 没 reason 字段)
      state.laterUntilByReason = state.laterUntilByReason || {};
      state.laterUntilByReason[pending.reason || '_default'] = now + 60 * 60 * 1000;
      ok('这一类 (' + (pending.reason || '_default') + ') 1 小时后再问');
    } else if (choice === 'skip-today') {
      state.dismissedTodayKey = todayKey();
      ok('今天不再问 · 明天见');
    } else if (choice === 'skip-once') {
      ok('好 · 接着搞');
    } else if (choice === 'mute') {
      state.mutedUntil = now + 24 * 60 * 60 * 1000;
      ok('静音 24 小时');
    } else if (choice === 'mute-30m') {
      state.mutedUntil = now + 30 * 60 * 1000;
      ok('暂停 30 分钟 · 出去走走');
    } else if (choice === 'ui-push') {
      // UI session 的对比图流程比较复杂 · alpha 期 AI 模式先不支持
      // 降级成普通 push · 不贴对比图
      const cfg = mustHaveConfig();
      await apiAction(cfg, 'addUpdate', { projectId: pending.projectId, text });
      state.lastPushAtByProject = state.lastPushAtByProject || {};
      state.lastPushAtByProject[pending.projectId] = now;
      ok('发出去了 · (AI 模式暂不支持对比图)');
    } else {
      err('未知 choice: ' + choice);
      process.exit(1);
    }
    savePromptState(state);
    clearPending();
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
}

// v0.4 Phase 2 · 读 ~/.tinker/style-pool/good/*.md · 调 LLM 总结作者真实 voice fingerprint
// 输出到 当前 cwd 的 .tinker/voice-fingerprint.md
// 之后 tinker draft 应该读这个 fingerprint 加进 prompt (Phase 3 · 暂未做)
// v0.9 voice teach · 主动喂样本到 style-pool
// 用法:
//   tinker voice teach --from-claude        从 Claude Code 对话历史抽 user message
//   tinker voice teach --from-claude --limit 50   自定义条数 (默认 100)
//   tinker voice teach --file path/to/file.md     从单个文件读
// 交互式让用户标 y/n/skip · 分别进 good 池 / bad 池 / 跳过
// 直接监督 fingerprint 学习 · 是 v0.11 voice teach review 模式的核心
async function reviewCandidatesInteractively(candidates, cfg, sourceTag) {
  const { select } = require('@inquirer/prompts');
  const goodDir = path.join(CONFIG_DIR, 'style-pool', 'good');
  const badDir = path.join(CONFIG_DIR, 'style-pool', 'bad');
  fs.mkdirSync(goodDir, { recursive: true });
  fs.mkdirSync(badDir, { recursive: true });

  let nGood = 0, nBad = 0, nSkip = 0, stopped = false;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    log('');
    log(sepia('  ── ') + bold((i + 1) + ' / ' + candidates.length) + sepia(' ──'));
    log('  ' + c.text.split('\n').join('\n  '));
    log('');
    let choice;
    try {
      choice = await select({
        message: '这条像不像你写的?',
        choices: [
          { name: '✓ 像我 · 进 good 池', value: 'y' },
          { name: '✗ 不像 · 进 bad 池 (告诉 LLM "别学这种")', value: 'n' },
          { name: '— 跳过 · 不打标', value: 'skip' },
          { name: '⏹ 停下 · 不看了', value: 'stop' },
        ],
      });
    } catch { choice = 'stop'; }

    if (choice === 'stop') { stopped = true; break; }
    if (choice === 'skip') { nSkip++; continue; }

    const targetDir = choice === 'y' ? goodDir : badDir;
    const ts = c.ts || Date.now();
    const stamp = new Date(ts).toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const file = path.join(targetDir, `${stamp}-teach-${sourceTag}-${i}.md`);
    const meta = ['---',
      `handle: ${cfg.handle || ''}`,
      `at: ${new Date(ts).toISOString()}`,
      `choice: teach-${sourceTag}-${choice === 'y' ? 'good' : 'bad'}`,
      `source: ${sourceTag}`,
      `reviewed_at: ${new Date().toISOString()}`,
      '---'].join('\n');
    fs.writeFileSync(file, `${meta}\n\n${c.text}\n`);
    if (choice === 'y') nGood++; else nBad++;
  }

  log('');
  log(sepia('  ── 完成 ──'));
  log(sepia('    good ') + moss(nGood + ' 篇'));
  log(sepia('    bad  ') + vermilion(nBad + ' 篇'));
  log(sepia('    skip ') + sepia(nSkip + ' 篇'));
  if (stopped) log(sepia('  (中途停下 · 没看完)'));
  log('');
  if (nGood + nBad >= 3) {
    log(sepia('  下一步: ') + vermilion('tinker voice analyze') + sepia(' 重新生成 fingerprint'));
  }
}

async function cmdVoiceTeach(opts) {
  const cfg = mustHaveConfig();

  if (!opts.fromClaude && !opts.file && !opts.review) {
    log(sepia('  用法:'));
    log(sepia('    ') + vermilion('tinker voice teach --from-claude'));
    log(sepia('      从 Claude Code 对话历史抽你说过的话当 sample (默认 100 条最近 · 自动加进 good 池)'));
    log(sepia('    ') + vermilion('tinker voice teach --from-claude --review'));
    log(sepia('      逐条让你标 y/n/skip · 分别进 good / bad / 跳过 (v0.11 新加)'));
    log(sepia('    ') + vermilion('tinker voice teach --review'));
    log(sepia('      从你最近 Tinker 推过的 update 里抽来 review (高信号样本 · v0.11 新加)'));
    log(sepia('    ') + vermilion('tinker voice teach --file <path>'));
    log(sepia('      从单个文件读 sample (整个文件当一篇)'));
    return;
  }

  // v0.11: review 模式 + 从 Tinker 自己 push 历史拉
  if (opts.review && !opts.fromClaude && !opts.file) {
    log(sepia('  从你最近的 Tinker update 抽样本...'));
    let candidates = [];
    try {
      const state = await apiState(cfg);
      for (const p of state.projects) {
        if (p.owner !== cfg.handle) continue;
        for (const u of (p.updates || [])) {
          if (u.text && u.text.length >= 30) candidates.push({ text: u.text, ts: u.at });
        }
      }
    } catch (e) { err('拉 Tinker 数据失败: ' + e.message); process.exit(1); }
    candidates.sort((a, b) => b.ts - a.ts);
    const N = opts.limit && opts.limit > 0 ? opts.limit : 10;
    candidates = candidates.slice(0, N);
    if (candidates.length === 0) { log(sepia('  没有 update 可 review · 先发几条再来')); return; }
    return reviewCandidatesInteractively(candidates, cfg, 'tinker-self');
  }

  // 模式 1 · 从 Claude Code 对话历史抽
  if (opts.fromClaude) {
    const claudeBase = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(claudeBase)) {
      err('找不到 ' + claudeBase + ' · 没有 Claude Code 对话历史');
      process.exit(1);
    }

    const messages = [];
    function walk(dir) {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.name.endsWith('.jsonl')) {
            try {
              const lines = fs.readFileSync(full, 'utf-8').split('\n').filter(Boolean);
              for (const line of lines) {
                try {
                  const obj = JSON.parse(line);
                  if (obj.type === 'user' && obj.message && obj.message.content) {
                    let content = '';
                    if (typeof obj.message.content === 'string') {
                      content = obj.message.content;
                    } else if (Array.isArray(obj.message.content)) {
                      content = obj.message.content
                        .filter(c => c.type === 'text' && c.text)
                        .map(c => c.text)
                        .join('\n');
                    }
                    if (content) {
                      const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
                      messages.push({ text: content, ts });
                    }
                  }
                } catch {}
              }
            } catch {}
          }
        }
      } catch {}
    }

    log(sepia('  扫 ~/.claude/projects/ ...'));
    walk(claudeBase);
    log(sepia(`  找到 ${messages.length} 条 user message`));

    // 过滤
    const filtered = messages
      .map(m => ({ ...m, text: m.text.trim() }))
      .filter(m => m.text.length >= 30 && m.text.length <= 500)
      .filter(m => !m.text.startsWith('/'))             // skip slash command
      .filter(m => /[一-鿿]/.test(m.text))      // 含中文
      .filter(m => !/^[\s\d\W]*$/.test(m.text));        // 非纯符号 / 数字

    log(sepia(`  过滤后 ${filtered.length} 条候选 (长度 30-500 · 含中文 · 非 slash command)`));
    if (filtered.length === 0) {
      log(sepia('  没有合适的样本'));
      return;
    }

    // 按时间倒序 · 取最近 N 条
    filtered.sort((a, b) => b.ts - a.ts);
    const N = opts.limit && opts.limit > 0 ? opts.limit : 100;
    const picked = filtered.slice(0, N);

    // v0.11 --review · 逐条标 y/n/skip 而不是 bulk add
    if (opts.review) {
      return reviewCandidatesInteractively(picked, cfg, 'claude');
    }

    log('');
    log(vermilion(`  预览前 5 条 (将从这 ${picked.length} 条里全部加进 pool):`));
    picked.slice(0, 5).forEach((m, i) => {
      const preview = m.text.replace(/\n/g, ' ').slice(0, 100);
      log(sepia(`  ${i + 1}. `) + preview + (m.text.length > 100 ? sepia('...') : ''));
    });
    log('');

    let go;
    try {
      const { confirm } = require('@inquirer/prompts');
      go = await confirm({ message: `把这 ${picked.length} 条加进 ~/.tinker/style-pool/good/ 吗?`, default: true });
    } catch { go = false; }
    if (!go) { log(sepia('  取消了')); return; }

    const dir = path.join(CONFIG_DIR, 'style-pool', 'good');
    fs.mkdirSync(dir, { recursive: true });
    picked.forEach((m, i) => {
      const ts = m.ts || Date.now();
      const stamp = new Date(ts).toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const file = path.join(dir, `${stamp}-teach-claude-${String(i).padStart(3, '0')}.md`);
      const meta = [
        '---',
        `handle: ${cfg.handle || ''}`,
        `at: ${new Date(ts).toISOString()}`,
        'choice: teach-claude',
        'source: Claude Code 对话历史',
        '---',
      ].join('\n');
      fs.writeFileSync(file, `${meta}\n\n${m.text}\n`);
    });
    log('');
    ok(`已加 ${picked.length} 条到 ~/.tinker/style-pool/good/`);
    log(sepia('  下一步: ') + vermilion('tinker voice analyze') + sepia(' 生成 fingerprint'));
    return;
  }

  // 模式 2 · 从单个文件读
  if (opts.file) {
    if (!fs.existsSync(opts.file)) { err('文件不存在: ' + opts.file); process.exit(1); }
    const raw = fs.readFileSync(opts.file, 'utf-8').trim();
    if (!raw) { err('文件是空的'); process.exit(1); }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const dir = path.join(CONFIG_DIR, 'style-pool', 'good');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${stamp}-teach-file.md`);
    const meta = [
      '---',
      `handle: ${cfg.handle || ''}`,
      `at: ${new Date().toISOString()}`,
      'choice: teach-file',
      `source: ${opts.file}`,
      '---',
    ].join('\n');
    fs.writeFileSync(file, `${meta}\n\n${raw}\n`);
    ok('已加 1 条到 ~/.tinker/style-pool/good/');
    log(sepia('  下一步: ') + vermilion('tinker voice analyze') + sepia(' 生成 fingerprint'));
  }
}

async function cmdVoiceAnalyze() {
  const cfg = mustHaveConfig();
  if (!cfg.llm || !cfg.llm.apiKey) {
    err('LLM 没配置 · 跑 ' + vermilion('tinker login') + ' 配一下');
    process.exit(1);
  }
  const poolDir = path.join(CONFIG_DIR, 'style-pool', 'good');
  if (!fs.existsSync(poolDir)) {
    log(sepia('  还没有 sample · style-pool 是空的'));
    log(sepia('  在 AI 模式下每次 ') + vermilion('tinker resolve push*') + sepia(' 会自动收集 · 用一段时间再 analyze'));
    return;
  }
  const files = fs.readdirSync(poolDir).filter(f => f.endsWith('.md')).sort();
  if (files.length < 3) {
    log(sepia(`  pool 太薄 (${files.length} 篇) · 至少需要 3 篇才能 analyze`));
    log(sepia('  少于 3 篇 fingerprint 会过拟合 · 再多发几条试试'));
    return;
  }
  log(sepia(`  读 ${files.length} 篇 sample...`));
  const samples = files.map(f => {
    const raw = fs.readFileSync(path.join(poolDir, f), 'utf-8');
    // 取 frontmatter 后的 text 内容
    const m = raw.match(/---\s*\n[\s\S]*?\n---\s*\n([\s\S]+)$/);
    return m ? m[1].trim() : raw.trim();
  }).filter(Boolean);

  const joined = samples.map((s, i) => `### 样本 ${i + 1}\n${s}\n`).join('\n');
  const prompt = `分析这位作者的语言风格,输出一份 voice fingerprint。这份 fingerprint 之后会喂给 LLM 起草草稿用,目的是让 LLM 模仿这位作者的真实气质。

==================
任务
==================
读这 ${samples.length} 篇真实 update,总结作者的:
- 节奏 (平均字数 / 句长 / 段落数)
- 标点偏好 (顿号 / 逗号 / 句号 / 中圆点 / em-dash / 引号类型和频率)
- 高频词汇 / 罕见词汇 / 完全没用过的词
- 开头习惯 (第一句话怎么开)
- 结尾习惯 (是否留 takeaway / 结尾是否带反思)
- 技术名词处理 (是否用 ALL_CAPS / 是否带版本号 / 是否解释术语)
- 工程化程度 (像 PM 周报 / 像私人日记 / 像工匠日志)
- 其他能让另一个 LLM mimic 这种气质的特征

==================
输出格式
==================
直接 markdown · 顶级标题用 \`##\` 不用 \`#\` · 不要"好的我来分析"这种废话开头 · 直接 fingerprint 正文。

==================
作者过去发过的 ${samples.length} 篇真实 update
==================
${joined}`;

  log(sepia('  调 LLM 分析中...'));
  const provider = cfg.llm.provider || 'deepseek';
  const apiKey = cfg.llm.apiKey;
  let fingerprint;
  try {
    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.llm.model || 'claude-sonnet-4-5-20250929',
          max_tokens: 3000,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data.error && data.error.message) || 'Anthropic API ' + res.status);
      fingerprint = data.content[0].text.trim();
    } else if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.llm.model || 'gpt-4o-mini',
          max_tokens: 3000,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data.error && data.error.message) || 'OpenAI API ' + res.status);
      fingerprint = data.choices[0].message.content.trim();
    } else if (provider === 'deepseek') {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.llm.model || 'deepseek-chat',
          max_tokens: 3000,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data.error && data.error.message) || 'DeepSeek API ' + res.status);
      fingerprint = data.choices[0].message.content.trim();
    } else {
      throw new Error('不支持的 LLM provider: ' + provider);
    }
  } catch (e) {
    err('LLM 调用失败: ' + e.message);
    process.exit(1);
  }

  const tinkerDir = path.join(process.cwd(), '.tinker');
  try { fs.mkdirSync(tinkerDir, { recursive: true }); } catch {}
  const outFile = path.join(tinkerDir, 'voice-fingerprint.md');
  const header = `# voice fingerprint · @${cfg.handle || ''} · ${new Date().toISOString().slice(0, 10)}\n基于过去 ${samples.length} 篇真实 update 分析 · ${new Date().toLocaleString()}\n\n`;
  fs.writeFileSync(outFile, header + fingerprint + '\n');

  log('');
  ok('生成完成 → ' + sepia(path.relative(process.cwd(), outFile)));
  log('');
  log(sepia('  下一步 (Phase 3 暂未实现):'));
  log(sepia('    · tinker draft 还没读 fingerprint · 仍用 DEFAULT_VOICE 起草'));
  log(sepia('    · 等 sample 累积到 ' + bold('10+') + sepia(' 篇时再来 analyze 一次,fingerprint 会更准')));
  log('');
}

// v0.12 方法库 · 搜 (借) 用法 · tinker borrow "supabase auth"
async function cmdBorrow(query, opts) {
  const cfg = loadConfig();
  if (!cfg.serverUrl) {
    if (opts.json) return errJson('未配置 serverUrl', 'NO_CONFIG');
    err('未配置 serverUrl · 先 tinker config'); process.exit(1);
  }
  const q = (query || '').trim();
  if (!q) {
    if (opts.json) return errJson('用法: tinker borrow "<关键词>"', 'NO_QUERY');
    log(sepia('  用法: ') + vermilion('tinker borrow "<关键词>"'));
    log(sepia('  例:   ') + vermilion('tinker borrow "阿里云 邮件"') + sepia(' (搜踩坑经验)'));
    log(sepia('  例:   ') + vermilion('tinker borrow "supabase 邮箱登录"') + sepia(' (搜方法)'));
    log(sepia('  加 --methods-only 只看方法 · --kind experience 只看踩坑经验'));
    return;
  }
  const url = new URL('/api/method/search', cfg.serverUrl);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(opts.limit || 10));
  if (opts.methodsOnly || opts['methods-only']) url.searchParams.set('methodsOnly', '1');
  if (opts.kind && ['method', 'experience', 'learning'].includes(opts.kind)) url.searchParams.set('kind', opts.kind);
  // 带 handle 让作者收到反馈 (反馈闭环 v0.12) · 没登录就匿名
  if (cfg.handle) url.searchParams.set('borrower', cfg.handle);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const errMsg = '搜失败 · HTTP ' + res.status;
    if (opts.json) return errJson(errMsg, 'HTTP_' + res.status);
    err(errMsg); process.exit(1);
  }
  const data = await res.json();
  if (opts.json) return outputJson({ query: q, hits: data.hits || [] });
  const hits = data.hits || [];
  if (hits.length === 0) {
    log(sepia('  没搜到 "') + q + sepia('" · 试试别的词或者去掉 --methods-only'));
    return;
  }
  log('');
  log(sepia(`  搜到 ${hits.length} 条 · 关键词: `) + bold(q));
  log('');
  hits.forEach((h, i) => {
    // v0.13 四种标签 · 决策推演/经验/上手指南 排在方法之前 (更稀缺 · 更值得看)
    const flags = [];
    if (h.isDecision) flags.push(vermilion('[决策推演]'));
    if (h.isExperience) flags.push(vermilion('[踩坑经验]'));
    if (h.isLearning) flags.push(vermilion('[上手指南]'));
    if (h.isMethod) flags.push(vermilion('[方法]'));
    const flag = flags.length ? ' ' + flags.join(' ') : '';
    const when = new Date(h.at).toISOString().slice(0, 10);
    log(bold(`  ${i + 1}. `) + h.projectName + sepia(' · @') + h.ownerHandle + sepia(' · ') + when + flag);
    const lines = h.text.split('\n').filter(Boolean).slice(0, 3);
    lines.forEach(line => log('     ' + line.slice(0, 120) + (line.length > 120 ? sepia('...') : '')));
    log(sepia(`     id: ${h.updateId}`));
    log('');
  });
  log(sepia('  借了哪条记得回头 ') + vermilion('tinker contribute') + sepia(' 把自己的总结也放进去'));
}

// tinker contribute <updateId> — 标自己一条 update 为方法
// 不带参数时 · 默认拿最近一条 push 的 id
async function cmdContribute(updateIdArg, opts) {
  const cfg = loadConfig();
  if (!cfg.serverUrl || !cfg.token) {
    if (opts.json) return errJson('未登录', 'NO_AUTH');
    err('未登录 · 先 tinker login'); process.exit(1);
  }
  // --unmark <id> · 删除一个方法 (兼容老 updateId 入参 · 自动判断 prefix 走 deleteMethod 或 unmarkMethod)
  if (opts.unmark) {
    const id = typeof opts.unmark === 'string' ? opts.unmark : updateIdArg;
    if (!id) {
      if (opts.json) return errJson('--unmark 需要 id (m-xxx 或 u-xxx)', 'NO_ID');
      err('--unmark 需要 id · 例: tinker contribute --unmark m-xxx (方法 id) 或 u-xxx (从 update 升格的)'); process.exit(1);
    }
    // v0.81: m-xxx 走 deleteMethod (新 API) · u-xxx 走 unmarkMethod (兼容路径)
    if (id.startsWith('m-')) {
      await apiAction(cfg, 'deleteMethod', { methodId: id });
    } else {
      await apiAction(cfg, 'unmarkMethod', { updateId: id });
    }
    if (opts.json) return outputJson({ ok: true, id, deleted: true });
    log(sepia('  删了: ') + id);
    return;
  }
  // v0.13 --from-file: 从 markdown 文件按段 contribute (走 CLI 路径承载长文档)
  if (opts.fromFile) {
    return cmdContributeFromFile(cfg, opts);
  }
  let updateId = updateIdArg;
  if (!updateId) {
    // 找最近一条自己的 update
    const state = await apiState(cfg);
    let latest = null;
    for (const p of state.projects || []) {
      for (const u of p.updates || []) {
        if (!latest || u.at > latest.at) latest = { ...u, project: p.name };
      }
    }
    if (!latest) {
      if (opts.json) return errJson('还没记过进展 · 没东西可标', 'NO_UPDATES');
      err('还没记过进展 · 没东西可标'); process.exit(1);
    }
    updateId = latest.id;
    log(sepia('  默认拿最近一条: ') + bold(latest.project) + sepia(' · ') + latest.text.slice(0, 60) + sepia('...'));
  }
  const result = await apiAction(cfg, 'markAsMethod', { updateId });
  if (opts.json) return outputJson({ ok: true, updateId, marked: true });
  log('');
  log(moss('  已标为方法 · 别人 tinker borrow 时能搜到这条'));
  log(sepia('  id: ') + updateId);
  log(sepia('  反悔: ') + vermilion(`tinker contribute --unmark ${updateId}`));
  log('');
}

// v0.13 markdown 切段 · 按 H1/H2/H3 标题切 · 跳过代码块里的 #
// 返回 [{ level, heading, body, fullText, lineStart }]
// fullText 包含 heading 自身 · 直接 push 时拿这个
function parseMarkdownSections(content) {
  const lines = content.split('\n');
  const sections = [];
  let inCode = false;
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) inCode = !inCode;
    const m = inCode ? null : line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (m) {
      if (current) sections.push(current);
      current = {
        level: m[1].length,
        heading: m[2].trim(),
        bodyLines: [],
        headingLine: line,
        lineStart: i + 1,
      };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  if (current) sections.push(current);
  // 拼 fullText · 去掉 body 头尾空行
  return sections.map(s => {
    let body = s.bodyLines.join('\n').replace(/^\s+|\s+$/g, '');
    const fullText = s.headingLine + (body ? '\n\n' + body : '');
    return {
      level: s.level,
      heading: s.heading,
      body,
      fullText,
      charCount: fullText.length,
      lineStart: s.lineStart,
    };
  }).filter(s => s.charCount > 30); // 太短的段没 contribute 价值
}

// v0.13 让 LLM 看完整 doc 推荐 3 段最值得分享的
// 返回 [{ heading, reason }] 数组 · 失败 throw
async function llmPickSections(cfg, sections) {
  if (!cfg.llm || !cfg.llm.apiKey) throw new Error('未配置 LLM · 先 tinker llm 配置 key');
  const provider = cfg.llm.provider || 'deepseek';
  const apiKey = cfg.llm.apiKey;
  const summary = sections.map((s, i) => {
    const preview = s.fullText.slice(0, 180).replace(/\n/g, ' ');
    return `${i + 1}. 标题: ${s.heading} · ${s.charCount} 字 · 前 180 字: ${preview}${s.charCount > 180 ? '...' : ''}`;
  }).join('\n');
  const prompt = `你在帮一个 vibe coder (用 AI 编程的开发者) 整理 markdown 文档 · 挑出最值得分享给别人 borrow / 复用的几段。

文档有以下 ${sections.length} 个段落:

${summary}

判断标准:
- 包含具体可操作的方法 / 套路 / 配置 · 不是只有结论
- 对踩同样坑的人有直接价值 (而不是只对作者自己有意义)
- 不是项目特定的细节 (内部路径 / 变量名 / 私人决策)
- 字数太短 (<50 字) 一般不值得

挑 3 段 (真没合适的可以少挑)。

输出严格 JSON · 不要包 \`\`\`json:
{ "picks": [{ "heading": "完整标题原文 (字符要跟上面列表里完全一样)", "reason": "10-20 字 · 为什么值得分享" }] }`;

  let rawText;
  if (provider === 'deepseek') {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.llm.model || 'deepseek-chat', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || 'DeepSeek ' + r.status);
    rawText = d.choices[0].message.content.trim();
    recordLLMUsage(provider, d.usage && d.usage.total_tokens, 'auto-pick');
  } else if (provider === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.llm.model || 'claude-sonnet-4-5-20250929', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || 'Anthropic ' + r.status);
    rawText = d.content[0].text.trim();
    recordLLMUsage(provider, d.usage && (d.usage.input_tokens + d.usage.output_tokens), 'auto-pick');
  } else if (provider === 'openai') {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.llm.model || 'gpt-4o-mini', max_tokens: 1500, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || 'OpenAI ' + r.status);
    rawText = d.choices[0].message.content.trim();
    recordLLMUsage(provider, d.usage && d.usage.total_tokens, 'auto-pick');
  } else {
    throw new Error('不支持的 LLM provider: ' + provider);
  }
  rawText = rawText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  let parsed;
  try { parsed = JSON.parse(rawText); }
  catch (e) { throw new Error('LLM 返回不是合法 JSON:\n' + rawText.slice(0, 200)); }
  if (!parsed.picks || !Array.isArray(parsed.picks)) throw new Error('LLM 返回缺 picks 数组');
  return parsed.picks;
}

// v0.13 隐私扫描 · 给作者上传前提示 · 不强删 · 让作者决定
// 返回 [{ kind, sample, hint }] 命中列表
function scanPrivacyRisks(text, cfg) {
  const hits = [];
  // IPv4 (排除 0.0.0.0 跟 127. 跟 localhost · 那些不算敏感)
  const ipMatches = text.match(/\b(?!0\.|127\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g);
  if (ipMatches) hits.push({ kind: 'IPv4 地址', sample: ipMatches[0], hint: '可能是你的服务器 IP · 考虑替换成 <服务器 IP>' });
  // API key 类
  const keyMatch = text.match(/\b(sk-[A-Za-z0-9_-]{16,}|tk_[A-Za-z0-9_-]{16,}|pk_[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9_.-]{16,})/);
  if (keyMatch) hits.push({ kind: 'API key / token', sample: keyMatch[0].slice(0, 20) + '...', hint: '上传前一定要删 · 或者改成 <你的 API key>' });
  // 长 base64 / hex (40+ 连续无空格字母数字)
  const longTokenMatch = text.match(/\b[A-Za-z0-9+/=]{40,}\b/);
  if (longTokenMatch) hits.push({ kind: '长随机串', sample: longTokenMatch[0].slice(0, 20) + '...', hint: '看起来像密钥 · 上传前确认' });
  // 本地路径
  if (/\/Users\/[a-zA-Z0-9_-]+\//.test(text) || /\/home\/[a-zA-Z0-9_-]+\//.test(text)) {
    hits.push({ kind: '本地用户路径', sample: '/Users/<name>/...', hint: '路径里有你的用户名 · 考虑替换成 ~/...' });
  }
  // LLM apiKey 直接命中 (用户 config 里有就检测)
  if (cfg && cfg.llm && cfg.llm.apiKey && text.includes(cfg.llm.apiKey.slice(0, 12))) {
    hits.push({ kind: '!!! 你的 LLM apiKey', sample: cfg.llm.apiKey.slice(0, 12) + '...', hint: '上传前一定要删 · 不要 contribute 含 key 的内容' });
  }
  return hits;
}

// v0.13 contribute --from-file · 从 markdown 文件按 H1/H2/H3 切段
// 让用户挑要 contribute 的段 · 每段一条 update + 自动 isMethod=true
// 隐私扫描 + 预览 + 确认 · 默认交互 (--json 模式走 --section 直接选)
async function cmdContributeFromFile(cfg, opts) {
  const filePath = opts.fromFile;
  if (!fs.existsSync(filePath)) {
    if (opts.json) return errJson('文件不存在: ' + filePath, 'NO_FILE');
    err('文件不存在: ' + filePath); process.exit(1);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const sections = parseMarkdownSections(content);
  if (sections.length === 0) {
    if (opts.json) return errJson('没切出可发的段 (≥30 字带标题的段)', 'NO_SECTIONS');
    err('没切出可发的段 (要求每段 ≥30 字 · 且要有 #/##/### 标题)'); process.exit(1);
  }

  // 决定 projectId
  // 优先级: --project <slug> > 当前 cwd repoConfig > 交互选 > 报错
  let projectId = null;
  let projectName = null;
  if (opts.projectId) {
    const state = await apiState(cfg);
    // 优先精确 (id/slug/name 全等) · 没有再退到 name 子串匹配 (大小写不敏感)
    const q = opts.projectId;
    const mine = state.projects.filter(x => x.owner === cfg.handle);
    const exact = mine.find(x => x.id === q || x.slug === q || x.name === q);
    const fuzzy = exact || mine.find(x => x.name.toLowerCase().includes(q.toLowerCase()));
    const p = fuzzy;
    if (!p) {
      if (opts.json) return errJson('找不到项目: ' + opts.projectId, 'NO_PROJECT');
      err('找不到你的项目: ' + opts.projectId); process.exit(1);
    }
    projectId = p.id; projectName = p.name;
  } else {
    const repoCfg = loadRepoConfig();
    if (repoCfg) {
      projectId = repoCfg.projectId; projectName = repoCfg.projectName;
      log(sepia('  当前 repo 绑定 ') + bold(projectName) + sepia(' · 这次 contribute 挂在它名下'));
    } else if (!opts.json) {
      // 交互选项目
      const { select } = require('@inquirer/prompts');
      const state = await apiState(cfg);
      const mine = state.projects.filter(x => x.owner === cfg.handle && x.status !== 'done');
      if (mine.length === 0) { err('你还没建项目 · 先发一条 push 创建'); process.exit(1); }
      const picked = await select({
        message: 'contribute 到哪个项目?',
        choices: mine.map(p => ({ name: p.name + sepia(' · ' + p.desc.slice(0, 40)), value: p.id })),
      });
      projectId = picked;
      projectName = mine.find(p => p.id === picked).name;
    } else {
      return errJson('未指定项目 (--project) 且当前 repo 未绑定', 'NO_PROJECT_CTX');
    }
  }

  // JSON 模式必须 --section 或 --auto · 否则没法非交互运行
  if (opts.json && !opts.section && !opts.auto) {
    return errJson('--json 模式需要 --section "<标题>" 或 --auto', 'NO_SECTION_IN_JSON');
  }

  // 选段
  let chosen = [];
  if (opts.auto) {
    // --auto: LLM 看完整篇推荐 3 段最值得分享的 · 跳过手动勾
    log(sepia('  LLM 看完 ') + bold(sections.length + ' 段') + sepia(' 推荐中... (DeepSeek)'));
    let picks;
    try { picks = await llmPickSections(cfg, sections); }
    catch (e) {
      if (opts.json) return errJson('LLM 推荐失败: ' + e.message, 'LLM_FAIL');
      err('LLM 推荐失败: ' + e.message); process.exit(1);
    }
    if (!picks.length) {
      const msg = 'LLM 看完没挑出合适的方法段 (可能整篇都偏项目特定 / 偏结论) · 试试 --section 手动选';
      if (opts.json) return errJson(msg, 'NO_PICKS');
      log(sepia('  ' + msg)); return;
    }
    // 匹配回 sections (完全匹配 / 子串两端都试)
    for (const pick of picks) {
      const h = (pick.heading || '').trim();
      const match = sections.find(s =>
        s.heading === h ||
        s.heading.toLowerCase() === h.toLowerCase() ||
        s.heading.includes(h) ||
        (h.length > 4 && h.includes(s.heading))
      );
      if (match) chosen.push({ ...match, llmReason: pick.reason });
    }
    if (chosen.length === 0) {
      const msg = 'LLM 返回的标题匹配不上文档段 · 可能 LLM 改写了标题 · 试试 --section 手动';
      if (opts.json) return errJson(msg, 'NO_MATCH_AFTER_LLM');
      err(msg); process.exit(1);
    }
    log('');
    log(moss('  LLM 推荐 ') + bold(chosen.length + ' 段') + sepia(':'));
    chosen.forEach(c => log(sepia('    · ') + bold(c.heading) + sepia(' · ') + (c.llmReason || '')));
    log('');
  } else if (opts.section) {
    // --section "标题" 支持多次 · 模糊匹配 (大小写不敏感 · 子串)
    const want = (Array.isArray(opts.section) ? opts.section : [opts.section]).map(s => s.toLowerCase());
    chosen = sections.filter(s => want.some(w => s.heading.toLowerCase().includes(w)));
    if (chosen.length === 0) {
      const errMsg = '没匹配上 · 文件里的段: ' + sections.map(s => '"' + s.heading + '"').join(' / ');
      if (opts.json) return errJson(errMsg, 'NO_MATCH');
      err(errMsg); process.exit(1);
    }
  } else {
    // 交互式选 (复选)
    const { checkbox } = require('@inquirer/prompts');
    log('');
    log(sepia('  从 ') + bold(filePath) + sepia(' 切了 ') + bold(sections.length + ' 段') + sepia(' · 勾你想 contribute 的'));
    log('');
    chosen = await checkbox({
      message: '选要 contribute 的段 (空格勾选 · 回车确认)',
      pageSize: 12,
      choices: sections.map(s => ({
        name: '  '.repeat(s.level - 1) + s.heading + sepia(' (' + s.charCount + ' 字)'),
        value: s,
      })),
    });
    if (chosen.length === 0) { log(sepia('  没勾任何段 · 取消')); return; }
  }

  // 隐私扫描 · 每段单独扫
  log('');
  const successes = [];
  const skipped = [];
  for (const sec of chosen) {
    const risks = scanPrivacyRisks(sec.fullText, cfg);
    log(sepia('  ── ') + bold(sec.heading) + sepia(' · ' + sec.charCount + ' 字 ──'));
    if (risks.length > 0) {
      log(vermilion('  ⚠ 隐私扫描命中 ' + risks.length + ' 处:'));
      risks.forEach(r => log(sepia('    · ') + bold(r.kind) + sepia(' (') + r.sample + sepia(') · ') + r.hint));
      if (opts.json) {
        skipped.push({ heading: sec.heading, reason: 'PRIVACY', risks });
        log(sepia('    --json 模式 · 自动跳过含隐私风险段'));
        continue;
      }
      const { confirm } = require('@inquirer/prompts');
      const goAnyway = await confirm({ message: '还是要 contribute 这段? (你看过没问题就 y)', default: false });
      if (!goAnyway) { skipped.push({ heading: sec.heading, reason: 'PRIVACY_USER' }); log(sepia('    跳过')); continue; }
    }
    // 预览前 200 字
    const preview = sec.fullText.slice(0, 200).replace(/\n/g, ' ');
    log(sepia('    预览: ') + preview + (sec.charCount > 200 ? sepia('...') : ''));
    if (!opts.json) {
      const { confirm } = require('@inquirer/prompts');
      const go = await confirm({ message: '发这段 (标方法)?', default: true });
      if (!go) { skipped.push({ heading: sec.heading, reason: 'USER_NO' }); log(sepia('    跳过')); continue; }
    }
    try {
      // v0.81: methods 是 first-class entity · 不再 addUpdate + isMethod=true
      // 直接 createMethod · 关联 projectId · 记 source_doc_path
      // v0.84: 支持 --tag · 跨用户聚类
      const r = await apiAction(cfg, 'createMethod', {
        text: sec.fullText,
        scenario: sec.llmReason || null,
        projectId,
        sourceDocPath: filePath,
        tags: opts.tags && opts.tags.length > 0 ? opts.tags : undefined,
      });
      const newId = r.result && r.result.methodId;
      successes.push({ heading: sec.heading, methodId: newId, charCount: sec.charCount });
      log(moss('    ✓ 发了 · 进方法库 · id ' + (newId || '?')));
    } catch (e) {
      log(vermilion('    ✗ 失败: ' + e.message));
      skipped.push({ heading: sec.heading, reason: 'API_ERROR', error: e.message });
    }
    log('');
  }
  if (opts.json) return outputJson({ ok: true, projectId, projectName, file: filePath, contributed: successes, skipped });
  log('');
  log(moss('  完成 · ') + bold(successes.length + ' 段') + sepia(' 进了方法库 · ') + sepia(skipped.length + ' 段') + sepia(' 跳过'));
  log(sepia('  别人 ') + vermilion('tinker borrow "<关键词>"') + sepia(' 时就能搜到你这些段了'));
  log('');
}

// v0.12 自己最近的 update · 给 CLI / MCP / AI agent 用
// tinker recent [--limit N] [--kind experience|method|ship|stuck|prototype] [--json]
async function cmdRecent(opts) {
  const cfg = loadConfig();
  if (!cfg || !cfg.serverUrl || !cfg.token) {
    if (opts.json) return errJson('未登录 · 先 tinker login', 'NO_AUTH');
    err('未登录 · 先 ' + vermilion('tinker login')); process.exit(1);
  }
  const limit = parseInt(opts.limit, 10) || 5;
  const kind = opts.kind || (opts.experience ? 'experience' : 'all');
  const qs = new URLSearchParams({ limit: String(limit), kind }).toString();
  let data;
  try {
    const res = await safeFetch(cfg, '/api/me/updates?' + qs, {
      headers: { 'Authorization': 'Bearer ' + cfg.token },
    });
    if (!res.ok) {
      const body = await res.text();
      if (opts.json) return errJson(body || ('HTTP ' + res.status), 'HTTP_' + res.status);
      err('拉失败: HTTP ' + res.status); process.exit(1);
    }
    data = await res.json();
  } catch (e) {
    if (opts.json) return errJson(e.message, 'FETCH_FAIL');
    err(e.message); process.exit(1);
  }
  const list = (data && data.updates) || [];
  if (opts.json) return outputJson({ updates: list });
  if (list.length === 0) {
    log(sepia('  没有 update' + (kind !== 'all' ? ' (kind=' + kind + ')' : '')));
    return;
  }
  log('');
  log(bold(`  最近 ${list.length} 条` + (kind !== 'all' ? ` · 限定 ${kind}` : '')));
  log('');
  list.forEach((u, i) => {
    const when = new Date(u.at).toISOString().slice(0, 10);
    const tags = [];
    if (u.isDecision) tags.push(vermilion('[决策]'));
    if (u.isExperience) tags.push(vermilion('[经验]'));
    if (u.isLearning) tags.push(vermilion('[上手指南]'));
    if (u.isMethod) tags.push(vermilion('[方法]'));
    if (u.kind) tags.push(sepia('[' + u.kind + ']'));
    log(bold(`  ${i + 1}. `) + u.projectName + sepia(' · ') + when + ' ' + tags.join(' '));
    const lines = u.text.split('\n').filter(Boolean).slice(0, 3);
    lines.forEach(line => log('     ' + line.slice(0, 120) + (line.length > 120 ? sepia('...') : '')));
    log(sepia(`     id: ${u.id}  · ${cfg.serverUrl}/#/p/${u.ownerHandle}/${u.projectSlug}`));
    log('');
  });
}

// v0.12 标某条 update 为"踩坑经验" · 给 AI 检索池
// tinker mark-experience <updateId>  /  --unmark <id>
// 不带参数时 · 拿最近一条 push 的 update
async function cmdMarkExperience(updateIdArg, opts) {
  const cfg = loadConfig();
  if (!cfg.serverUrl || !cfg.token) {
    if (opts.json) return errJson('未登录', 'NO_AUTH');
    err('未登录 · 先 ' + vermilion('tinker login')); process.exit(1);
  }
  if (opts.unmark) {
    const id = typeof opts.unmark === 'string' ? opts.unmark : updateIdArg;
    if (!id) {
      if (opts.json) return errJson('--unmark 需要 updateId', 'NO_ID');
      err('--unmark 需要 updateId · 例: tinker mark-experience --unmark u-xxx'); process.exit(1);
    }
    await apiAction(cfg, 'unmarkExperience', { updateId: id });
    if (opts.json) return outputJson({ ok: true, updateId: id, marked: false });
    log(sepia('  已取消经验标: ') + id);
    return;
  }
  let updateId = updateIdArg;
  if (!updateId) {
    const state = await apiState(cfg);
    let latest = null;
    for (const p of state.projects || []) {
      for (const u of p.updates || []) {
        if (!latest || u.at > latest.at) latest = { ...u, project: p.name };
      }
    }
    if (!latest) {
      if (opts.json) return errJson('还没记过进展 · 没东西可标', 'NO_UPDATES');
      err('还没记过进展 · 没东西可标'); process.exit(1);
    }
    updateId = latest.id;
    log(sepia('  默认拿最近一条: ') + bold(latest.project) + sepia(' · ') + latest.text.slice(0, 60) + sepia('...'));
  }
  await apiAction(cfg, 'markAsExperience', { updateId });
  if (opts.json) return outputJson({ ok: true, updateId, marked: true });
  log('');
  log(moss('  已标为经验 · 给 AI 检索时优先取这类 · 帮其他人少踩坑'));
  log(sepia('  id: ') + updateId);
  log(sepia('  反悔: ') + vermilion(`tinker mark-experience --unmark ${updateId}`));
  log('');
}

// v0.13 mark learning · 跟 mark-experience 同构 · 标为上手指南
async function cmdMarkLearning(updateIdArg, opts) {
  const cfg = loadConfig();
  if (!cfg.serverUrl || !cfg.token) {
    if (opts.json) return errJson('未登录', 'NO_AUTH');
    err('未登录 · 先 ' + vermilion('tinker login')); process.exit(1);
  }
  if (opts.unmark) {
    const id = typeof opts.unmark === 'string' ? opts.unmark : updateIdArg;
    if (!id) {
      if (opts.json) return errJson('--unmark 需要 updateId', 'NO_ID');
      err('--unmark 需要 updateId · 例: tinker mark-learning --unmark u-xxx'); process.exit(1);
    }
    await apiAction(cfg, 'unmarkLearning', { updateId: id });
    if (opts.json) return outputJson({ ok: true, updateId: id, marked: false });
    log(sepia('  已取消上手指南标: ') + id);
    return;
  }
  let updateId = updateIdArg;
  if (!updateId) {
    const state = await apiState(cfg);
    let latest = null;
    for (const p of state.projects || []) {
      for (const u of p.updates || []) {
        if (!latest || u.at > latest.at) latest = { ...u, project: p.name };
      }
    }
    if (!latest) {
      if (opts.json) return errJson('还没记过进展 · 没东西可标', 'NO_UPDATES');
      err('还没记过进展 · 没东西可标'); process.exit(1);
    }
    updateId = latest.id;
    log(sepia('  默认拿最近一条: ') + bold(latest.project) + sepia(' · ') + latest.text.slice(0, 60) + sepia('...'));
  }
  await apiAction(cfg, 'markAsLearning', { updateId });
  if (opts.json) return outputJson({ ok: true, updateId, marked: true });
  log('');
  log(moss('  已标为上手指南 · 给 AI 检索时优先取这类 · 帮其他人快速入门新技术'));
  log(sepia('  id: ') + updateId);
  log(sepia('  反悔: ') + vermilion(`tinker mark-learning --unmark ${updateId}`));
  log('');
}

function cmdMute(args) {
  const arg = (args || '').trim();
  const state = loadPromptState();
  const now = Date.now();
  if (arg === 'off' || arg === 'unmute') {
    state.mutedUntil = null;
    state.laterUntil = null;            // 老字段 · 向后兼容清理
    state.laterUntilByReason = {};      // v0.13 per-reason 延后清空
    state.dismissedTodayKey = null;
    savePromptState(state);
    ok('解除静音 · 触发器开启');
    return;
  }
  const m = arg.match(/^(\d+)(m|h|d)$/);
  let duration = 60 * 60 * 1000; // 默认 1h
  let label = '1 小时';
  if (m) {
    const n = parseInt(m[1], 10);
    if (m[2] === 'm') { duration = n * 60 * 1000; label = `${n} 分钟`; }
    else if (m[2] === 'h') { duration = n * 60 * 60 * 1000; label = `${n} 小时`; }
    else if (m[2] === 'd') { duration = n * 24 * 60 * 60 * 1000; label = `${n} 天`; }
  } else if (arg === 'today') {
    const d = new Date(); d.setHours(28, 0, 0, 0); // 明天凌晨 4:00
    duration = d.getTime() - now;
    label = '到明早 4 点';
  } else if (arg === 'forever') {
    state.mutedUntil = Number.MAX_SAFE_INTEGER;
    savePromptState(state);
    ok('永久静音 · 用 ' + vermilion('tinker mute off') + ' 解除');
    return;
  } else if (arg) {
    err('用法: tinker mute [Nm|Nh|Nd|today|forever|off]');
    process.exit(1);
  }
  state.mutedUntil = now + duration;
  savePromptState(state);
  ok('静音 ' + label + ' · 用 ' + vermilion('tinker mute off') + ' 解除');
}

// v0.13 tinker stream <resource> · 长跑 NDJSON 输出
// CLI 对偶 MCP 资源订阅 · 不依赖任何 AI agent · 任何能读 stdout 的 AI / 脚本都能用
//
// 资源:
//   triggers · prompt-state 快照 · 内容变化时推一行
//   today    · 今日 git commit + Tinker push 计数 · 30s 轮询
//
// 用法:
//   tinker stream triggers              一直跑 · 内容变化时打一行 NDJSON
//   tinker stream triggers --once       打完当前 snapshot 就退 (调试 / poll)
//
// 输出格式:
//   {"event":"snapshot","resource":"...","at":1234,"data":{...}}   起始快照
//   {"event":"updated","resource":"...","at":1234,"data":{...}}    变化推送
async function cmdStream(resource, opts = {}) {
  if (!resource) {
    err('用法: tinker stream <resource> · 可选: triggers / today');
    process.exit(1);
  }
  const emit = (event, data) => {
    process.stdout.write(JSON.stringify({ event, resource, at: Date.now(), data }) + '\n');
  };

  // 资源读取函数表 · 共享给 snapshot / updated 都用
  const reads = {
    triggers: () => {
      const s = loadPromptState();
      const now = Date.now();
      return {
        muted: !!(s.mutedUntil && s.mutedUntil > now),
        mutedUntil: s.mutedUntil || null,
        dismissedToday: s.dismissedTodayKey === todayKey(),
        lastPromptedAt: s.lastPromptedAt || null,
        uiSession: s.uiSession || null,
        lastPushAtByProject: s.lastPushAtByProject || {},
        pending: loadPending() || null,
      };
    },
    today: async () => {
      const cfg = loadConfig();
      let gitCommits = 0;
      if (inGitRepo()) {
        try {
          const since = (() => { const d = new Date(); d.setHours(4, 0, 0, 0); return d.toISOString().slice(0, 10) + ' 04:00'; })();
          const out = require('child_process').execSync(`git log --since="${since}" --no-merges --oneline`, { encoding: 'utf-8' });
          gitCommits = out.trim().split('\n').filter(Boolean).length;
        } catch {}
      }
      let tinkerPushed = 0;
      if (cfg && cfg.serverUrl && cfg.token) {
        try {
          const state = await apiState(cfg);
          const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
          for (const p of state.projects || []) {
            for (const u of p.updates || []) {
              if (u.at >= todayStart.getTime()) tinkerPushed++;
            }
          }
        } catch {}
      }
      return { gitCommits, tinkerPushed };
    },
  };

  const read = reads[resource];
  if (!read) {
    err('未知资源: ' + resource + ' · 可选: ' + Object.keys(reads).join(' / '));
    process.exit(1);
  }

  // 起始 snapshot
  const initial = await read();
  emit('snapshot', initial);
  if (opts.once) return;

  let lastKey = JSON.stringify(initial);
  let polling = false;
  const checkAndPush = async () => {
    if (polling) return; // 避免并发
    polling = true;
    try {
      const next = await read();
      const k = JSON.stringify(next);
      if (k !== lastKey) { lastKey = k; emit('updated', next); }
    } catch {}
    polling = false;
  };

  // 5s 轮询 (triggers 偏低频 · today 偏低频 · 都 5s 就够)
  const interval = setInterval(checkAndPush, 5000);
  interval.unref();

  // triggers: 加 prompt-state.json 文件 watch (1s · 更灵敏)
  if (resource === 'triggers') {
    const stateFile = path.join(CONFIG_DIR, 'prompt-state.json');
    if (fs.existsSync(stateFile)) {
      fs.watchFile(stateFile, { interval: 1000 }, () => checkAndPush());
    }
  }

  // 等 SIGINT · stdin EOF · 主进程退出
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  process.stdin.on('end', () => process.exit(0));
  await new Promise(() => {}); // 永远 hang
}

function help() {
  log('');
  log(bold('  tinker') + sepia(' — 在 coding 时把进展发到捣鼓 / Tinker'));
  log(sepia('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  log('');
  log(sepia('  ') + vermilion('一次性'));
  log('  ' + vermilion('tinker login') + sepia('                       配置 server + 钥匙 + LLM'));
  log('');
  log(sepia('  ') + vermilion('日常 · 半自动'));
  log('  ' + vermilion('tinker draft') + sepia('                       LLM 看 git 历史 · 起草 1-3 条候选到 .tinker/drafts/'));
  log('  ' + vermilion('tinker draft --since 30m') + sepia('           自定义时间窗'));
  log('  ' + vermilion('tinker push <file.md>') + sepia('              从草稿文件发布(读完文件 · 把不想发的段落删掉再发)'));
  log('  ' + vermilion('tinker push <file.md> --only=1,3') + sepia('   只发指定候选'));
  log('');
  log(sepia('  ') + vermilion('直接发'));
  log('  ' + vermilion('tinker push -m "..."') + sepia('               一句话直接发'));
  log('  ' + vermilion('tinker push') + sepia('                        交互式 · 默认最近一条 commit 作为建议'));
  log('  ' + vermilion('tinker stuck -m "..."') + sepia('              标项目卡住 + 写"卡在哪" · 通知关心你的人'));
  log('');
  log(sepia('  ') + vermilion('完工'));
  log('  ' + vermilion('tinker ship -m "..."') + sepia('               改 done + 写完工感想 · 默认抓 productLink 截图当陈列馆封面'));
  log('  ' + vermilion('tinker ship -m "..." --feedback-ask "..."') + sepia(' · 加上"想知道"的具体问题'));
  log('  ' + vermilion('tinker ship -m "..." --no-feedback') + sepia('    · 不勾求反馈'));
  log('  ' + vermilion('tinker ship -m "..." --image ./shot.png') + sepia('     · 用本地图当封面 (优先于自动截图)'));
  log('  ' + vermilion('tinker ship -m "..." --no-screenshot') + sepia('       · 不带封面'));
  log('');
  log(sepia('  ') + vermilion('主动 prompt · 让 CLI 在合适的时间问你 (默认 opt-in)'));
  log('  ' + vermilion('tinker hook install') + sepia('                装 git post-commit hook · 25 个触发器分优先级'));
  log('  ' + vermilion('tinker hook uninstall') + sepia('              卸 hook'));
  log('  ' + vermilion('tinker check') + sepia('                       手动跑一次触发器评估 (hook 自动调这个)'));
  log('  ' + vermilion('tinker triggers') + sepia('                    自检 · 看每个触发器的状态 + 当前 winner'));
  log('  ' + vermilion('tinker resolve <choice> -m "..."') + sepia('    响应 pending prompt (push / ship / stuck 等)'));
  log('  ' + vermilion('tinker mute 1h') + sepia(' / ') + vermilion('today') + sepia(' / ') + vermilion('forever') + sepia(' / ') + vermilion('off') + sepia('   静音控制'));
  log('  ' + vermilion('tinker session status') + sepia(' / ') + vermilion('end') + sepia('     看 UI session 状态 / 手动结束'));
  log('  ' + vermilion('tinker llm set') + sepia(' / ') + vermilion('status') + sepia(' / ') + vermilion('off') + sepia('       配 / 看 / 清 LLM key (给自动起草用)'));
  log('');
  log(sepia('  ') + vermilion('收尾 · 沉淀'));
  log('  ' + vermilion('tinker goodnight') + sepia('                   今日总结 (commit + push + Claude Code token + 方法被借)'));
  log('  ' + vermilion('tinker goodnight --week') + sepia(' / ') + vermilion('--month') + sepia('     周报 / 月报'));
  log('  ' + vermilion('tinker goodnight --narrate') + sepia('          让 LLM 替你说一句'));
  log('');
  log(sepia('  ') + vermilion('踩坑跟踪 · 自动整理经验贴'));
  log('  ' + vermilion('tinker struggle') + sepia('                    看当前是不是在折腾 + 最近的踩坑列表'));
  log('  ' + vermilion('tinker struggle off') + sepia(' / ') + vermilion('on') + sepia('             24h 关跟踪 / 重新开'));
  log(sepia('  ') + dim('Claude Code 对话里反复挣扎 → CLI 自动记 dossier → 破局后后台整理成草稿 → 一键发'));
  log('');
  log(sepia('  ') + vermilion('方法库 · 让别人借 / 借别人的'));
  log('  ' + vermilion('tinker borrow "<关键词>"') + sepia('            搜方法库 (作者标方法的排前)'));
  log('  ' + vermilion('tinker borrow ... --methods-only') + sepia('    只看作者标方法的'));
  log('  ' + vermilion('tinker contribute [updateId]') + sepia('        标自己一条 update 为方法'));
  log('  ' + vermilion('tinker contribute --from-file <md>') + sepia('  从 markdown 按段交互选 contribute · 隐私扫描'));
  log('  ' + vermilion('tinker contribute --from-file <md> --auto') + sepia(' LLM 看完帮挑 3 段 · 一键确认'));
  log('');
  log(sepia('  ') + vermilion('voice · 写作风格学习'));
  log('  ' + vermilion('tinker voice analyze') + sepia('               用 pool 样本生成 fingerprint'));
  log('  ' + vermilion('tinker voice teach --from-claude') + sepia('    从 Claude Code 对话历史抽样本'));
  log('  ' + vermilion('tinker voice teach --review') + sepia('         逐条 y/n/skip 自监督 (good / bad 池)'));
  log('');
  log(sepia('  ') + vermilion('给 AI 用 (machine-readable)'));
  log('  ' + vermilion('tinker schema --json') + sepia('               CLI 自身能力 schema · AI 读这个知道怎么用'));
  log('  ' + vermilion('tinker state --json') + sepia('                读 prompt-state 当前快照'));
  log('  ' + vermilion('tinker stream <resource>') + sepia('            长跑 NDJSON 事件流 (triggers / today)'));
  log('  ' + vermilion('tinker mcp') + sepia('                          启 MCP server (stdio) · 给 Claude Code / Cursor 当 first-class tool'));
  log(sepia('  ') + dim('几乎所有命令支持 --json · 错误统一 { ok: false, error, code } 形态'));
  log('');
  log(sepia('  ') + vermilion('辅助'));
  log('  ' + vermilion('tinker projects | ls') + sepia('               列我的活跃项目'));
  log('  ' + vermilion('tinker config') + sepia('                      看当前配置'));
  log('  ' + vermilion('tinker update') + sepia('                      拉最新代码 + 重装(需要按一键命令装的)'));
  log('');
  log(sepia('  voice 覆盖: 在项目里建 ') + vermilion('.tinker/voice.md') + sepia(' · LLM 起草时会用这个气质'));
  log(sepia('  --since 支持: ') + dim('30m / 2h / 1d / today / yesterday / git 能理解的格式'));
  log('');
}

// =============================================
// arg parsing
// =============================================
function parseArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-m' || a === '--message') opts.text = args[++i];
    else if (a === '--since') opts.since = args[++i];
    else if (a === '-p' || a === '--project') opts.projectId = args[++i];
    else if (a.startsWith('--only=')) opts.only = a.slice('--only='.length);
    else if (a === '--only') opts.only = args[++i];
    else if (a === '--feedback-ask') opts.feedbackAsk = args[++i];
    else if (a.startsWith('--feedback-ask=')) opts.feedbackAsk = a.slice('--feedback-ask='.length);
    else if (a === '--no-feedback') opts.noFeedback = true;
    else if (a === '--image') opts.image = args[++i];
    else if (a.startsWith('--image=')) opts.image = a.slice('--image='.length);
    else if (a === '--no-screenshot') opts.noScreenshot = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--from-hook') opts.fromHook = true;
    else if (a === '--from-claude') opts.fromClaude = true;
    else if (a === '--week') opts.week = true;
    else if (a === '--month') opts.month = true;
    else if (a === '--days') opts.daysBack = parseInt(args[++i], 10);
    else if (a.startsWith('--days=')) opts.daysBack = parseInt(a.slice('--days='.length), 10);
    else if (a === '--narrate') opts.narrate = true;
    else if (a === '--review') opts.review = true;
    else if (a === '--idempotency-key' || a === '--idem-key') opts.idemKey = args[++i];
    else if (a.startsWith('--idempotency-key=')) opts.idemKey = a.slice('--idempotency-key='.length);
    else if (a.startsWith('--idem-key=')) opts.idemKey = a.slice('--idem-key='.length);
    else if (a === '--file') opts.file = args[++i];
    else if (a.startsWith('--file=')) opts.file = a.slice('--file='.length);
    else if (a === '--limit') opts.limit = parseInt(args[++i], 10);
    else if (a.startsWith('--limit=')) opts.limit = parseInt(a.slice('--limit='.length), 10);
    else if (a === '--methods-only' || a === '--methodsOnly') opts.methodsOnly = true;
    else if (a === '--kind') opts.kind = args[++i];
    else if (a.startsWith('--kind=')) opts.kind = a.slice('--kind='.length);
    else if (a === '--as-experience' || a === '--asExperience') opts.asExperience = true;
    else if (a === '--as-learning' || a === '--asLearning') opts.asLearning = true;
    else if (a === '--as-decision' || a === '--asDecision') opts.asDecision = true;
    else if (a === '--quiet' || a === '-q') opts.quiet = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--tag') {
      // v0.84 支持多次 · 收集 · contribute 时一并发上
      const v = (args[++i] || '').trim();
      if (v) {
        if (!opts.tags) opts.tags = [];
        opts.tags.push(v);
      }
    }
    else if (a.startsWith('--tag=')) {
      const v = a.slice('--tag='.length).trim();
      if (v) {
        if (!opts.tags) opts.tags = [];
        opts.tags.push(v);
      }
    }
    else if (a === '--from-file') opts.fromFile = args[++i];
    else if (a.startsWith('--from-file=')) opts.fromFile = a.slice('--from-file='.length);
    else if (a === '--auto') opts.auto = true;
    else if (a === '--once') opts.once = true;
    else if (a === '--section') {
      // 支持多次 · 收集成数组 (匹配多段一起 contribute)
      const v = args[++i];
      if (opts.section) opts.section = Array.isArray(opts.section) ? [...opts.section, v] : [opts.section, v];
      else opts.section = v;
    }
    else if (a.startsWith('--section=')) {
      const v = a.slice('--section='.length);
      if (opts.section) opts.section = Array.isArray(opts.section) ? [...opts.section, v] : [opts.section, v];
      else opts.section = v;
    }
    else if (a.startsWith('--project=')) opts.projectId = a.slice('--project='.length);
    else if (a === '--unmark') {
      // 既支持 --unmark <id> 也支持 --unmark=<id> · 单独 --unmark 走 positional id
      const next = args[i + 1];
      if (next && !next.startsWith('-')) { opts.unmark = next; i++; }
      else opts.unmark = true;
    }
    else if (a.startsWith('--unmark=')) opts.unmark = a.slice('--unmark='.length);
    // 不以 - 开头的第一个 positional 当成草稿文件路径
    else if (!a.startsWith('-') && !opts.draftFile) {
      // 必须是已存在的文件 / 以 .md 结尾
      if (fs.existsSync(a) || /\.md$/i.test(a)) opts.draftFile = a;
    }
  }
  return opts;
}

// =============================================
// main
// =============================================
// `tinker state` · 给 AI agent 读 prompt-state.json 当前快照
// 看 mute/cooldown/dismissed/uiSession 状态 · 决定要不要 prompt
function cmdState(opts = {}) {
  const state = loadPromptState();
  const now = Date.now();
  // v0.13: laterUntilByReason 替代老 laterUntil · per-reason 延后状态
  const laterByReason = state.laterUntilByReason || {};
  const activeLaterByReason = Object.fromEntries(
    Object.entries(laterByReason).filter(([_, until]) => until > now)
  );
  const summary = {
    ok: true,
    now,
    muted: state.mutedUntil && state.mutedUntil > now
      ? { until: state.mutedUntil, remainingMs: state.mutedUntil - now }
      : null,
    laterByReason: Object.keys(activeLaterByReason).length > 0 ? activeLaterByReason : null,
    dismissedToday: state.dismissedTodayKey === todayKey(),
    lastPromptedAt: state.lastPromptedAt || null,
    cooldownActive: state.lastPromptedAt && (now - state.lastPromptedAt) < 30 * 60 * 1000,
    uiSession: state.uiSession || null,
    lastPushAtByProject: state.lastPushAtByProject || {},
  };
  if (opts.json) { outputJson(summary); return; }
  // 人类可读 fallback
  log('');
  log(sepia('  prompt 状态:'));
  log(sepia('    mute       ') + (summary.muted ? bold('到 ' + new Date(summary.muted.until).toLocaleString()) : sepia('(无)')));
  if (summary.laterByReason) {
    log(sepia('    later      ') + bold(Object.keys(summary.laterByReason).length + ' 类延后中:'));
    for (const [reason, until] of Object.entries(summary.laterByReason)) {
      log(sepia('      · ') + reason + sepia(' 到 ') + new Date(until).toLocaleString());
    }
  } else {
    log(sepia('    later      ') + sepia('(无)'));
  }
  log(sepia('    今日 skip  ') + (summary.dismissedToday ? bold('是') : sepia('否')));
  log(sepia('    冷却中     ') + (summary.cooldownActive ? bold('是 · 30min 内 prompt 过') : sepia('否')));
  log(sepia('    UI session ') + (summary.uiSession ? bold('进行中 · ' + summary.uiSession.commitCount + ' commits') : sepia('(无)')));
  log('');
}

// v0.12 触发器自检 · 让作者看见 Tinker 触发器系统的工作
// 三段:当前 commit 信号 / state 拦截原因 / 今日累计胜出分布
// 解决"我 commit 完了为什么没看到 prompt" 这个黑盒
function cmdTriggers(opts = {}) {
  const now = Date.now();
  const state = loadPromptState();

  // 收集结构化数据 (json 输出用 + 人类输出共用同一份)
  const data = {
    inGitRepo: inGitRepo(),
    cwd: process.cwd(),
    state: {
      muted: state.mutedUntil && state.mutedUntil > now
        ? { until: state.mutedUntil, remainingMs: state.mutedUntil - now } : null,
      laterByReason: (() => {
        const m = state.laterUntilByReason || {};
        const active = Object.fromEntries(Object.entries(m).filter(([_, u]) => u > now));
        return Object.keys(active).length > 0 ? active : null;
      })(),
      dismissedToday: state.dismissedTodayKey === todayKey(),
      cooldownActive: !!(state.lastPromptedAt && (now - state.lastPromptedAt) < 30 * 60 * 1000),
      cooldownRemainingMin: state.lastPromptedAt && (now - state.lastPromptedAt) < 30 * 60 * 1000
        ? Math.ceil((30 * 60 * 1000 - (now - state.lastPromptedAt)) / 60000) : 0,
    },
    commit: null,
    repoBound: false,
    fired: [],
    winner: null,
    wouldPrompt: false,
    blockReason: null,
    todayHits: null,
    triggerCount: 25,
  };

  if (data.inGitRepo) {
    try {
      const title = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim();
      const bodyLen = execSync('git log -1 --pretty=%b', { encoding: 'utf-8' }).trim().length;
      let stat = null;
      try {
        const out = execSync('git diff HEAD~1 HEAD --shortstat 2>/dev/null', { encoding: 'utf-8' }).trim();
        const im = out.match(/(\d+) insertion/);
        const dm = out.match(/(\d+) deletion/);
        const fm = out.match(/(\d+) files? changed/);
        stat = { files: fm ? +fm[1] : 0, ins: im ? +im[1] : 0, del: dm ? +dm[1] : 0 };
      } catch {}
      data.commit = { title, bodyLen, stat };
    } catch {}

    const repoCfg = loadRepoConfig();
    if (repoCfg) {
      data.repoBound = true;
      data.project = { id: repoCfg.projectId, name: repoCfg.projectName };
      const cfgForUi = (() => { try { return mustHaveConfig({ requireToken: false }); } catch { return null; } })();
      const { winner, allFired } = evaluateAllTriggersDetailed(state, repoCfg, cfgForUi);
      data.fired = allFired.map(r => ({
        kind: r.kind || r.reason || null,
        reason: r.reason || null,
        priority: r.priority,
        msg: stripAnsi(r.msg || ''),
      }));
      if (winner) {
        data.winner = {
          kind: winner.kind || winner.reason || null,
          priority: winner.priority,
          msg: stripAnsi(winner.msg || ''),
        };
        const blockedByMute = data.state.muted;
        const blockedByLater = data.state.later;
        const blockedByDismissed = data.state.dismissedToday;
        const blockedByCooldown = data.state.cooldownActive && winner.priority < 100;
        if (blockedByMute) data.blockReason = '静音中';
        else if (blockedByLater) data.blockReason = '延后中';
        else if (blockedByDismissed) data.blockReason = '今日已 skip';
        else if (blockedByCooldown) data.blockReason = '冷却内 + priority < 100';
        data.wouldPrompt = !data.blockReason;
      }
    }
  }

  // 今日累计 (跨天清零的 state.todayTriggerHits)
  const tk = todayKey();
  if (state.todayTriggerHits && state.todayTriggerHits.date === tk) {
    const ws = state.todayTriggerHits.winners || {};
    const kinds = Object.keys(ws).sort((a, b) => ws[b].count - ws[a].count);
    data.todayHits = kinds.map(k => ({ kind: k, count: ws[k].count, suppressed: ws[k].suppressed }));
  }

  if (opts.json) { outputJson(data); return; }

  // 人类可读
  log('');
  log(bold('Tinker 触发器自检'));
  log('');

  // state
  log(sepia('state:'));
  log(sepia('  静音:    ') + (data.state.muted ? bold('是 · 到 ' + new Date(data.state.muted.until).toLocaleString()) : sepia('否')));
  log(sepia('  延后:    ') + (data.state.later ? bold('是 · 到 ' + new Date(data.state.later.until).toLocaleString()) : sepia('否')));
  log(sepia('  今日 skip:') + (data.state.dismissedToday ? bold(' 是 · 明天再问') : sepia(' 否')));
  if (data.state.cooldownActive) {
    log(sepia('  冷却:    ') + bold('是 · 还剩 ' + data.state.cooldownRemainingMin + ' 分钟') + sepia(' · priority < 100 不 prompt'));
  } else {
    log(sepia('  冷却:    ') + sepia('否'));
  }
  log('');

  // commit
  if (!data.inGitRepo) {
    log(sepia('  ⚠ 不在 git 仓库 · 触发器扫描跳过'));
  } else if (data.commit) {
    log(sepia('当前 commit: ') + bold(data.commit.title.slice(0, 80)));
    const statStr = data.commit.stat
      ? `${data.commit.stat.files} 文件 / +${data.commit.stat.ins} / -${data.commit.stat.del}`
      : '(无 diff)';
    log(sepia('  body ') + bold(data.commit.bodyLen + ' 字') + sepia(' · diff ') + bold(statStr));
    log('');
  }

  // 触发器扫描
  if (!data.repoBound) {
    log(sepia('  ⚠ 这个 repo 没绑定 Tinker 项目 · 跑 ') + vermilion('tinker hook install') + sepia(' 才能用'));
  } else {
    log(sepia('触发器扫描 (24 个):'));
    if (data.fired.length === 0) {
      log(sepia('  全部没命中 · 安静'));
    } else {
      data.fired.forEach(r => {
        const label = (r.kind || r.reason || '?').padEnd(28);
        log('  ' + vermilion('✓') + ' ' + label + sepia('priority ' + r.priority));
      });
      const notFired = data.triggerCount - data.fired.length;
      if (notFired > 0) log(sepia('  其他 ' + notFired + ' 个没命中'));
      log('');
      if (data.winner) {
        log(sepia('胜出: ') + bold(data.winner.kind) + sepia(' (priority ' + data.winner.priority + ')'));
        if (data.wouldPrompt) {
          log(sepia('  ') + vermilion('→') + bold(' 会 prompt'));
        } else {
          log(sepia('  ') + sepia('被拦: ') + bold(data.blockReason));
        }
      }
    }
  }

  // 今日累计
  if (data.todayHits && data.todayHits.length > 0) {
    log('');
    log(sepia('今天累计 (04:00 起):'));
    data.todayHits.forEach(h => {
      const supStr = h.suppressed > 0 ? sepia(' (' + h.suppressed + ' 次被冷却拦)') : '';
      log(sepia('  ') + h.kind.padEnd(28) + bold(h.count + ' 次胜出') + supStr);
    });
  }
  log('');
}

// `tinker schema --json` · 给 AI agent 一次拿到完整 CLI 能力地图
// 不需要解析 help 文本 · 不会因为 --help 改文案而变
function cmdSchema(opts = {}) {
  const schema = {
    ok: true,
    version: '0.8',
    commands: [
      { name: 'check', purpose: '评估触发器 · 看现在该不该 prompt', args: [
        { flag: '--json', purpose: '结构化输出 · pending 写盘' },
        { flag: '--from-hook', purpose: '标记 hook 调用 · 静默非命中' },
      ], jsonOutput: true, example: 'tinker check --json' },
      { name: 'resolve', purpose: '响应 check 返的 pending · 执行动作', args: [
        { arg: '<choice>', purpose: '从 check 返的 choices 里挑一个 id' },
        { flag: '-m / --message', purpose: '文本动作必填: push / ship / stuck 等' },
      ], jsonOutput: false, example: 'tinker resolve push -m "..."' },
      { name: 'projects', alias: 'ls', purpose: '列我的所有项目 (含 id/slug/status)', args: [
        { flag: '--json', purpose: '结构化数组' },
      ], jsonOutput: true, example: 'tinker projects --json' },
      { name: 'config', purpose: '看当前 server/handle/token/llm 配置', args: [
        { flag: '--json', purpose: '结构化 · token 只露后 4 位' },
      ], jsonOutput: true, example: 'tinker config --json' },
      { name: 'state', purpose: '读 prompt-state.json (mute/cooldown/uiSession 等)', args: [
        { flag: '--json', purpose: '结构化' },
      ], jsonOutput: true, example: 'tinker state --json' },
      { name: 'triggers', purpose: '触发器自检 · 当前 commit 上 24 个触发器命中情况 + state 拦截原因 + 今日累计', args: [
        { flag: '--json', purpose: '结构化' },
      ], jsonOutput: true, example: 'tinker triggers' },
      { name: 'struggle', purpose: '看 / 关 / 重新开启踩坑跟踪状态机 (透明 + 信任建设)', args: [
        { arg: 'status | off | on', purpose: '默认 status · off 关 24h · on 重新开启' },
        { flag: '--json', purpose: '结构化' },
      ], jsonOutput: true, example: 'tinker struggle' },
      { name: 'session', purpose: '看 / 强制结束 UI session', args: [
        { arg: 'status | end', purpose: 'status 看 · end 标结束' },
        { flag: '--json', purpose: '结构化' },
      ], jsonOutput: true, example: 'tinker session status --json' },
      { name: 'llm', purpose: '看 / 设 / 清 LLM 配置 · 看 token 用量', args: [
        { arg: 'set | status | off | usage', purpose: '子命令' },
        { flag: '--json', purpose: '结构化' },
      ], jsonOutput: true, example: 'tinker llm usage --json' },
      { name: 'goodnight', alias: 'recap', purpose: '今日总结 (commits / Tinker push / Claude Code token)', args: [
        { flag: '--json', purpose: '结构化' },
        { flag: '--narrate', purpose: '让 LLM 朋友式说一句' },
      ], jsonOutput: true, example: 'tinker goodnight --json' },
      { name: 'push', purpose: '发一笔进展 · 直接 / 从草稿文件 / experience 单篇都支持', args: [
        { flag: '-m / --message', purpose: '内容' },
        { flag: '-p / --project', purpose: '指定项目 id (不指定时自动选唯一一个)' },
        { arg: '<file.md>', purpose: '从草稿文件发布 (含 autopsy 生成的 experience 草稿)' },
        { flag: '--as-experience', purpose: '把这条标为踩坑经验 (发完自动 markAsExperience)' },
        { flag: '--yes / -y', purpose: '跳过确认 (autopsy 草稿一键发用)' },
      ], jsonOutput: false, example: 'tinker push .tinker/drafts/experience-xxx.md --as-experience' },
      { name: 'ship', purpose: '完工仪式 · 进陈列馆', args: [
        { flag: '-m / --message', purpose: '感想' },
        { flag: '-p / --project', purpose: '项目 id' },
        { flag: '--image <path>', purpose: '本地图当封面' },
        { flag: '--no-screenshot', purpose: '不带封面' },
      ], jsonOutput: false, example: 'tinker ship -m "..."' },
      { name: 'stuck', purpose: '标卡住 + 写"卡在哪" + 通知关心你的人', args: [
        { flag: '-m / --message', purpose: '卡在哪' },
      ], jsonOutput: false, example: 'tinker stuck -m "..."' },
      { name: 'draft', purpose: 'LLM 看 git 历史起草 1-3 条候选', args: [
        { flag: '--since', purpose: '时间窗 · 默认 1h' },
      ], jsonOutput: false, example: 'tinker draft --since 2h' },
      { name: 'mute', purpose: '静音/解除触发器', args: [
        { arg: 'Nm | Nh | Nd | today | forever | off', purpose: '时长' },
      ], jsonOutput: false, example: 'tinker mute today' },
      { name: 'hook', purpose: '装 / 卸 post-commit hook', args: [
        { arg: 'install | uninstall', purpose: '子命令' },
      ], jsonOutput: false, example: 'tinker hook install' },
      { name: 'voice', purpose: 'voice fingerprint 系统', args: [
        { arg: 'analyze | teach', purpose: 'analyze 从 pool 生成 fingerprint · teach 手动喂样本' },
      ], jsonOutput: false, example: 'tinker voice analyze' },
      { name: 'update', purpose: '拉最新代码 + 重装 CLI', args: [
        { flag: '--check-only', purpose: '只刷新 cache 不真升级' },
      ], jsonOutput: false, example: 'tinker update' },
      { name: 'login', purpose: '配置 server / handle / token / LLM (交互)', args: [], jsonOutput: false, example: 'tinker login' },
      { name: 'borrow', purpose: '搜方法 + 踩坑经验 + 上手指南 (任意人的 update · is_method / is_experience / is_learning 优先)', args: [
        { arg: '<关键词>', purpose: '查询词 · 可中英混杂 · 1-200 字' },
        { flag: '--methods-only', purpose: '只看作者标方法的' },
        { flag: '--kind method|experience|learning', purpose: '过滤 · experience 只搜踩坑经验 · learning 只搜上手指南' },
        { flag: '--limit N', purpose: '返回条数 · 默认 10 · 上限 50' },
        { flag: '--json', purpose: 'machine-readable 输出' },
      ], jsonOutput: true, example: 'tinker borrow "supabase realtime" --kind learning' },
      { name: 'mark-experience', alias: 'mark-exp', purpose: '把自己一条 update 标为踩坑经验 (给 AI 检索时优先取)', args: [
        { arg: '<updateId>', purpose: '不传默认拿最近一条 push' },
        { flag: '--unmark <updateId>', purpose: '取消经验标' },
        { flag: '--json', purpose: 'machine-readable 输出' },
      ], jsonOutput: true, example: 'tinker mark-experience u-xxx' },
      { name: 'mark-learning', alias: 'mark-learn', purpose: '把自己一条 update 标为上手指南 (给 AI 检索入门新技术用)', args: [
        { arg: '<updateId>', purpose: '不传默认拿最近一条 push' },
        { flag: '--unmark <updateId>', purpose: '取消上手指南标' },
        { flag: '--json', purpose: 'machine-readable 输出' },
      ], jsonOutput: true, example: 'tinker mark-learning u-xxx' },
      { name: 'contribute', purpose: '标方法 · 现有 update 升格 / 或从 markdown 文件按段批量发', args: [
        { arg: '<updateId>', purpose: '不传默认拿最近一条 push' },
        { flag: '--unmark <updateId>', purpose: '取消方法标' },
        { flag: '--from-file <path.md>', purpose: '按 H1/H2/H3 切段交互选 · 隐私扫描 · 每段一条 update + 自动标方法' },
        { flag: '--auto', purpose: '配合 --from-file · 让 LLM 看完整篇推荐 3 段最值得分享的 · 跳过手动勾' },
        { flag: '--section "<标题>"', purpose: '配合 --from-file · 直接选指定段 (可多次)' },
        { flag: '--project <slug>', purpose: '配合 --from-file · 指定项目 (否则当前 repo 绑定 / 交互选)' },
        { flag: '--json', purpose: 'machine-readable 输出' },
      ], jsonOutput: true, example: 'tinker contribute --from-file docs/08.md --section "能力地图"' },
      { name: 'mcp', purpose: '启动 MCP server (stdio) · 给 Claude Code / Cursor 当 first-class tool', args: [], jsonOutput: false, example: 'tinker mcp' },
      { name: 'stream', purpose: 'NDJSON 事件流 · CLI 对偶 MCP 订阅 · 任何 AI 通过 stdout 都能拿', args: [
        { arg: '<resource>', purpose: 'triggers / today' },
        { flag: '--once', purpose: '打完当前 snapshot 就退 · 不长跑' },
      ], jsonOutput: true, example: 'tinker stream triggers' },
    ],
    pendingFile: path.join(CONFIG_DIR, 'pending.json'),
    promptStateFile: path.join(CONFIG_DIR, 'prompt-state.json'),
    configFile: CONFIG_FILE,
    notes: [
      'AI agent 工作流: 1) tinker check --json 看是否命中 · 2) 若命中读 pending · 3) tinker resolve <choice> -m "text" 执行',
      'AI 也可绕开触发器直接 push / ship / stuck (需要 -m 和 -p)',
      'json 模式下错误也走 JSON: { ok: false, error, code, exitCode: 1 }',
    ],
  };
  if (opts.json) { outputJson(schema); return; }
  // 人类可读 fallback (压缩版)
  log('');
  log(sepia('  CLI 命令清单 (用 ') + vermilion('--json') + sepia(' 拿结构化):'));
  schema.commands.forEach(c => {
    log(sepia('    ') + bold(c.name.padEnd(12)) + sepia(' ' + c.purpose));
  });
  log('');
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opts = parseArgs(args.slice(1));
  try {
    switch (cmd) {
      case 'login': await cmdLogin(); break;
      case 'config': await cmdConfig(opts); break;
      case 'projects': case 'ls': await cmdProjects(opts); break;
      case 'push': await cmdPush(opts); break;
      case 'stuck': await cmdStuck(opts); break;
      case 'ship': await cmdShip(opts); break;
      case 'update': await cmdUpdate({ checkOnly: args.includes('--check-only') }); break;
      case 'draft': await cmdDraft(opts); break;
      case 'hook':
        if (args[1] === 'install') await cmdHookInstall();
        else if (args[1] === 'uninstall') cmdHookUninstall();
        else if (args[1] === 'install-claude') await cmdClaudeHookInstall(opts);
        else if (args[1] === 'uninstall-claude') cmdClaudeHookUninstall();
        else { err('用法: tinker hook install | uninstall | install-claude | uninstall-claude'); process.exit(1); }
        break;
      case 'check': await cmdCheck({ fromHook: opts.fromHook, json: opts.json }); break;
      case 'resolve': await cmdResolve(args[1], opts); break;
      case 'voice':
        if (args[1] === 'analyze') await cmdVoiceAnalyze();
        else if (args[1] === 'teach') await cmdVoiceTeach(opts);
        else {
          log(sepia('  用法:'));
          log(sepia('    ') + vermilion('tinker voice analyze'));
          log(sepia('      用 pool 里的样本生成 fingerprint'));
          log(sepia('    ') + vermilion('tinker voice teach --from-claude'));
          log(sepia('      从 Claude Code 对话历史抽样本 (默认 100 条最近)'));
          log(sepia('    ') + vermilion('tinker voice teach --file <path>'));
          log(sepia('      从单个文件读样本'));
        }
        break;
      case 'mute': cmdMute(args[1]); break;
      case 'borrow': {
        // borrow 接所有 positional 参数当查询词 · 跳过 --xxx flag
        // tinker borrow "supabase 邮箱" --kind learning
        const qParts = [];
        for (let i = 1; i < args.length; i++) {
          const a = args[i];
          if (a.startsWith('--')) {
            // 带参 flag 要再跳一个 (不能把它的值当成 query)
            if (['--limit', '--unmark', '--kind', '--file'].includes(a)) i++;
            continue;
          }
          qParts.push(a);
        }
        await cmdBorrow(qParts.join(' '), opts);
        break;
      }
      case 'contribute': await cmdContribute(args[1], opts); break;
      case 'recent': await cmdRecent(opts); break;
      case 'mark-experience': case 'mark-exp':
        await cmdMarkExperience(args[1], opts); break;
      case 'mark-learning': case 'mark-learn':
        await cmdMarkLearning(args[1], opts); break;
      case 'mark-decision': case 'mark-dec':
        await cmdMarkDecision(args[1], opts); break;
      case 'situation':
        // tinker situation backfill --type design-loop --hours 6
        if (args[1] === 'backfill') await cmdSituationBackfill(opts);
        else { err('用法: tinker situation backfill [--type design-loop] [--hours 4]'); process.exit(1); }
        break;
      case 'session': await cmdSession(args[1], opts); break;
      case 'goodnight': case 'recap':
        await cmdGoodnight({
          narrate: opts.narrate || args.includes('--narrate'),
          json: opts.json,
          week: opts.week,
          month: opts.month,
          daysBack: opts.daysBack,
        });
        break;
      case 'maybe-goodnight':
        // 静默触发器 · 给 Claude Code user-prompt-submit-hook 调
        cmdMaybeGoodnight();
        return; // 不走末尾 showUpdateBannerIfNeeded · 保持 stdout 干净

      case 'llm': await cmdLlm(args[1], opts); break;
      case 'state': cmdState(opts); break;
      case 'triggers': cmdTriggers(opts); break;
      case 'struggle': await cmdStruggle(args[1], opts); break;
      case '__autopsy':
        // 内部命令 · 不暴露给 user help · 由 spawnAutopsyAsync detached child 调
        await cmdAutopsy(args[1]);
        return;
      case 'schema': cmdSchema(opts); break;
      case 'mcp':
        // 启动 MCP server · stdio 模式 · 给 Claude Code / Cursor 等当作 first-class tool
        // 配置: ~/.claude/mcp.json 加 { mcpServers: { tinker: { command: "tinker", args: ["mcp"] } } }
        const { startMcpServer } = require('../lib/mcp-server.js');
        await startMcpServer();
        return; // 这里不退出 · server 跑到 stdin EOF

      case 'stream': await cmdStream(args[1], opts); return; // 长跑 NDJSON 输出 · 不退出
      case 'watch': await cmdWatch(args[1]); break;  // 内部命令 · 被 spawnDeployWatcher 调用
      case 'help': case '--help': case '-h': case undefined: help(); break;
      default:
        if (opts.json) errJson('未知命令: ' + cmd, 'UNKNOWN_COMMAND');
        else { err('未知命令: ' + cmd); help(); process.exit(1); }
    }
    // 命令跑完 · 如果 cache 显示有更新就在末尾静静提示一行
    // 不在 hook / watch / check (--from-hook) / update 等后台/系统命令里显示
    if (!['watch', 'check', 'update', undefined, 'help', '--help', '-h'].includes(cmd)) {
      showUpdateBannerIfNeeded();
    }
  } catch (e) {
    if (e.message && (e.message.includes('User force closed') || e.message.includes('ExitPromptError'))) {
      log(sepia('\n  取消了\n'));
    } else {
      err(e.message || String(e));
      process.exit(1);
    }
  }
}

// 导出给 mcp-server.js 复用 · 不重写 API/state/git 逻辑
module.exports = {
  // 配置
  loadConfig, mustHaveConfig, CONFIG_DIR, CONFIG_FILE,
  // API
  apiState, apiMe, apiAction, safeFetch,
  // 状态持久化
  loadPromptState, savePromptState, todayKey, recordPushAt,
  // git
  inGitRepo, gitHistorySince,
  // LLM
  llmDraft, llmQuickDraft, sanitizeDraft, validateDraft,
  recordLLMUsage, getTodayLLMUsage,
  // Claude Code 用量
  getClaudeCodeUsageToday,
  // 触发器
  evaluateAllTriggers, loadRepoConfig,
  // pending (AI agent 路径)
  loadPending, savePending, clearPending,
  // sample pool
  savePoolSample,
  // 幂等性 (给 MCP / AI agent 防重放)
  withIdempotency, idemGet, idemSet,
  // drift 检测的注册表 (MCP 也可暴露)
  loadReposRegistry, registerRepoForDrift,
  // v0.13 markdown 工具 (单测可见)
  parseMarkdownSections, scanPrivacyRisks,
};

// 直接 ./tinker 跑才走 main · require 拿模块时不跑
if (require.main === module) {
  main();
}

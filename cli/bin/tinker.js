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

// v0.21 helper · cmdStudio / cmdBridge* 用 · 直接拿 JSON body · 不用每个 case 写 res.json()
async function safeFetchJson(cfg, path, init) {
  const res = await safeFetch(cfg, path, init);
  return res.json();
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

  // v0.20 voice 守门 · 防裸奔 AI 直出 (尤其 -m 直接 push 没经 draft 的)
  const gate = await gateVoiceCheck(pushText, opts);
  if (!gate.ok) process.exit(1);

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
      // v0.20 voice 守门 · 草稿也要过 · 因为 LLM 起草后用户可能没改就发
      const gate = await gateVoiceCheck(candidates[i].text, opts);
      if (!gate.ok) { log(C.red + '  ✗ ' + C.reset + sepia('候选 ' + (i+1) + ' 被 voice 守门拦了 · 加 --force 强发')); continue; }
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

  // v0.20 voice 守门 · --as-experience / --as-learning / --as-decision 也要过
  const gate = await gateVoiceCheck(text, opts);
  if (!gate.ok) process.exit(1);

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
  // v0.14 命名错位兜底:tinker update 在 CLI 业内是"升级自己" · 但 Tinker 里 update 是
  // 核心概念词 (一条进展记录) · 新用户手敲 tinker update 大概率是想"记一条进展"
  // TTY 时先确认 · 防误用 · 非 TTY (LLM / hook / pipe) 直接跑升级 不打扰
  if (process.stdin.isTTY && process.stdout.isTTY) {
    log(sepia('  ── ') + vermilion('提醒一下') + sepia(' ──'));
    log('  你是想' + bold('记一条进展') + '? 那个命令是 ' + vermilion("tinker push -m '...'"));
    log(sepia('  这个 ') + vermilion('tinker update') + sepia(' 是升级 CLI 自己 · 拉最新代码 + npm install -g'));
    log('');
    try {
      const { confirm } = require('@inquirer/prompts');
      const go = await confirm({ message: '要继续升级 CLI 吗?', default: false });
      if (!go) {
        log('');
        log(sepia('  好 · 没升级'));
        log(sepia('  记一条进展跑 ') + vermilion("tinker push -m '今天搞了 ...'"));
        log('');
        return;
      }
    } catch {
      log(sepia('  好 · 没升级'));
      return;
    }
    log('');
  }

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
// v0.17 post-commit hook 默认走 --json · 命中触发器只 stdout JSON + append pending-reminders.jsonl
// 不再弹 inquirer (Claude Code Bash tool 没 TTY · 弹了立刻 fall back 到 later · 用户感受不到)
// 用户后续可以跑 tinker pending --json 看待处理 reminder · AI 工具也能主动调
const HOOK_BLOCK = `${HOOK_BEGIN}
# 装/改/卸: tinker hook install | uninstall
command -v tinker >/dev/null 2>&1 && tinker check --from-hook --json >/dev/null 2>&1 || true
${HOOK_END}
`;

// v0.13 post-push hook · 用户 git push 时 · 自然的"模块告一段落" 信号
// detached spawn backfill · 不阻塞 push 返回 · 草稿后台跑
const POST_PUSH_BLOCK = `${HOOK_BEGIN}
# tinker post-push: detached backfill · 不阻塞
command -v tinker >/dev/null 2>&1 && \\
  (tinker situation backfill --type design-loop --hours 4 --quiet >/dev/null 2>&1 &) || true
${HOOK_END}
`;

// v0.13 post-checkout hook · 切回 main 分支时触发 (feature done)
// $1 = previous HEAD · $2 = new HEAD · $3 = 1 if branch checkout (not file)
const POST_CHECKOUT_BLOCK = `${HOOK_BEGIN}
# tinker post-checkout: 切回 main 时认为 feature 做完了 · 触发推演总结
if [ "$3" = "1" ]; then
  CUR_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ "$CUR_BRANCH" = "main" ] || [ "$CUR_BRANCH" = "master" ]; then
    command -v tinker >/dev/null 2>&1 && \\
      (tinker situation backfill --type design-loop --hours 4 --quiet >/dev/null 2>&1 &) || true
  fi
fi
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
// v0.25 Tinker 服务东八区用户 · 所有"今天 / 这周 / 这个月" 一律按北京时间算
// 不依赖运行机器时区 (阿里云 ECS 跑 UTC / 国外协作者跑 CLI 都能拿到一致结果)
const TZ_BEIJING = 'Asia/Shanghai';

// 北京时间今天 YYYY-MM-DD · en-CA locale 自然输出 ISO 日期格式
function todayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_BEIJING, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// 北京当前 0-23 小时 (用来判断凌晨)
function beijingHour() {
  return parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ_BEIJING, hour: 'numeric', hour12: false,
  }).format(new Date()), 10);
}

// 北京时间 (今天 + offsetDays) hour:00:00 对应的 UTC epoch ms
// hour 可以溢出 (28 = 明天 4am · 跟原 setHours(28) 语义一致)
function beijingDayStart(offsetDays = 0, hour = 0) {
  const [y, m, d] = todayKey().split('-').map(Number);
  return Date.UTC(y, m - 1, d + offsetDays, hour - 8, 0, 0);
}

// git log --since 用的 ISO 字符串 (UTC · git 能正确解析时区)
function beijingSinceISO(offsetDays = 0, hour = 4) {
  return new Date(beijingDayStart(offsetDays, hour)).toISOString();
}

// v0.88 工作日 key · 北京凌晨 0-4 算前一天的 tail · 给 maybe-goodnight 和 goodnight 标记用
function workdayKey() {
  if (beijingHour() >= 4) return todayKey();
  // 凌晨 · 拿昨天 (北京) 的 key
  const [y, m, d] = todayKey().split('-').map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d - 1));
  return yesterday.getUTCFullYear() + '-' +
    String(yesterday.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(yesterday.getUTCDate()).padStart(2, '0');
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
  installSingleGitHook(gitDir, 'post-commit', HOOK_BLOCK);
  installSingleGitHook(gitDir, 'post-push', POST_PUSH_BLOCK);
  installSingleGitHook(gitDir, 'post-checkout', POST_CHECKOUT_BLOCK);

  ok('hooks 装好了 · 三件套:');
  log(sepia('    post-commit    每次 commit 跑触发器评估 (24 个触发器自动判断)'));
  log(sepia('    post-push      推上之后后台起草推演总结 (不阻塞)'));
  log(sepia('    post-checkout  切回 main 后台起草推演总结 (feature done 信号)'));
  log('');
  log(sepia('  默认: 静默 · 满足触发条件才会出来问'));
  log(sepia('  关:    ') + vermilion('tinker hook uninstall'));
  log(sepia('  静音: ') + vermilion('tinker mute 1h') + sepia(' / ') + vermilion('tinker mute today'));
}

// v0.13 helper · 装一个 git hook · 复用 marker 块逻辑
function installSingleGitHook(gitDir, name, block) {
  const hookFile = path.join(gitDir, 'hooks', name);
  let content = '';
  if (fs.existsSync(hookFile)) {
    content = fs.readFileSync(hookFile, 'utf-8');
    content = content.replace(new RegExp(HOOK_BEGIN + '[\\s\\S]*?' + HOOK_END + '\\n?', 'g'), '');
  } else {
    content = '#!/bin/sh\n';
  }
  content = content.trimEnd() + '\n\n' + block;
  fs.writeFileSync(hookFile, content);
  fs.chmodSync(hookFile, 0o755);
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
  settings.hooks.SessionEnd = settings.hooks.SessionEnd || [];
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit || [];

  // 命令:每个 lifecycle 都试一遍 (design-loop 优先 · 不命中再 learning · 都不命中静默退)
  const backfillCmd = 'tinker situation backfill --type design-loop --hours 4 --quiet 2>/dev/null || tinker situation backfill --type learning --hours 4 --quiet 2>/dev/null || true';

  // SessionStart matcher=compact · 用户 /compact 时触发
  installClaudeHookEntry(settings.hooks.SessionStart, 'compact', backfillCmd, 'compact');

  // v0.22 SessionStart (无 matcher · 每次 Claude Code 启动跑) · 看 inbox 有没有未处理 handoff
  // 有的话 stdout 注入 reminder · 让接收方 Claude 自动 load 接力现场
  installClaudeHookEntry(settings.hooks.SessionStart, null, 'tinker bridge-check-inbox 2>/dev/null || true', 'bridge-inbox');

  // SessionEnd · 用户 Cmd+Q 或 session 终止时触发
  installClaudeHookEntry(settings.hooks.SessionEnd, null, backfillCmd, 'session-end');

  // v0.16 词典统一:matcher 词从 MAYBE_KINDS 拿 · 改词只动 MAYBE_KINDS 一处 · DRY
  // 跨 AI 通用入口 `tinker maybe-check --text "..."` 跟这里共用同一份词典
  // tinker maybe-goodnight 走单独的 GOODNIGHT_MATCHER · 自己判断今天值不值得收尾
  installClaudeHookEntry(settings.hooks.UserPromptSubmit, GOODNIGHT_MATCHER, 'tinker maybe-goodnight 2>/dev/null || true', 'goodnight');

  // 6 组 maybe-X · 每组 matcher 词从 MAYBE_KINDS 取
  // kind camelCase → shell command kebab-case (cleverFix → clever-fix)
  const KIND_TO_CMD = { stuck: 'stuck', breakthrough: 'breakthrough', decision: 'decision', subtraction: 'subtraction', cleverFix: 'clever-fix', ship: 'ship', handoff: 'handoff', invite: 'invite' };
  for (const [kind, cfg] of Object.entries(MAYBE_KINDS)) {
    if (!cfg.matcher) continue;
    const cmdName = KIND_TO_CMD[kind];
    installClaudeHookEntry(settings.hooks.UserPromptSubmit, cfg.matcher, `tinker maybe-${cmdName} 2>/dev/null || true`, cmdName);
  }

  // v0.17 全局 UserPromptSubmit (无 matcher) · 每次用户 prompt 都 check pending reminders
  // post-commit hook 触发的 reminder 没人处理时 · 这里会注入 AI context · 让 AI 主动汇报
  installClaudeHookEntry(settings.hooks.UserPromptSubmit, null, 'tinker pending --check 2>/dev/null || true', 'pending-check');

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  log('');
  ok('Claude Code hooks 装好了:');
  log(sepia('    SessionStart compact              · /compact 时'));
  log(sepia('    SessionStart bridge-inbox         · 每次启动 · 看 inbox 有未处理 handoff'));
  log(sepia('    SessionEnd                         · 关 Claude Code / 系统 sleep 时'));
  log(sepia('    UserPromptSubmit pending-check    · 每次用户 prompt · 检查 hook 触发的待处理 reminder'));
  log(sepia('    UserPromptSubmit goodnight        · 说收工类的话'));
  log(sepia('    UserPromptSubmit stuck            · 说卡住类的话'));
  log(sepia('    UserPromptSubmit breakthrough     · 说顿悟类的话'));
  log(sepia('    UserPromptSubmit decision         · 做工具/方案选择'));
  log(sepia('    UserPromptSubmit subtraction      · 说砍 / 删类的话'));
  log(sepia('    UserPromptSubmit clever-fix       · 说搞通 / 跑通类的话'));
  log(sepia('    UserPromptSubmit ship             · 说完工 / 上线类的话'));
  log(sepia('    UserPromptSubmit handoff          · 说接力 / 交接给类的话 · 自动跑 tinker handoff'));
  log(sepia('    UserPromptSubmit invite           · 说邀请加入类的话 · 自动跑 tinker studio invite'));
  log(sepia('  matcher 命中 → maybe-X 静默判断 → 输出 reminder 注入 AI 上下文 → AI 看上下文决定是否提醒'));
  log('');
  log(sepia('  关:    ') + vermilion('tinker hook uninstall-claude'));
}

// helper · 装一个 Claude Code hook entry (匹配 matcher 或没 matcher 的全局 hook)
// 已存在我们装的 · 更新;别人的 · 附加;否则新建
function installClaudeHookEntry(arr, matcher, cmd, kind) {
  const existingIdx = matcher
    ? arr.findIndex(h => h && h.matcher === matcher)
    : arr.findIndex(h => h && !h.matcher);
  const newEntry = matcher
    ? { matcher, hooks: [{ type: 'command', command: cmd }] }
    : { hooks: [{ type: 'command', command: cmd }] };

  if (existingIdx >= 0) {
    const cur = arr[existingIdx];
    const isOurs = cur.hooks && cur.hooks.some(h => h.command && h.command.includes('tinker situation'));
    if (isOurs) {
      arr[existingIdx] = newEntry;
    } else {
      cur.hooks = cur.hooks || [];
      cur.hooks.push({ type: 'command', command: cmd });
    }
  } else {
    arr.push(newEntry);
  }
}

function cmdClaudeHookUninstall() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) { log(sepia('  没装 · 直接退')); return; }
  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); }
  catch { err('settings.json 解析失败 · 手动看一下'); process.exit(1); }

  const before = JSON.stringify(settings);
  // 卸 SessionStart compact 跟 SessionEnd 两套
  ['SessionStart', 'SessionEnd'].forEach(evt => {
    const list = (settings.hooks && settings.hooks[evt]) || [];
    for (let i = list.length - 1; i >= 0; i--) {
      list[i].hooks = (list[i].hooks || []).filter(h => !(h.command || '').includes('tinker situation'));
      if (list[i].hooks.length === 0) list.splice(i, 1);
    }
  });

  if (JSON.stringify(settings) === before) {
    log(sepia('  没找到 Tinker hook · 没动'));
    return;
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  ok('Claude Code hooks 删了 (SessionStart compact + SessionEnd)');
}

function cmdHookUninstall() {
  if (!inGitRepo()) { err('不在 git 仓库'); process.exit(1); }
  const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf-8' }).trim();
  // v0.13 卸 3 个 hooks
  let any = false;
  ['post-commit', 'post-push', 'post-checkout'].forEach(name => {
    if (uninstallSingleGitHook(gitDir, name)) any = true;
  });
  if (any) ok('hooks 移除了');
  else log(sepia('  没找到 tinker 的 hook 块'));
}

// v0.13 helper · 卸 marker 块
function uninstallSingleGitHook(gitDir, name) {
  const hookFile = path.join(gitDir, 'hooks', name);
  if (!fs.existsSync(hookFile)) return false;
  let content = fs.readFileSync(hookFile, 'utf-8');
  const before = content;
  content = content.replace(new RegExp(HOOK_BEGIN + '[\\s\\S]*?' + HOOK_END + '\\n?', 'g'), '');
  content = content.replace(/^.*tinker post-commit hook[\s\S]*?esac\s*\n/m, '');
  content = content.trimEnd();
  if (content === before.trimEnd()) return false;
  if (content === '#!/bin/sh' || content === '') {
    fs.unlinkSync(hookFile);
  } else {
    fs.writeFileSync(hookFile, content + '\n');
  }
  return true;
}

function cmdHookUninstallLegacy() {  // kept for legacy reference · unused
  if (!inGitRepo()) { err('不在 git 仓库'); process.exit(1); }
  const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf-8' }).trim();
  const hookFile = path.join(gitDir, 'hooks', 'post-commit');
  if (!fs.existsSync(hookFile)) { log(sepia('  没装 hook · 直接退')); return; }
  let content = fs.readFileSync(hookFile, 'utf-8');
  const before = content;
  content = content.replace(new RegExp(HOOK_BEGIN + '[\\s\\S]*?' + HOOK_END + '\\n?', 'g'), '');
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
    //   v0.90 FRUSTRATED 从这里搬走 · 改看 reflog 行为 (triggerFrustrationBehavior)
    //   原因: commit msg 是计划文字 · "靠 X 实现" 不是骂人 · "测试崩了" 不是个人崩溃
    //   SHIP / STUCK / PROTOTYPE · 显式仪式词 · 信号最直接 priority 100
    //   BREAKTHROUGH · "终于明白" 不含跑通 · 没被 SHIP 吃掉才到这 95
    //   DECISION · v0.2 新加 · 工具链选型 priority 85 · 比 fix 长期价值高
    //   FIX / TINKER / DISCOVERY · 弱信号最后

    // v0.91 conventional commit prefix 检测 · feat:/fix:/refactor: 等开头 = 技术叙述
    // 主要给 BRAND 用 · 避免项目作者自指误触发 · 其他触发器维持原判断
    const isConventionalCommit = /^(feat|fix|refactor|chore|docs|test|style|build|ci|perf|revert)(\([^)]+\))?:/i.test(title);

    // SHIP (仪式信号 · 完工) · 优先级 100 · 同时命中时盖过 BREAKTHROUGH
    // v0.91 砍 merged? (git merge 高频) / done|finished? (多义) / 发布|完成 (描述性)
    // 留显式仪式词 · 真完工才命中
    const SHIP_WORDS = /(\bship(?:ped|s|it)?\b|\bdeployed?\b|\breleased?\b|\blaunch(?:ed)?\b|\brolled out\b|完工|跑通|上线|上架)/i;
    if (SHIP_WORDS.test(scanText)) {
      return { fired: true, priority: 100, reason: 'keyword-ship', kind: 'ship', msg: `像完工的 commit: ${dim(titleSnippet)}`, suggestion: '要不要进陈列馆 · 写一句感想' };
    }

    // STUCK (技术性卡住 · 不像 FRUSTRATED 那么情绪化)
    // v0.91 砍 hotfix (是 commit prefix 不是状态)
    const STUCK_WORDS = /(\bstuck\b|卡住|卡了|卡在|\bbroken\b|挂了|不对劲|出问题|报错了|\bblocker\b)/i;
    if (STUCK_WORDS.test(scanText)) {
      return { fired: true, priority: 100, reason: 'keyword-stuck', kind: 'stuck', msg: `像卡住的 commit: ${dim(titleSnippet)}`, suggestion: '要不要标卡住 · 让在意的人看到' };
    }

    // PROTOTYPE
    // v0.91 砍 demo (demo 数据 / demo 视频高频)
    const PROTO_WORDS = /(\bprototype\b|原型|\bmockup\b)/i;
    if (PROTO_WORDS.test(scanText)) {
      return { fired: true, priority: 100, reason: 'keyword-prototype', kind: 'prototype', msg: `像原型节点的 commit: ${dim(titleSnippet)}`, suggestion: '要不要把原型挂上 · 顺便记一笔' };
    }

    // BREAKTHROUGH · "终于明白 / 想清楚了" · 没被 SHIP 吃掉的顿悟时刻
    // v0.91 砍 clicked (UI 词高频) / got it (太宽泛) · 修了 done|done 重复 bug
    const BREAKTHROUGH_WORDS = /(终于(?:明白|搞清|搞定|想通|懂了)|搞清楚了|想清楚了|想通了|想明白了|顿悟|\baha\b|\bfinally\b(?!\s+(?:ship|done)))/i;
    if (BREAKTHROUGH_WORDS.test(scanText)) {
      return { fired: true, priority: 95, reason: 'keyword-breakthrough', kind: 'progress', msg: `像顿悟的 commit: ${dim(titleSnippet)}`, suggestion: '这种十秒钟很难复现 · 一笔留下来吧' };
    }

    // v0.2 #1 DECISION · 工具链选型 · 长期记得起来比 fix 重要
    // v0.91 砍 升级|降级|引入(了)?|移除(了)?|去掉了|选了 (高频日常依赖管理 · 不是工具链决策)
    // 留明确动词性决策: adopt / switch to / migrate to / 换成 / 改用 / 切到 / 采用 / 放弃 等
    const DECISION_WORDS = /(\badopt(?:ed|ing)?\b|\bswitch(?:ed|ing)?\s+to\b|\bmov(?:e|ed|ing)\s+to\b|\bmigrat(?:e|ed|ing)\s+to\b|\bstop\s+using\b|\bdeprecat(?:e|ed|ing)\b|装(?:了|上)|装上|换成|改用|不再用|不用了|切到|切换到|定下来|决定用|采用|放弃(?:了)?|改回)/i;
    if (DECISION_WORDS.test(scanText)) {
      return { fired: true, priority: 85, reason: 'keyword-decision', kind: 'decision', msg: `像工具链决策的 commit: ${dim(titleSnippet)}`, suggestion: '这种决策几个月后自己都想不起为什么 · 记一笔吧' };
    }

    // v0.91 FIX 触发器整体砍 (§12 砍 > 加)
    // 原因: 每个 fix:/fix(scope): commit 都命中 · 最大疲劳源
    // 真值钱的 fix 会自动被 BREAKTHROUGH ("终于搞定") / DECISION ("换成 X 修了") 抓走
    // 普通 fix 不需要 prompt · 违反 §10 不烦人精神

    // BRAND_MENTION · "捣鼓" / "Tinker" 出现 = 品牌 engagement 信号
    // 设计:全世界除了 Tinker 社区谁会写"捣鼓" · 一旦出现就大概率关于我们
    // v0.91 加自指守卫: conventional commit prefix 开头 + 看 git remote 是 tinker repo → 跳过
    // 项目作者在自己 repo 里 commit 含"捣鼓" = 必然 · 不算品牌 mention
    let isOwnTinkerRepo = false;
    try {
      const remote = execSync('git remote get-url origin 2>/dev/null', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      isOwnTinkerRepo = /tinker/i.test(remote);
    } catch {}
    const BRAND_WORDS = /(捣鼓|\btinker\b)/i;
    if (BRAND_WORDS.test(scanText) && !(isConventionalCommit && isOwnTinkerRepo)) {
      return { fired: true, priority: 75, reason: 'keyword-brand', kind: 'brand', msg: `commit 里有"捣鼓": ${dim(titleSnippet)}`, suggestion: '这是关于 Tinker 的什么?' };
    }

    // v0.91 TINKER 触发器整体砍 (§12 砍 > 加)
    // 原因: "玩了/弄了/搞了/折腾/试了" 全是日常虚词 · 无独占价值
    // 真有趣的探索会被 DISCOVERY / PROTOTYPE / BREAKTHROUGH 抓走
    // 留 TINKER 只是噪音 · priority 70 实际命中率高但价值低

    // DISCOVERY (发现 / 学到)
    // v0.91 砍 原来 (太宽 "原来在这"/"原来配置错了")
    const DISCOVERY_WORDS = /(发现|意识到|才知道|学到|学了|理解了|\blearned\b|\brealized?\b|\bdiscovered?\b|\bturns out\b)/i;
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
  const since = beijingSinceISO(0, 4);
  // 算每个 registered repo 今日 commit 数 (北京时间 4am 起)
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
    suggestion: `要不切到那边记一笔 · 还是这边其实没动 (那这一笔可能不发就好)`,
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
      suggestion: '作者花时间写的事一般值得记 · 顺手记一笔吧',
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
    // "今天" 从北京时间凌晨 4 点开始算 · 跟 mute 'today' 的语义对齐 · 熬夜 coder 友好
    const since = beijingSinceISO(0, 4);
    const out = execSync(
      `git log --since="${since}" --no-merges --pretty=format:"%h"`,
      { encoding: 'utf-8' }
    ).trim();
    const count = out ? out.split('\n').length : 0;
    if (count !== 1) return { fired: false }; // 不是首条不触发
    return { fired: true, priority: 60, reason: 'first-commit', msg: '早 · 今天首条 commit', suggestion: '想了想要做什么了吗? 写一笔规划自己听' };
  } catch { return { fired: false }; }
}

// v0.90 行为信号 FRUSTRATED · 替代 v0.2 keyword-frustrated 列表
// 老设计看 commit msg · 但 commit msg 是计划写出来的描述文字 · 不是当下情绪
// "靠 X 实现" 的"靠"会被当骂人 · "测试崩了"的"崩"会被当个人崩溃 · 误触发率天花板
// 真破防的人短时间会 reset --hard / amend 反复 / revert 来回 · 这才是行为信号
function triggerFrustrationBehavior() {
  try {
    const out = execSync('git reflog --date=unix -n 100', { encoding: 'utf-8' }).trim();
    if (!out) return { fired: false };
    const windowMs = 30 * 60 * 1000; // 30 分钟密度窗口
    const now = Date.now();
    const minThreshold = 3;
    let undoCount = 0;
    let hardResetCount = 0;
    for (const line of out.split('\n')) {
      // 格式: <sha> HEAD@{<unix_ts>}: <action>
      const m = line.match(/HEAD@\{(\d+)\}:\s*(.+)$/);
      if (!m) continue;
      const ts = parseInt(m[1], 10) * 1000;
      if (now - ts > windowMs) break; // reflog 时间倒序 · 越窗口就停
      const op = m[2];
      // 撤销类: reset / commit (amend) / revert · 真"卷在哪了"的信号
      if (/^reset:/.test(op) || /^commit \(amend\)/.test(op) || /^revert:/.test(op)) {
        undoCount++;
        if (/^reset:/.test(op)) hardResetCount++;
      }
    }
    if (undoCount >= minThreshold) {
      const what = hardResetCount >= 2
        ? `reset 来回 ${hardResetCount} 次`
        : `${undoCount} 次撤销操作`;
      return {
        fired: true,
        priority: 101,
        reason: 'behavior-undo-spree',
        kind: 'frustrated',
        msg: `近 30 分钟 ${what} · 卡在哪了`,
        suggestion: '不打分。不告诉别人。看你想怎么处理。'
      };
    }
    return { fired: false };
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
    suggestion: '想记一笔总结吗? 我会自动等 deploy 完贴 before/after 对比图',
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
  const child = spawn(process.argv[0], [process.argv[1], 'watch-deploy', taskFile], {
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
    triggerFrustrationBehavior(),
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

  // v0.13 冷却:30 分钟内同 reason 已经 prompt 过 + 不是 keyword 级 (priority < 100) 不再 prompt
  // 之前用全局 lastPromptedAt · clever-fix 跟 tool-combo 互压 · 一天命中 10+ 但用户只听到 1 次
  // 改成 per-reason · 不同信号源不再互相吃掉 · keyword 级 (priority >= 100) 仍豁免冷却
  const byReason = state.lastPromptedAtByReason || {};
  const lastForThisReason = byReason[result.reason];
  const suppressedByCooldown = lastForThisReason && (now - lastForThisReason) < 30 * 60 * 1000 && result.priority < 100;
  // v0.12 不管最后是否 prompt · 都记 winner 到今日 hits (给 goodnight + tinker triggers 看)
  recordTriggerWinner(state, result, suppressedByCooldown);
  savePromptState(state);
  if (suppressedByCooldown) {
    return;
  }

  // 非 TTY (Bash 工具触发 git commit / CI / detached) 时 silently 跳过
  // 之前 line 3315 select() 在非 TTY 会抛错 · catch 默认 'later' → 静默 1 小时
  // 用户看着像"被 Tinker 自动选了稍后 1 小时再问" · 实际上 select 根本没机会问
  // 不污染 state · 下次真 TTY commit 仍能正常触发 (winner 已经在 line 3143 记给 goodnight)
  if (!opts.json && !(process.stdin.isTTY && process.stdout.isTTY)) {
    try { logTriggerEvent('check-skip-non-tty', 'fired', { trigger_kind: result.kind, trigger_reason: result.reason }); } catch {}
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
  //   keyword=frustrated → 特殊:不说"想记一笔"·三选 [标卡住 / 喘口气 / 没事接着搞]
  //   keyword=ship → "进陈列馆" (走 shipProject) 排第一
  //   keyword=stuck → "标卡住" 排第一
  //   其他 → "记一笔" 排第一
  const choices = [];
  if (result.kind === 'frustrated') {
    // 破防时刻 · 文案 / 选项跟其他都不一样 · 不要产品语言
    choices.push({ name: '⚠ 标卡住 · 让在意你的人看到', value: 'stuck-quiet' });
    choices.push({ name: '暂停 30 分钟 · 出去走走', value: 'mute-30m' });
    choices.push({ name: '没事 · 我接着搞', value: 'skip-once' });
  } else if (result.kind === 'ui-session') {
    // UI session 结束 · 想记一笔 + 自动贴对比图 (第二个 commit 加 deploy watcher)
    choices.push({ name: '记一笔 · 自动贴 before / after 对比图', value: 'ui-push' });
    choices.push({ name: '只记一笔 · 不要对比图', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'brand') {
    // 品牌信号 · "捣鼓" / Tinker 出现 · 主动认歧义 · 让用户挑哪种意思
    // v0.2 #3: 两个选项 value 区分 · 让 input prompt 文案匹配语境
    choices.push({ name: '是 Tinker 项目本身的进展 · 记一笔', value: 'push-brand-self' });
    choices.push({ name: '是用 Tinker 做事情的反思 · 记一笔', value: 'push-brand-meta' });
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
    choices.push({ name: '顺手记一笔', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'ship') {
    choices.push({ name: '✦ 进陈列馆 · 写一句完工感想', value: 'ship' });
    choices.push({ name: '只记一笔普通进展', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'stuck') {
    choices.push({ name: '⚠ 标卡住 · 写在哪里卡了', value: 'stuck' });
    choices.push({ name: '只记一笔普通进展', value: 'push' });
    choices.push({ name: '稍后 · 1 小时后再问', value: 'later' });
    choices.push({ name: '今天不发了 · 明天再问', value: 'skip-today' });
    choices.push({ name: '静音 24 小时', value: 'mute' });
  } else if (result.kind === 'prototype') {
    choices.push({ name: '◐ 进陈列馆 · 作为原型', value: 'prototype' });
    choices.push({ name: '只记一笔普通进展', value: 'push' });
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
    // v0.17 累积模式 · 同时 append 到 pending-reminders.jsonl
    // savePending 是单条覆盖 (给 tinker resolve 走 pending.json 路径用 · 兼容老 flow)
    // pending-reminders.jsonl 是累积 · 不覆盖 · AI 工具 / 用户随时能扫"待处理 reminder 列表"
    // post-commit hook 跑这条路径 · 命中触发器自动 append · 用户 / LLM 后续 tinker pending --json 看
    appendPendingReminder({
      id: 'pr-' + now + '-' + Math.random().toString(36).slice(2, 6),
      at: new Date(now).toISOString(),
      kind: result.kind,
      reason: result.reason,
      priority: result.priority,
      msg: stripAnsi(result.msg),
      suggestion: result.suggestion || '',
      projectId: repoCfg.projectId,
      projectName: repoCfg.projectName,
      commitSha: (() => { try { return execSync('git log -1 --pretty=%h', { encoding: 'utf-8' }).trim(); } catch { return ''; } })(),
      commitTitle: pending.commitTitle,
      cwd: process.cwd(),
      choices: choices.map(c => ({ id: c.value, label: stripAnsi(c.name) })),
      handled: false,
    });
    // 写 state · 标记已 prompt · 防重复触发
    state.lastPromptedAt = now;
    state.lastPromptedAtByReason = state.lastPromptedAtByReason || {};
    state.lastPromptedAtByReason[result.reason] = now;
    if (result.priority < 70) state.lowFiredTodayKey = todayKey();
    savePromptState(state);
    // v0.17 bridge auto-ping · 用户开了的话自动通知团队
    // 失败静默 · 不阻塞 hook
    try {
      const cfg2 = (() => { try { return loadConfig(); } catch { return null; } })();
      if (cfg2 && cfg2.serverUrl && cfg2.token) await maybeAutoPing(result, repoCfg, cfg2);
    } catch {}
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
  state.lastPromptedAtByReason = state.lastPromptedAtByReason || {};
  state.lastPromptedAtByReason[result.reason] = now;
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
    // v0.20 voice 守门
    const gate1 = await gateVoiceCheck(text, opts);
    if (!gate1.ok) { log(sepia('  voice 守门拦了 · 没发')); return; }
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
    // v0.20 voice 守门
    const gate2 = await gateVoiceCheck(text, opts);
    if (!gate2.ok) { log(sepia('  voice 守门拦了 · 没发')); return; }
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
  const dayStart = beijingDayStart(-(daysBack - 1), 4);
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
      const since = beijingSinceISO(-(daysBack - 1), 4);
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
    const rangeStart = beijingDayStart(-(daysBack - 1), 4);
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
  log(sepia('  ── ') + vermilion(titleText) + sepia(' ── ') + sepia(new Intl.DateTimeFormat('zh-CN', { timeZone: TZ_BEIJING, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())));
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
    const todayStart = beijingDayStart(0, 4);
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
    // v0.13 注入 fingerprint + 真实样本 · 让 narrate 按作者真实气质写 · 不是通用 LLM 朋友腔
    const fingerprintBlock = loadFingerprint();
    const goodSamplesBlock = loadGoodSamples(2);
    const voiceInjection = (fingerprintBlock || goodSamplesBlock)
      ? `\n\n${fingerprintBlock}\n\n${goodSamplesBlock}\n`
      : '';
    const prompt = `今天的 git commits:\n${commitsLine}\n\n今天发到 Tinker 的 updates:\n${updatesLine || '(无)'}\n\n用一段话 (80-150 字) 替作者收个尾 · 准备睡觉 · 语气朋友式 · 不总结 · 给一句你觉得最值得说的 · 一句"明天接着搞"那种话。不要"总结今天"那种 PM 周报开头。${voiceInjection}`;
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
  // 用 workdayKey · 凌晨 23:50 跑 / 凌晨 00:30 又说晚安 应该算同一天
  if (daysBack === 1) {
    const ps = loadPromptState();
    ps.lastGoodnightDate = workdayKey();
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
  if (ps.lastGoodnightDate === workdayKey()) return;
  // 不在 git repo → 静默 · 没法判断今日活动
  if (!inGitRepo()) return;
  // "工作日" commit 数 · 凌晨 0-4 算前一天 (不然 since=今日4am 是未来时间 · git 返回 0)
  let commitCount = 0;
  try {
    const since = `${workdayKey()} 04:00`;
    const out = execSync(`git log --since="${since}" --no-merges --oneline`, { encoding: 'utf-8' }).toString().trim();
    commitCount = out ? out.split('\n').length : 0;
  } catch { return; }
  if (commitCount === 0) return;
  // 命中 · 输出 reminder 给 hook 注入到 Claude Code 对话
  process.stdout.write(`用户今天在当前 repo commit 了 ${commitCount} 次但还没跑 tinker goodnight 收尾 · 用户刚说了收工类的话 · 可以主动提醒一下\n`);
}

// v0.14 对话内 maybe-X 触发器 · 把 keyword 触发从 commit message 搬到 Claude Code 对话
// 思路:commit message 是事后总结 · 真正的卡住/顿悟/决策/砍/修通/完工 都发生在跟 AI 对话里
// 每个命令静默检查 per-kind 冷却 (默认 60 min) · 命中 → stdout reminder 给 hook 注入我的 context
// 我看到 reminder 才主动跟用户说 · 不命中静默退出
// v0.16 maybe-X 词典升格:install-claude (Claude Code hook) 跟 maybe-check (跨 AI 通用) 共用同一份
// matcher 字段 = 正则 · | 分隔多个关键词 · 命中任意一个就算 kind hit
// 改关键词只动这里一处 · install-claude 跟 cmdMaybeCheck 都拿到新词
// goodnight 是特殊 kind · 不在这里 (有自己的 lastGoodnightDate / commit 数判断)
const MAYBE_KINDS = {
  stuck: {
    cooldownMin: 60,
    matcher: '卡住了|卡了|不行|怎么都|还是错|搞不定|不知道哪|找不到|为什么不|跑不起来',
    reminder: '用户跟 AI 对话里出现卡住相关的话 · 如果是真的困住没思路 (不是一句普通描述) · 可以建议跑 `tinker stuck "一句话说卡哪"` 让在意 ta 的人看到 · 看上下文判断 · 不是每次都建议',
  },
  breakthrough: {
    cooldownMin: 30,
    matcher: '懂了|明白了|哦哦|原来如此|终于通了|噢|啊我懂|找到原因|找到问题|搞清楚了',
    reminder: '用户刚说了顿悟类的话 (懂了 / 明白了 / 哦哦 等) · 顿悟时刻的十秒钟难复现 · 如果是真的有发现 · 可以建议跑 `tinker push -m "..."` 留一笔 · 上下文判断',
  },
  decision: {
    cooldownMin: 60,
    matcher: '决定用|还是用|改用|选 |不用 |换成|放弃|敲定|决定不|敲定下来',
    reminder: '用户在对话里做了工具链 / 方案选择 · 几个月后自己都想不起为什么选这个 · 如果是有思考的决策 · 可以建议跑 `tinker push -m "..."` 记下来 (或者 push-decision) · 不是每次都建议',
  },
  subtraction: {
    cooldownMin: 60,
    matcher: '砍了|砍掉|删了|算了|不做了|不要这个|去掉|移除|撤了|拿掉|不做这',
    reminder: '用户刚说了砍 / 删除 / 不做了类的话 · 减法决策是工程师圈最难学的事 · 如果是有理由的取舍 (不是临时改主意) · 可以建议记一笔说为什么砍',
  },
  cleverFix: {
    cooldownMin: 30,
    matcher: '跑通了|搞通了|搞定了|搞定|跑起来了|修好了|改好了|通了|终于跑|终于成|成功了',
    reminder: '用户刚说了跑通 / 搞通 / 搞定类的话 · 如果是修复了别人能学的真坑 · 可以建议跑 `tinker push -m "..."` 把这个修法留下来 · 上下文判断不是每次都建议',
  },
  ship: {
    cooldownMin: 60,
    matcher: '完工|发出去|上线了|发布了|做完了|部署了|deploy 了|push 了|release 了|线上了|搞完了',
    reminder: '用户刚说了完工 / 发出去 / 上线类的话 · 如果是真的发布了 (不只是计划) · 可以建议跑 `tinker ship -m "一句话感想"` 进陈列馆',
  },
  handoff: {
    cooldownMin: 30,
    matcher: '接力|交接给|帮我接力|给.{0,4}接着做|让.{0,4}接|你接一下|你接着做|换人|这个给.{0,4}做|把现场|把这个交给|打包给',
    reminder: '用户对话里像是想 handoff 接力 · 把当前现场打包发给队友。\n看上下文判断是不是真的想交接 · 不是的话别打扰 (单说"接"字不算)。\n是的话主动帮用户跑命令 · 不是只提醒:\n1) 看对话上下文写一句 50-100 字 handoff 说明 · 气质参考: "X 做了一半 · 卡在 Y · 你接着 Z" · 不是产品发布会语气\n2) 找接收方 handle: 从对话里看 (比如"给猫猫" → -t @maomao) · 没指定就走 active studio 广播 (不带 -t)\n3) Bash 跑 `tinker handoff -m "<你写的说明>" [-t @<handle>]`\n4) 命令输出给用户看 · 让用户确认是否真的发了 (handoff 一旦发出去对方就收到 · 没法撤回)',
  },
  invite: {
    cooldownMin: 30,
    matcher: '邀请.{0,4}加入|拉.{0,4}进|拉.{0,4}入|加入.{0,4}(工作室|团队|我们)|让.{0,4}(进|加入)|把.{0,4}拉.{0,4}进|拉一下.{0,4}(进|入)',
    reminder: '用户对话里像是想邀请队友加入工作室。跟其他 maybe-X 不同 · invite 让你主动跑命令:\n1) 找 slug: 跑 `tinker studio list` 看用户哪个 active · 用 active 的 slug\n2) 找目标 handle: 从对话里看 (比如"邀请猫猫" → @猫猫)\n3) Bash 跑 `tinker studio invite <slug> @<handle>`\n4) 命令自动通过 bridge 投递邀请通知给对方 · 不用复制 token 微信发\n5) 报告用户已发 · 对方 watch 上会收 + 下次起 Claude session 提示一键加入',
  },
};

// goodnight matcher · 单独存 (cmdMaybeGoodnight 有自己的判断逻辑 · 不走 MAYBE_KINDS)
const GOODNIGHT_MATCHER = '晚安|收工|今天就到|明天继续|睡了|累了|下班|收摊|休息|不弄了|做到这|歇了';

// v0.14 maybe-X 命中观测 · 追加 jsonl 到 ~/.tinker/trigger-log.jsonl
// 只记 kind / event / cwd / 冷却剩余 · 不持久 prompt 内容 · 失败静默
function logTriggerEvent(kind, event, extra) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      kind,
      event,
      cwd: process.cwd(),
      ...extra,
    }) + '\n';
    fs.appendFileSync(path.join(CONFIG_DIR, 'trigger-log.jsonl'), line);
  } catch { /* 容错 · 日志失败不影响触发器 */ }
}

function cmdMaybe(kind) {
  const cfg = MAYBE_KINDS[kind];
  if (!cfg) return;
  const ps = loadPromptState();
  ps.lastMaybeAtByKind = ps.lastMaybeAtByKind || {};
  const last = ps.lastMaybeAtByKind[kind];
  const now = Date.now();
  if (last && (now - last) < cfg.cooldownMin * 60 * 1000) {
    logTriggerEvent(kind, 'cooled_down', { remaining_ms: cfg.cooldownMin * 60 * 1000 - (now - last) });
    return;
  }
  ps.lastMaybeAtByKind[kind] = now;
  savePromptState(ps);
  logTriggerEvent(kind, 'fired', { cooldown_min: cfg.cooldownMin });
  process.stdout.write(cfg.reminder + '\n');
}

// v0.16 跨 AI 通用入口 · 任何 AI 工具的 LLM 看用户消息 · 主动 Bash 跑这个
// 把所有 MAYBE_KINDS 的 matcher 跑一遍 · 命中且未冷却的输出 reminder
// 设计原则:
// - 共用 lastMaybeAtByKind 冷却 · 跟 hook 触发的 maybe-X 不会重复
// - 多个 kind 可能同时命中 · 全部输出 (LLM 自己看上下文挑)
// - --json 输出结构化数组 · 默认人可读
// 用法: tinker maybe-check --text "用户的最近一条消息"
function cmdMaybeCheck(opts) {
  const text = (opts.text || '').trim();
  if (!text) {
    if (opts.json) return errJson('用法: tinker maybe-check --text "<用户消息>"', 'NO_TEXT');
    err('用法: ' + vermilion('tinker maybe-check --text "<用户消息>"'));
    log(sepia('  把用户的最近一条 prompt 喂给我 · 我跑全部 matcher · 输出命中且没冷却的 reminder'));
    log(sepia('  Claude Code 用户:hook 会自动跑 · 不用手动调'));
    log(sepia('  其他 AI 用户 (Cursor / Aider 等):LLM 看到用户消息时主动 Bash 调'));
    process.exit(1);
  }
  const ps = loadPromptState();
  ps.lastMaybeAtByKind = ps.lastMaybeAtByKind || {};
  const now = Date.now();
  const fired = [];
  const cooled = [];
  for (const [kind, cfg] of Object.entries(MAYBE_KINDS)) {
    if (!cfg.matcher) continue;
    const re = new RegExp(cfg.matcher);
    if (!re.test(text)) continue;
    const last = ps.lastMaybeAtByKind[kind];
    if (last && (now - last) < cfg.cooldownMin * 60 * 1000) {
      cooled.push({ kind, remainingMs: cfg.cooldownMin * 60 * 1000 - (now - last) });
      logTriggerEvent(kind, 'cooled_down_check', { remaining_ms: cfg.cooldownMin * 60 * 1000 - (now - last) });
      continue;
    }
    fired.push({ kind, reminder: cfg.reminder, cooldownMin: cfg.cooldownMin });
    ps.lastMaybeAtByKind[kind] = now;
    logTriggerEvent(kind, 'fired_check', { cooldown_min: cfg.cooldownMin });
  }
  savePromptState(ps);
  if (opts.json) {
    return outputJson({ ok: true, fired, cooled });
  }
  if (fired.length === 0) {
    if (cooled.length === 0) log(sepia('  没命中任何 maybe-X'));
    else log(sepia('  命中 ' + cooled.length + ' 个 kind 但都在冷却中: ' + cooled.map(c => c.kind).join(' / ')));
    return;
  }
  for (const f of fired) {
    log(vermilion('[' + f.kind + ']'));
    log(sepia('  ') + f.reminder);
    log('');
  }
}

// v0.17 `tinker pending` · 看 / 处理 hook 触发的待处理 reminder
// 设计:
//   --json           列待处理 (给 AI 工具用)
//   --check          UserPromptSubmit hook 用 · 命中静默 stdout 注入 AI context · 不打扰
//   --mark-handled <id>  标某条已处理
//   --clear          全清
//   不带 flag        人可读列表 (最近 10 条)
// 跨 AI 通用:Claude Code 用 hook 自动 check · Cursor / Aider 等 LLM 主动 Bash 跑 --json
function cmdPending(opts) {
  if (opts.clear) {
    if (fs.existsSync(pendingRemindersPath())) {
      try { fs.unlinkSync(pendingRemindersPath()); } catch {}
    }
    if (opts.json) return outputJson({ ok: true, cleared: true });
    ok('清空 pending reminders');
    return;
  }
  const reminders = readPendingReminders();
  if (opts.markHandled) {
    const id = opts.markHandled;
    let found = false;
    const updated = reminders.map(r => {
      if (r.id === id) { found = true; return { ...r, handled: true, handledAt: new Date().toISOString() }; }
      return r;
    });
    writePendingReminders(updated);
    if (opts.json) return outputJson({ ok: true, markedHandled: id, found });
    if (found) ok('标了 ' + id + ' 为已处理');
    else err('找不到 id: ' + id);
    return;
  }
  const pending = reminders.filter(r => !r.handled);
  if (opts.check) {
    // UserPromptSubmit hook 调用 · 跟用户每次说话时触发
    // 命中 pending → stdout 注入我 (AI) 的 context · 我看上下文判断要不要提醒用户
    // 没 pending → 静默退出 · 不打扰
    if (pending.length === 0) return;
    const recent = pending.slice(-3).map(r => `[${r.kind}] ${r.msg.slice(0, 60)}`).join(' / ');
    process.stdout.write(`Tinker hook 触发了 ${pending.length} 条待处理 reminder · 最近: ${recent} · 看完整列表 \`tinker pending --json\` · 跟用户聊到合适时机时建议 \`tinker resolve <choice> -m "..."\` 处理 · 或者 \`tinker pending --mark-handled <id>\` 标已处理 · 不每次都打扰用户\n`);
    return;
  }
  if (opts.json) return outputJson({ ok: true, count: pending.length, pending, handledCount: reminders.length - pending.length });
  if (pending.length === 0) {
    log(sepia('  没有待处理 reminder'));
    if (reminders.length > 0) log(sepia('  历史已处理 ' + reminders.length + ' 条 · 清掉跑 ') + vermilion('tinker pending --clear'));
    return;
  }
  log('');
  log(bold('  待处理 ' + pending.length + ' 条 (最近 10 条):'));
  log('');
  for (const r of pending.slice(-10)) {
    const t = new Date(r.at).toLocaleTimeString();
    log(vermilion('  [' + r.kind + ']') + sepia(' · ' + t + ' · ' + (r.commitSha || '').slice(0, 7) + ' · ' + (r.projectName || '')));
    log('  ' + r.msg);
    if (r.suggestion) log(sepia('    ' + r.suggestion));
    log(sepia('    id: ') + r.id);
    log('');
  }
  log(sepia('  处理一条: ') + vermilion('tinker resolve <choice> -m "..."'));
  log(sepia('  标已处理: ') + vermilion('tinker pending --mark-handled <id>'));
  log(sepia('  全清:     ') + vermilion('tinker pending --clear'));
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

  // post-commit hook 每次 commit 都后台 spawn backfill · 密集 commit 时会同一段事件生成多份草稿
  // quiet 模式 (hook 触发) 加 30 分钟 per-(cwd, type) 节流 · 手动跑不受影响
  if (opts.quiet) {
    const ps = loadPromptState();
    ps.lastBackfillAtByKey = ps.lastBackfillAtByKey || {};
    const key = type + '|' + process.cwd();
    const last = ps.lastBackfillAtByKey[key];
    const now = Date.now();
    const cooldownMs = 30 * 60 * 1000;
    if (last && (now - last) < cooldownMs) {
      try { logTriggerEvent('backfill-' + type, 'cooled_down', { remaining_ms: cooldownMs - (now - last) }); } catch {}
      return;
    }
    ps.lastBackfillAtByKey[key] = now;
    savePromptState(ps);
    try { logTriggerEvent('backfill-' + type, 'fired', { cooldown_min: 30 }); } catch {}
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
    return `(LLM 没起草 · template 兜底 · 把下面信息组成一段工作日志气质的连贯散文 · 不用 markdown 标题)

刚理清楚一件事 (待补 · 看下面信号补具体在想什么)。

想过几种走法:
${signalLines || '(信号不足 · 自己回忆补一下)'}

最后决定 (待补 · 选了哪种 · 决定性理由是什么)。

${fixTitle ? '相关 commit: ' + fixTitle : ''}

---

(LLM 没起草 · 这是 template 兜底 · 改成连贯散文再发 · \`tinker push <这个文件> --as-${productTag}\`)
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

// v0.17 pending-reminders.jsonl · 累积所有 hook 触发的 reminder
// 跟 pending.json 不同:pending.json 是单条覆盖 (老 flow tinker resolve 用 · 同 commit 内只能记一个)
// jsonl 是累积 · 历史所有 reminder 都在 · 任何 AI / 用户能 scan 看到"漏掉的 ship / clever-fix 等"
function pendingRemindersPath() { return path.join(CONFIG_DIR, 'pending-reminders.jsonl'); }
function appendPendingReminder(entry) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(pendingRemindersPath(), JSON.stringify(entry) + '\n');
  } catch { /* 失败静默 · 别阻塞 hook */ }
}
function readPendingReminders() {
  if (!fs.existsSync(pendingRemindersPath())) return [];
  try {
    const lines = fs.readFileSync(pendingRemindersPath(), 'utf-8').split('\n').filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function writePendingReminders(arr) {
  try {
    fs.writeFileSync(pendingRemindersPath(), arr.map(r => JSON.stringify(r)).join('\n') + (arr.length > 0 ? '\n' : ''));
  } catch { /* 失败静默 */ }
}

// v0.17 bridge auto-ping config · post-commit hook 命中触发器后自动发 bridge ping
// 默认 disabled · 用户主动开 + 选 kinds + 选目标 handle (null = 广播给团队所有人)
// 触发流程: cmdCheck --json 命中 → appendPendingReminder → maybeAutoPing → fetch /api/bridge/send
function autoPingConfigPath() { return path.join(CONFIG_DIR, 'bridge-auto-ping.json'); }
function loadAutoPingConfig() {
  if (!fs.existsSync(autoPingConfigPath())) {
    return { enabled: false, kinds: ['ship', 'stuck'], toHandle: null };
  }
  try { return JSON.parse(fs.readFileSync(autoPingConfigPath(), 'utf-8')); }
  catch { return { enabled: false, kinds: ['ship', 'stuck'], toHandle: null }; }
}
function saveAutoPingConfig(c) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(autoPingConfigPath(), JSON.stringify(c, null, 2));
}

// 触发器命中后 · 看配置 · 命中就 ping
// 失败静默 · 不阻塞 hook · 不影响 commit
async function maybeAutoPing(triggerResult, repoCfg, cfg) {
  try {
    const apCfg = loadAutoPingConfig();
    if (!apCfg.enabled) return;
    // result.kind 是 trigger kind (ship / stuck / clever-fix / decision 等)
    // result.reason 也行 · 比如 keyword-ship · 取前缀
    const kind = triggerResult.kind || (triggerResult.reason || '').replace(/^keyword-/, '');
    if (!apCfg.kinds.includes(kind)) return;
    const bridgeLib = require('../lib/bridge');
    if (!bridgeLib.hasSecret()) return;  // 没设暗号 · 静默放弃
    const secret = bridgeLib.loadSecret();
    const title = `[auto] ${kind} · @${cfg.handle}`;
    const body = `${triggerResult.msg || ''}\n${triggerResult.suggestion || ''}\n${repoCfg.projectName || ''}`.trim();
    const level = (kind === 'stuck' || kind === 'frustrated') ? 'warn' : (kind === 'ship' ? 'ok' : 'info');
    const obj = { v: 1, title, body, level, at: Date.now(), autoPing: true, triggerKind: kind };
    const payload = bridgeLib.encrypt(JSON.stringify(obj), secret);
    const res = await fetch(cfg.serverUrl + '/api/bridge/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
      body: JSON.stringify({ to: apCfg.toHandle || null, kind: 'noti', payload }),
    });
    if (!res.ok) return;  // 失败静默
    // 成功 → log 一行 (hook stdout 会被丢 · 但 trigger-log 记一笔)
    logTriggerEvent(kind, 'auto_pinged', { to: apCfg.toHandle || 'broadcast' });
  } catch { /* 任何错都静默 · 不阻塞 hook */ }
}

// tinker bridge auto-ping --enable/--disable/--status [--kinds ship,stuck] [--to @maomao]
async function cmdBridgeAutoPing(opts) {
  const apCfg = loadAutoPingConfig();
  if (opts.disable) {
    apCfg.enabled = false;
    saveAutoPingConfig(apCfg);
    ok('bridge auto-ping 已停用 · post-commit hook 命中触发器不再 ping');
    return;
  }
  if (opts.enable) {
    apCfg.enabled = true;
    if (opts.kinds && opts.kinds.length > 0) apCfg.kinds = opts.kinds;
    if (opts.toHandle !== undefined) {
      const newHandle = opts.toHandle || null;
      if (newHandle) {
        try {
          const cfg = mustHaveConfig();
          const state = await apiState(cfg);
          const allHandles = Object.keys(state.users || {});
          if (!allHandles.includes(newHandle)) {
            err('找不到 @' + newHandle + ' · 没保存');
            if (allHandles.length > 0) {
              const list = allHandles.slice(0, 20).map(h => '@' + h).join(sepia(' · '));
              log(sepia('  现有 handles: ') + list);
            }
            return;
          }
        } catch (e) {
          log(sepia('  ⚠ handle 校验跳过 (' + (e.message || 'unknown') + ') · 保存原值'));
        }
      }
      apCfg.toHandle = newHandle;
    }
    saveAutoPingConfig(apCfg);
    const bridgeLib = require('../lib/bridge');
    const hasSecret = bridgeLib.hasSecret();
    log('');
    ok('bridge auto-ping 已启用');
    log(sepia('  触发 kinds: ') + vermilion(apCfg.kinds.join(' / ')));
    log(sepia('  目标:       ') + vermilion(apCfg.toHandle ? '@' + apCfg.toHandle : '广播 (团队所有人)'));
    if (!hasSecret) {
      log('');
      log(vermilion('  ⚠ 还没设暗号 · 跑 ') + vermilion('tinker secret <暗号>') + sepia(' 后 auto-ping 才会真发出去'));
    }
    log('');
    return;
  }
  // --status / 默认
  log('');
  log(bold('  bridge auto-ping 状态'));
  log(sepia('  启用:    ') + (apCfg.enabled ? vermilion('是') : sepia('否')));
  log(sepia('  kinds:   ') + vermilion(apCfg.kinds.join(' / ')));
  log(sepia('  目标:    ') + vermilion(apCfg.toHandle ? '@' + apCfg.toHandle : '广播 / 未设'));
  log('');
  if (!apCfg.enabled) {
    log(sepia('  启用: ') + vermilion('tinker bridge auto-ping --enable [--kinds ship,stuck] [--to @maomao]'));
  } else {
    log(sepia('  停用: ') + vermilion('tinker bridge auto-ping --disable'));
  }
  log('');
}

// ============================================
// studios · 工作室 (v0.20)
//
// 概念:
//   一个 user 可以挂靠到 studio · 工作室聚合所有成员的 projects/updates
//   secretHash = sha256(暗号) 给 server 验成员关系 · 真暗号本地存 · 也是桥的 e2e key
//
// 邀请第一版用 copy-paste cmd · 不搞复杂的桥邀请协议:
//   owner 跑 create → 输出 `tinker studio join <slug> <secret>` 一行
//   把这行发给队友 (微信/桥/面对面) · 队友跑一下就加入
// ============================================
function sha256Hex(s) { return require('crypto').createHash('sha256').update(s).digest('hex'); }

async function cmdStudio(subcmd, args, opts) {
  const cfg = mustHaveConfig(opts);
  const bridgeLib = require('../lib/bridge');

  if (!subcmd || subcmd === 'help') {
    log('');
    log(bold('  tinker studio · 工作室 (你 + 队友 = 一个工作室)'));
    log('');
    log('  ' + vermilion('tinker studio create <slug> --name "..." [--tagline "..."]'));
    log(sepia('     建工作室 · 自动当 owner'));
    log('  ' + vermilion('tinker studio invite <slug> @<handle>'));
    log(sepia('     给队友生成一次性邀请 token · 24h 有效 · server 看不到 token 跟暗号'));
    log('  ' + vermilion('tinker studio accept <token>'));
    log(sepia('     兑换邀请 · 自动写本地暗号'));
    log('  ' + vermilion('tinker studio join <slug> <secret>'));
    log(sepia('     直接用 slug+secret 加入 (没收到 invite 时的 fallback)'));
    log('  ' + vermilion('tinker studio list'));
    log(sepia('     看我所属的工作室'));
    log('  ' + vermilion('tinker studio info <slug>'));
    log(sepia('     看某工作室聚合页 (成员 + 项目)'));
    log('  ' + vermilion('tinker studio leave <slug>'));
    log(sepia('     退出'));
    log('');
    return;
  }

  switch (subcmd) {
    case 'create': {
      const slug = args[2];
      if (!slug) { err('slug 必填 · 比如 `tinker studio create daogu-studio --name "捣鼓工作室"`'); process.exit(1); }
      const name = opts.name || slug;
      const tagline = opts.tagline || null;
      const secret = require('crypto').randomBytes(16).toString('hex');
      const secretHash = sha256Hex(secret);

      const res = await safeFetchJson(cfg, '/api/studios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
        body: JSON.stringify({ slug, name, tagline, secretHash }),
      });
      if (!res.ok) { err(res.error || '建工作室失败'); process.exit(1); }

      // 本地存暗号 + 自动 active · 后续 bridge / studio 通信用这个
      bridgeLib.addStudio({ slug, name, secret, id: res.studio.id });
      bridgeLib.setActiveStudio(slug);

      log('');
      ok(`工作室建好了 — ${bold(name)}`);
      log(sepia('  slug:    ') + vermilion(slug));
      if (tagline) log(sepia('  一句话:  ') + tagline);
      log(sepia('  本地暗号已存:  ') + vermilion(bridgeLib.STUDIOS_FILE));
      log('');
      log(bold('  邀请队友 · 把下面这行发给 ta (微信/桥/面对面都行):'));
      log('');
      log('  ' + vermilion(`tinker studio join ${slug} ${secret}`));
      log('');
      log(sepia('  暗号只在这条命令里 · server 只存 hash · 别截图发公开渠道'));
      log('');
      return;
    }

    case 'join': {
      const slug = args[2];
      const secret = args[3];
      if (!slug || !secret) { err('用法: tinker studio join <slug> <secret>'); process.exit(1); }

      const secretHash = sha256Hex(secret);
      const res = await safeFetchJson(cfg, '/api/studios/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
        body: JSON.stringify({ slug, secretHash }),
      });
      if (!res.ok) { err(res.error || '加入失败'); process.exit(1); }

      bridgeLib.addStudio({ slug, name: res.name, secret, id: res.id });
      bridgeLib.setActiveStudio(slug);

      log('');
      if (res.alreadyMember) {
        ok(`你已经在 ${bold(res.name)} 里了 · 本地暗号已刷新`);
      } else {
        ok(`加入了 — ${bold(res.name)}`);
      }
      log(sepia('  本地暗号已存:  ') + vermilion(bridgeLib.STUDIOS_FILE));
      log(sepia('  现在桥消息能跟工作室所有成员通了'));
      log('');
      return;
    }

    case 'list': {
      const res = await safeFetchJson(cfg, '/api/me/studios', {
        headers: { Authorization: 'Bearer ' + cfg.token },
      });
      if (!res.ok) { err(res.error || '拉取失败'); process.exit(1); }
      if (opts.json) { outputJson(res); return; }
      log('');
      if (!res.studios || res.studios.length === 0) {
        log(sepia('  你还没加入任何工作室'));
        log(sepia('  建一个: ') + vermilion('tinker studio create <slug> --name "..."'));
        log('');
        return;
      }
      log(bold('  我的工作室:'));
      for (const s of res.studios) {
        log('  · ' + bold(s.name) + sepia('  /s/' + s.slug) + sepia('  [' + s.role + ']'));
        if (s.tagline) log(sepia('      ') + s.tagline);
      }
      log('');
      return;
    }

    case 'info': {
      const slug = args[2];
      if (!slug) { err('用法: tinker studio info <slug>'); process.exit(1); }
      const res = await safeFetchJson(cfg, '/api/studios/' + encodeURIComponent(slug));
      if (!res.ok) { err(res.error || '拉取失败'); process.exit(1); }
      if (opts.json) { outputJson(res); return; }
      const s = res.studio;
      log('');
      log(bold('  ' + s.name) + sepia('  /s/' + s.slug));
      if (s.tagline) log(sepia('  ') + s.tagline);
      log('');
      log(sepia('  成员 (' + s.members.length + '):'));
      for (const m of s.members) {
        log('  · @' + bold(m.handle) + sepia('  [' + m.role + ']') + (m.tagline ? sepia(' — ') + m.tagline : ''));
      }
      log('');
      log(sepia('  项目 (' + s.projects.length + '):'));
      for (const p of s.projects) {
        log('  · ' + bold(p.name) + sepia('  by @' + p.ownerHandle) + sepia('  [' + p.status + ']'));
      }
      log('');
      return;
    }

    case 'leave': {
      const slug = args[2];
      if (!slug) { err('用法: tinker studio leave <slug>'); process.exit(1); }
      const getRes = await safeFetchJson(cfg, '/api/studios/' + encodeURIComponent(slug));
      if (!getRes.ok) { err(getRes.error || '工作室不存在'); process.exit(1); }
      const studioId = getRes.studio.id;
      const res = await safeFetchJson(cfg, '/api/studios/' + studioId + '/leave', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + cfg.token },
      });
      if (!res.ok) { err(res.error || '退出失败'); process.exit(1); }
      log('');
      ok(`退出了 — ${getRes.studio.name}`);
      log(sepia('  本地暗号文件还在 · 想清掉: rm ') + bridgeLib.STUDIOS_FILE);
      log('');
      return;
    }

    case 'invite': {
      // tinker studio invite <slug> @handle
      const slug = args[2];
      const targetHandle = (args[3] || '').replace(/^@/, '');
      if (!slug || !targetHandle) { err('用法: tinker studio invite <slug> @<handle>'); process.exit(1); }

      if (!bridgeLib.hasSecret()) {
        err('本地没暗号 · 你不是这个工作室的成员? 先 tinker studio join 或 create');
        process.exit(1);
      }
      const secret = bridgeLib.loadSecret();

      // 查 studio_id (server 要)
      const getRes = await safeFetchJson(cfg, '/api/studios/' + encodeURIComponent(slug));
      if (!getRes.ok) { err(getRes.error || '工作室不存在'); process.exit(1); }
      const studioId = getRes.studio.id;

      // e2e: 客户端生成 token + 加密 secret · server 只存 hash + 密文
      const token = require('crypto').randomBytes(6).toString('hex'); // 12 字符 · 好复制
      const tokenHash = sha256Hex(token);
      const secretCipher = bridgeLib.encrypt(secret, token);

      const res = await safeFetchJson(cfg, '/api/studios/' + studioId + '/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
        body: JSON.stringify({ targetHandle, tokenHash, secretCipher }),
      });
      if (!res.ok) { err(res.error || '邀请失败'); process.exit(1); }

      // v0.29 自动通过 bridge 投递邀请通知 · 减少"复制 token 微信发"
      // payload 走明文 base64 (没暗号 chicken-egg · 接收方还没共享 secret · 解不了普通密文)
      // server 看到 base64 跟其他密文长一样 · 不能区分
      let autoSent = false;
      try {
        const inviteObj = {
          type: 'studio-invite',
          slug,
          studioName: getRes.studio.name,
          token,
          fromHandle: cfg.handle,
          at: Date.now(),
        };
        const invitePayload = Buffer.from(JSON.stringify(inviteObj), 'utf-8').toString('base64');
        const sendRes = await safeFetchJson(cfg, '/api/bridge/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
          body: JSON.stringify({ to: targetHandle, kind: 'noti', payload: invitePayload }),
        });
        autoSent = !!(sendRes && sendRes.ok);
      } catch { /* bridge 发不出也不阻塞主流程 · token 还能手动发 */ }

      log('');
      ok(`邀请生成了 · 给 @${targetHandle} · 24h 内有效`);
      if (autoSent) {
        log(sepia('  ✓ 已自动通过 bridge 投递到 ta 的 inbox'));
        log(sepia('  ✓ ta tinker watch 上会自动收到 · 下次起 Claude session 提示一键加入'));
        log('');
        log(sepia('  备份方案 (bridge 失效时):'));
      } else {
        log('');
        log(bold('  把这一行发给 @' + targetHandle + ':'));
      }
      log('');
      log('  ' + vermilion(`tinker studio accept ${token}`));
      log('');
      log(sepia('  token 一次性 · server 看不到 token 跟 studio 暗号 · 可以放心发'));
      log('');
      return;
    }

    case 'accept': {
      const token = args[2];
      if (!token) { err('用法: tinker studio accept <token>'); process.exit(1); }
      const tokenHash = sha256Hex(token);

      const res = await safeFetchJson(cfg, '/api/studios/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
        body: JSON.stringify({ tokenHash }),
      });
      if (!res.ok) { err(res.error || '兑换失败 · token 不对 / 过期 / 不是给你的'); process.exit(1); }

      // 用 token 解 server 返的密文 · 拿到 studio secret
      let secret;
      try {
        secret = bridgeLib.decrypt(res.secretCipher, token);
      } catch (e) {
        err('密文解不开 — token 跟 server 存的不一致 · 这不应该发生');
        process.exit(1);
      }
      bridgeLib.addStudio({ slug: res.slug, name: res.name, secret, id: res.studioId });
      bridgeLib.setActiveStudio(res.slug);

      log('');
      ok(`加入了 — ${bold(res.name)}`);
      log(sepia('  本地暗号已存:  ') + vermilion(bridgeLib.STUDIOS_FILE));
      log(sepia('  看工作室主页: ') + vermilion(cfg.serverUrl + '/#/s/' + res.slug));
      log('');
      return;
    }

    default:
      err('未知子命令: ' + subcmd + ' · 跑 `tinker studio help` 看用法');
      process.exit(1);
  }
}

// strip ANSI 颜色码 · JSON 里不该带终端控制符
function stripAnsi(s) { return (s || '').toString().replace(/\x1b\[[0-9;]*m/g, ''); }

// v0.20 voice 守门 · 在所有 push 路径 addUpdate 前调
// 防 "tinker push -m '<没经 LLM 起草的 AI 直出文本>'" 的裸奔
//   score >= 3 → 拒绝 (要 --force 才发)
//   score == 2 → TTY 时 confirm · 非 TTY 默认放过 (不阻塞 hook / AI agent 调用)
//   score <= 1 → 通过
// 返回 { ok: true } 通过 · { ok: false, reason } 拒绝
// 注意 helper 是 async (因为 TTY confirm 走 inquirer)

// =====================================================
// v0.21 bridge user-facing commands · ping / send / watch
// 走 active studio 暗号 (来自 cmdStudio create/join/accept)
// 默认广播到 active studio · -t @who 点对点
// =====================================================

async function cmdPing(opts) {
  const cfg = mustHaveConfig();
  const bridgeLib = require('../lib/bridge');
  const activeStudio = bridgeLib.getActiveStudio();
  if (!activeStudio) {
    err('还没加入任何工作室 · 跑 `tinker studio create <slug>` 建一个 · 或 `tinker studio accept <token>` 兑换邀请');
    process.exit(1);
  }
  const secret = activeStudio.secret;

  const to = opts.toHandle || null;
  const useStudio = !to;
  const positional = opts.positional || [];
  const title = (opts.title || positional[0] || '').trim();
  const noteBody = (opts.body || opts.text || positional[1] || '').trim();
  const level = (opts.level || 'info').toLowerCase();
  if (!title) { err('要一句 title · 例: tinker ping "构建挂了" -l urgent'); process.exit(1); }
  if (!['info', 'ok', 'warn', 'urgent'].includes(level)) { err('level 只支持: info / ok / warn / urgent'); process.exit(1); }

  const obj = { v: 1, title, body: noteBody, level, at: Date.now() };
  const payload = bridgeLib.encrypt(JSON.stringify(obj), secret);
  const apiBody = useStudio
    ? { toStudio: activeStudio.id, kind: 'noti', payload }
    : { to, kind: 'noti', payload };

  try {
    const r = await safeFetchJson(cfg, '/api/bridge/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
      body: JSON.stringify(apiBody),
    });
    log('');
    const tag = level === 'urgent' ? '🚨' : level === 'warn' ? '⚠' : level === 'ok' ? '✓' : '🔔';
    ok(tag + ' ping → ' + (useStudio ? bold(activeStudio.name) + sepia(' (' + activeStudio.slug + ')') : '@' + to));
    log(sepia('  ' + title));
    if (noteBody) log(sepia('  ' + noteBody.slice(0, 200)));
    log(sepia('  seq ') + r.seq + sepia(' · id ') + r.id);
    log('');
  } catch (e) { err(e.message); process.exit(1); }
}

async function cmdSend(opts) {
  const cfg = mustHaveConfig();
  const bridgeLib = require('../lib/bridge');
  const activeStudio = bridgeLib.getActiveStudio();
  if (!activeStudio) { err('还没加入工作室'); process.exit(1); }
  const secret = activeStudio.secret;

  const positional = opts.positional || [];
  const files = positional.slice(0);
  if (files.length === 0) { err('要给至少一个文件 · 例: tinker send foo.md -t @maomao'); process.exit(1); }
  const to = opts.toHandle;
  const useStudio = !to;

  const items = [];
  let totalSize = 0;
  for (const f of files) {
    if (!fs.existsSync(f)) { err('找不到: ' + f); process.exit(1); }
    const st = fs.statSync(f);
    if (!st.isFile()) { err('不是文件: ' + f); process.exit(1); }
    if (st.size > 6 * 1024 * 1024) { err('单文件 6MB 上限: ' + f); process.exit(1); }
    items.push({ name: path.basename(f), size: st.size, content: fs.readFileSync(f).toString('base64') });
    totalSize += st.size;
  }
  if (totalSize > 6 * 1024 * 1024) { err('合计 6MB 上限'); process.exit(1); }

  const obj = { v: 1, message: opts.text || '', files: items, at: Date.now() };
  const payload = bridgeLib.encrypt(JSON.stringify(obj), secret);
  const apiBody = useStudio
    ? { toStudio: activeStudio.id, kind: 'file', payload }
    : { to, kind: 'file', payload };

  try {
    const r = await safeFetchJson(cfg, '/api/bridge/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
      body: JSON.stringify(apiBody),
    });
    log('');
    ok('📎 文件发了 → ' + (useStudio ? bold(activeStudio.name) : '@' + to));
    log(sepia('  ' + items.length + ' 个文件 · 合计 ' + totalSize + ' 字节'));
    for (const it of items) log(sepia('    · ') + it.name + sepia(' (' + it.size + ' 字节)'));
    log(sepia('  seq ') + r.seq);
    log('');
  } catch (e) { err(e.message); process.exit(1); }
}

async function cmdBridgeWatch(opts) {
  const cfg = mustHaveConfig();
  const bridgeLib = require('../lib/bridge');
  const studiosData = bridgeLib.loadStudios();
  if (!studiosData.studios || studiosData.studios.length === 0) {
    err('还没加入任何工作室 · 没东西可收');
    process.exit(1);
  }

  const inboxDir = path.join(CONFIG_DIR, 'inbox');
  if (!fs.existsSync(inboxDir)) fs.mkdirSync(inboxDir, { recursive: true });
  const cursorFile = path.join(inboxDir, '.cursor');
  let since = 0;
  try { since = parseInt(fs.readFileSync(cursorFile, 'utf-8').trim(), 10) || 0; } catch {}

  log('');
  log(sepia('  tinker watch · 长轮询挂上 · Ctrl+C 退出'));
  log(sepia('  inbox: ') + inboxDir);
  log(sepia('  起点 seq: ') + since);
  log(sepia('  studios: ') + studiosData.studios.map(s => s.slug).join(' / '));
  log('');

  let backoff = 1000;
  while (true) {
    try {
      const resRaw = await fetch(cfg.serverUrl + '/api/bridge/poll?since=' + since, {
        headers: { Authorization: 'Bearer ' + cfg.token },
        signal: AbortSignal.timeout ? AbortSignal.timeout(35000) : undefined,
      });
      if (!resRaw.ok) {
        log(sepia('  poll HTTP ' + resRaw.status + ' · 退避 ' + backoff + 'ms'));
        await new Promise(r => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
        continue;
      }
      backoff = 1000;
      const data = await resRaw.json();
      for (const msg of (data.messages || [])) {
        const tryDec = bridgeLib.tryDecryptWithAnyStudio(msg.payload);
        if (tryDec) {
          try {
            const obj = JSON.parse(tryDec.plaintext);
            renderInboxMessage(msg, obj, tryDec.studio, inboxDir);
          } catch { /* JSON 坏 · 忽略 */ }
        } else {
          // v0.29 fallback: 邀请走明文 base64 (没暗号可解 · 这是设计)
          try {
            const plain = Buffer.from(msg.payload, 'base64').toString('utf-8');
            const obj = JSON.parse(plain);
            if (obj && obj.type === 'studio-invite') {
              renderInviteMessage(msg, obj, inboxDir);
            }
          } catch { /* 不是 invite · 别的团队的密文 · 忽略 */ }
        }
        since = Math.max(since, msg.seq);
      }
      fs.writeFileSync(cursorFile, String(since));
    } catch (e) {
      if (e.name === 'AbortError' || (e.message || '').includes('timeout')) continue;
      log(sepia('  网络错: ' + e.message + ' · 退避 ' + backoff + 'ms'));
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

function renderInboxMessage(msg, obj, studio, inboxDir) {
  const ts = new Date(msg.createdAt).toLocaleTimeString('zh-CN', { hour12: false });
  const target = msg.toStudio
    ? sepia('→ studio:') + studio.slug
    : msg.toHandle ? sepia('→ @') + msg.toHandle : sepia('(广播)');
  log('');
  log(sepia('  ─── ') + ts + sepia(' · @') + msg.fromHandle + ' ' + target + sepia(' · ') + msg.kind + sepia(' · seq ') + msg.seq);
  if (msg.kind === 'noti') {
    const lvl = obj.level || 'info';
    const tag = lvl === 'urgent' ? '🚨' : lvl === 'warn' ? '⚠' : lvl === 'ok' ? '✓' : '🔔';
    log('  ' + tag + ' ' + bold(obj.title || '(无标题)'));
    if (obj.body) log(sepia('  ') + obj.body);
  } else if (msg.kind === 'file') {
    const files = obj.files || [];
    log(sepia('  📎 ') + files.length + ' 个文件' + (obj.message ? ' · ' + obj.message : ''));
    for (const f of files) {
      const safe = (f.name || 'unnamed').replace(/[^\w.\-一-鿿]/g, '_');
      const fp = path.join(inboxDir, msg.fromHandle + '_' + msg.seq + '_' + safe);
      try {
        fs.writeFileSync(fp, Buffer.from(f.content, 'base64'));
        log(sepia('    ↓ ') + fp);
      } catch (e) { log(sepia('    ⚠ ') + e.message); }
    }
  } else if (msg.kind === 'task') {
    // v0.22 handoff · 落地 dossier 到 ~/.tinker/inbox/<msgId>/
    try {
      const dossierLib = require('../lib/dossier');
      const targetDir = dossierLib.unpackDossier({ msgId: msg.id, fromHandle: msg.fromHandle, dossier: obj });
      log(sepia('  🎯 ') + bold('handoff 接力包') + sepia(' · ') + (obj.message || '(无说明)').slice(0, 80));
      log(sepia('     落地: ') + targetDir);
      log(sepia('     看 README: ') + vermilion('cat ' + path.join(targetDir, 'README.md')));
      log(sepia('     处理完: ') + vermilion('tinker inbox done ' + msg.id));
    } catch (e) {
      log(sepia('  ⚠ handoff 解包失败:') + e.message);
    }
  }
  log('');
}

// v0.29 邀请通知 · 走明文 base64 (没暗号可解 · 这是设计)
// payload = base64 JSON { type:'studio-invite', slug, studioName, token, fromHandle, at }
function renderInviteMessage(msg, obj, inboxDir) {
  const ts = new Date(msg.createdAt).toLocaleTimeString('zh-CN', { hour12: false });
  const from = obj.fromHandle || msg.fromHandle;
  const name = obj.studioName || obj.slug || '(无名工作室)';
  log('');
  log(sepia('  ─── ') + ts + sepia(' · @') + from + sepia(' · studio-invite · seq ') + msg.seq);
  log('  📩 ' + bold('@' + from + ' 邀请你加入 ' + name));
  log(sepia('     slug: ') + (obj.slug || '?'));
  log(sepia('     一键加入: ') + vermilion('tinker studio accept ' + (obj.token || '?')));

  const inviteDir = path.join(inboxDir, 'invite-' + msg.id);
  try {
    fs.mkdirSync(inviteDir, { recursive: true });
    fs.writeFileSync(path.join(inviteDir, 'INVITE.json'), JSON.stringify({
      msgId: msg.id,
      fromHandle: from,
      studio: { slug: obj.slug, name: obj.studioName },
      token: obj.token,
      at: obj.at || msg.createdAt,
      seq: msg.seq,
    }, null, 2));
    fs.writeFileSync(path.join(inviteDir, 'PENDING'), String(Date.now()));
    log(sepia('     落地: ') + inviteDir);
  } catch (e) {
    log(sepia('  ⚠ 落地 invite 失败:') + e.message);
  }
  log('');
}

// =====================================================
// v0.22 handoff · 把当前现场打包加密发给队友 / 工作室
// 包含: situation JSON / git diff / voice fingerprint / cwd / repo info
// =====================================================

// tinker handoff -m "..." [-t @who] [--situation <id>]
async function cmdHandoff(opts) {
  const cfg = mustHaveConfig();
  const bridgeLib = require('../lib/bridge');
  const dossierLib = require('../lib/dossier');
  const activeStudio = bridgeLib.getActiveStudio();
  if (!activeStudio) {
    err('要先加入工作室才能接力 · tinker studio create / accept');
    process.exit(1);
  }

  const message = (opts.text || opts.body || '').trim();
  if (!message) {
    err('要给接力说明 · 例:tinker handoff -m "图片压缩做一半 · 剩 webp 转换"');
    process.exit(1);
  }
  const to = opts.toHandle || null;
  const useStudio = !to;

  let situationId = opts.situation || dossierLib.pickActiveSituationId();
  if (!situationId) {
    log(sepia('  没找到 active situation · 不带 situation 也能发 · 接收方只看 git/voice'));
  }

  const dossier = dossierLib.packDossier({ situationId, message, cwd: process.cwd() });
  const plain = JSON.stringify(dossier);
  if (plain.length > 8 * 1024 * 1024) {
    err('dossier 太大 (' + plain.length + ' 字节) · server 限 10MB · 试 --no-diff (TODO) 或缩小工作树');
    process.exit(1);
  }
  const payload = bridgeLib.encrypt(plain, activeStudio.secret);

  const apiBody = useStudio
    ? { toStudio: activeStudio.id, kind: 'task', payload }
    : { to, kind: 'task', payload };

  try {
    const r = await safeFetchJson(cfg, '/api/bridge/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
      body: JSON.stringify(apiBody),
    });
    log('');
    ok('🎯 handoff 发了 → ' + (useStudio ? bold(activeStudio.name) + sepia(' (工作室广播)') : '@' + to));
    log(sepia('  说明:    ') + message);
    log(sepia('  situation: ') + (situationId || sepia('(无)')));
    log(sepia('  dossier:  ') + plain.length + ' 字节 (含 ' + (dossier.diff ? 'git diff' : '无 diff') + ' / ' + (dossier.voiceFingerprint ? 'voice fingerprint' : '无 voice') + ')');
    log(sepia('  seq ') + r.seq);
    log('');
  } catch (e) { err(e.message); process.exit(1); }
}

// =====================================================
// v0.22 inbox · 看 / 处理收到的 handoff task
// =====================================================

// tinker inbox [<id>] · 列表 / 看详情
// tinker inbox done <id> · 标已处理
function cmdInbox(opts) {
  const dossierLib = require('../lib/dossier');
  const sub = (opts.positional || [])[0];
  const arg = (opts.positional || [])[1];

  if (sub === 'done') {
    if (!arg) { err('要给 task id · 例:tinker inbox done msg-xxx'); process.exit(1); }
    const ok2 = dossierLib.markInboxDone(arg);
    if (ok2) ok('标已处理: ' + arg);
    else err('找不到 PENDING · 可能已处理或 id 错: ' + arg);
    return;
  }

  // 看单个 (id 当 sub 传)
  if (sub && sub !== 'list') {
    const readmePath = path.join(dossierLib.INBOX_DIR, sub, 'README.md');
    if (!fs.existsSync(readmePath)) { err('找不到 inbox 项: ' + sub); process.exit(1); }
    log('');
    log(fs.readFileSync(readmePath, 'utf-8'));
    log('');
    return;
  }

  // 列表
  const items = dossierLib.listInbox();
  log('');
  if (items.length === 0) {
    log(sepia('  inbox 空 · 还没收到 handoff task'));
    log('');
    return;
  }
  for (const it of items) {
    const tag = it.pending ? vermilion('● 待处理') : sepia('○ 完成 ');
    const ts = new Date(it.packedAt).toLocaleString('zh-CN', { hour12: false });
    log('  ' + tag + ' ' + bold(it.id) + sepia(' · ') + ts);
    log(sepia('    ' + (it.message || '').slice(0, 100)));
    log('');
  }
  log(sepia('  看一个:    ') + vermilion('tinker inbox <id>'));
  log(sepia('  标处理完:  ') + vermilion('tinker inbox done <id>'));
  log('');
}

// 给 SessionStart hook 跑 · 有 PENDING task 则 stdout 注入 reminder
// Claude Code 看到 stdout 就 load 接力现场
function cmdBridgeCheckInbox() {
  try {
    const dossierLib = require('../lib/dossier');
    const items = dossierLib.listInbox().filter(it => it.pending);

    // v0.29 加 invite 检查 · 走 ~/.tinker/inbox/invite-<msgId>/
    const invites = [];
    const INBOX = path.join(CONFIG_DIR, 'inbox');
    if (fs.existsSync(INBOX)) {
      for (const d of fs.readdirSync(INBOX)) {
        if (!d.startsWith('invite-')) continue;
        if (!fs.existsSync(path.join(INBOX, d, 'PENDING'))) continue;
        try {
          const inv = JSON.parse(fs.readFileSync(path.join(INBOX, d, 'INVITE.json'), 'utf-8'));
          invites.push(inv);
        } catch {}
      }
    }

    if (items.length === 0 && invites.length === 0) return;

    const lines = [];
    // invite 优先 (跟 handoff 比 · 加入团队是一次性 onboarding)
    if (invites.length > 0) {
      lines.push('收到 ' + invites.length + ' 个工作室邀请');
      for (const inv of invites.slice(0, 3)) {
        const name = inv.studio?.name || inv.studio?.slug || '(无名)';
        lines.push('  · @' + inv.fromHandle + ' 邀请你加入 ' + name);
        lines.push('    一键加入: tinker studio accept ' + inv.token);
      }
      lines.push('如果用户确认要加入: Bash 跑 tinker studio accept <token>');
    }
    if (items.length > 0) {
      lines.push('收到 ' + items.length + ' 个未处理的 handoff 接力 · 队友把现场打包发过来了');
      for (const it of items.slice(0, 3)) {
        lines.push('  · ' + it.id + ' · ' + (it.message || '').slice(0, 80));
        lines.push('    cat ' + path.join(dossierLib.INBOX_DIR, it.id, 'README.md') + ' 看完整接力说明');
      }
      if (items.length > 3) lines.push('  ... 还有 ' + (items.length - 3) + ' 个 · tinker inbox 看全部');
      lines.push('处理完跑 tinker inbox done <id> 标完工');
    }
    console.log(lines.join('\n'));
  } catch { /* hook 出错不阻塞 Claude Code 启动 */ }
}

async function gateVoiceCheck(text, opts = {}) {
  if (opts.force) return { ok: true, forced: true };
  let vc;
  try { vc = require('../lib/voice-check').detectAIVoice(text); }
  catch { return { ok: true }; }  // 模块缺失就静默通过 · 别因为守门挂掉主流程
  if (!vc || vc.score <= 1) return { ok: true };
  const hits = (vc.list || []).join(' / ');
  // score >= 3 强拒
  if (vc.score >= 3) {
    if (opts.json) return { ok: false, reason: 'voice 守门拒绝 · 命中 ' + vc.score + ' 条 AI 直出模式 (' + hits + ') · 加 --force 强发', code: 'VOICE_GATE_BLOCK' };
    log('');
    err('voice 守门拒绝 · 这段读着像 AI 直出 (命中 ' + vc.score + ' 条: ' + hits + ')');
    log(sepia('  建议:跑 ') + vermilion('tinker draft') + sepia(' 让 LLM 按你的 voice fingerprint 重写 · 再 ') + vermilion('tinker push <草稿>'));
    log(sepia('  或者:确认想这样发 · 加 ') + vermilion('--force') + sepia(' 跳过守门'));
    log('');
    return { ok: false, reason: 'blocked', code: 'VOICE_GATE_BLOCK' };
  }
  // score == 2 软警告
  if (opts.json) return { ok: true, warn: true, hits: vc.list, score: vc.score };
  log('');
  log(vermilion('  ⚠ voice 自检') + sepia(' · 这段读着有点像 AI 直出 (命中 ' + vc.score + ' 条: ' + hits + ')'));
  if (process.stdin.isTTY && process.stdout.isTTY) {
    try {
      const { confirm } = require('@inquirer/prompts');
      const go = await confirm({ message: '还是要发吗?', default: true });
      if (!go) {
        log(sepia('  没发 · 跑 ') + vermilion('tinker draft') + sepia(' 让 LLM 按你 voice 重写一下'));
        return { ok: false, reason: 'user-cancelled', code: 'USER_CANCELLED' };
      }
    } catch { /* 没装 inquirer 走默认 · 通过 */ }
  } else {
    log(sepia('  非 TTY · 默认放过 · 想拦加 --force 反义'));  // 非 TTY 仅警告 · 不拦
  }
  return { ok: true, warned: true };
}

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
  // v0.13 per-reason 冷却:pending.reason 在 cmdCheck --json 时存进了 pending
  // 老 pending 可能没 reason 字段 · 兜底 '_default'
  if (pending.reason) {
    state.lastPromptedAtByReason = state.lastPromptedAtByReason || {};
    state.lastPromptedAtByReason[pending.reason] = now;
  }

  // 文本类动作:需要 -m "..."
  const needsText = ['push', 'push-brand-self', 'push-brand-meta', 'push-decision', 'ship', 'prototype', 'stuck', 'stuck-quiet'];
  if (needsText.includes(choice) && !text) {
    err('这个动作需要文本: tinker resolve ' + choice + ' -m "一句话"');
    process.exit(1);
  }

  try {
    if (choice === 'push' || choice === 'push-brand-self' || choice === 'push-brand-meta' || choice === 'push-decision') {
      const cfg = mustHaveConfig();
      // v0.20 voice 守门 · AI agent 走 tinker resolve push -m "..." 路径 · 同样要过
      const gate = await gateVoiceCheck(text, opts);
      if (!gate.ok) {
        if (opts.json) return errJson(gate.reason || 'voice 守门拦了', gate.code || 'VOICE_GATE_BLOCK');
        process.exit(1);
      }
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

  if (!opts.fromClaude && !opts.fromTinker && !opts.file && !opts.review) {
    log(sepia('  用法:'));
    log(sepia('    ') + vermilion('tinker voice teach --from-claude'));
    log(sepia('      从 Claude Code 对话历史抽你说过的话当 sample (默认 100 条最近 · 自动加进 good 池)'));
    log(sepia('    ') + vermilion('tinker voice teach --from-claude --review'));
    log(sepia('      逐条让你标 y/n/skip · 分别进 good / bad / 跳过 (v0.11 新加)'));
    log(sepia('    ') + vermilion('tinker voice teach --from-tinker'));
    log(sepia('      回填:server 上自己最近 update 全部加进 good 池 (默认 30 条 · 自动去重)'));
    log(sepia('    ') + vermilion('tinker voice teach --review'));
    log(sepia('      从你最近 Tinker 推过的 update 里抽来 review (高信号样本 · v0.11 新加)'));
    log(sepia('    ') + vermilion('tinker voice teach --file <path>'));
    log(sepia('      从单个文件读 sample (整个文件当一篇)'));
    return;
  }

  // v0.11 review 模式 + 从 Tinker 自己 push 历史拉
  // v0.13 --from-tinker 默认 bulk · 回填 webapp 直发 / contribute --from-file 等不走 CLI 的 update
  const wantTinker = opts.fromTinker || (opts.review && !opts.fromClaude && !opts.file);
  if (wantTinker) {
    log(sepia('  从你最近的 Tinker update 抽样本...'));
    let candidates = [];
    try {
      const state = await apiState(cfg);
      for (const p of state.projects) {
        if (p.owner !== cfg.handle) continue;
        for (const u of (p.updates || [])) {
          if (u.text && u.text.length >= 30) candidates.push({ text: u.text, ts: u.at, updateId: u.id });
        }
      }
    } catch (e) { err('拉 Tinker 数据失败: ' + e.message); process.exit(1); }
    candidates.sort((a, b) => b.ts - a.ts);
    const N = opts.limit && opts.limit > 0 ? opts.limit : (opts.fromTinker ? 30 : 10);
    candidates = candidates.slice(0, N);
    if (candidates.length === 0) { log(sepia('  没有 update 可拉 · 先发几条再来')); return; }

    // review 模式 (review 显式)
    if (opts.review) {
      return reviewCandidatesInteractively(candidates, cfg, 'tinker-self');
    }

    // bulk 模式 (--from-tinker 默认) · 直接加 · 自动去重
    const dir = path.join(CONFIG_DIR, 'style-pool', 'good');
    fs.mkdirSync(dir, { recursive: true });
    // 去重:扫已有文件 · 读 frontmatter 里的 source_update_id · 兜底走 text head
    const existingIds = new Set();
    const existingHeads = new Set();
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
        const idMatch = raw.match(/source_update_id:\s*(\S+)/);
        if (idMatch) existingIds.add(idMatch[1]);
        const bodyMatch = raw.match(/---\s*\n[\s\S]*?\n---\s*\n([\s\S]+)$/);
        if (bodyMatch) existingHeads.add(bodyMatch[1].trim().slice(0, 80));
      }
    } catch {}

    let added = 0, skipped = 0;
    candidates.forEach((m, i) => {
      if (existingIds.has(m.updateId)) { skipped++; return; }
      const head = m.text.trim().slice(0, 80);
      if (existingHeads.has(head)) { skipped++; return; }
      const ts = m.ts || Date.now();
      const stamp = new Date(ts).toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const file = path.join(dir, `${stamp}-backfill-tinker-${String(i).padStart(3, '0')}.md`);
      const meta = [
        '---',
        `handle: ${cfg.handle || ''}`,
        `at: ${new Date(ts).toISOString()}`,
        'choice: backfill-tinker',
        'source: Tinker server (回填)',
        `source_update_id: ${m.updateId}`,
        '---',
      ].join('\n');
      fs.writeFileSync(file, `${meta}\n\n${m.text}\n`);
      added++;
    });
    log('');
    ok(`加了 ${added} 条 · 跳过 ${skipped} 条 (已在 pool 里)`);
    if (added > 0) log(sepia('  下一步: ') + vermilion('tinker voice analyze') + sepia(' 生成 fingerprint'));
    return;
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

// v0.14 反馈链路三件套 · 让 CLI 也能完成 Tinker 反算法的核心闭环 (借了能回应 / 启发了能反馈)
// 之前 reactToProject / submitTinkered / deleteTinkered / markMethodUsed 这 4 个 server action
// 只有 webapp 在用 · CLI 没暴露 · 现在补上

// 从 p-xxx 直接 ID · 或从 URL 提取
function resolveProjectId(arg) {
  if (!arg) return null;
  if (arg.startsWith('p-')) return arg;
  // URL 形态: https://.../#/p/<handle>/<slug>  或  /#/p/<id>
  const m = arg.match(/p-[a-zA-Z0-9]+/);
  return m ? m[0] : null;
}

// tinker react <projectId|url> — toggle "想试试"
// 已标 → 撤回 (server 内部 toggle)
async function cmdReact(arg, opts) {
  const cfg = mustHaveConfig();
  const projectId = resolveProjectId(arg);
  if (!projectId) {
    if (opts.json) return errJson('用法: tinker react <projectId>', 'NO_PROJECT');
    err('用法: ' + vermilion('tinker react <projectId>') + sepia(' (例: tinker react p-mq10xkuo)'));
    process.exit(1);
  }
  try {
    const r = await apiAction(cfg, 'reactToProject', { projectId, level: 'wantToTry' });
    const action = (r && r.result && r.result.action) || 'add';
    if (opts.json) return outputJson({ ok: true, action, projectId });
    ok(action === 'undo' ? '撤回了想试试' : '标了想试试 · 项目作者会收到通知');
  } catch (e) {
    if (opts.json) return errJson(e.message, 'REACT_FAILED');
    err(e.message); process.exit(1);
  }
}

// tinker tinkered <projectId|url> --name "..." --link "..." --inspired-by <updateId>
// --undo 撤回
// 必填: name / link / inspired-by  (link 必须 https://)
async function cmdTinkered(arg, opts) {
  const cfg = mustHaveConfig();
  const projectId = resolveProjectId(arg);
  if (!projectId) {
    if (opts.json) return errJson('用法: tinker tinkered <projectId> --name <> --link <> --inspired-by <updateId>', 'NO_PROJECT');
    err('用法: ' + vermilion('tinker tinkered <projectId> --name "..." --link "https://..." --inspired-by <updateId>'));
    err('  撤回: ' + vermilion('tinker tinkered <projectId> --undo'));
    process.exit(1);
  }
  if (opts.undo) {
    try {
      await apiAction(cfg, 'deleteTinkered', { projectId });
      if (opts.json) return outputJson({ ok: true, action: 'undo' });
      ok('撤回了接走 · 原作者通知也清了');
    } catch (e) {
      if (opts.json) return errJson(e.message, 'UNDO_FAILED');
      err(e.message); process.exit(1);
    }
    return;
  }
  if (!opts.name || !opts.link || !opts.inspiredBy) {
    if (opts.json) return errJson('必填: --name <> --link <https://...> --inspired-by <updateId>', 'MISSING_ARGS');
    err('必填: --name "你做的项目名" --link "https://..." --inspired-by <updateId>');
    process.exit(1);
  }
  try {
    await apiAction(cfg, 'submitTinkered', {
      projectId,
      name: opts.name,
      link: opts.link,
      inspiredByUpdateId: opts.inspiredBy,
    });
    if (opts.json) return outputJson({ ok: true, projectId, name: opts.name, link: opts.link, inspiredByUpdateId: opts.inspiredBy });
    ok('挂上了你的延伸版 · 原作者会收到通知');
  } catch (e) {
    if (opts.json) return errJson(e.message, 'TINKERED_FAILED');
    err(e.message); process.exit(1);
  }
}

// tinker used <updateId> [-m "怎么用的"] — 标"用了 · 跑通了"
// server 要 updateIdx (按 at DESC 排) · 不是 updateId · 这里 CLI 拉 state 自己算
// toggle 行为:已标 → 撤回 · 没标 → 加
async function cmdUsed(updateId, opts) {
  const cfg = mustHaveConfig();
  if (!updateId || !updateId.startsWith('u-')) {
    if (opts.json) return errJson('用法: tinker used <updateId>', 'NO_UPDATE_ID');
    err('用法: ' + vermilion('tinker used <updateId>') + sepia(' (例: tinker used u-abc123 -m "我也跑通了 · 加了 retry")'));
    process.exit(1);
  }
  let state;
  try { state = await apiState(cfg); }
  catch (e) {
    if (opts.json) return errJson(e.message, 'STATE_FAILED');
    err(e.message); process.exit(1);
  }
  let foundProject = null, foundIdx = -1;
  for (const p of state.projects) {
    const idx = (p.updates || []).findIndex(u => u.id === updateId);
    if (idx >= 0) { foundProject = p; foundIdx = idx; break; }
  }
  if (!foundProject) {
    if (opts.json) return errJson('找不到 update: ' + updateId, 'NOT_FOUND');
    err('找不到这条 update: ' + updateId); process.exit(1);
  }
  if (foundProject.owner === cfg.handle) {
    if (opts.json) return errJson('不能给自己的进展标"用了"', 'SELF');
    err('不能给自己的进展标"用了"'); process.exit(1);
  }
  try {
    const r = await apiAction(cfg, 'markMethodUsed', {
      projectId: foundProject.id,
      updateIdx: foundIdx,
      note: (opts.text || '').trim(),
    });
    const action = (r && r.result && r.result.action) || 'add';
    if (opts.json) return outputJson({ ok: true, action, updateId, projectId: foundProject.id });
    ok(action === 'undo' ? '撤回了"用了 · 跑通了"' : '标了"用了 · 跑通了" · 原作者会收到通知');
  } catch (e) {
    if (opts.json) return errJson(e.message, 'USED_FAILED');
    err(e.message); process.exit(1);
  }
}

// v0.15 编辑/删除/建项目 · 补齐 CLI 跟 server 之间最后几个动作 gap
// 之前 editUpdate / deleteUpdate / editMethod / addProject / editProject 只有 webapp 用
// 现在 CLI 直接能做 · 写错可以改 · 测试条可以删 · 新项目命令行起手

// helper: 在自己 owned 项目里找 updateId 对应的 projectId + updateIdx
async function findMyUpdate(cfg, updateId) {
  if (!updateId || !updateId.startsWith('u-')) return null;
  const state = await apiState(cfg);
  for (const p of state.projects) {
    if (p.owner !== cfg.handle) continue;
    const idx = (p.updates || []).findIndex(u => u.id === updateId);
    if (idx >= 0) return { project: p, idx, update: p.updates[idx] };
  }
  return null;
}

// tinker edit <updateId> -m "新内容" [--scenario "..."]
async function cmdEditUpdate(updateId, opts) {
  const cfg = mustHaveConfig();
  if (!updateId || !updateId.startsWith('u-')) {
    if (opts.json) return errJson('用法: tinker edit <updateId> -m "新内容"', 'NO_ID');
    err('用法: ' + vermilion('tinker edit <updateId> -m "新内容"') + sepia(' [--scenario "..."]'));
    process.exit(1);
  }
  if (!opts.text) {
    if (opts.json) return errJson('-m "新内容" 必填', 'NO_TEXT');
    err('-m "新内容" 必填'); process.exit(1);
  }
  const found = await findMyUpdate(cfg, updateId);
  if (!found) {
    if (opts.json) return errJson('找不到你的 update: ' + updateId, 'NOT_FOUND');
    err('找不到你的 update: ' + updateId); process.exit(1);
  }
  const payload = { projectId: found.project.id, updateIdx: found.idx, text: opts.text };
  if (opts.scenario !== undefined) payload.scenario = opts.scenario;
  try {
    await apiAction(cfg, 'editUpdate', payload);
    if (opts.json) return outputJson({ ok: true, updateId, projectId: found.project.id });
    ok('改好了');
  } catch (e) {
    if (opts.json) return errJson(e.message, 'EDIT_FAILED');
    err(e.message); process.exit(1);
  }
}

// tinker delete <updateId> [--yes]
// 不可逆 · TTY 默认 confirm · 非 TTY 必须显式 --yes
async function cmdDeleteUpdate(updateId, opts) {
  const cfg = mustHaveConfig();
  if (!updateId || !updateId.startsWith('u-')) {
    if (opts.json) return errJson('用法: tinker delete <updateId>', 'NO_ID');
    err('用法: ' + vermilion('tinker delete <updateId>') + sepia(' [--yes 跳过确认]'));
    process.exit(1);
  }
  const found = await findMyUpdate(cfg, updateId);
  if (!found) {
    if (opts.json) return errJson('找不到你的 update: ' + updateId, 'NOT_FOUND');
    err('找不到你的 update: ' + updateId); process.exit(1);
  }
  if (!opts.yes && !opts.json) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const preview = (found.update.text || '').slice(0, 80) + ((found.update.text || '').length > 80 ? '...' : '');
      log(sepia('  要删: ') + preview);
      log(sepia('  项目: ') + found.project.name);
      try {
        const { confirm } = require('@inquirer/prompts');
        const go = await confirm({ message: '确定删 (不可逆)?', default: false });
        if (!go) { log(sepia('  没删')); return; }
      } catch { log(sepia('  没删')); return; }
    } else {
      err('删除不可逆 · 非 TTY 调用必须加 --yes 显式确认');
      process.exit(1);
    }
  }
  try {
    await apiAction(cfg, 'deleteUpdate', { projectId: found.project.id, updateIdx: found.idx });
    if (opts.json) return outputJson({ ok: true, updateId });
    ok('删了');
  } catch (e) {
    if (opts.json) return errJson(e.message, 'DELETE_FAILED');
    err(e.message); process.exit(1);
  }
}

// tinker edit-method <methodId> [-m] [--scenario] [--title] [--tag x --tag y]
async function cmdEditMethod(methodId, opts) {
  const cfg = mustHaveConfig();
  if (!methodId || !methodId.startsWith('m-')) {
    if (opts.json) return errJson('用法: tinker edit-method <methodId> -m "..."', 'NO_ID');
    err('用法: ' + vermilion('tinker edit-method <methodId> -m "..."') + sepia(' [--scenario "..."] [--title "..."] [--tag x --tag y]'));
    process.exit(1);
  }
  const payload = { methodId };
  if (opts.text) payload.text = opts.text;
  if (opts.scenario !== undefined) payload.scenario = opts.scenario;
  if (opts.title !== undefined) payload.title = opts.title;
  if (opts.tags) payload.tags = opts.tags;
  const fieldCount = Object.keys(payload).length - 1;
  if (fieldCount === 0) {
    if (opts.json) return errJson('至少给一个字段: -m / --scenario / --title / --tag', 'NO_FIELD');
    err('至少给一个字段: -m / --scenario / --title / --tag');
    process.exit(1);
  }
  try {
    await apiAction(cfg, 'editMethod', payload);
    if (opts.json) return outputJson({ ok: true, methodId, fieldsChanged: fieldCount });
    ok('方法改好了 (' + fieldCount + ' 个字段)');
  } catch (e) {
    if (opts.json) return errJson(e.message, 'EDIT_METHOD_FAILED');
    err(e.message); process.exit(1);
  }
}

// tinker project new --name "..." --desc "..." [--link "..."] [--tool x --tool y]
// tinker project edit <projectId> [--name --desc --link --tool x --tool y]
async function cmdProject(sub, projectIdArg, opts) {
  const cfg = mustHaveConfig();
  if (sub === 'new') {
    if (!opts.name || !opts.desc) {
      if (opts.json) return errJson('用法: tinker project new --name "..." --desc "..." [--link <url>] [--tool x --tool y]', 'MISSING_ARGS');
      err('用法: ' + vermilion('tinker project new --name "..." --desc "..."') + sepia(' [--link <url>] [--tool x --tool y]'));
      process.exit(1);
    }
    try {
      const r = await apiAction(cfg, 'addProject', {
        name: opts.name,
        desc: opts.desc,
        productLink: opts.link || '',
        tools: opts.tools || [],
      });
      const newProj = r && r.result;
      if (opts.json) return outputJson({ ok: true, project: newProj });
      ok('项目建好了');
      if (newProj && newProj.id) log(sepia('  projectId: ') + newProj.id);
      if (newProj && newProj.slug) log(sepia('  去看: ') + cfg.serverUrl + '/#/p/' + cfg.handle + '/' + newProj.slug);
    } catch (e) {
      if (opts.json) return errJson(e.message, 'CREATE_FAILED');
      err(e.message); process.exit(1);
    }
    return;
  }
  if (sub === 'edit') {
    const projectId = resolveProjectId(projectIdArg);
    if (!projectId) {
      if (opts.json) return errJson('用法: tinker project edit <projectId> [--name --desc --link --tool]', 'NO_PROJECT');
      err('用法: ' + vermilion('tinker project edit <projectId>') + sepia(' [--name --desc --link --tool]'));
      process.exit(1);
    }
    const noField = !opts.name && !opts.desc && opts.link === undefined && !opts.tools;
    if (noField) {
      if (opts.json) return errJson('至少给一个字段', 'NO_FIELD');
      err('至少给一个字段: --name / --desc / --link / --tool');
      process.exit(1);
    }
    // editProject 要 name/desc 必填 · 没改的字段用当前值兜底
    const state = await apiState(cfg);
    const proj = state.projects.find(p => p.id === projectId);
    if (!proj) {
      if (opts.json) return errJson('找不到项目: ' + projectId, 'NOT_FOUND');
      err('找不到项目: ' + projectId); process.exit(1);
    }
    if (proj.owner !== cfg.handle) {
      if (opts.json) return errJson('只能改自己的项目', 'NOT_OWNER');
      err('只能改自己的项目'); process.exit(1);
    }
    try {
      await apiAction(cfg, 'editProject', {
        projectId,
        name: opts.name || proj.name,
        desc: opts.desc || proj.desc,
        productLink: opts.link !== undefined ? opts.link : (proj.productLink || ''),
        tools: opts.tools || proj.tools || [],
      });
      if (opts.json) return outputJson({ ok: true, projectId });
      ok('项目改好了');
    } catch (e) {
      if (opts.json) return errJson(e.message, 'EDIT_PROJECT_FAILED');
      err(e.message); process.exit(1);
    }
    return;
  }
  if (opts.json) return errJson('用法: tinker project new | edit <projectId>', 'UNKNOWN_SUB');
  err('用法: ' + vermilion('tinker project new') + sepia(' / ') + vermilion('tinker project edit <projectId>'));
  process.exit(1);
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

// v0.12 自己最近的 update · 给 CLI / AI agent 用
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

// v0.17 tinker feed @<handle> · 看指定 handle 的最近 update + method · 公开 update 流
// 跟 bridge 不冲突:bridge 是私信加密 · feed 是公开进展流 · 两者互补
// 使用场景:想知道 ta 在做什么 / 到哪一步了 · 不靠 ta 主动 ping
async function cmdFeed(handleArg, opts) {
  const cfg = mustHaveConfig();
  if (!handleArg) {
    if (opts.json) return errJson('用法: tinker feed @<handle>', 'NO_HANDLE');
    err('用法: ' + vermilion('tinker feed @<handle>') + sepia(' [--limit N] [--watch]'));
    process.exit(1);
  }
  const handle = handleArg.replace(/^@/, '');
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 10;

  async function fetchEvents() {
    const state = await apiState(cfg);
    const userInfo = (state.users && state.users[handle]) || null;
    const allHandles = Object.keys(state.users || {});
    const events = [];
    for (const p of state.projects) {
      if (p.owner !== handle) continue;
      for (const u of (p.updates || [])) {
        events.push({
          type: 'update', at: u.at, projectName: p.name, projectSlug: p.slug,
          projectStatus: p.status, text: u.text, kind: u.kind, id: u.id,
          isMethod: !!u.isMethod, isExperience: !!u.isExperience,
          isLearning: !!u.isLearning, isDecision: !!u.isDecision,
        });
      }
      for (const m of (p.methods || [])) {
        events.push({
          type: 'method', at: m.at, projectName: p.name, scenario: m.scenario,
          title: m.title, id: m.id, borrowCount: m.borrowCount || 0,
        });
      }
    }
    events.sort((a, b) => b.at - a.at);
    return { userInfo, events, allHandles, projects: state.projects.filter(p => p.owner === handle) };
  }

  function renderHeader(userInfo, projects) {
    log('');
    log(bold('  @' + handle + ' · ' + (userInfo?.name || handle)));
    if (userInfo?.tagline) log(sepia('  ' + userInfo.tagline));
    const active = projects.filter(p => ['active', 'stuck'].includes(p.status));
    const stuck = projects.filter(p => p.status === 'stuck');
    const done = projects.filter(p => p.status === 'done');
    const parts = [];
    if (active.length > 0) parts.push('在做 ' + active.length);
    if (stuck.length > 0) parts.push(vermilion('卡住 ' + stuck.length));
    if (done.length > 0) parts.push('完工 ' + done.length);
    if (parts.length > 0) log(sepia('  ') + parts.join(sepia(' · ')));
    log('');
  }

  function renderEvent(e) {
    const t = new Date(e.at).toLocaleString();
    if (e.type === 'method') {
      log(vermilion('  ✤ 方法') + sepia(' · ' + t + ' · ') + bold(e.projectName)
          + (e.borrowCount > 0 ? sepia(' · 被借 ') + e.borrowCount : ''));
      if (e.scenario) log(sepia('    场景:') + ' ' + e.scenario);
    } else {
      const badges = [];
      if (e.kind === 'ship') badges.push(vermilion('✦ 完工'));
      if (e.projectStatus === 'stuck') badges.push(vermilion('⚠ 卡住'));
      if (e.isMethod) badges.push(sepia('[方法]'));
      if (e.isExperience) badges.push(sepia('[经验]'));
      if (e.isLearning) badges.push(sepia('[上手指南]'));
      if (e.isDecision) badges.push(sepia('[决策]'));
      const badgeStr = badges.length ? ' ' + badges.join(' ') : '';
      log(sepia('  ' + t + ' · ') + bold(e.projectName) + badgeStr);
      const snippet = (e.text || '').replace(/\n/g, ' ').slice(0, 120);
      log('    ' + snippet + ((e.text || '').length > 120 ? sepia('...') : ''));
    }
    log('');
  }

  let { userInfo, events, projects, allHandles } = await fetchEvents();
  if (!userInfo && projects.length === 0) {
    if (opts.json) {
      return outputJson({ ok: false, error: '找不到 @' + handle, code: 'NOT_FOUND',
        availableHandles: allHandles });
    }
    err('找不到 @' + handle);
    if (allHandles && allHandles.length > 0) {
      const list = allHandles.slice(0, 20).map(h => '@' + h).join(sepia(' · '));
      log(sepia('  现有 handles: ') + list
        + (allHandles.length > 20 ? sepia(' (共 ' + allHandles.length + ' 个)') : ''));
    }
    process.exit(1);
  }
  if (opts.json) {
    return outputJson({ ok: true, handle, name: userInfo?.name || handle,
      tagline: userInfo?.tagline || '', events: events.slice(0, limit),
      projects: projects.map(p => ({ id: p.id, slug: p.slug, name: p.name, status: p.status })),
    });
  }
  renderHeader(userInfo, projects);
  if (events.length === 0) {
    log(sepia('  还没有公开 update'));
    return;
  }
  for (const e of events.slice(0, limit)) renderEvent(e);

  if (opts.watch) {
    log(sepia('  ── watch 模式 · 每 30s 拉一次新进展 · Ctrl+C 退出 ──'));
    let lastTs = events[0]?.at || Date.now();
    while (true) {
      await new Promise(r => setTimeout(r, 30 * 1000));
      try {
        const next = await fetchEvents();
        const fresh = next.events.filter(e => e.at > lastTs);
        if (fresh.length > 0) {
          log(sepia('  ── ' + new Date().toLocaleTimeString() + ' · ' + fresh.length + ' 条新 ──'));
          for (const e of fresh) renderEvent(e);
          lastTs = fresh[0].at;
        }
      } catch (e) { log(sepia('  poll 失败: ' + e.message)); }
    }
  }
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
    duration = beijingDayStart(1, 4) - now; // 北京明天凌晨 4:00
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
// 不依赖任何 AI agent · 任何能读 stdout 的 AI / 脚本都能用
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
          const since = beijingSinceISO(0, 4);
          const out = require('child_process').execSync(`git log --since="${since}" --no-merges --oneline`, { encoding: 'utf-8' });
          gitCommits = out.trim().split('\n').filter(Boolean).length;
        } catch {}
      }
      let tinkerPushed = 0;
      if (cfg && cfg.serverUrl && cfg.token) {
        try {
          const state = await apiState(cfg);
          const todayStart = beijingDayStart(0, 0); // 北京 0am
          for (const p of state.projects || []) {
            for (const u of p.updates || []) {
              if (u.at >= todayStart) tinkerPushed++;
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
  log(sepia('  ') + vermilion('反馈链路 · 反算法的闭环 (借了 / 启发了要回应)'));
  log('  ' + vermilion('tinker react <projectId>') + sepia('            toggle "想试试" · 项目作者收到通知'));
  log('  ' + vermilion('tinker used <updateId> -m "..."') + sepia('     标某条进展为"用了 · 跑通了" · 给原作者反馈'));
  log('  ' + vermilion('tinker tinkered <projectId> --name "..." --link "https://..." --inspired-by <updateId>'));
  log(sepia('                                       挂上你做的延伸版 · 因 ta 启发'));
  log('  ' + vermilion('tinker tinkered <projectId> --undo') + sepia('  撤回延伸版'));
  log('');
  log(sepia('  ') + vermilion('编辑 / 删除 / 建项目'));
  log('  ' + vermilion('tinker edit <updateId> -m "..."') + sepia('     改一条 update [--scenario "..."]'));
  log('  ' + vermilion('tinker delete <updateId>') + sepia('            删一条 update · TTY confirm · 非 TTY 加 --yes'));
  log('  ' + vermilion('tinker edit-method <methodId>') + sepia('       改一条 method [-m] [--scenario] [--title] [--tag]'));
  log('  ' + vermilion('tinker project new --name "..." --desc "..."') + sepia(' 建项目 [--link <url>] [--tool x --tool y]'));
  log('  ' + vermilion('tinker project edit <projectId>') + sepia('     改项目 [--name] [--desc] [--link] [--tool]'));
  log('');
  log(sepia('  ') + vermilion('看别人在做什么 / 团队联动'));
  log('  ' + vermilion('tinker feed @<handle>') + sepia('             看 ta 最近 update / method / 项目状态 [--limit N] [--watch]'));
  log('  ' + vermilion('tinker feed @<handle> --watch') + sepia('      每 30s 拉一次新进展 · 命令行里持续看 ta 在干啥'));
  log('  ' + vermilion('tinker bridge auto-ping --enable') + sepia('   触发器命中 ship/stuck 时自动 ping 团队 [--kinds ...] [--to @who]'));
  log(sepia('                                        ') + dim('需要先 tinker secret <暗号>'));
  log('  ' + vermilion('tinker bridge auto-ping --status') + sepia('   看当前配置'));
  log('  ' + vermilion('tinker bridge auto-ping --disable') + sepia('  停用'));
  log('');
  log(sepia('  ') + vermilion('工作室 · 你跟队友 = 一个工作室'));
  log('  ' + vermilion('tinker studio create <slug> --name "..."') + sepia('  建工作室 · 自动当 owner'));
  log('  ' + vermilion('tinker studio invite <slug> @<handle>') + sepia('     给队友生成一次性邀请 token · e2e'));
  log('  ' + vermilion('tinker studio accept <token>') + sepia('              兑换邀请 · 自动写本地暗号'));
  log('  ' + vermilion('tinker studio list / info <slug> / leave <slug>') + sepia('  其余操作 · 跑 tinker studio help 看全'));
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
  log('  ' + vermilion('tinker maybe-check --text "..."') + sepia('     跨 AI 通用入口 · 非 Claude Code 的 LLM 主动调拿 matcher 命中 reminder'));
  log('  ' + vermilion('tinker pending [--json|--check|--mark-handled <id>|--clear]') + sepia(' 看/处理 post-commit hook 触发的待处理 reminder'));
  log(sepia('  ') + dim('几乎所有命令支持 --json · 错误统一 { ok: false, error, code } 形态'));
  log('');
  // v0.14 AI agent 反向映射:关键场景 → 调什么命令 · 让 LLM 看 help 就能直接用
  // CLI 一条路线 · LLM 通过 Bash 跑 tinker + --json 拿结构化结果 · 任何 AI client 都能用
  log(sepia('  ') + vermilion('AI agent 指南 (LLM 看下方关键场景决定调什么)'));
  log(sepia('  ─────────────────────────────────────────────────────────────'));
  log(sepia('  用户聊到某技术/报错/想入门 X        → ') + vermilion('tinker borrow "<关键词>" --json --limit 5'));
  log(sepia('  用户说"卡住/不行/跑不起来"          → ') + vermilion('tinker stuck -m "..." ') + dim('(看上下文真卡才调)'));
  log(sepia('  用户说"懂了/顿悟/终于通了"          → ') + vermilion('tinker push -m "..." ') + dim('(顿悟时刻难复现)'));
  log(sepia('  用户做工具/方案决策                  → ') + vermilion('tinker resolve push-decision -m "..."'));
  log(sepia('  用户说"砍了/不做了"                 → ') + vermilion('tinker push -m "..." ') + dim('(说为什么砍)'));
  log(sepia('  用户说"完工/上线了/deploy 了"        → ') + vermilion('tinker ship -m "..." ') + dim('(进陈列馆)'));
  log(sepia('  用户问"今天都做了啥"                → ') + vermilion('tinker goodnight --json'));
  log(sepia('  用户问"上次怎么解决的"              → ') + vermilion('tinker recent --json --limit 10'));
  log(sepia('  起草前避免重复 / 引用作者过往        → ') + vermilion('tinker recent --json'));
  log(sepia('  作者要"标方法/经验/上手指南/决策"     → ') + vermilion('tinker contribute / mark-experience / mark-learning / mark-decision'));
  log(sepia('  用户借了某条 update 且跑通了          → ') + vermilion('tinker used <updateId> -m "..." ') + dim('(给原作者反馈)'));
  log(sepia('  用户说"想试试某个项目"              → ') + vermilion('tinker react <projectId>'));
  log(sepia('  用户做了延伸版 (因 ta 启发)           → ') + vermilion('tinker tinkered <projectId> --name --link --inspired-by'));
  log(sepia('  用户要改一条 update / method         → ') + vermilion('tinker edit <updateId> -m / tinker edit-method <methodId>'));
  log(sepia('  用户要删测试条 / 误发条              → ') + vermilion('tinker delete <updateId> --yes ') + dim('(非 TTY 必须 --yes)'));
  log(sepia('  用户开新项目                       → ') + vermilion('tinker project new --name "..." --desc "..."'));
  log(sepia('  hook 触发了 pending 等响应          → ') + vermilion('tinker resolve <choice> -m "..."'));
  log(sepia('  查 post-commit hook 触发的待处理      → ') + vermilion('tinker pending --json'));
  log(sepia('  用户问"猫猫在做什么 / 到哪一步了"      → ') + vermilion('tinker feed @maomao --json'));
  log(sepia('  ') + dim('  LLM 主动调:session 开头 / 用户问"今天怎么样" / commit 之后 · 看有没有漏掉的 ship / clever-fix 等'));
  log(sepia('  非 Claude Code (Cursor/Aider 等) · 没有 hook → ') + vermilion('tinker maybe-check --text "<用户消息>" --json'));
  log(sepia('  ') + dim('  上面这个跟 Claude Code hook 共用词典 + 冷却 · LLM 主动调拿命中 reminder'));
  log(sepia('  ') + dim('调前看 ') + vermilion('tinker state --json') + dim(' · 静音/冷却中别打扰'));
  log(sepia('  ') + dim('幂等保险 · 给 --idempotency-key (同 key 24h 内不重复)'));
  log(sepia('  ') + dim('关键词命中只是候选 · 看上下文判断是否真的提醒 · 不每次都建议'));
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
    if (a === '-m' || a === '--message' || a === '--text') opts.text = args[++i];
    else if (a.startsWith('--text=')) opts.text = a.slice('--text='.length);
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
    else if (a === '--from-tinker') opts.fromTinker = true;
    else if (a === '--name') opts.name = args[++i];
    else if (a.startsWith('--name=')) opts.name = a.slice('--name='.length);
    else if (a === '--tagline') opts.tagline = args[++i];
    else if (a.startsWith('--tagline=')) opts.tagline = a.slice('--tagline='.length);
    else if (a === '--link') opts.link = args[++i];
    else if (a.startsWith('--link=')) opts.link = a.slice('--link='.length);
    else if (a === '--inspired-by') opts.inspiredBy = args[++i];
    else if (a.startsWith('--inspired-by=')) opts.inspiredBy = a.slice('--inspired-by='.length);
    else if (a === '--undo') opts.undo = true;
    else if (a === '--watch') opts.watch = true;
    else if (a === '--enable') opts.enable = true;
    else if (a === '--disable') opts.disable = true;
    else if (a === '--status') opts.status = true;
    else if (a === '--to' || a === '-t') opts.toHandle = (args[++i] || '').replace(/^@/, '');
    else if (a.startsWith('--to=')) opts.toHandle = a.slice('--to='.length).replace(/^@/, '');
    else if (a === '--kinds') opts.kinds = (args[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a.startsWith('--kinds=')) opts.kinds = a.slice('--kinds='.length).split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--check') opts.check = true;
    else if (a === '--clear') opts.clear = true;
    else if (a === '--mark-handled') opts.markHandled = args[++i];
    else if (a.startsWith('--mark-handled=')) opts.markHandled = a.slice('--mark-handled='.length);
    else if (a === '--desc') opts.desc = args[++i];
    else if (a.startsWith('--desc=')) opts.desc = a.slice('--desc='.length);
    else if (a === '--scenario') opts.scenario = args[++i];
    else if (a.startsWith('--scenario=')) opts.scenario = a.slice('--scenario='.length);
    else if (a === '--title') opts.title = args[++i];
    else if (a.startsWith('--title=')) opts.title = a.slice('--title='.length);
    else if (a === '--tool') {
      const v = args[++i];
      if (v) { opts.tools = opts.tools || []; opts.tools.push(v); }
    } else if (a.startsWith('--tool=')) {
      const v = a.slice('--tool='.length);
      if (v) { opts.tools = opts.tools || []; opts.tools.push(v); }
    }
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
    else if (a === '--force' || a === '-f') opts.force = true;
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
    // 不以 - 开头的 positional · 全部收集到 opts.positional 数组 (给 ping/send/inbox 等用)
    // 同时第一个看着像文件路径的设到 opts.draftFile (push <file> 兼容)
    else if (!a.startsWith('-')) {
      if (!opts.positional) opts.positional = [];
      opts.positional.push(a);
      if (!opts.draftFile && (fs.existsSync(a) || /\.md$/i.test(a))) opts.draftFile = a;
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
      { name: 'push', purpose: '记一笔进展 · 直接 / 从草稿文件 / experience 单篇都支持', args: [
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
      { name: 'stream', purpose: 'NDJSON 事件流 · 任何 AI 通过 stdout 都能订阅', args: [
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
      case 'feed': await cmdFeed(args[1], opts); break;
      case 'react': await cmdReact(args[1], opts); break;
      case 'tinkered': await cmdTinkered(args[1], opts); break;
      case 'used': await cmdUsed(args[1], opts); break;
      case 'edit': await cmdEditUpdate(args[1], opts); break;
      case 'delete': await cmdDeleteUpdate(args[1], opts); break;
      case 'edit-method': await cmdEditMethod(args[1], opts); break;
      case 'project': await cmdProject(args[1], args[2], opts); break;
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
      case 'maybe-stuck':         cmdMaybe('stuck'); return;
      case 'maybe-breakthrough':  cmdMaybe('breakthrough'); return;
      case 'maybe-decision':      cmdMaybe('decision'); return;
      case 'maybe-subtraction':   cmdMaybe('subtraction'); return;
      case 'maybe-clever-fix':    cmdMaybe('cleverFix'); return;
      case 'maybe-ship':          cmdMaybe('ship'); return;
      case 'maybe-handoff':       cmdMaybe('handoff'); return;
      case 'maybe-invite':        cmdMaybe('invite'); return;
      case 'maybe-check':         cmdMaybeCheck(opts); return;
      case 'pending':             cmdPending(opts); return;
      case 'bridge':
        if (args[1] === 'auto-ping') { await cmdBridgeAutoPing(opts); return; }
        err('用法: tinker bridge auto-ping [--enable|--disable|--status] [--kinds X,Y] [--to @who]');
        process.exit(1);

      case 'ping': await cmdPing(opts); break;
      case 'send': await cmdSend(opts); break;
      case 'handoff': await cmdHandoff(opts); break;
      case 'inbox': cmdInbox(opts); break;
      case 'bridge-check-inbox': cmdBridgeCheckInbox(); break;  // hidden · SessionStart hook 用
      case 'studio':
        await cmdStudio(args[1], args, opts);
        break;

      case 'llm': await cmdLlm(args[1], opts); break;
      case 'state': cmdState(opts); break;
      case 'triggers': cmdTriggers(opts); break;
      case 'struggle': await cmdStruggle(args[1], opts); break;
      case '__autopsy':
        // 内部命令 · 不暴露给 user help · 由 spawnAutopsyAsync detached child 调
        await cmdAutopsy(args[1]);
        return;
      case 'schema': cmdSchema(opts); break;
      case 'stream': await cmdStream(args[1], opts); return; // 长跑 NDJSON 输出 · 不退出
      case 'watch': await cmdBridgeWatch(opts); break;  // v0.21 用户面: 长轮询收 bridge 消息
      case 'watch-deploy': await cmdWatch(args[1]); break;  // 内部命令 · 被 spawnDeployWatcher 调用
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

// 导出给测试 / 内部 require 复用 · 不重写 API/state/git 逻辑
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
  // 幂等性 (AI agent 防重放)
  withIdempotency, idemGet, idemSet,
  // drift 检测的注册表
  loadReposRegistry, registerRepoForDrift,
  // v0.13 markdown 工具 (单测可见)
  parseMarkdownSections, scanPrivacyRisks,
};

// 直接 ./tinker 跑才走 main · require 拿模块时不跑
if (require.main === module) {
  main();
}

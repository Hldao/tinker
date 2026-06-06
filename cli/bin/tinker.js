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
const { execSync } = require('child_process');

const CONFIG_DIR = path.join(os.homedir(), '.tinker');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

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

// =============================================
// Config
// =============================================
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); }
  catch (e) { return null; }
}
function saveConfig(cfg) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
function mustHaveConfig() {
  const cfg = loadConfig();
  if (!cfg) { err('还没配置 · 先跑 ' + vermilion('tinker login')); process.exit(1); }
  return cfg;
}

// =============================================
// API client
// =============================================
function authHeaders(cfg) {
  if (!cfg.token) return { 'Content-Type': 'application/json' };
  return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.token };
}
async function apiState(cfg) {
  const res = await fetch(cfg.serverUrl + '/api/state', { headers: authHeaders(cfg) });
  if (!res.ok) throw new Error('server 返回 ' + res.status);
  return res.json();
}
async function apiMe(cfg) {
  const res = await fetch(cfg.serverUrl + '/api/auth/me', { headers: authHeaders(cfg) });
  if (!res.ok) throw new Error('/me 返回 ' + res.status);
  return res.json();
}
async function apiAction(cfg, type, payload) {
  const res = await fetch(cfg.serverUrl + '/api/action', {
    method: 'POST',
    headers: authHeaders(cfg),
    body: JSON.stringify({ type, payload }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'action 失败');
  return data;
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
const DEFAULT_VOICE = `Tinker / 捣鼓 是给 vibe coder 的工作室社区。这里的"进展" (update) voice 是工匠的工作日志:

- 像跟朋友说"我刚做了 X" · 不像产品发布会
- 用"跑通了 / 卡在 / 试了" 这种动作动词 · 不用 "feature add / bug fix" 这种 changelog 词
- 短句优先 · 200-400 字一条 · 不需要排版
- 不写"今天/最近"开头(平台已显示时间)
- 支持 inline markdown:**粗体** 和 \`代码\` 会渲染 · 不支持 headers / lists
- 反对"AI 装大佬"·反对"看着像产品宣传"`;

const DRAFT_PROMPT_TEMPLATE = `${'$'}{voice}

任务:看下面的 git 历史 + 当前未 commit 改动 · 帮作者起草 **1-3 条** 候选进展。

每条候选两部分:
1. \`text\`:进展正文(Tinker voice)
2. \`rationale\`:一两句话说为什么这条值得发(给作者筛选用 · 不会发布)

如果 git 历史全是 typo / 格式调整 / 没意义的小修补 · 返回空数组:\`{ "candidates": [] }\`。**宁可少 · 不要凑数**。

输出**严格** JSON 格式(只输出 JSON 本体 · 不要 markdown 代码块):
{
  "candidates": [
    { "text": "...", "rationale": "..." }
  ]
}

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
  const prompt = DRAFT_PROMPT_TEMPLATE
    .replaceAll('${voice}', voice)
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

async function cmdConfig() {
  const cfg = loadConfig();
  if (!cfg) { err('还没配置 · 先跑 tinker login'); process.exit(1); }
  log(sepia('\n  current config:'));
  log('    server     ' + bold(cfg.serverUrl));
  log('    handle     ' + bold('@' + cfg.handle));
  if (cfg.llm) {
    log('    llm        ' + bold(cfg.llm.provider) + sepia(' (key: ****' + cfg.llm.apiKey.slice(-4) + ')'));
  } else {
    log('    llm        ' + sepia('(未配置)'));
  }
  log(sepia('    file       ' + CONFIG_FILE + '\n'));
}

async function cmdProjects() {
  const cfg = mustHaveConfig();
  const state = await apiState(cfg);
  const me = cfg.handle;
  const mine = state.projects.filter(p => p.owner === me);
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

  const md = renderDraftMarkdown({
    candidates, since: history.since, commits: (history.log||'').split('\n').filter(Boolean).length, handle: cfg.handle,
  });
  fs.writeFileSync(draftFile, md);

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
  try {
    await apiAction(cfg, 'addUpdate', { projectId, text: pushText });
    const p = mine.find(x => x.id === projectId);
    log('');
    ok('记上了 — ' + bold(p.name));
    log(sepia('  内容: ') + pushText);
    log(sepia('  去看: ') + cfg.serverUrl + '/');
    log('');
  } catch (e) { err(e.message); process.exit(1); }
}

// 从草稿文件发布 · tinker push <file> [--only=1,3]
async function cmdPushFromDraft(cfg, opts) {
  const file = opts.draftFile;
  if (!fs.existsSync(file)) { err('找不到草稿:' + file); process.exit(1); }
  const md = fs.readFileSync(file, 'utf-8');
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

function cmdHookInstall() {
  if (!inGitRepo()) { err('不在 git 仓库'); process.exit(1); }
  const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf-8' }).trim();
  const hookFile = path.join(gitDir, 'hooks', 'post-commit');
  const script = `#!/bin/sh
# tinker post-commit hook
echo ""
echo "  \\033[38;5;243m── tinker ──\\033[0m"
read -p "  发到捣鼓? (y/N): " yn
case "$yn" in
  [Yy]* ) tinker push ;;
  * ) echo "  跳过" ;;
esac
`;
  fs.writeFileSync(hookFile, script);
  fs.chmodSync(hookFile, 0o755);
  ok('hook 装好了: ' + sepia(hookFile));
  log(dim('  每次 git commit 后会问你 "发到捣鼓?" · y 触发 tinker push'));
}

function cmdHookUninstall() {
  if (!inGitRepo()) { err('不在 git 仓库'); process.exit(1); }
  const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf-8' }).trim();
  const hookFile = path.join(gitDir, 'hooks', 'post-commit');
  if (!fs.existsSync(hookFile)) { log(sepia('  hook 不存在 · 没事')); return; }
  fs.unlinkSync(hookFile);
  ok('hook 移除了');
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
  log(sepia('  ') + vermilion('辅助'));
  log('  ' + vermilion('tinker projects | ls') + sepia('               列我的活跃项目'));
  log('  ' + vermilion('tinker config') + sepia('                      看当前配置'));
  log('  ' + vermilion('tinker hook install') + sepia('                装 git post-commit hook'));
  log('  ' + vermilion('tinker hook uninstall') + sepia('              卸 hook'));
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
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opts = parseArgs(args.slice(1));
  try {
    switch (cmd) {
      case 'login': await cmdLogin(); break;
      case 'config': await cmdConfig(); break;
      case 'projects': case 'ls': await cmdProjects(); break;
      case 'push': await cmdPush(opts); break;
      case 'stuck': await cmdStuck(opts); break;
      case 'draft': await cmdDraft(opts); break;
      case 'hook':
        if (args[1] === 'install') cmdHookInstall();
        else if (args[1] === 'uninstall') cmdHookUninstall();
        else { err('用法: tinker hook install | uninstall'); process.exit(1); }
        break;
      case 'help': case '--help': case '-h': case undefined: help(); break;
      default: err('未知命令: ' + cmd); help(); process.exit(1);
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

main();

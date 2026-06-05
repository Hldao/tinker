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
async function apiState(cfg) {
  const res = await fetch(cfg.serverUrl + '/api/state');
  if (!res.ok) throw new Error('server 返回 ' + res.status);
  return res.json();
}
async function apiAction(cfg, type, payload) {
  const res = await fetch(cfg.serverUrl + '/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
const PROMPT_TEMPLATE = `你是一个帮 vibe coder 总结 coding 进展的助手。看下面的 git 历史，用一句话(不超过 60 字)总结进展。

要求:
- 像在跟朋友说"我刚做了 X"
- 简洁自然 · 不要 markdown 不要 emoji
- 不要"今天/最近"开头
- 关注"做了什么/卡在什么/跑通了什么"

Git 历史 (since ${'$'}{since}):
${'$'}{history}

${'$'}{pending}

一句话:`;

async function llmSummarize(cfg, gitContext) {
  if (!cfg.llm || !cfg.llm.apiKey) {
    throw new Error('LLM 没配置 · tinker login 时填一下 (或直接配 ~/.tinker/config.json 的 llm 字段)');
  }
  const provider = cfg.llm.provider || 'anthropic';
  const apiKey = cfg.llm.apiKey;
  const history = gitContext.log || '(没有 commit)';
  const pending = gitContext.pendingStat
    ? `\n当前未 commit 的改动:\n${gitContext.pendingStat}` : '';
  const prompt = PROMPT_TEMPLATE
    .replaceAll('${since}', gitContext.since)
    .replaceAll('${history}', history)
    .replaceAll('${pending}', pending);

  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.llm.model || 'claude-sonnet-4-5-20250929',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || 'Anthropic API ' + res.status);
    return data.content[0].text.trim();
  }
  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.llm.model || 'gpt-4o-mini',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || 'OpenAI API ' + res.status);
    return data.choices[0].message.content.trim();
  }
  if (provider === 'deepseek') {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.llm.model || 'deepseek-chat',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || 'DeepSeek API ' + res.status);
    return data.choices[0].message.content.trim();
  }
  throw new Error('不支持的 LLM provider: ' + provider);
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
    default: 'http://localhost:8788',
  });
  const handle = await input({
    message: '你的 handle (工作室名)',
    default: 'daodao',
    validate: (v) => /^[a-zA-Z0-9_]+$/.test(v.trim()) || '只能是字母/数字/下划线',
  });
  const cfg = { serverUrl: serverUrl.replace(/\/$/, ''), handle: handle.trim() };

  // 可选: LLM
  const wantLLM = await select({
    message: '配置 LLM? (用于 tinker draft / push --auto)',
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
      message: 'API key',
      validate: (v) => v.trim().length > 0 || '不能空',
    });
    cfg.llm = { provider, apiKey: apiKey.trim() };
  }

  saveConfig(cfg);
  ok('配置已保存到 ' + sepia(CONFIG_FILE));
  log(dim('  下一步: ') + vermilion('tinker push'));
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
    err('git 历史是空的 · 你这段时间没 commit 也没改动');
    process.exit(1);
  }
  log(sepia('\n  分析 git 历史 (since ' + history.since + ')...'));
  if (history.log) log(sepia('  ' + history.log.split('\n').slice(0, 3).join('\n  ')));
  if (history.pendingStat) log(sepia('  pending: ' + history.pendingStat));
  log('');
  log(sepia('  喂给 LLM...'));
  try {
    const draft = await llmSummarize(cfg, history);
    log('');
    log(bold('  → ') + draft);
    log('');
    log(sepia('  (用 ') + vermilion('tinker push -m "..."') + sepia(' 推这一句 · 或 ') + vermilion('tinker push --since ' + since + ' --auto') + sepia(' 直接推)'));
    log('');
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
}

async function cmdPush(opts) {
  const cfg = mustHaveConfig();
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

  // 决定内容
  let pushText = opts.text;

  // 1. -m 直接给了
  if (pushText) {
    // skip
  }
  // 2. --auto: LLM 生成 (需要 history)
  else if (opts.auto) {
    const history = gitHistorySince(opts.since || '1h');
    if (!history) { err('不在 git 仓库 · --auto 需要 git 历史'); process.exit(1); }
    log(sepia('  喂给 LLM (since ' + history.since + ')...'));
    pushText = await llmSummarize(cfg, history);
    log(sepia('  draft: ') + pushText);
  }
  // 3. --since 给了: 抓历史作为 default
  else if (opts.since) {
    const history = gitHistorySince(opts.since);
    let suggestion = '';
    if (history && history.log) {
      // 简单默认: 用最近一条 commit message
      suggestion = history.log.split('\n')[0].replace(/^\w+\s/, '');
    }
    const { input } = require('@inquirer/prompts');
    if (history) {
      log(sepia('  git 历史 (since ' + history.since + '):'));
      log(sepia('  ' + (history.log || '(空)').split('\n').slice(0, 5).join('\n  ')));
      log('');
    }
    pushText = await input({ message: '一句进展', default: suggestion || undefined });
  }
  // 4. 默认交互模式
  else {
    const { input } = require('@inquirer/prompts');
    const suggestion = gitOneCommit();
    pushText = await input({ message: '一句进展', default: suggestion || undefined });
  }

  pushText = (pushText || '').trim();
  if (!pushText) { err('内容不能空'); process.exit(1); }

  // 推
  try {
    await apiAction(cfg, 'addUpdate', { projectId, text: pushText, currentUser: me });
    const p = mine.find(x => x.id === projectId);
    log('');
    ok('记上了 — ' + bold(p.name));
    log(sepia('  内容: ') + pushText);
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
  log(bold('  tinker') + sepia(' — 在 coding 时一句话发布到捣鼓'));
  log(sepia('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  log('');
  log('  ' + vermilion('tinker login') + sepia('                       一次性配置'));
  log('  ' + vermilion('tinker push') + sepia('                        交互式推一条'));
  log('  ' + vermilion('tinker push -m "..."') + sepia('               直接推'));
  log('  ' + vermilion('tinker push --since 1h') + sepia('             抓 1 小时 git 历史作为建议'));
  log('  ' + vermilion('tinker push --auto') + sepia('                 LLM 自动生成 + 推'));
  log('  ' + vermilion('tinker push --since 1h --auto') + sepia('      LLM 总结 1 小时 + 推'));
  log('  ' + vermilion('tinker draft') + sepia('                       LLM 看建议 (不推)'));
  log('  ' + vermilion('tinker draft --since 30m') + sepia('           自定义时间窗'));
  log('  ' + vermilion('tinker projects | ls') + sepia('               列我的活跃项目'));
  log('  ' + vermilion('tinker hook install') + sepia('                装 git post-commit hook'));
  log('  ' + vermilion('tinker hook uninstall') + sepia('              卸 hook'));
  log('  ' + vermilion('tinker config') + sepia('                      看当前配置'));
  log('');
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
    else if (a === '--auto') opts.auto = true;
    else if (a === '-p' || a === '--project') opts.projectId = args[++i];
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

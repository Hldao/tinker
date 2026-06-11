// cli-version · 让 CLI 问 server "最新 CLI 版本 + 我落后几个 cli/ 改动"
//
// 为什么在 server 算:CLI 原本直接打 GitHub API (匿名限额 60/小时/IP · 多人同出口 IP
// 会撞限额 · 还依赖 GitHub 可达)。改成问 server · 一次往返 · 不依赖 GitHub。
//
// server 读自己仓库的 git 历史 (宿主 .git 只读挂进容器)。只数动了 cli/ 目录的 commit ·
// 这样"落后 N 个 commit"才真对应 CLI 变化 · 不会因为改了 server/webapp 就误报 CLI 有更新。

const { execFileSync } = require('child_process');

const GIT_DIR = process.env.CLI_VERSION_GIT_DIR || '/app/.gitdir';
const CACHE_TTL_MS = 5 * 60 * 1000;
const WINDOW = 200; // 最近 200 个 cli/ commit · 足够覆盖任何还在用的旧版本

let cache = null; // { at, commits: [{sha, title}], available }

function loadCommits() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;
  let commits = [];
  let available = false;
  try {
    const out = execFileSync('git', [
      '-c', 'safe.directory=*',
      '--git-dir', GIT_DIR,
      'log', '-n', String(WINDOW),
      '--pretty=format:%H%x09%s',
      '--', 'cli/',
    ], { encoding: 'utf-8', timeout: 5000 });
    commits = out.split('\n').filter(Boolean).map(line => {
      const tab = line.indexOf('\t');
      return { sha: line.slice(0, tab), title: line.slice(tab + 1) };
    });
    available = commits.length > 0;
  } catch {
    available = false;
  }
  cache = { at: Date.now(), commits, available };
  return cache;
}

// since 给了就算落后多少个 cli/ commit + 列出标题
// since 不在窗口里 (太旧) · 返 windowExceeded · CLI 那边照样提示升级
function getCliVersion(since) {
  const { commits, available } = loadCommits();
  if (!available) return { available: false };
  const latest = commits[0];
  const base = { available: true, latestSha: latest.sha, latestMsg: latest.title, total: commits.length };
  if (!since) return base;
  if (since === latest.sha) return { ...base, behindBy: 0, recentCommits: [] };
  const idx = commits.findIndex(c => c.sha === since);
  if (idx === -1) {
    return { ...base, behindBy: commits.length, windowExceeded: true, recentCommits: commits.slice(0, 5).map(c => c.title) };
  }
  return { ...base, behindBy: idx, recentCommits: commits.slice(0, idx).slice(0, 5).map(c => c.title) };
}

module.exports = { getCliVersion };

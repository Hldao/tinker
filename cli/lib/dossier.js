// cli/lib/dossier.js · handoff 现场打包 / 解包
//
// 发起方 (cmdHandoff):
//   1. 拣 active situation (从 ~/.tinker/struggles/) + git repo info + git diff +
//      .tinker/voice-fingerprint.md + cwd
//   2. 序列化成 JSON · 加密成 task msg payload
//
// 接收方 (cmdBridgeWatch 处理 task kind):
//   1. 解密 + JSON.parse
//   2. 落到 ~/.tinker/inbox/<msg-id>/ 目录
//   3. 写 README.md (人 + Claude 都能读)
//   4. 写 PENDING 标记 (没就是已处理)
//
// SessionStart hook 跑 `tinker bridge-check-inbox` · 有 PENDING 就 stdout reminder
// 注入到接收方 Claude Code 的 context · 让 Claude 自动 load 接力现场

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const STRUGGLES_DIR = path.join(os.homedir(), '.tinker', 'struggles');
const INBOX_DIR = path.join(os.homedir(), '.tinker', 'inbox');

// 找当前最新 situation (按 mtime · resolved=false 优先)
function pickActiveSituationId() {
  if (!fs.existsSync(STRUGGLES_DIR)) return null;
  const files = fs.readdirSync(STRUGGLES_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) return null;
  const candidates = files.map(f => {
    const fp = path.join(STRUGGLES_DIR, f);
    let mtime = 0, resolved = true;
    try { mtime = fs.statSync(fp).mtime.getTime(); } catch {}
    try {
      const j = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      resolved = !!j.resolved;
    } catch {}
    return { f, mtime, resolved };
  });
  // 未 resolved 的优先 · 同档按 mtime desc
  candidates.sort((a, b) => {
    if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
    return b.mtime - a.mtime;
  });
  return candidates[0].f.replace(/\.json$/, '');
}

function safeGit(cmd, cwd, maxBytes = 200000) {
  try {
    const out = execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.length > maxBytes ? out.slice(0, maxBytes) + '\n... (截断)' : out;
  } catch { return null; }
}

// 打包 dossier · cwd 一般是 repo root
function packDossier({ situationId, message, cwd }) {
  let situation = null;
  if (situationId) {
    const f = path.join(STRUGGLES_DIR, situationId + '.json');
    if (fs.existsSync(f)) {
      try { situation = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch {}
    }
  }

  // repo info
  let repo = null;
  const url = safeGit('git config --get remote.origin.url', cwd, 500);
  const branch = safeGit('git rev-parse --abbrev-ref HEAD', cwd, 200);
  const sha = safeGit('git rev-parse HEAD', cwd, 200);
  if (url || branch || sha) {
    repo = {
      url: (url || '').trim() || null,
      branch: (branch || '').trim() || null,
      sha: (sha || '').trim() || null,
    };
  }

  // diff: unpushed + working tree
  const parts = [];
  const unpushed = safeGit('git log origin/main..HEAD --oneline', cwd, 5000);
  if (unpushed && unpushed.trim()) {
    parts.push('=== unpushed commits ===\n' + unpushed.trim());
  }
  const unpushedDiff = safeGit('git diff origin/main..HEAD', cwd);
  if (unpushedDiff && unpushedDiff.trim()) {
    parts.push('=== unpushed diff (origin/main..HEAD) ===\n' + unpushedDiff);
  }
  const wtDiff = safeGit('git diff', cwd);
  if (wtDiff && wtDiff.trim()) {
    parts.push('=== working tree diff (uncommitted) ===\n' + wtDiff);
  }
  const wtStatus = safeGit('git status --porcelain', cwd, 5000);
  if (wtStatus && wtStatus.trim()) {
    parts.push('=== working tree status ===\n' + wtStatus.trim());
  }
  const diff = parts.length ? parts.join('\n\n') : null;

  // voice fingerprint (项目级 · 接收方按这个口吻接力)
  let voiceFingerprint = null;
  try {
    voiceFingerprint = fs.readFileSync(path.join(cwd, '.tinker', 'voice-fingerprint.md'), 'utf-8');
  } catch {}

  // .tinker/repo.json (跟 Tinker project 绑定)
  let repoJson = null;
  try {
    repoJson = JSON.parse(fs.readFileSync(path.join(cwd, '.tinker', 'repo.json'), 'utf-8'));
  } catch {}

  return {
    v: 1,
    message,
    situationId: situationId || null,
    situation,
    repo,
    repoJson,
    diff,
    voiceFingerprint,
    cwd,
    packedAt: Date.now(),
  };
}

// 落地 dossier 到 ~/.tinker/inbox/<msgId>/
// 返回路径
function unpackDossier({ msgId, fromHandle, dossier }) {
  if (!fs.existsSync(INBOX_DIR)) fs.mkdirSync(INBOX_DIR, { recursive: true });
  const targetDir = path.join(INBOX_DIR, msgId);
  fs.mkdirSync(targetDir, { recursive: true });

  fs.writeFileSync(path.join(targetDir, 'dossier.json'), JSON.stringify(dossier, null, 2));

  if (dossier.situation) {
    fs.writeFileSync(path.join(targetDir, 'situation.json'), JSON.stringify(dossier.situation, null, 2));
  }
  if (dossier.diff) {
    fs.writeFileSync(path.join(targetDir, 'diff.patch'), dossier.diff);
  }
  if (dossier.voiceFingerprint) {
    fs.writeFileSync(path.join(targetDir, 'voice-fingerprint.md'), dossier.voiceFingerprint);
  }

  // README.md · 人 + Claude 共享的入口
  const readme = renderReadme({ msgId, fromHandle, dossier });
  fs.writeFileSync(path.join(targetDir, 'README.md'), readme);

  // PENDING 标记 · 删掉 = 已处理
  fs.writeFileSync(path.join(targetDir, 'PENDING'), String(Date.now()));

  return targetDir;
}

function renderReadme({ msgId, fromHandle, dossier }) {
  const repoLine = dossier.repo
    ? `- url: ${dossier.repo.url || '(本地仓库 · 没 remote)'}\n- branch: ${dossier.repo.branch || '(无)'}\n- sha: ${dossier.repo.sha || '(无)'}`
    : '(没传 repo 信息)';
  const filesLine = [
    '- `dossier.json` 完整结构',
    dossier.situation ? '- `situation.json` 起源 situation (lifecycle + signals · 看作者怎么卡进来的)' : null,
    dossier.diff ? '- `diff.patch` 已 unpushed + working tree diff (拿来 git apply 或者参考)' : null,
    dossier.voiceFingerprint ? '- `voice-fingerprint.md` 发起方的 voice (接力回稿按这个写)' : null,
  ].filter(Boolean).join('\n');

  return `# 接力 task · @${fromHandle} → 你

## 一句话
${dossier.message || '(发起方没写说明)'}

## 起源 cwd
\`${dossier.cwd || '(无)'}\`

## 仓库信息
${repoLine}

## dossier 包含的文件
${filesLine}

## 接力建议 (Claude 读到这一段时主动按下面办)
1. 看完 \`situation.json\` (如果有) · 了解发起方卡在哪 / 怎么想的
2. cd 到一个本地 clone · checkout 到 \`${dossier.repo?.branch || '(无 branch)'}\` · reset 到 \`${dossier.repo?.sha?.slice(0, 8) || '(无 sha)'}\`
3. \`git apply diff.patch\` 拿到发起方未推的改动 (如果有)
4. 看 \`voice-fingerprint.md\` 学发起方的口吻 (接力的进展用同样气质)
5. 接着做 · 完了 \`tinker push -m "..."\` 或 \`tinker ship\` 把进展发回
6. 处理完跑 \`tinker inbox done ${msgId}\` 标记 task 关闭

## 元信息
- msg id: \`${msgId}\`
- 收到时间: ${new Date(dossier.packedAt).toLocaleString('zh-CN', { hour12: false })}
- dossier 大小: ${JSON.stringify(dossier).length} 字节
`;
}

// 列 inbox 里所有 task (含 done/pending 状态)
function listInbox() {
  if (!fs.existsSync(INBOX_DIR)) return [];
  const dirs = fs.readdirSync(INBOX_DIR).filter(d => {
    try { return fs.statSync(path.join(INBOX_DIR, d)).isDirectory(); } catch { return false; }
  });
  const items = [];
  for (const d of dirs) {
    const dossierFile = path.join(INBOX_DIR, d, 'dossier.json');
    if (!fs.existsSync(dossierFile)) continue;
    let dossier;
    try { dossier = JSON.parse(fs.readFileSync(dossierFile, 'utf-8')); } catch { continue; }
    items.push({
      id: d,
      message: dossier.message || '',
      packedAt: dossier.packedAt || 0,
      pending: fs.existsSync(path.join(INBOX_DIR, d, 'PENDING')),
      situation: dossier.situation ? dossier.situation.id : null,
      cwd: dossier.cwd || null,
    });
  }
  items.sort((a, b) => b.packedAt - a.packedAt);
  return items;
}

function markInboxDone(msgId) {
  const pendingFile = path.join(INBOX_DIR, msgId, 'PENDING');
  if (!fs.existsSync(pendingFile)) return false;
  fs.unlinkSync(pendingFile);
  return true;
}

module.exports = {
  packDossier,
  unpackDossier,
  pickActiveSituationId,
  listInbox,
  markInboxDone,
  INBOX_DIR,
  STRUGGLES_DIR,
};

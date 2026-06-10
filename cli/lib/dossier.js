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
//   3. 两类读者分层 (v0.53): BRIEF.md 给人扫一眼 · README.md 给 AI · context/ 收原料
//   4. 写 PENDING 标记 (没就是已处理)
//
// SessionStart hook 跑 `tinker bridge-check-inbox` · 有 PENDING 就 stdout reminder
// 注入到接收方 Claude Code 的 context · 让 Claude 自动 load 接力现场

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
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

// 截断标记 · 末尾追加 · 检测靠 endsWith 而不是 includes
// 历史教训:includes 会误判 · 比如 diff 里恰好含 dossier.js 自身这行源码就自匹配
const DIFF_TRUNC_MARK = '\n... (截断)';

function safeGit(cmd, cwd, maxBytes = 200000) {
  try {
    const out = execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.length > maxBytes ? out.slice(0, maxBytes) + DIFF_TRUNC_MARK : out;
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
  // 哪段 git diff 真被截断了 · 打包时记标志位 · 别让接收方事后猜文本
  let diffTruncated = false;
  const unpushedDiff = safeGit('git diff origin/main..HEAD', cwd);
  if (unpushedDiff && unpushedDiff.trim()) {
    if (unpushedDiff.endsWith(DIFF_TRUNC_MARK)) diffTruncated = true;
    parts.push('=== unpushed diff (origin/main..HEAD) ===\n' + unpushedDiff);
  }
  const wtDiff = safeGit('git diff', cwd);
  if (wtDiff && wtDiff.trim()) {
    if (wtDiff.endsWith(DIFF_TRUNC_MARK)) diffTruncated = true;
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
    diffTruncated,
    voiceFingerprint,
    cwd,
    packedAt: Date.now(),
  };
}

// 落地 dossier 到 ~/.tinker/inbox/<msgId>/
// 返回路径
function unpackDossier({ msgId, fromHandle, dossier, studioSlug }) {
  if (!fs.existsSync(INBOX_DIR)) fs.mkdirSync(INBOX_DIR, { recursive: true });
  const targetDir = path.join(INBOX_DIR, msgId);
  fs.mkdirSync(targetDir, { recursive: true });

  fs.writeFileSync(path.join(targetDir, 'dossier.json'), JSON.stringify(dossier, null, 2));

  // v0.48 fromHandle 单独落一份 · reply 命令拿来知道回稿给谁
  if (fromHandle) {
    try { fs.writeFileSync(path.join(targetDir, 'from.txt'), String(fromHandle)); } catch {}
  }
  // v0.52 解开这个包用的 studio · 回执/退信要用同一把暗号加密 · 不然发起方解不开
  if (studioSlug) {
    try { fs.writeFileSync(path.join(targetDir, 'studio.txt'), String(studioSlug)); } catch {}
  }

  // v0.53 两类读者分层 · 原料全收进 context/ 子目录 · 顶层只留给人扫一眼的东西
  // 人 = 扫 BRIEF.md 决定接不接 · 不耗 token · AI = 决定接了才钻 context/ 里那堆重料
  const contextDir = path.join(targetDir, 'context');
  fs.mkdirSync(contextDir, { recursive: true });

  // v0.55 懒取 · 带 blobRef = 重料还在 server · 标 BLOB-PENDING · 用户接了才 fetch
  // 不带 = 老的整包 inline (v1) · 直接落 context
  if (dossier.blobRef) {
    fs.writeFileSync(path.join(targetDir, 'BLOB-PENDING.json'), JSON.stringify({
      studioSlug: studioSlug || null,
      hash: dossier.blobRef.hash,
      blobRef: dossier.blobRef,
    }, null, 2));
  } else {
    writeContextFiles(contextDir, dossier);
  }

  // BRIEF.md · 纯给人看的一层 · 三五行 · 不放命令汤 不放文件路径
  fs.writeFileSync(path.join(targetDir, 'BRIEF.md'), renderBrief({ msgId, fromHandle, dossier }));

  // README.md · 给 AI 的工作文档 · 指向 context/ 里的原料 · 人接了让 AI 读这份
  fs.writeFileSync(path.join(targetDir, 'README.md'), renderReadme({ msgId, fromHandle, dossier }));

  // PENDING 标记 · 删掉 = 已处理
  fs.writeFileSync(path.join(targetDir, 'PENDING'), String(Date.now()));

  return targetDir;
}

// 把重料 (diff / situation / voice) 落进 context/ · v1 拆包 + v2 fetch 回来都用
function writeContextFiles(contextDir, src) {
  fs.mkdirSync(contextDir, { recursive: true });
  if (src.situation) {
    fs.writeFileSync(path.join(contextDir, 'situation.json'), JSON.stringify(src.situation, null, 2));
  }
  if (src.diff) {
    fs.writeFileSync(path.join(contextDir, 'diff.patch'), src.diff);
  }
  if (src.voiceFingerprint) {
    fs.writeFileSync(path.join(contextDir, 'voice-fingerprint.md'), src.voiceFingerprint);
  }
}

// =====================================================
// v0.55 拆信封懒取 (Phase 2) · 重料拆出去单独存 · 接了才取
// 信封分两类读者的同时 · 传输也分层:
//   light  = bridge task 消息 (说明 + repo + blobRef) · 小 · SessionStart 一拉就到
//   heavy  = diff + situation + voice · 加密压缩后存 server blob 库 · 接了才 GET
// blob 按 sha256(heavy 明文) 寻址 · 同工作室内容相同自动去重 (#3 白送)
// =====================================================

// 全 dossier → { light, heavyPlain, blobRef } · 没重料就退回整包 inline (v1)
function prepareHandoff(dossier) {
  const heavy = {};
  if (dossier.diff) heavy.diff = dossier.diff;
  if (dossier.situation) heavy.situation = dossier.situation;
  if (dossier.voiceFingerprint) heavy.voiceFingerprint = dossier.voiceFingerprint;

  if (Object.keys(heavy).length === 0) {
    // 没重料 · 不值得拆 · 整包当 v1 发 · 接收方照旧
    return { light: { ...dossier, v: 1 }, heavyPlain: null, blobRef: null };
  }

  const heavyPlain = JSON.stringify(heavy);
  const hash = crypto.createHash('sha256').update(heavyPlain).digest('hex');
  const blobRef = {
    hash,
    diffBytes: dossier.diff ? dossier.diff.length : 0,
    hasSituation: !!dossier.situation,
    hasVoice: !!dossier.voiceFingerprint,
    plainBytes: heavyPlain.length,
  };
  const light = {
    v: 2,
    message: dossier.message,
    situationId: dossier.situationId || null,
    repo: dossier.repo || null,
    repoJson: dossier.repoJson || null,
    diffTruncated: !!dossier.diffTruncated,
    cwd: dossier.cwd || null,
    packedAt: dossier.packedAt,
    blobRef,
  };
  return { light, heavyPlain, blobRef };
}

// fetch 回 heavy 后 · 合回 light · 得到跟 v1 同形的完整 dossier (给 verify / reply 用)
function mergeHeavyIntoDossier(light, heavy) {
  return {
    ...light,
    diff: heavy.diff || null,
    situation: heavy.situation || null,
    voiceFingerprint: heavy.voiceFingerprint || null,
  };
}

// 不管 v1 (整包) 还是 v2 (light + blobRef) · 统一给出"带了啥"的元信息
function payloadMeta(dossier) {
  if (dossier.blobRef) {
    const r = dossier.blobRef;
    return { diffBytes: r.diffBytes || 0, hasSituation: !!r.hasSituation, hasVoice: !!r.hasVoice };
  }
  return {
    diffBytes: dossier.diff ? dossier.diff.length : 0,
    hasSituation: !!dossier.situation,
    hasVoice: !!dossier.voiceFingerprint,
  };
}

// 人会带什么原料的口语化描述 · 给人看 · 不暴露文件名
function describePayload(dossier) {
  const m = payloadMeta(dossier);
  const bits = [];
  if (m.diffBytes) bits.push('一份大约 ' + Math.max(1, Math.round(m.diffBytes / 1024)) + 'kb 的改动');
  if (m.hasSituation) bits.push('当时卡住的现场');
  if (m.hasVoice) bits.push('发起方的写作口吻');
  if (bits.length === 0) return '只有一句说明 · 没带代码';
  return '带了' + bits.join(' · ');
}

// BRIEF.md · 人扫一眼的卡片 · 决定接 / 不接 / 稍后
function renderBrief({ msgId, fromHandle, dossier }) {
  const cwdName = dossier.cwd ? dossier.cwd.split('/').filter(Boolean).pop() : null;
  return `# 接力包 · @${fromHandle || '(未知)'} 发来的

${dossier.message || '(发起方没写说明)'}

${cwdName ? '来自项目「' + cwdName + '」· ' : ''}${describePayload(dossier)}。
收到时间 ${new Date(dossier.packedAt).toLocaleString('zh-CN', { hour12: false })}。

想接 → 让 AI 读这个包里的 README · 它会先验一遍能不能落地 · 再往下做。
不接 → \`tinker inbox done ${msgId}\` 标完工就行。
`;
}

function renderReadme({ msgId, fromHandle, dossier }) {
  const m = payloadMeta(dossier);
  const lazy = !!dossier.blobRef;  // v2 · 重料还在 server · 没 fetch 还没落 context/
  const repoLine = dossier.repo
    ? `- url: ${dossier.repo.url || '(本地仓库 · 没 remote)'}\n- branch: ${dossier.repo.branch || '(无)'}\n- sha: ${dossier.repo.sha || '(无)'}`
    : '(没传 repo 信息)';
  const filesLine = [
    '- `dossier.json` 完整结构 (顶层)',
    m.hasSituation ? '- `context/situation.json` 起源 situation (lifecycle + signals · 看作者怎么卡进来的)' : null,
    m.diffBytes ? '- `context/diff.patch` 已 unpushed + working tree diff (拿来 git apply 或者参考)' : null,
    m.hasVoice ? '- `context/voice-fingerprint.md` 发起方的 voice (接力回稿按这个写)' : null,
  ].filter(Boolean).join('\n');
  const filesNote = lazy
    ? '\n\n> 这些重料是懒取的 · 现在还在 server 上 · 跑 `tinker inbox fetch ' + msgId + '` 或直接 `tinker inbox verify ' + msgId + '` (会自动取) 才落到 context/'
    : '';

  // v2 多一步 fetch · verify 会自动取所以也可以直接 verify
  const steps = lazy
    ? [
        '1. 用户确认要接 → 跑 `tinker inbox fetch ' + msgId + '` 把重料取回 context/ (懒取 · 之前没下载)',
        '2. 看 `context/situation.json` (如果有) · 了解发起方卡在哪 / 怎么想的',
        '3. cd 到一个本地 clone · 跑 `tinker inbox verify ' + msgId + '` 验包 (没 fetch 会自动先取 · 结果自动回执给发起方)',
        '4. checkout 到 `' + (dossier.repo?.branch || '(无 branch)') + '` · reset 到 `' + (dossier.repo?.sha?.slice(0, 8) || '(无 sha)') + '`',
        '5. `git apply context/diff.patch` 拿到发起方未推的改动 (如果有)',
        '6. 看 `context/voice-fingerprint.md` 学发起方的口吻 (接力的进展用同样气质)',
        '7. 接着做 · 完了 `tinker push -m "..."` 或 `tinker ship` 把进展发回',
        '8. 处理完跑 `tinker inbox done ' + msgId + '` 标记 task 关闭',
      ].join('\n')
    : [
        '1. 看完 `context/situation.json` (如果有) · 了解发起方卡在哪 / 怎么想的',
        '2. cd 到一个本地 clone · 跑 `tinker inbox verify ' + msgId + '` 验包 (sha 对不对得上 · diff 落不落得下 · 结果自动回执给发起方)',
        '3. checkout 到 `' + (dossier.repo?.branch || '(无 branch)') + '` · reset 到 `' + (dossier.repo?.sha?.slice(0, 8) || '(无 sha)') + '`',
        '4. `git apply context/diff.patch` 拿到发起方未推的改动 (如果有)',
        '5. 看 `context/voice-fingerprint.md` 学发起方的口吻 (接力的进展用同样气质)',
        '6. 接着做 · 完了 `tinker push -m "..."` 或 `tinker ship` 把进展发回',
        '7. 处理完跑 `tinker inbox done ' + msgId + '` 标记 task 关闭',
      ].join('\n');

  return `# 接力 task · @${fromHandle} → 你 (AI 工作文档)

> 这份是给 AI 看的 · 人扫一眼 \`BRIEF.md\` 就够了 · 用户确认要接 · 你再读下面 + 钻 \`context/\`

## 一句话
${dossier.message || '(发起方没写说明)'}

## 起源 cwd
\`${dossier.cwd || '(无)'}\`

## 仓库信息
${repoLine}

## 原料 (都在 context/ 子目录)
${filesLine}${filesNote}

## 接力建议 (Claude 读到这一段时主动按下面办)
${steps}

## 元信息
- msg id: \`${msgId}\`
- 收到时间: ${new Date(dossier.packedAt).toLocaleString('zh-CN', { hour12: false })}
- 重料: ${lazy ? dossier.blobRef.plainBytes + ' 字节 · 懒取 (接了才下载)' : '已随包落地'}
- 拆包回执: 已自动回给 @${fromHandle || '(未知)'} · ta 下次起 session 能看到包到了
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

// =====================================================
// v0.52 接力包验收 · 邮件系统的回执/退信那一半
// 快验 (拆包时顺手跑) + 深验 (tinker inbox verify 显式跑)
// =====================================================

// git@github.com:foo/bar.git 跟 https://github.com/foo/bar 算同一个仓库
function sameRepoUrl(a, b) {
  if (!a || !b) return false;
  const norm = u => String(u).trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .toLowerCase();
  return norm(a) === norm(b);
}

// sha 来自队友的包 · 进 shell 前先验格式
function isSafeSha(sha) {
  return typeof sha === 'string' && /^[0-9a-f]{7,40}$/i.test(sha);
}

// 快验 · 只做便宜检查:找本地对应 clone + 起点 sha 认不认识 · 不动工作树
// SessionStart hook 拆包时跑 · 结果进回执
function quickVerifyDossier(dossier) {
  const facts = { repoPath: null, shaKnown: null };
  const repo = dossier.repo || {};
  if (!repo.url) return facts;
  const candidates = [process.cwd(), dossier.cwd].filter(Boolean);
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) continue;
      const url = safeGit('git config --get remote.origin.url', c, 500);
      if (!url || !sameRepoUrl(url, repo.url)) continue;
      facts.repoPath = c;
      if (isSafeSha(repo.sha)) {
        try {
          execSync('git cat-file -e ' + repo.sha + '^{commit}', { cwd: c, stdio: 'ignore' });
          facts.shaKnown = true;
        } catch { facts.shaKnown = false; }
      }
      break;
    } catch {}
  }
  return facts;
}

// packDossier 用 '=== xxx ===' 拼 diff 段 · 这里按同样标记拆回去
function splitDiffSections(diff) {
  const out = {};
  const re = /^=== (.+) ===$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(diff)) !== null) {
    marks.push({ name: m[1], start: m.index, bodyStart: m.index + m[0].length });
  }
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : diff.length;
    const body = diff.slice(marks[i].bodyStart, end).trim();
    if (marks[i].name.startsWith('unpushed diff')) out.unpushed = body;
    else if (marks[i].name.startsWith('working tree diff')) out.workingTree = body;
  }
  return out;
}

// 深验 · 临时工作树上把 diff 真 apply 一遍 · 完了拆掉 · 不碰用户当前工作树
// sha 本地有 → 基于 sha 重放 working tree 段
// sha 本地没有 (含未推 commit 时正常) → 基于 origin/main 重放 unpushed + working tree 段
// 返回 { checks: [{name, ok, note}], verdict, reason }
function verifyDossier({ dossier, repoPath }) {
  const checks = [];
  const add = (name, okFlag, note) => checks.push({ name, ok: okFlag, note: note || '' });
  const repo = dossier.repo || {};

  const url = safeGit('git config --get remote.origin.url', repoPath, 500);
  const remoteOk = sameRepoUrl(url, repo.url);
  add('remote 对得上', remoteOk, remoteOk ? '' : '本地 ' + ((url || '').trim() || '(无)') + ' vs 包里 ' + (repo.url || '(无)'));
  if (!remoteOk) return { checks, verdict: false, reason: 'remote 对不上 · 不是同一个仓库' };

  // 先 fetch 一把 · 失败不挡路 (离线也能验本地已有的)
  try { execSync('git fetch origin --quiet', { cwd: repoPath, stdio: 'ignore', timeout: 20000 }); } catch {}

  let shaKnown = false;
  if (isSafeSha(repo.sha)) {
    try {
      execSync('git cat-file -e ' + repo.sha + '^{commit}', { cwd: repoPath, stdio: 'ignore' });
      shaKnown = true;
    } catch {}
  }
  const shaShort = isSafeSha(repo.sha) ? repo.sha.slice(0, 8) : '(无)';
  add('起点 sha 本地认识', shaKnown, shaKnown ? shaShort : shaShort + ' 没有 · 含未推 commit 时正常 · 改走 origin/main 重放');

  if (!dossier.diff) {
    add('diff 重放', true, '包里没 diff · 没啥可重放');
    return { checks, verdict: true, reason: null };
  }
  // diffTruncated 是打包时记的标志位 (v0.53) · 老包没这字段 · 缺省当没截断 · 真截了 apply 会自己失败
  if (dossier.diffTruncated) {
    add('diff 重放', false, 'diff 打包时被截断 (超 200kb) · 重放不了');
    return { checks, verdict: false, reason: 'diff 被截断 · 让发起方推一把 commit 再重发' };
  }

  const sections = splitDiffSections(dossier.diff);
  const base = shaKnown ? repo.sha : 'origin/main';
  const baseShort = shaKnown ? shaShort : base;
  const toApply = [];
  if (!shaKnown && sections.unpushed) toApply.push(['unpushed diff', sections.unpushed]);
  if (sections.workingTree) toApply.push(['working tree diff', sections.workingTree]);
  if (toApply.length === 0) {
    add('diff 重放', true, '没有要重放的 patch 段');
    return { checks, verdict: true, reason: null };
  }

  let tmpWorktree = null;
  let tmpPatch = null;
  try {
    tmpWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'tinker-verify-'));
    // mkdtemp 建了目录 · worktree add 要目录不存在
    fs.rmSync(tmpWorktree, { recursive: true, force: true });
    execSync('git worktree add --detach "' + tmpWorktree + '" ' + base, { cwd: repoPath, stdio: 'ignore' });
    tmpPatch = tmpWorktree + '.patch';
    for (const [name, patch] of toApply) {
      fs.writeFileSync(tmpPatch, patch.endsWith('\n') ? patch : patch + '\n');
      try {
        execSync('git apply --whitespace=nowarn "' + tmpPatch + '"', { cwd: tmpWorktree, stdio: 'ignore' });
        add(name + ' 落得下', true, '基于 ' + baseShort);
      } catch {
        add(name + ' 落得下', false, '基于 ' + baseShort + ' apply 失败');
        return { checks, verdict: false, reason: name + ' 在 ' + baseShort + ' 上 apply 不上 · 接收方仓库可能太旧或包过期' };
      }
    }
  } catch (e) {
    add('临时工作树', false, String(e.message || e).slice(0, 120));
    return { checks, verdict: false, reason: '临时工作树建不起来 · ' + String(e.message || e).slice(0, 80) };
  } finally {
    if (tmpWorktree) {
      try { execSync('git worktree remove --force "' + tmpWorktree + '"', { cwd: repoPath, stdio: 'ignore' }); } catch {}
      try { fs.rmSync(tmpWorktree, { recursive: true, force: true }); } catch {}
    }
    if (tmpPatch) { try { fs.rmSync(tmpPatch, { force: true }); } catch {} }
  }
  return { checks, verdict: true, reason: null };
}

module.exports = {
  packDossier,
  unpackDossier,
  pickActiveSituationId,
  listInbox,
  markInboxDone,
  quickVerifyDossier,
  verifyDossier,
  sameRepoUrl,
  describePayload,
  prepareHandoff,
  mergeHeavyIntoDossier,
  payloadMeta,
  writeContextFiles,
  INBOX_DIR,
  STRUGGLES_DIR,
};

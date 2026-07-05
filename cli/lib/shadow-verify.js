// 影子产出的验收官 · 铁判 + 语义判 混合(从 shadow-verify-lab 原型移植)
// 铁判:能数清的(禁词/字数/必须含/文件存在/跑命令)用代码硬判 · 不花 token
// 语义判:没法用尺子量的(暖不暖 / 像不像 / 有没有取舍)才交给便宜模型(默认 haiku)
// 用法:const { verify } = require('./lib/shadow-verify'); verify(标准文件, 产出目录, { model })
// 返回 { pass, failCount, feedback, report }
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

// 用绝对路径别靠 PATH 撞运气(偶发 claude not found 会误判 FAIL → 冤枉打回)
function resolveClaude() {
  try {
    const p = execSync('command -v claude', { encoding: 'utf-8' }).trim();
    if (p) return p;
  } catch {}
  return '/opt/homebrew/bin/claude';
}

// 收集产出目录里所有非隐藏文件
// raw = 纯内容(铁判数字数 / 找禁词用 · 不含合成表头)
// labeled = 带「文件名」表头(只给语义判用 · 帮 AI 分辨多文件)
function gather(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => !f.startsWith('.')); } catch {}
  const raws = [];
  const labels = [];
  for (const f of files.sort()) {
    const fp = path.join(dir, f);
    try {
      if (fs.statSync(fp).isFile()) {
        const content = fs.readFileSync(fp, 'utf-8');
        raws.push(content);
        labels.push('# ==== ' + f + ' ====\n' + content);
      }
    } catch {}
  }
  const raw = raws.join('\n\n');
  // 单文件不加「# ==== 文件名 ====」表头 · 免得语义判把表头当成产出的多余内容 → 冤枉打回
  const labeled = raws.length <= 1 ? raw : labels.join('\n\n');
  return { raw, labeled };
}

// 调便宜模型判语义 · 最多 3 次 · valid 谓词不满足(如没吐 VERDICT)也算没通 · 继续重试
// 彻底拿不到合格输出返 null(上层别当质量 FAIL 兜底 · 免得冤枉打回烧钱)
function callClaude(prompt, model, claudePath, valid) {
  const args = ['-p'];
  if (model) args.push('--model', model); // model 传 null 就走 claude 默认模型(拆一刀这种要好点的脑子)
  args.push(prompt);
  for (let i = 0; i < 3; i++) {
    try {
      const out = execFileSync(claudePath, args, { encoding: 'utf-8', timeout: 180000 });
      if (out && out.trim() && (!valid || valid(out))) return out;
    } catch {}
  }
  return null;
}

// 标准文件语法(# 开头是注释):
//   禁止包含: X          出现就 FAIL
//   必须包含: A|B|C      都没出现才 FAIL(任一命中即过 · 治死抠字面)
//   最多字数: N / 最少字数: N
//   文件存在: 名
//   命令: shell          在产出目录里跑 · 退出非 0 就 FAIL
//   语义: 一句话          交给便宜模型判
function verify(criteriaFile, deliverDir, options) {
  options = options || {};
  const model = options.model || 'haiku';
  const claudePath = options.claudePath || resolveClaude();

  const { raw: text, labeled } = gather(deliverDir);
  const nchars = text.replace(/\s/g, '').length; // 去空白字数 · 中文一个算一个 · 只数纯内容
  const lines = ['===== 铁判(代码硬判 · 不靠 AI)====='];
  let hardFails = 0;
  const semLines = [];

  let crit = [];
  try { crit = fs.readFileSync(criteriaFile, 'utf-8').split('\n'); } catch {}
  for (const raw of crit) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('禁止包含:')) {
      const pat = line.slice('禁止包含:'.length).trim();
      const n = pat ? text.split(pat).length - 1 : 0;
      if (n > 0) { lines.push('  [FAIL] 禁止包含「' + pat + '」· ' + n + ' 次'); hardFails++; }
      else lines.push('  [PASS] 禁止包含「' + pat + '」');
    } else if (line.startsWith('必须包含:')) {
      const rawPat = line.slice('必须包含:'.length).trim();
      const alts = rawPat.split('|').map(s => s.trim()).filter(Boolean);
      const hit = alts.find(a => text.includes(a));
      if (hit) lines.push('  [PASS] 必须包含「' + rawPat + '」· 命中「' + hit + '」');
      else { lines.push('  [FAIL] 必须包含「' + rawPat + '」· 都没出现'); hardFails++; }
    } else if (line.startsWith('最多字数:')) {
      const mx = parseInt(line.slice('最多字数:'.length).trim(), 10);
      if (nchars > mx) { lines.push('  [FAIL] 最多 ' + mx + ' 字 · 实际 ' + nchars); hardFails++; }
      else lines.push('  [PASS] 最多 ' + mx + ' 字 · 实际 ' + nchars);
    } else if (line.startsWith('最少字数:')) {
      const mn = parseInt(line.slice('最少字数:'.length).trim(), 10);
      if (nchars < mn) { lines.push('  [FAIL] 最少 ' + mn + ' 字 · 实际 ' + nchars); hardFails++; }
      else lines.push('  [PASS] 最少 ' + mn + ' 字 · 实际 ' + nchars);
    } else if (line.startsWith('文件存在:')) {
      const fn = line.slice('文件存在:'.length).trim();
      if (fs.existsSync(path.join(deliverDir, fn))) lines.push('  [PASS] 文件存在「' + fn + '」');
      else { lines.push('  [FAIL] 文件存在「' + fn + '」· 没有'); hardFails++; }
    } else if (line.startsWith('命令:')) {
      const cmd = line.slice('命令:'.length).trim();
      try { execSync(cmd, { cwd: deliverDir, stdio: 'ignore', timeout: 300000 }); lines.push('  [PASS] 命令「' + cmd + '」'); }
      catch { lines.push('  [FAIL] 命令「' + cmd + '」· 退出非 0'); hardFails++; }
    } else if (line.startsWith('语义:')) {
      semLines.push(line.slice('语义:'.length).trim());
    } else {
      semLines.push(line); // 没写前缀的当语义兜底
    }
  }

  let semFail = 0;
  let semFeedback = '';
  if (semLines.length) {
    lines.push('', '===== 语义判(交给便宜模型 · 只判没法用尺子量的)=====');
    const prompt =
      '你是严格的验收官。下面「产出」已经给全了 · 现在就判 · 不要回「准备好了」「等待输入」这类话 · 也不要等我再给内容。\n' +
      '字数 / 禁用词 / 跑命令这类硬指标已由程序另判,你不要再数数或跑东西。\n' +
      '只判下面这些没法用尺子量的语义要求,逐条看产出满不满足。\n\n' +
      '语义要求:\n' + semLines.join('\n') + '\n\n' +
      '产出(就是这些 · 已完整):\n"""\n' + labeled + '\n"""\n\n' +
      '直接给结论,别展示思考,只输出一次这个格式(第一行必须是 VERDICT:):\n' +
      'VERDICT: PASS 或 FAIL\n- [PASS/FAIL] <要求>: 一句话理由\n' +
      'FEEDBACK: 若 FAIL 写给影子照着改的指令 · PASS 写「无」';
    const out = callClaude(prompt, model, claudePath, o => /^VERDICT:/im.test(o));
    if (out === null) {
      lines.push('  [验收官够不着 · 基础设施故障 · 保守判 FAIL]');
      semFail = 1;
    } else {
      lines.push(out.trim());
      const verdicts = out.split('\n').filter(l => l.trim().toUpperCase().startsWith('VERDICT:'));
      if (!verdicts.length || !verdicts[verdicts.length - 1].toUpperCase().includes('PASS')) semFail = 1;
      const fb = out.split('\n').filter(l => l.trim().toUpperCase().startsWith('FEEDBACK:'));
      if (fb.length && fb[fb.length - 1].indexOf('无') === -1) semFeedback = fb[fb.length - 1];
    }
  }

  const failCount = hardFails + semFail;
  const failLines = lines.filter(l => l.indexOf('[FAIL]') !== -1);
  const feedback = [
    failLines.length ? '没过的条目:\n' + failLines.join('\n') : '',
    semFeedback,
  ].filter(Boolean).join('\n');

  return { pass: failCount === 0, failCount, feedback, report: lines.join('\n') };
}

// 拆一刀 · 给一个要交给影子的任务 · 让模型现生成验收标准(默认走好点的模型 · 拆得准更重要)
// 返回标准文本(可直接写成标准文件)· 拆不出返 ''
function genCriteria(task, options) {
  options = options || {};
  const model = options.model || null; // null = claude 默认模型
  const claudePath = options.claudePath || resolveClaude();
  const prompt =
    '你是验收标准拟定官。下面是要交给影子完成的任务 · 请定出这份产出该满足的验收标准。\n' +
    '只输出标准行 · 每行一条 · 用这些前缀:\n' +
    '必须包含: 只写产出正文里该出现的专有名词 / 术语 / 具体数值(可写 A|B 表示同义任一)。\n' +
    '  注意:别把「写入文件X」「文件名叫X」「用markdown」这类操作/格式要求写成必须包含 —— 那不是正文内容 · 会永远判不过。文件的事不用你管。\n' +
    '语义: 用于概念 / 覆盖 / 质量类要求(如 每块要有取舍不是罗列 · 要有明确结论 · 该覆盖哪几方面)\n' +
    '至少 3 条 · 概念性要求优先用语义 · 拿不准就用语义别用必须包含 · 别输出任务原文或别的话。\n\n' +
    '任务:\n' + task;
  const out = callClaude(prompt, model, claudePath,
    o => /(必须包含:|语义:|最多字数:|最少字数:|禁止包含:|文件存在:)/.test(o));
  if (!out) return '';
  const lines = out.split('\n').map(l => l.trim()).filter(
    l => /^(必须包含:|语义:|最多字数:|最少字数:|禁止包含:|文件存在:)/.test(l));
  return lines.length ? ('# 自动拆出的验收标准\n' + lines.join('\n') + '\n') : '';
}

module.exports = { verify, genCriteria };

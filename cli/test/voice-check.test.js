// voice-check 兜底守门测试
// detectAIVoice 是 push 前的核心闸门 (score>=3 强拒 / ==2 confirm / <=1 放过)
// 这套测试守两头:真实作者声音不被错杀 · 重度 AI 腔确实被拦住

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectAIVoice, VOICE_SAMPLES } = require('../lib/voice-check');

// ============================================
// 最重要的回归守卫:真实工作日志一定不被拦
// 设计原则「宁可漏判不要错判」· 这条挂了说明守门误伤作者
// ============================================
test('真实作者样本 score < 2 · 永远放过', () => {
  for (const s of VOICE_SAMPLES) {
    const r = detectAIVoice(s.text);
    assert.ok(r.score < 2, `样本被误判 (score=${r.score}, ${r.list.join('/')}): ${s.text.slice(0, 20)}`);
  }
});

test('日常口语工作日志 score 0', () => {
  const r = detectAIVoice('今天把登录重构了一遍,踩了个 cookie 的坑,改完清爽多了');
  assert.equal(r.score, 0);
});

// ============================================
// 边界输入
// ============================================
test('空串 / null / 非字符串 → score 0', () => {
  assert.equal(detectAIVoice('').score, 0);
  assert.equal(detectAIVoice(null).score, 0);
  assert.equal(detectAIVoice(undefined).score, 0);
  assert.equal(detectAIVoice(12345).score, 0);
});

// ============================================
// 各检测器单独命中
// ============================================
test('段首 emoji', () => {
  const r = detectAIVoice('🚀 今天把登录修好了');
  assert.ok(r.list.includes('段首 emoji'));
});

test('破折号 (—— / —)', () => {
  assert.ok(detectAIVoice('今天修了登录——花了俩小时').list.includes('破折号'));
  assert.ok(detectAIVoice('今天修了登录—花了俩小时').list.includes('破折号'));
});

test('中圆点滥用 (>= 3 才算)', () => {
  assert.ok(detectAIVoice('今天 · 修了 · 登录 · 还行').list.includes('中圆点滥用'));
  // 两个中圆点不算 (口语化标点常用)
  assert.ok(!detectAIVoice('今天 · 修了登录 · 还行').list.includes('中圆点滥用'));
});

test('多项排比 (4+ 顿号项)', () => {
  assert.ok(detectAIVoice('改了登录、注册、找回、改密、注销这些').list.includes('多项排比'));
});

test('等号金句', () => {
  assert.ok(detectAIVoice('我的理解是 简单 = 好用').list.includes('等号金句'));
});

test('内部代号 (选 X / 不选 Y / 方案 X)', () => {
  assert.ok(detectAIVoice('纠结半天 · 最后选 A 不选 B').list.includes('内部代号(选 X / 不选 Y / 方案 X)'));
});

// ============================================
// 中英混杂:>= 2 个生英文词才命中 · 常见缩写豁免
// ============================================
test('中英混杂:2 个生词命中', () => {
  assert.ok(detectAIVoice('今天调了 studio 跟 handle 两个东西').list.some(x => x.startsWith('中英混杂')));
});

test('中英混杂:单个生词不命中 (宁可漏判)', () => {
  assert.ok(!detectAIVoice('今天调了 studio 这块').list.some(x => x.startsWith('中英混杂')));
});

test('中英混杂:常见缩写 (API/JSON) 豁免', () => {
  assert.equal(detectAIVoice('今天调了 API 跟 JSON 的对接').score, 0);
});

// ============================================
// 闸门阈值:重度 AI 腔 score >= 3 一定被强拒
// ============================================
test('重度 AI 腔 score >= 3 · 触发强拒', () => {
  const r = detectAIVoice('🚀 今天悟了——好产品 = 好体验');
  assert.ok(r.score >= 3, `应强拒但 score=${r.score} (${r.list.join('/')})`);
});

test('score 字段等于 list 长度', () => {
  const r = detectAIVoice('🚀 今天悟了——好产品 = 好体验');
  assert.equal(r.score, r.list.length);
});

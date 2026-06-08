// cli/lib/bridge.js · 加密私信通道客户端
//
// 跟 server/bridge.js 对应:
//   - server 只存密文 + to_handle/to_studio 明文 · 看不到内容
//   - 客户端 AES-256-GCM 加密/解密 · key = sha256(团队暗号)
//   - 信封 = base64( iv(12) | authTag(16) | ciphertext )
//   - 解不开 (key 错 / 别的团队 / 篡改) → 客户端忽略 · 不告警
//
// v0.19 升级: 暗号属于 studio (工作室)
//   - ~/.tinker/studios.json 存:{ active, studios: [{ slug, name, secret, id }] }
//   - 一个 user 可属多个 studio · 任何时刻只有一个 active
//   - active 的 secret 给 send/ping/watch 默认用
//   - 旧 ~/.tinker/bridge-secret 自动迁移成 legacy studio (避免老用户掉线)

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.tinker');
const STUDIOS_FILE = path.join(CONFIG_DIR, 'studios.json');
const LEGACY_SECRET_FILE = path.join(CONFIG_DIR, 'bridge-secret');

// ======================================================
// studios.json 读写 (含 legacy 文件 auto migrate)
// ======================================================

function loadStudios() {
  try {
    return JSON.parse(fs.readFileSync(STUDIOS_FILE, 'utf-8'));
  } catch {
    // 兼容旧版:有 ~/.tinker/bridge-secret 就视为 legacy studio
    if (fs.existsSync(LEGACY_SECRET_FILE)) {
      const secret = fs.readFileSync(LEGACY_SECRET_FILE, 'utf-8').trim();
      if (secret) {
        return {
          active: 'legacy',
          studios: [{ slug: 'legacy', name: '(legacy 暗号)', secret, id: null }],
        };
      }
    }
    return { active: null, studios: [] };
  }
}

function saveStudios(data) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(STUDIOS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(STUDIOS_FILE, 0o600); } catch {}
}

function getActiveStudio() {
  const data = loadStudios();
  if (!data.active) return null;
  return data.studios.find(s => s.slug === data.active) || null;
}

function getActiveSecret() {
  const s = getActiveStudio();
  return s ? s.secret : null;
}

// v0.50 守门 · 防 test-secret-1234567 这种测试占位混进 studios.json
// 历史教训:占位 secret 进了真 studio 槽位 · AES-GCM auth 全 fail
// 表象是网络问题 / server 收不到 · 实际是暗号根本对不上
const BAD_SECRET_PATTERNS = [
  /^(test|debug|demo|dummy|fake|placeholder|sample|example|temp|tmp)[-_]/i,
  /^(secret|password|passwd|abc|xxx|yyy|zzz|123|0+|1+)/i,
  /^changeme$/i,
];
function assertRealSecret(secret) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('secret 不能空');
  }
  if (secret.length < 24) {
    throw new Error('secret 太短 (< 24 字符) · 不像真暗号 · 当前长度 ' + secret.length + ' · 历史踩坑:test-secret-1234567 这种占位是 19 字符');
  }
  for (const re of BAD_SECRET_PATTERNS) {
    if (re.test(secret)) {
      throw new Error('secret 看起来是测试占位 (匹配 ' + re + ') · 不允许进 studios.json · 走正经 invite + accept 流程拿真暗号');
    }
  }
}

function addStudio({ slug, name, secret, id }) {
  assertRealSecret(secret);
  const data = loadStudios();
  data.studios = data.studios.filter(s => s.slug !== slug);
  data.studios.push({ slug, name, secret, id: id || null });
  if (!data.active) data.active = slug;
  saveStudios(data);
}

function setActiveStudio(slug) {
  const data = loadStudios();
  if (!data.studios.find(s => s.slug === slug)) {
    throw new Error('未加入 studio: ' + slug + ' · 先 tinker studio join 或 create');
  }
  data.active = slug;
  saveStudios(data);
}

function removeStudio(slug) {
  const data = loadStudios();
  data.studios = data.studios.filter(s => s.slug !== slug);
  if (data.active === slug) data.active = data.studios[0]?.slug || null;
  saveStudios(data);
}

// 旧 cmdSecret 兼容用 · 内部转成"legacy" studio
function saveLegacySecret(secret) {
  addStudio({ slug: 'legacy', name: '(legacy 暗号)', secret, id: null });
  setActiveStudio('legacy');
}

// 旧 API · cmd 还在用 (一律走 active studio)
function hasSecret() {
  return getActiveSecret() !== null;
}
function loadSecret() {
  return getActiveSecret();
}

// ======================================================
// 加密信封 · AES-256-GCM
// ======================================================

function deriveKey(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

// secret hash 给 server 校验 studio 成员关系用
function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function encrypt(plaintext, secret) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decrypt(envelope, secret) {
  const key = deriveKey(secret);
  const buf = Buffer.from(envelope, 'base64');
  if (buf.length < 28) throw new Error('信封太短');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf-8');
}

// 用本地所有 studio secret 依次试解 · 解开的返 { plaintext, studio }
// 用于 watch 时不知道消息属于哪个 studio · 自动选对的 key
function tryDecryptWithAnyStudio(envelope) {
  const data = loadStudios();
  for (const s of data.studios) {
    try {
      return { plaintext: decrypt(envelope, s.secret), studio: s };
    } catch {}
  }
  return null;
}

module.exports = {
  // studios 管理
  loadStudios, saveStudios, getActiveStudio, getActiveSecret,
  addStudio, setActiveStudio, removeStudio, saveLegacySecret,
  // 旧 API (active studio 透明转发)
  hasSecret, loadSecret,
  // 加密
  encrypt, decrypt, hashSecret, tryDecryptWithAnyStudio,
  // 路径常量
  STUDIOS_FILE, LEGACY_SECRET_FILE,
};

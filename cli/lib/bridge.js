// cli/lib/bridge.js · 加密私信通道客户端 (跟 server/bridge.js 对应)
//
// server 只存密文 + to_handle 明文 · 看不到内容
// 客户端 AES-256-GCM 加密/解密 · key = sha256(团队暗号)
// 暗号本地 ~/.tinker/bridge-secret · 文件权限 0600
//
// 信封格式: base64( iv(12) | authTag(16) | ciphertext )
// 拿到密文解不开 (key 错 / 别的团队 / 篡改) → 客户端忽略 · 不告警

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SECRET_FILE = path.join(os.homedir(), '.tinker', 'bridge-secret');

function hasSecret() {
  return fs.existsSync(SECRET_FILE);
}

function loadSecret() {
  try {
    return fs.readFileSync(SECRET_FILE, 'utf-8').trim();
  } catch {
    return null;
  }
}

function saveSecret(secret) {
  const dir = path.dirname(SECRET_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  try { fs.chmodSync(SECRET_FILE, 0o600); } catch {}
}

function deriveKey(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

// plaintext → base64 信封
function encrypt(plaintext, secret) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

// base64 信封 → plaintext · 解不开抛
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

module.exports = { hasSecret, loadSecret, saveSecret, encrypt, decrypt, SECRET_FILE };

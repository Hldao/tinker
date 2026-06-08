// build-webapp-crypto.js · 给 webapp 打包 e2e 加密用的纯 JS 实现
//
// 背景:
//   webapp 端的 studio create / invite / accept 需要 sha256 + AES-GCM。
//   原本用浏览器内置 crypto.subtle · 但 SubtleCrypto 只在 secure context
//   (https / localhost / file://) 下可用。线上是 http + IP 直连 (ICP 备案
//   没下来 · 短期上不了 https) · subtle 是 undefined · 加密链路全断。
//
// 这个脚本用 esbuild 把 @noble/hashes + @noble/ciphers 打成一个 IIFE bundle
// 输出到 webapp/lib/studio-crypto.js · webapp 用 <script src=> 加载后
// 暴露成 window.studioCrypto · 任何 context 都能跑。
//
// 一次性 build · 产物提交进 repo · server 部署不需要带 devDep。
// 升级 noble 时重跑这个脚本一次。

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const ENTRY = path.join(__dirname, 'webapp-crypto-entry.tmp.js');
const OUT_DIR = path.join(__dirname, '..', 'webapp', 'lib');
const OUT = path.join(OUT_DIR, 'studio-crypto.js');

const entrySrc = `
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';

// 信封格式跟 cli/lib/bridge.js 跟 server/bridge.js 完全一致:
//   base64( iv(12) | authTag(16) | ciphertext )
// key 来自 sha256(secret) · 32 字节 → AES-256-GCM
// random 用浏览器原生 crypto.getRandomValues (所有 context 都可用 · 只 subtle 限 secure)

function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}
function base64FromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function bytesFromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

window.studioCrypto = {
  // sha256 hex · 跟 server studios.js 的 sha256Hex 一致
  async sha256Hex(s) {
    return bytesToHex(sha256(new TextEncoder().encode(s)));
  },
  // 随机 hex string (用于生成 secret / token)
  randomHex(byteLen) {
    const buf = new Uint8Array(byteLen);
    crypto.getRandomValues(buf);
    return bytesToHex(buf);
  },
  // plaintext + secret → base64 信封
  async encrypt(plaintext, secret) {
    const key = sha256(new TextEncoder().encode(secret));
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const cipher = gcm(key, iv);
    const ctWithTag = cipher.encrypt(new TextEncoder().encode(plaintext));
    // noble gcm 输出末尾 16 字节是 tag · 拆出来按 cli 信封格式重组
    const tag = ctWithTag.slice(ctWithTag.length - 16);
    const ct = ctWithTag.slice(0, ctWithTag.length - 16);
    const out = new Uint8Array(iv.length + tag.length + ct.length);
    out.set(iv, 0);
    out.set(tag, iv.length);
    out.set(ct, iv.length + tag.length);
    return base64FromBytes(out);
  },
  // base64 信封 + secret → plaintext (解不开抛)
  async decrypt(envelope, secret) {
    const buf = bytesFromBase64(envelope);
    if (buf.length < 28) throw new Error('信封太短');
    const iv = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const ct = buf.slice(28);
    const ctWithTag = new Uint8Array(ct.length + tag.length);
    ctWithTag.set(ct, 0);
    ctWithTag.set(tag, ct.length);
    const key = sha256(new TextEncoder().encode(secret));
    const cipher = gcm(key, iv);
    const plain = cipher.decrypt(ctWithTag);
    return new TextDecoder().decode(plain);
  },
};
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(ENTRY, entrySrc);

try {
  esbuild.buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    outfile: OUT,
    format: 'iife',
    target: 'es2020',
    minify: true,
    banner: { js: '/* studio-crypto · 纯 JS sha256 + AES-GCM · 不依赖 crypto.subtle · build via server/build-webapp-crypto.js */' },
  });
  const stats = fs.statSync(OUT);
  console.log('built:', OUT, '(' + (stats.size / 1024).toFixed(1) + ' KB)');
} finally {
  fs.unlinkSync(ENTRY);
}

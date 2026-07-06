// server 侧飞书通知
//
// 产品级做法:一套 app 凭证配在服务器(env)· 团队所有人零配置就能收到 bridge 提醒。
// 对比客户端方案(每人各自 login + set-chat + 守护进程)· 这里新成员登录一次就够 · 不用逐个配。
//
// bridge payload 是端到端加密的 · server 读不到内容。但 from / to / kind 是明文 ·
// 通知本来也只需要"谁给你发了个啥 · 去看看" · 不需要内容 · 反而更干净不泄密。
//
// env:
//   FEISHU_APP_ID / FEISHU_APP_SECRET  应用凭证(跟 CLI 用的同一个自建应用)
//   FEISHU_NOTIFY_CHAT_ID              通知群 chat_id(oc_ 开头)

const db = require('./db');

const APP_ID = process.env.FEISHU_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const NOTIFY_CHAT_ID = process.env.FEISHU_NOTIFY_CHAT_ID || '';
const BASE = 'https://open.feishu.cn';

function isConfigured() { return !!(APP_ID && APP_SECRET && NOTIFY_CHAT_ID); }

// tenant_access_token 缓存 · 快过期(留 60s)再换
let _tok = { value: null, exp: 0 };
async function tenantToken() {
  if (_tok.value && _tok.exp - Date.now() > 60000) return _tok.value;
  const r = await fetch(BASE + '/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  }).then(x => x.json());
  if (!r.tenant_access_token) throw new Error('feishu tenant token 失败: ' + (r.msg || ''));
  _tok = { value: r.tenant_access_token, exp: Date.now() + (r.expire || 7000) * 1000 };
  return _tok.value;
}

async function sendGroupText(text) {
  const tok = await tenantToken();
  const r = await fetch(BASE + '/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ receive_id: NOTIFY_CHAT_ID, msg_type: 'text', content: JSON.stringify({ text }) }),
  }).then(x => x.json());
  if (r.code !== 0) throw new Error('feishu 发群失败: ' + (r.msg || JSON.stringify(r).slice(0, 120)));
}

function kindWord(kind) { return kind === 'task' ? '接力包' : kind === 'file' ? '文件' : '一条消息'; }

// 拼收件人称呼:绑了飞书就用 <at> 真 @(静音也戳得到)· 没绑退化成纯文本 @handle
function recipientTag(toHandle) {
  const row = db.prepare('SELECT feishu_open_id, feishu_name, name FROM users WHERE handle = ?').get(toHandle);
  if (row && row.feishu_open_id) {
    return '<at user_id="' + row.feishu_open_id + '">' + (row.feishu_name || row.name || toHandle) + '</at>';
  }
  return '@' + toHandle;
}

// 收到 bridge 消息时 server 主动推飞书 · 点对点 @ 收件人本人 · 工作室广播则 @ 不到具体人只提示
// 失败(没配 / 网络 / 飞书报错)一律吞掉 · 绝不影响消息本身的收发
async function notifyBridge({ from, to, toStudio, kind }) {
  if (!isConfigured()) return;
  try {
    let text;
    if (to) text = '🌉 @' + from + ' 给 ' + recipientTag(to) + ' 发来' + kindWord(kind) + ' · 去 tinker inbox 看看';
    else if (toStudio) text = '🌉 @' + from + ' 往工作室发来' + kindWord(kind) + ' · tinker inbox';
    else text = '🌉 @' + from + ' 广播了' + kindWord(kind);
    await sendGroupText(text);
  } catch (e) {
    try { require('./logger').logger.warn({ err: e.message }, 'feishu notifyBridge 失败'); } catch (_) {}
  }
}

// CLI 登录后把自己的飞书身份注册上来 · 之后 server 发通知就能 @ 到 ta
function linkIdentity(userId, openId, name) {
  db.prepare('UPDATE users SET feishu_open_id = ?, feishu_name = ?, updated_at = ? WHERE id = ?')
    .run(openId, name || null, Date.now(), userId);
}

module.exports = { isConfigured, notifyBridge, linkIdentity };

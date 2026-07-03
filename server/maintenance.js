// 传输层清道夫
//
// bridge 的消息(ping / 交接信封 / witness / 通知)和 handoff 的 blob 都是"过路的"·
// 送到就没用了。之前只进不清 · 会慢慢堆。这里给它们加 TTL · 定时删掉过期的 · 把存储焊在上限内。
//
// 只清传输类 · 不碰存档类(updates / methods / research_digests)—— 那是价值本身要永久留。
// blob 是内容寻址去重的 · 删了真要再传会重新生成 · 所以可以更激进。
//
// TTL 可用环境变量调 · 默认:消息 30 天 · blob 14 天。
// 纯 DELETE · 不动表结构 · 不需要 migration。

const db = require('./db');

const DAY = 24 * 3600 * 1000;
const MSG_TTL_DAYS = parseInt(process.env.BRIDGE_MSG_TTL_DAYS || '30', 10);
const BLOB_TTL_DAYS = parseInt(process.env.BRIDGE_BLOB_TTL_DAYS || '14', 10);

// 删过期消息 + 过期 blob · 返回删了多少 · 供日志
function pruneBridge() {
  const now = Date.now();
  const msgCutoff = now - MSG_TTL_DAYS * DAY;
  const blobCutoff = now - BLOB_TTL_DAYS * DAY;

  // 先量 blob 要腾多少字节(删之前 SUM)· 给日志用
  let freedBytes = 0;
  try {
    freedBytes = db.prepare('SELECT COALESCE(SUM(bytes),0) AS b FROM bridge_blobs WHERE created_at < ?').get(blobCutoff).b || 0;
  } catch (e) { /* 表不存在就算了 */ }

  let msgs = 0, blobs = 0;
  const txn = db.transaction(() => {
    try { msgs = db.prepare('DELETE FROM messages WHERE created_at < ?').run(msgCutoff).changes; } catch (e) {}
    try { blobs = db.prepare('DELETE FROM bridge_blobs WHERE created_at < ?').run(blobCutoff).changes; } catch (e) {}
  });
  txn();
  // 注意:SQLite 删了不会缩小文件 · 但空出的页会被后续写入复用 · 所以文件大小会到顶后不再涨(达到封顶目的)
  return { msgs, blobs, freedBytes, msgTtlDays: MSG_TTL_DAYS, blobTtlDays: BLOB_TTL_DAYS };
}

// 启动跑一次 + 之后每天一次 · timer.unref 不拦进程退出
function startBridgeJanitor(logger) {
  const run = () => {
    try {
      const r = pruneBridge();
      if (logger && (r.msgs || r.blobs)) {
        logger.info(r, `传输层清理: 消息 ${r.msgs} 条 · blob ${r.blobs} 个 (约 ${Math.round(r.freedBytes / 1024)}KB)`);
      }
    } catch (e) {
      if (logger) logger.warn({ err: e.message }, '传输层清理失败');
    }
  };
  run();
  const timer = setInterval(run, DAY);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { pruneBridge, startBridgeJanitor };

-- 060_bridge_blobs.sql · handoff 重料的内容寻址 blob 库 (Phase 2 懒取)
--
-- 背景:022 的 task 消息把整个 dossier (含 30kb+ diff) inline 塞进 bridge payload。
-- 接收方 SessionStart 一拉就全落盘 · 不管接不接。重的字节白白流动 + 占轮询。
--
-- 这里把重料 (diff / situation / voice fingerprint) 拆出来单独存:
--   - bridge task 消息只带"轻信封" (说明 + repo + blobRef 哈希)
--   - 重料加密压缩后存这张表 · 接收方点了"接"才 GET 回来
--
-- 内容寻址:hash = sha256(重料明文) · 客户端算好传上来。同一工作室里
-- 内容一样 (比如同一个人反复发的 voice fingerprint) 哈希就一样 · 自动去重。
--
-- 命名空间按 studio_id 隔开:
--   - 防跨工作室哈希撞车 (不同工作室明文偶然相同也各存各的)
--   - 兼做访问控制 · GET/PUT 都要校验是该 studio 成员
--   - server 看不到明文 · payload 是 AES-256-GCM 信封 (跟 messages.payload 同套)

CREATE TABLE bridge_blobs (
  studio_id   TEXT NOT NULL,
  hash        TEXT NOT NULL,        -- sha256(明文) hex · 客户端算
  payload     TEXT NOT NULL,        -- 压缩+加密的信封 base64
  bytes       INTEGER NOT NULL,     -- 上线字节数 (统计 / 上限)
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (studio_id, hash)
);

CREATE INDEX idx_bridge_blobs_created ON bridge_blobs(created_at);

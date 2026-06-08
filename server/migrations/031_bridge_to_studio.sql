-- 031_bridge_to_studio.sql · 桥支持工作室维度
--
-- 022 的桥是 from_handle → to_handle (点对点 · 或 NULL 广播)。
-- 这里加 to_studio · 让桥消息可以投递给整个工作室 (所有成员都能 poll 到)。
--
-- 路由优先级:to_studio 有值 → 投递给所有 studio members
--          to_handle 有值 → 点对点
--          两个都没 → 广播 (跟 022 行为兼容)
--
-- server 不解密 payload · 但需要校验:发送方必须是 to_studio 的成员
-- (防别的工作室往你工作室扔东西)

ALTER TABLE messages ADD COLUMN to_studio TEXT;

CREATE INDEX idx_messages_to_studio_seq ON messages(to_studio, seq);

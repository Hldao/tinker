-- "求反馈" 是 update 级属性 · 不是项目状态
-- 创作者在某条进展上勾"我求看看 · 求反馈" · 可选写"想知道:X"
-- spec §四 "给在做但没做完的人留主舞台" 的对偶 —— "做完了想被看见"也有舞台
-- 跟 PH 的根本区别:反馈仍然只能是 method_used / 接走 / 便签 · 不开放赞踩投票

-- 设计:
--   NULL = 不求反馈
--   非 NULL(包括空字符串) = 求反馈 · 内容是可选的具体问题
-- 视觉:勾了之后 · update 卡片加 "求 反 馈" 印章 · 试用 CTA 加强
-- 发现:feed 加"只看求反馈"切换

ALTER TABLE updates ADD COLUMN feedback_ask TEXT;
CREATE INDEX IF NOT EXISTS idx_updates_feedback_ask ON updates(feedback_ask) WHERE feedback_ask IS NOT NULL;

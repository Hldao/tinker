-- v0.78 方法卡片 "使用场景" 字段
-- 痛点 (用户 dogfood 反馈): 方法卡片正文一般给 AI 看 · 不给人看
-- 人需要的是"这个方法能解决什么问题"的一句话标题 · 让 ta 判断要不要展开
--
-- scenario · 短文本 · 10-30 字 · 人话回答 "这个文档帮你跟 AI 合作时解决什么问题"
-- 优先 LLM 自动填 (contribute --auto 时取 LLM 的 reason)
-- 作者可手动编辑覆盖
-- 普通进展 (非方法) 可以留空

ALTER TABLE updates ADD COLUMN scenario TEXT;

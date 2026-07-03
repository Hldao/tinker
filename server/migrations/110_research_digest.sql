-- 调研资料投喂 (v1.x) · 给"主要在豆包 app 里做调研"的人一个单向知识投喂口
--
-- 背景:豆包 app 用户没有 CLI · 挂不上 hook · 只能往 server 发一段原文。
-- 所以这是唯一一条压缩发生在服务端的路径 (其余 LLM 调用都在 CLI 端)。
--
-- 内容形态:顶部是 DeepSeek 压出的结论+高密度要点 · 底部折叠完整全文。
-- 语义上**不是 method** (不是可复用的手艺) · 也**不是 update** (不强绑项目) · 独立表。
--
-- 关键设计:
-- - studio_id 绑团队 · 投喂按团队隔离 (每个团队看自己的调研流) · 是团队知识池不是全局大池子
-- - submitter_id 直属 user · 谁投的 (可空 · 留给以后无账号外部投喂)
-- - summary 可空 · DeepSeek 挂了也先把 full_text 存下来 · 不丢投喂 · 事后可重压
-- - source 自由文本 · 记来源 (比如 "豆包·张三") · 归因用

CREATE TABLE IF NOT EXISTS research_digests (
  id           TEXT PRIMARY KEY,
  studio_id    TEXT,                  -- 绑哪个团队 · 投喂/读取都按这个隔离
  summary      TEXT,                  -- DeepSeek 压出的结论+要点 (顶部) · 可空 (压缩失败先留全文)
  full_text    TEXT NOT NULL,         -- 完整原文 (底部折叠)
  source       TEXT,                  -- 来源标注 "豆包·张三" · 归因
  submitter_id TEXT,                  -- 谁投的 · 可空
  at           INTEGER NOT NULL,      -- 投喂时间
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (studio_id) REFERENCES studios(id) ON DELETE CASCADE,
  FOREIGN KEY (submitter_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_research_digests_studio_at ON research_digests(studio_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_research_digests_submitter_at ON research_digests(submitter_id, at DESC) WHERE submitter_id IS NOT NULL;

-- 给 CLI 钥匙加「轻度 / 重度」类型 · 影子分版用
-- light = 影子当帮手(默认 · 免费):打草稿、记录,人审了才发
-- heavy = 影子当队员(自带 LLM 钥匙):离开时自动处理低风险的事
-- 老钥匙没这列 → 默认 light · 不破坏现有钥匙

ALTER TABLE api_tokens ADD COLUMN tier TEXT NOT NULL DEFAULT 'light';

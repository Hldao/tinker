-- 飞书身份映射 · server 侧发飞书通知时用来 @ 到本人
-- 每个成员 tinker feishu login 后 · CLI 把自己的 open_id 注册上来(POST /api/feishu/link)
-- server 收到 bridge 消息时据此在通知群 @ 收件人 · 群静音也戳得到 · 新成员登录一次即可 · 零额外配置
ALTER TABLE users ADD COLUMN feishu_open_id TEXT;
ALTER TABLE users ADD COLUMN feishu_name TEXT;

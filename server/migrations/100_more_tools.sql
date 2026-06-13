-- v1.0 工具预设补全 · 加 Codex 等当前 AI coding agent · 顺手理顺顺序
--
-- 起因: 来了用 Codex 的用户 · 但新项目"用了什么"的预设 pill 里没 Codex
--       (跟 CLI 的 AI 工具识别列表当初漏 codex 一个毛病)。顺带补 GitHub Copilot / Gemini / Aider / Cline。
--
-- 安全性: available_tools 是全局预设 pill 列表 · 项目实际选的工具存在 project_tools (字符串 · 独立)
--         所以这里 DELETE + 重新 INSERT 不影响任何已有项目的工具 · 只换"可选 pill"的内容和顺序。
--
-- 号 100: 跳过 095-099 当 buffer · 避开别处在制 migration 撞 schema_version。

DELETE FROM available_tools;
INSERT INTO available_tools (tool, position) VALUES
  ('Claude Code', 0), ('Codex', 1), ('Cursor', 2), ('GitHub Copilot', 3), ('Gemini', 4), ('Aider', 5), ('Cline', 6),
  ('v0', 7), ('Bolt', 8), ('Lovable', 9), ('Replit', 10), ('Windsurf', 11), ('Trae', 12),
  ('通义灵码', 13), ('CodeGeex', 14), ('文心 Comate', 15),
  ('Claude', 16), ('ChatGPT', 17), ('DeepSeek', 18), ('豆包', 19), ('Kimi', 20), ('通义千问', 21),
  ('Node.js', 22), ('Docker', 23), ('Tailwind', 24), ('Supabase', 25), ('Vercel', 26);

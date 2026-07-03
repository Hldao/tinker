// server/llm.js — 服务端唯一的 LLM 出口
//
// 立场:Tinker server 默认不碰模型 · 所有 LLM 调用都在 CLI 端 · 用用户自己的 key。
// 唯一例外就是这里:调研资料投喂。豆包 app 用户没有 CLI · 压缩只能在服务端做。
// 所以这道口子刻意收窄 · 只暴露一个 summarizeResearch · 不做通用 provider 层。
//
// key 走 process.env.DEEPSEEK_API_KEY (server/.env · 已 gitignore) · 报文照抄
// cli/bin/tinker.js callLLM 的 deepseek 分支 (OpenAI 兼容格式)。

const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';

// 配了 key 才开这条路 · 没配就当功能没上 · action 里据此降级 (只存全文不压缩)
function enabled() {
  return !!(process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.trim());
}

async function callDeepSeek(prompt, { maxTokens = 1200 } = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey || !apiKey.trim()) throw new Error('DEEPSEEK_API_KEY 没配 · 服务端压缩不可用');
  const res = await fetch(DEEPSEEK_ENDPOINT, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || 'deepseek api ' + res.status);
  return data.choices[0].message.content.trim();
}

// 把一段调研原文压成"结论 + 高密度要点" · 忠实原文 · 不编造
function buildSummaryPrompt(fullText) {
  return `你是一个信息压缩器。把下面这份调研资料压成高密度要点 · 让别人几秒钟抓到核心。

要求:
- 开头一句话给出最重要的结论 (不超过 40 字)
- 空一行 · 然后 3 到 7 条要点 · 每条一行 · 只保留信息本身 · 去掉铺垫 客套 重复
- 用中文 · 纯文本 · 不要 markdown 标题 · 不要"综上所述"这类废话
- 只忠实压缩原文已有的信息 · 不补充 不编造 · 原文没说的别写

调研原文:
"""
${fullText}
"""`;
}

async function summarizeResearch(fullText) {
  return callDeepSeek(buildSummaryPrompt(fullText), { maxTokens: 1200 });
}

module.exports = { enabled, summarizeResearch };

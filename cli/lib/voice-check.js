// voice-check.js · 兜底 voice 检测器
//
// CLI 起草路径走内置 DeepSeek + DEFAULT_VOICE 200+ 行规则约束 voice。
// 但用户不一定都走 DeepSeek:
//   - 手打 tinker push -m "..."
//   - 让 Claude Code / Cursor 帮写好复制过来
//   - 其他 agent 帮起草
// 这条兜底通道用 regex 在 push 前快速判一下 · 命中就温柔问一下用户。
//
// 设计原则:
//   - 不是违禁词审查 · 是友善编辑 · 用户永远能"我就要这样发"
//   - 宁可漏判 · 不要错判 (正常工作日志一定不被拦)
//   - 阈值 score >= 2 才弹 · 单条命中不打扰

// 教学范例 · 真实进展 · 让用户看气质参考
// (alpha 期 hard-code daodao 两条决策推演 · 后续可改 server 抓 isExemplar)
const VOICE_SAMPLES = [
  {
    handle: 'daodao',
    text: '刚理清楚一件事,方法跟进展到底是什么关系。之前 v0.80 把沉淀的踩坑方法塞进 feed 当普通卡片,跟今日进展排在一起,时间倒序。结果一周前的一条好方法和今天刚发的进展混着,好的经验被埋下去。',
  },
  {
    handle: 'daodao',
    text: '刚理清楚一件事,方法、进展、项目这三个板块在 Tinker 里到底该怎么摆。之前我一直把它们当成同一层级的子信息,倒序时间流一铺,所有东西按时间戳沉底。一个新方法如果是一周前总结的,得翻好几屏才能找到。',
  },
];

function detectAIVoice(text) {
  if (!text || typeof text !== 'string') return { score: 0, list: [] };
  const t = text.trim();
  const issues = [];

  const emojiRe = /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2700}-\u{27BF}\u{1F000}-\u{1F2FF}\u{1F900}-\u{1F9FF}]/u;
  if (emojiRe.test(t)) issues.push('段首 emoji');

  if (/——|—/.test(t)) issues.push('破折号');

  const midDots = (t.match(/[一-鿿]\s*·\s*[一-鿿]/g) || []).length;
  if (midDots >= 3) issues.push('中圆点滥用');

  if (/[^\s、,。:;]{2,15}(?:、[^\s、,。:;]{2,15}){3,}/.test(t)) {
    issues.push('多项排比');
  }

  if (/[一-鿿]\s*=\s*[一-鿿]/.test(t)) issues.push('等号金句');

  const COMMON_ABBR = /^(API|UI|UX|CLI|HTTP|HTTPS|URL|URI|JSON|AI|ID|IDE|SDK|OS|OK|app|PR|MR|SQL|NoSQL|CSV|XML|HTML|CSS|JS|TS|TSX|JSX|MCP|LLM|GPT|RGB|CPU|GPU|VPN|DNS|CDN|UUID|YAML|TOML|XSS|RCE|JWT|OAuth|REST|GraphQL|gRPC|RPC|MD|PDF|PNG|JPG|JPEG|SVG|GIF|CEO|CTO|CFO|VC|SaaS|PaaS|IaaS|B2B|B2C|MVP|YAGNI|alpha|beta|gamma|tinker|Tinker|daodao|hi|ok|tag|tags|hash|sha|git|Git|npm|node|Node|bash|zsh|Bash|vim|Vim|emoji|hook|hooks|repo|commit|push|pull|prompt|prompts|webapp|server|file|click|hover|loading|footer|header|update|toast|tab|tabs|menu|cmd|cwd|env|sudo|cron|todo|TODO|DRY|KISS|UTC|GMT|FAQ|ETA|TBD|AFAIK|TLDR)$/i;
  const cnOrPunctRe = /[　-〿一-鿿＀-￯]/;
  const enWordRe = /[a-zA-Z]{4,}/g;
  const mixedTerms = [];
  let match;
  while ((match = enWordRe.exec(t)) !== null) {
    const word = match[0];
    if (COMMON_ABBR.test(word)) continue;
    // v0.20 升级:看前 3 字符 + 后 3 字符 · 越过空格判断 "汉字 studio 汉字" 这种
    // 之前只看紧邻 1 个字符 · " studio " (空格隔开) 漏报
    const ctxBefore = t.slice(Math.max(0, match.index - 3), match.index);
    const ctxAfter = t.slice(match.index + word.length, match.index + word.length + 3);
    if (cnOrPunctRe.test(ctxBefore) || cnOrPunctRe.test(ctxAfter)) {
      mixedTerms.push(word);
    }
  }
  if (mixedTerms.length >= 2) {
    issues.push('中英混杂(' + [...new Set(mixedTerms)].slice(0, 3).join(', ') + ')');
  }

  // v0.20 "选 X 不选 Y" / "方案 A vs 方案 B" / "三条线索" 等内部代号 · 没上下文外人看不懂
  // 抓住 daodao 那条 "studio 一等公民" 漏报的根本
  if (/选\s*[A-Za-z](?:[\s 不]|$)|不选\s*[A-Za-z](?:[\s 因]|$)|方案\s*[A-Za-z]\b/.test(t)) {
    issues.push('内部代号(选 X / 不选 Y / 方案 X)');
  }

  return { score: issues.length, list: issues };
}

module.exports = { detectAIVoice, VOICE_SAMPLES };

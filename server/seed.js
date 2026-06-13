// 生产 seed — 最小启动状态
// daodao 是 maintainer · 其他 user / 项目 / 通知都从空开始 · 由真实用户填充
// 测试用全套 mock 数据见 test/fixtures.js

// 跟 migrations/100_more_tools.sql 保持同步 (一个给空库 seed · 一个给已有库迁移)
const AVAILABLE_TOOLS = [
  'Claude Code', 'Codex', 'Cursor', 'GitHub Copilot', 'Gemini', 'Aider', 'Cline',
  'v0', 'Bolt', 'Lovable', 'Replit', 'Windsurf', 'Trae',
  '通义灵码', 'CodeGeex', '文心 Comate',
  'Claude', 'ChatGPT', 'DeepSeek', '豆包', 'Kimi', '通义千问',
  'Node.js', 'Docker', 'Tailwind', 'Supabase', 'Vercel',
];

// v0.71 starter 4 类 × 3 道 · 用户主动选 "想给谁做" → spec §5.2 "定期换" 的轻量落地
// 跟 server/migrations/011_starters_category.sql + webapp renderOnboard 同步
const STARTERS = [
  // ─ self · 给自己用 ─
  { category: 'self', title: '用 Claude Artifact 做"今晚不想想"清单',
    prompt: '做一个网页. 我能列出今晚不想想的事 · 一条一条加 · 每加完它变浅色/划掉 · 给我"已经放下了"的感觉. 不要计数 · 不要鼓励语 · 数据存浏览器.',
    toolName: 'Claude', toolUrl: 'https://claude.ai' },
  { category: 'self', title: '用 v0 做"扔硬币帮我决定"工具',
    prompt: '做一个简单的决定器. 我输入两个选项 (比如 "出门" vs "在家") · 按一个大按钮 · 它用扔硬币的方式选一个并简单说明为什么. 风格俏皮但不卖萌.',
    toolName: 'v0', toolUrl: 'https://v0.dev' },
  { category: 'self', title: '用 Bolt 做"给明天的自己"留言板',
    prompt: '做一个网页. 我能写一条给明天自己的话 · 数据存浏览器 · 每天打开第一次自动显示昨天给今天的话. 风格安静 · 不要计数 · 不要打卡感.',
    toolName: 'Bolt', toolUrl: 'https://bolt.new' },

  // ─ others · 给身边的人 ─
  { category: 'others', title: '用 v0 做"妈妈版小红书排版器"',
    prompt: '做一个网页. 我能粘 3-9 张图 + 写几句话 · 它自动排成小红书风格的 9 宫格预览 + 一段适合发笔记的文案. 字体大一点 · 按钮简单 · 给不会用 PS 的人用.',
    toolName: 'v0', toolUrl: 'https://v0.dev' },
  { category: 'others', title: '用 Claude Artifact 做"今天来家里的客人卡"',
    prompt: '做一个网页. 我输入访客名字 + 来意 (比如 "李叔 · 来取年货") · 它生成一张 A4 大小的欢迎卡, 上面有大字名字 + 一句话欢迎 + 当天日期 · 可以打印出来贴门口.',
    toolName: 'Claude', toolUrl: 'https://claude.ai' },
  { category: 'others', title: '用 Bolt 做"两人家务交替排"',
    prompt: '做一个网页. 一周 7 天 · 两个人 (比如我和室友) 轮换 3 件家务 (倒垃圾/洗碗/拖地) · 每天打开只显示"今天该谁做什么" · 不打卡 · 不计分 · 数据存浏览器.',
    toolName: 'Bolt', toolUrl: 'https://bolt.new' },

  // ─ work · 工作或学习 ─
  { category: 'work', title: '用 Claude Artifact 做"会议笔记 → 决定 + 我要做啥"',
    prompt: '做一个网页. 我粘一段会议笔记进去 · 它自动提取两件事: "本次会议决定了什么" + "我接下来要做什么" · 两件事各列 3 条以内 · 不重复笔记内容 · 只提取动作.',
    toolName: 'Claude', toolUrl: 'https://claude.ai' },
  { category: 'work', title: '用 v0 做"读到的好想法记一下"',
    prompt: '做一个网页. 我能写一句话感想 + 贴一个来源链接 (书/文章/视频) · 攒一周 · 周日打开自动汇总成一段"给自己的 newsletter"格式. 风格安静 · 数据存浏览器.',
    toolName: 'v0', toolUrl: 'https://v0.dev' },
  { category: 'work', title: '用 Bolt 做"演示用的迷你 demo"',
    prompt: '做一个 1 屏 demo · 用来给老板/老师演示一个想法. 3 个核心操作 (比如 "上传 → 看结果 → 下载") · 每个都能真的点 · 让看的人 30 秒能理解你做的是什么.',
    toolName: 'Bolt', toolUrl: 'https://bolt.new' },

  // ─ play · 纯好玩 ─
  { category: 'play', title: '用 v0 做"莫名其妙的当日运势"',
    prompt: '做一个网页. 打开就给一段严肃但荒诞的当日运势 · 比如 "今日宜: 拒接陌生电话. 今日忌: 吃辣." · 每天不一样 · 必须荒诞 · 不要正能量 · 不要算命噱头.',
    toolName: 'v0', toolUrl: 'https://v0.dev' },
  { category: 'play', title: '用 Claude Artifact 做"假装我此刻在另一个城市"',
    prompt: '做一个网页. 我输入一个城市名 · 它给我一段 200 字的"我此刻在这里"的描述 · 包括天气 / 街边声音 / 闻到的味道 / 看到的人. 不要旅游攻略口吻 · 像一个临时居民的随笔.',
    toolName: 'Claude', toolUrl: 'https://claude.ai' },
  { category: 'play', title: '用 Bolt 做"两个名词的合成器"',
    prompt: '做一个网页. 我输入两个不相关的名词 (比如 "螺丝刀" + "睡眠") · 它生成一段奇怪的产品说明 (用法/材料/警告) + 一张简笔画形象 (可以是 emoji 拼贴). 必须严肃 · 不要解释自己很搞笑.',
    toolName: 'Bolt', toolUrl: 'https://bolt.new' },
];

// 数据迁移 (幂等 · 反复调用安全) — 加载 data.json 或返回 seed 前都过一遍
// 加新字段 / 删老字段 / 改 schema 都在这里做兼容处理
function migrateState(data) {
  // 砍掉 reactions.interested · spec 已从 4 级反馈改 3 级
  (data.projects || []).forEach(p => {
    if (p.reactions && 'interested' in p.reactions) delete p.reactions.interested;
  });
  return data;
}

function getSeedData() {
  return migrateState({
    users: {
      'daodao': { name: '捣鼓自己', tagline: '在做 Tinker · 这个产品本身' },
    },
    projects: [],
    notifications: [],
    starters: STARTERS,
    availableTools: AVAILABLE_TOOLS,
  });
}

module.exports = { getSeedData, AVAILABLE_TOOLS, migrateState };

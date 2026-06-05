// 生产 seed — 最小启动状态
// daodao 是 maintainer · 其他 user / 项目 / 通知都从空开始 · 由真实用户填充
// 测试用全套 mock 数据见 test/fixtures.js

const AVAILABLE_TOOLS = [
  'Claude Code', 'Cursor', 'Claude', 'v0', 'Bolt', 'Lovable', 'Replit', 'Windsurf',
  'Trae', '通义灵码', 'CodeGeex', '文心 Comate',
  'ChatGPT', 'DeepSeek', '豆包', 'Kimi', '通义千问',
  'Node.js', 'Docker', 'Tailwind', 'Supabase', 'Vercel',
];

const STARTERS = [
  { title: '用 Claude Artifact 做"今晚不想想"清单',
    prompt: '做一个网页. 我能列出今晚不想想的事 · 一条一条加 · 每加完它变浅色/划掉 · 给我"已经放下了"的感觉. 不要计数 · 不要鼓励语 · 数据存浏览器.',
    toolName: 'Claude', toolUrl: 'https://claude.ai' },
  { title: '用 v0 做"扔硬币帮我决定"工具',
    prompt: '做一个简单的决定器. 我输入两个选项 (比如 "出门" vs "在家") · 按一个大按钮 · 它用扔硬币的方式选一个并简单说明为什么. 风格俏皮但不卖萌.',
    toolName: 'v0', toolUrl: 'https://v0.dev' },
  { title: '用 Bolt 做"给明天的自己"留言板',
    prompt: '做一个网页. 我能写一条给明天自己的话 · 数据存浏览器 · 每天打开第一次自动显示昨天给今天的话. 风格安静 · 不要计数 · 不要打卡感.',
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

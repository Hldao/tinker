// 测试 fixtures — 从 prototype v0.23 提取的全套 mock 数据
// 仅 server/test 用 · 生产 seed 见 ../seed.js (minimal · 真实用户从空开始)

const MOCK_CAT_ERROR = `<svg width="640" height="380" xmlns="http://www.w3.org/2000/svg">
  <rect width="640" height="380" fill="#1a1a1a"/>
  <rect x="0" y="0" width="640" height="32" fill="#2a2a2a"/>
  <circle cx="18" cy="16" r="6" fill="#dc2626"/>
  <circle cx="38" cy="16" r="6" fill="#ca8a04"/>
  <circle cx="58" cy="16" r="6" fill="#16a34a"/>
  <text x="320" y="20" font-family="monospace" font-size="11" fill="#737373" text-anchor="middle">cat-mood — predict.py</text>
  <text x="24" y="68" font-family="monospace" font-size="13" fill="#a3a3a3">$ python train.py --epoch 10</text>
  <text x="24" y="92" font-family="monospace" font-size="13" fill="#737373">Loading dataset (320 images)...</text>
  <text x="24" y="116" font-family="monospace" font-size="13" fill="#737373">Training epoch 1/10... loss=2.43</text>
  <text x="24" y="140" font-family="monospace" font-size="13" fill="#737373">Training epoch 10/10... loss=0.41</text>
  <text x="24" y="164" font-family="monospace" font-size="13" fill="#737373">Training complete.</text>
  <text x="24" y="200" font-family="monospace" font-size="13" fill="#a3a3a3">$ python predict.py test/angry_*.jpg</text>
  <text x="24" y="224" font-family="monospace" font-size="13" fill="#dc2626">test/angry_01.jpg  ->  happy   (conf 0.71)</text>
  <text x="24" y="248" font-family="monospace" font-size="13" fill="#dc2626">test/angry_02.jpg  ->  happy   (conf 0.83)</text>
  <text x="24" y="272" font-family="monospace" font-size="13" fill="#dc2626">test/angry_03.jpg  ->  happy   (conf 0.69)</text>
  <text x="24" y="296" font-family="monospace" font-size="13" fill="#dc2626">test/angry_04.jpg  ->  curious (conf 0.55)</text>
  <text x="24" y="334" font-family="monospace" font-size="13" fill="#737373">Accuracy on angry set: 0.06  (??)</text>
</svg>`;

const MOCK_REDNOTE_COMPARE = `<svg width="640" height="420" xmlns="http://www.w3.org/2000/svg">
  <rect width="640" height="420" fill="#faf9f6"/>
  <rect x="20" y="20" width="290" height="380" fill="white" stroke="#e5e5e5"/>
  <text x="40" y="50" font-family="sans-serif" font-size="12" fill="#737373">AI 草稿</text>
  <text x="40" y="80" font-family="sans-serif" font-size="14" fill="#1c1917">本店精选护肤产品</text>
  <text x="40" y="102" font-family="sans-serif" font-size="14" fill="#1c1917">采用日本进口原料</text>
  <text x="40" y="124" font-family="sans-serif" font-size="14" fill="#1c1917">温和不刺激,适合敏感肌</text>
  <text x="40" y="146" font-family="sans-serif" font-size="14" fill="#1c1917">现在购买立享 8 折</text>
  <text x="40" y="168" font-family="sans-serif" font-size="14" fill="#1c1917">仅限本周</text>
  <text x="40" y="208" font-family="sans-serif" font-size="11" fill="#c2410c" font-style="italic">— "太像广告了" — 我妈</text>
  <rect x="330" y="20" width="290" height="380" fill="white" stroke="#e5e5e5"/>
  <text x="350" y="50" font-family="sans-serif" font-size="12" fill="#737373">妈妈想要的口气</text>
  <text x="350" y="80" font-family="sans-serif" font-size="14" fill="#1c1917">姐妹们 救命了 🥺</text>
  <text x="350" y="102" font-family="sans-serif" font-size="14" fill="#1c1917">这个真的好用</text>
  <text x="350" y="124" font-family="sans-serif" font-size="14" fill="#1c1917">我用了两周</text>
  <text x="350" y="146" font-family="sans-serif" font-size="14" fill="#1c1917">皮肤明显细腻了 ✨</text>
  <text x="350" y="168" font-family="sans-serif" font-size="14" fill="#1c1917">本来怕踩雷的我</text>
  <text x="350" y="190" font-family="sans-serif" font-size="14" fill="#1c1917">现在回购第三瓶 🛒</text>
  <text x="350" y="230" font-family="sans-serif" font-size="11" fill="#15803d" font-style="italic">— "这个才像" — 我妈</text>
</svg>`;

const MOCK_RED_GRID = `<svg width="640" height="420" xmlns="http://www.w3.org/2000/svg">
  <rect width="640" height="420" fill="#fafaf7"/>
  <text x="320" y="32" font-family="serif" font-size="14" font-style="italic" fill="#737373" text-anchor="middle">同一篇文案 · 4 张配图风格各异</text>
  <rect x="60" y="60" width="240" height="140" fill="#f5f5f4"/>
  <circle cx="180" cy="130" r="40" fill="#e7e5e4"/>
  <text x="180" y="220" font-family="serif" font-size="12" font-style="italic" fill="#737373" text-anchor="middle">极简风</text>
  <rect x="340" y="60" width="240" height="140" fill="#7c2d12"/>
  <circle cx="460" cy="130" r="40" fill="#fbbf24"/>
  <text x="460" y="220" font-family="serif" font-size="12" font-style="italic" fill="#737373" text-anchor="middle">油画风</text>
  <rect x="60" y="240" width="240" height="140" fill="#1e3a8a"/>
  <rect x="160" y="290" width="40" height="40" fill="#fde047"/>
  <text x="180" y="400" font-family="serif" font-size="12" font-style="italic" fill="#737373" text-anchor="middle">像素风</text>
  <rect x="340" y="240" width="240" height="140" fill="#fce7f3"/>
  <circle cx="460" cy="310" r="40" fill="#f9a8d4" opacity="0.7"/>
  <text x="460" y="400" font-family="serif" font-size="12" font-style="italic" fill="#737373" text-anchor="middle">水彩风</text>
</svg>`;

const MOCK_NOTE_EMOJI = `<svg width="500" height="240" xmlns="http://www.w3.org/2000/svg">
  <rect width="500" height="240" fill="#fafaf7"/>
  <text x="250" y="28" font-family="serif" font-size="13" font-style="italic" fill="#737373" text-anchor="middle">参考 · emoji 密度对比</text>
  <rect x="30" y="45" width="200" height="170" fill="white" stroke="#e5e5e5"/>
  <text x="50" y="72" font-family="sans-serif" font-size="11" fill="#a8a29e">原稿</text>
  <text x="50" y="100" font-family="sans-serif" font-size="13" fill="#1c1917">本店产品采用日本</text>
  <text x="50" y="118" font-family="sans-serif" font-size="13" fill="#1c1917">进口原料,温和不</text>
  <text x="50" y="136" font-family="sans-serif" font-size="13" fill="#1c1917">刺激,适合敏感肌</text>
  <text x="50" y="154" font-family="sans-serif" font-size="13" fill="#1c1917">使用。</text>
  <text x="50" y="195" font-family="sans-serif" font-size="11" fill="#c2410c" font-style="italic">太干 · 像广告</text>
  <rect x="270" y="45" width="200" height="170" fill="white" stroke="#e5e5e5"/>
  <text x="290" y="72" font-family="sans-serif" font-size="11" fill="#15803d">加了 emoji 后</text>
  <text x="290" y="100" font-family="sans-serif" font-size="13" fill="#1c1917">姐妹们 救命了 🥺</text>
  <text x="290" y="118" font-family="sans-serif" font-size="13" fill="#1c1917">这个真的好用 ✨</text>
  <text x="290" y="136" font-family="sans-serif" font-size="13" fill="#1c1917">日本进口 温和</text>
  <text x="290" y="154" font-family="sans-serif" font-size="13" fill="#1c1917">敏感肌也能用 🌸</text>
  <text x="290" y="195" font-family="sans-serif" font-size="11" fill="#15803d" font-style="italic">有 vibe 了</text>
</svg>`;

const MOCK_BOOK_RECOG = `<svg width="640" height="320" xmlns="http://www.w3.org/2000/svg">
  <rect width="640" height="320" fill="#faf8f3"/>
  <rect x="40" y="40" width="180" height="240" fill="#78716c"/>
  <text x="130" y="90" font-family="serif" font-size="14" fill="white" text-anchor="middle">线性代数</text>
  <text x="130" y="112" font-family="serif" font-size="12" fill="#e7e5e4" text-anchor="middle">同济版</text>
  <text x="130" y="270" font-family="monospace" font-size="10" fill="#a8a29e" text-anchor="middle">[scan photo]</text>
  <rect x="260" y="40" width="340" height="240" fill="white" stroke="#d6d3d1"/>
  <text x="280" y="74" font-family="monospace" font-size="11" fill="#737373">识别结果</text>
  <text x="280" y="104" font-family="serif" font-size="18" fill="#1c1917">《线性代数》</text>
  <text x="280" y="128" font-family="serif" font-size="13" fill="#44403c" font-style="italic">同济大学数学系 · 第六版</text>
  <line x1="280" y1="148" x2="580" y2="148" stroke="#d6d3d1"/>
  <text x="280" y="172" font-family="monospace" font-size="11" fill="#737373">估价 · 9.5 成新</text>
  <text x="280" y="196" font-family="serif" font-size="22" fill="#c2410c">¥ 8 — 32</text>
  <text x="280" y="220" font-family="serif" font-size="12" fill="#78716c" font-style="italic">(估价跨度太大 · 数据来源:多抓鱼公开页 + 闲鱼搜索)</text>
  <text x="280" y="258" font-family="monospace" font-size="11" fill="#c2410c">[ 估价模块还不准 ]</text>
</svg>`;

function svgUri(svg) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

const AVAILABLE_TOOLS = [
  'Cursor', 'Claude', 'v0', 'Bolt', 'Lovable', 'Replit', 'Windsurf',
  'Trae', '通义灵码', 'CodeGeex', '文心 Comate',
  'ChatGPT', 'DeepSeek', '豆包', 'Kimi', '通义千问',
  'Tailwind', 'Supabase', 'Vercel',
];

// 把 SEED 数据里的 ago 字符串转为真实 timestamp (at)
// alpha 期 SEED 时间基于 server 启动时间偏移
function ago2at(ago, now) {
  if (typeof ago !== 'string') return now;
  if (ago === '刚刚') return now;
  const min = 60 * 1000, hr = 60 * min, day = 24 * hr, week = 7 * day;
  if (ago.includes('分钟前')) return now - (parseInt(ago) || 1) * min;
  if (ago.includes('小时前')) return now - (parseInt(ago) || 1) * hr;
  if (ago === '昨天') return now - day;
  if (ago.includes('天前')) return now - (parseInt(ago) || 1) * day;
  if (ago.includes('周前')) return now - (parseInt(ago) || 1) * week;
  if (ago.includes('个月前')) return now - (parseInt(ago) || 1) * 30 * day;
  return now;
}

function convertAgoToAt(data) {
  const now = Date.now();
  (data.projects || []).forEach(p => {
    (p.updates || []).forEach(u => {
      if (u.ago) u.at = ago2at(u.ago, now);
      delete u.ago;
      if (u.usedBy) u.usedBy.forEach(x => { if (x.ago) x.at = ago2at(x.ago, now); delete x.ago; });
    });
    (p.notes || []).forEach(n => { if (n.ago) n.at = ago2at(n.ago, now); delete n.ago; });
  });
  (data.notifications || []).forEach(n => { if (n.ago) n.at = ago2at(n.ago, now); delete n.ago; });
  return data;
}

// 数据迁移 (幂等 · 反复调用安全) — 加载 data.json 或返回 seed 前都过一遍
function migrateState(data) {
  // 砍掉 reactions.interested · spec 已从 4 级反馈改 3 级
  (data.projects || []).forEach(p => {
    if (p.reactions && 'interested' in p.reactions) delete p.reactions.interested;
  });
  return data;
}

function getTestSeedData() {
  return migrateState(convertAgoToAt({
    users: {
      'daodao':   { name: '捣鼓自己',  tagline: '在做 Tinker · 这个产品本身' },
      'zhangsan': { name: '张三',     tagline: '用 AI 帮我妈做小红书' },
      'liushi':   { name: '柳师',     tagline: '设计师 · 用 AI 折腾产品 demo' },
      'wangwu':   { name: '王五',     tagline: '前 PM · 现在自己做点东西' },
      'lisi':     { name: '李四',     tagline: '大三 · 用 AI 做毕设' },
      'maomao':   { name: '猫猫',     tagline: '内容创作者 · 用 AI 做小工具' },
    },
    projects: [
      { id:'p1', owner:'daodao', name:'Tinker 主屏', slug:'tinker-feed', desc:'"今天有动静的工作室" 这个首页本身', productLink:'https://tinker.so', githubLink:'https://github.com/daodao/tinker', status:'active', tools:['Cursor','Claude','Tailwind'],
        updates:[
          { text:'今天加了工具筛选,但是想再观察一下要不要默认隐藏', ago:'15 分钟前' },
          { text:'"卡片来源是项目事件而不是用户发帖"这个差异要让新人一眼看出', ago:'2 小时前' },
          { text:'决定不做 onboarding wizard,新人点开主屏直接看真实工作室', ago:'昨天' },
          { text:'砍掉了"热门推荐",时间倒序到底', ago:'2 天前' },
        ],
        reactions:{ wantToTry:['lisi'],
          tinkered:[ { user:'liushi', name:'深色版 Tinker', link:'#' } ] },
        notes:[ { user:'wangwu', text:'我觉得卡片高度可以再小一点,信息密度再高一些', ago:'1 小时前' } ] },

      { id:'p2', owner:'zhangsan', name:'AI 简历优化器', slug:'resume-ai', desc:'让 AI 改简历但不胡编工作经历', productLink:'https://resume-ai.vercel.app', githubLink:'https://github.com/zhangsan/resume-ai', status:'active', tools:['Cursor','Claude'],
        updates:[
          { text:'终于让 GPT 不胡编工作经历了! 试了 4 种 prompt 模板,最后用了 strict mode', ago:'10 分钟前',
            prompt:'You are a resume editor. STRICT MODE: only rephrase information explicitly provided. Do NOT invent skills, dates, or experiences. If a field is missing, output "[未填写]" instead of guessing.',
            usedBy:[ { user:'wangwu', note:'接走思路做了求职信生成器,效果立竿见影', ago:'昨天' } ] },
          { text:'卡了: GPT 总会编造没填的字段. 试了 temperature=0,没用', ago:'昨天' },
          { text:'跑通了基础版,但优化建议比较套话', ago:'3 天前' },
        ],
        reactions:{ wantToTry:['lisi','daodao'],
          tinkered:[ { user:'wangwu', name:'求职信生成器', link:'#p7' } ] },
        notes:[
          { user:'lisi',   text:'你那个 strict mode prompt 第三句可以加 "do not invent fields"', ago:'2 小时前' },
          { user:'wangwu', text:'我之前做过类似的,卡在了 streaming 输出,后来用 SSE 解决了', ago:'昨天' },
        ] },

      { id:'p3', owner:'zhangsan', name:'给我妈做小红书', slug:'mom-rednote', desc:'给我妈的护肤品店做小红书图文', productLink:'https://v0.dev/r/momred-x7a', status:'stuck', tools:['v0','Claude'],
        updates:[
          { text:'卡了 3 天: 我妈说 AI 写的"太像广告",她想要那种像朋友推荐的口气',
            images:[ { src: svgUri(MOCK_REDNOTE_COMPARE), caption:'AI 草稿 vs 我妈想要的口气' } ],
            ago:'昨天' },
          { text:'试了让 Claude 模仿小红书博主的笔记风格,但读起来还是有点假', ago:'2 天前' },
          { text:'开始: 想做一个能自动生成小红书图文的小工具给我妈用', ago:'5 天前' },
        ],
        reactions:{ wantToTry:[], tinkered:[] },
        notes:[ { user:'maomao', text:'小红书的关键不是文案,是 emoji 密度. 你试试让 AI 每 2-3 句加一个 emoji,然后开头用"姐妹们..."',
          images:[ { src: svgUri(MOCK_NOTE_EMOJI), caption:'我之前帮另一个店做的,加了 emoji 后转化率明显涨' } ],
          ago:'20 分钟前' } ] },

      { id:'p4', owner:'zhangsan', name:'番茄钟', slug:'pomodoro', desc:'最简单的网页番茄钟', productLink:'https://claude.ai/chat/pomodoro-artifact', status:'done', tools:['Claude'],
        updates:[
          { text:'跑通了 · 加了响铃和暂停', ago:'1 周前' },
          { text:'5 分钟用 Claude Artifact 做的,直接复制粘贴跑起来', ago:'1 周前' },
        ],
        reactions:{ wantToTry:[], tinkered:[] },
        notes:[] },

      { id:'p5', owner:'liushi', name:'猫咪表情识别', slug:'cat-mood', desc:'上传猫咪照片,告诉你它现在什么心情', productLink:'https://v0.dev/r/catmood-k9z', status:'stuck', tools:['v0','Claude','TensorFlow.js'],
        updates:[
          { text:'卡住 6 小时: 表情分类总把"生气"识别成"开心". 训练数据集可能有问题. @daodao 你之前提过的"行为识别"思路靠谱吗?',
            images:[ { src: svgUri(MOCK_CAT_ERROR), caption:'angry 测试集 accuracy 只有 0.06 · 几乎全部预测成 happy' } ],
            ago:'2 小时前' },
          { text:'基础识别能跑了,但准确率只有 50%', ago:'昨天' },
          { text:'开始: 想给我家猫做一个表情识别器', ago:'4 天前' },
        ],
        reactions:{ wantToTry:['daodao'], tinkered:[] },
        notes:[ { user:'daodao', text:'猫的表情可能本来就不适合简单分类,试试做"行为识别"(摇尾巴/竖耳朵)会不会准一点?', ago:'1 小时前' } ] },

      { id:'p6', owner:'liushi', name:'UI 灵感图生成器', slug:'ui-inspo', desc:'描述一下场景,生成一组 UI 概念图', productLink:'https://lovable.dev/projects/ui-inspo-92', status:'active', tools:['Lovable','Cursor'],
        updates:[
          { text:'加了"风格"选项: 极简 / 拟物 / 玻璃拟态 / 杂志感', ago:'5 小时前' },
          { text:'能跑了 · 但是生成的图都长得有点像,要想办法增加多样性', ago:'3 天前' },
        ],
        reactions:{ wantToTry:['lisi'], tinkered:[] },
        notes:[] },

      { id:'p7', owner:'wangwu', name:'求职信生成器', slug:'cover-letter', desc:'基于 @zhangsan 简历优化器的思路', productLink:'https://cover-letter-ai.vercel.app', status:'active', tools:['Cursor','Claude'],
        updates:[
          { text:'接走了 @zhangsan 的 strict mode prompt,效果立竿见影', ago:'昨天' },
          { text:'开始: 看到 @zhangsan 的简历优化器,觉得可以延伸做求职信', ago:'2 天前' },
        ],
        reactions:{ wantToTry:[], tinkered:[] },
        notes:[] },

      { id:'p8', owner:'wangwu', name:'专注一起', slug:'focus-together', desc:'可以看到朋友也在专注 · 互相打气', productLink:'https://focus-together.vercel.app', status:'done', tools:['Bolt','Supabase'],
        updates:[
          { text:'跑通了, 已经用了一个月,确实比一个人专注更不容易划水', ago:'2 周前' },
          { text:'上线了, 邀请了 5 个朋友一起用', ago:'3 周前' },
        ],
        reactions:{ wantToTry:[],
          tinkered:[ { user:'lisi', name:'宿舍版番茄钟', link:'#' } ] },
        notes:[] },

      { id:'p9', owner:'lisi', name:'毕设: 校园二手书识别', slug:'book-recog', desc:'拍照识别书名 + 估价 · 毕设', productLink:'https://v0.dev/r/bookrecog-3a', status:'active', tools:['v0','Claude'],
        updates:[
          { text:'能跑了基础识别,但估价模块还不准 · 数据来源用了多抓鱼公开页',
            images:[ { src: svgUri(MOCK_BOOK_RECOG), caption:'识别 OK · 估价跨度 ¥8 – ¥32 太大' } ],
            ago:'昨天' },
          { text:'开始: 老师让我做一个有"实际应用"的毕设', ago:'1 周前' },
        ],
        reactions:{ wantToTry:[], tinkered:[] },
        notes:[] },

      { id:'p10', owner:'lisi', name:'课堂笔记小工具', slug:'class-notes', desc:'录音 + AI 整理 · 生成结构化笔记', productLink:'https://class-notes.replit.app', status:'done', tools:['Replit','Claude'],
        updates:[
          { text:'4 个室友都在用 · 实习课已经被点名"做得好"', ago:'3 天前' },
          { text:'跑通了基础版', ago:'1 周前' },
        ],
        reactions:{ wantToTry:['daodao'], tinkered:[] },
        notes:[] },

      { id:'p11', owner:'maomao', name:'小红书配图工具', slug:'rednote-img', desc:'给文案自动配 3-5 张图 · 风格统一', productLink:'https://lovable.dev/projects/rednote-img', status:'active', tools:['Lovable','Claude','Replicate'],
        updates:[
          { text:'加了 "风格一致性" 的小技巧: 所有图用同一个 seed', ago:'昨天',
            usedBy:[ { user:'liushi', note:'借鉴到我的 UI 灵感图生成器 · 终于不再乱跳风格了', ago:'5 小时前' } ] },
          { text:'能跑了, 但配图风格不统一',
            images:[ { src: svgUri(MOCK_RED_GRID), caption:'同一篇文案 · v1 输出的 4 张配图风格各异' } ],
            ago:'4 天前' },
        ],
        reactions:{ wantToTry:[], tinkered:[] },
        notes:[] },

      { id:'p12', owner:'maomao', name:'公众号一键排版', slug:'wechat-formatter', desc:'粘贴文章自动排版 · 几种模板', productLink:'https://wechat-fmt.vercel.app', status:'done', tools:['Cursor','Claude'],
        updates:[ { text:'跑通了 · 给我朋友的公众号节省了不少时间', ago:'2 周前' } ],
        reactions:{ wantToTry:[], tinkered:[] },
        notes:[] },
    ],
    starters: [
      { title:'用 Claude Artifact 做"今晚不想想"清单',
        prompt:'做一个网页. 我能列出今晚不想想的事 · 一条一条加 · 每加完它变浅色/划掉 · 给我"已经放下了"的感觉. 不要计数 · 不要鼓励语 · 数据存浏览器.',
        toolName:'Claude', toolUrl:'https://claude.ai' },
      { title:'用 v0 做"扔硬币帮我决定"工具',
        prompt:'做一个简单的决定器. 我输入两个选项 (比如 "出门" vs "在家") · 按一个大按钮 · 它用扔硬币的方式选一个并简单说明为什么. 风格俏皮但不卖萌.',
        toolName:'v0', toolUrl:'https://v0.dev' },
      { title:'用 Bolt 做"给明天的自己"留言板',
        prompt:'做一个网页. 我能写一条给明天自己的话 · 数据存浏览器 · 每天打开第一次自动显示昨天给今天的话. 风格安静 · 不要计数 · 不要打卡感.',
        toolName:'Bolt', toolUrl:'https://bolt.new' },
    ],
    notifications: [
      { id:'n10', target:'daodao', type:'projectDone', fromUser:'lisi',
        projectId:'p10', projectName:'课堂笔记小工具',
        extra:'你之前说过想试试 · 现在能用了',
        ago:'5 分钟前', read:false },
      { id:'n1', target:'daodao', type:'tinkered',  fromUser:'liushi',
        projectId:'p1', projectName:'Tinker 主屏', extra:'深色版 Tinker',
        ago:'10 分钟前', read:false },
      { id:'n2', target:'daodao', type:'noted',     fromUser:'wangwu',
        projectId:'p1', projectName:'Tinker 主屏',
        extra:'我觉得卡片高度可以再小一点,信息密度再高一些',
        ago:'1 小时前', read:false },
      { id:'n8', target:'daodao', type:'mentioned', fromUser:'liushi',
        projectId:'p5', projectName:'猫咪表情识别',
        extra:'@daodao 你之前提过的"行为识别"思路靠谱吗?',
        ago:'2 小时前', read:false },
      { id:'n7', target:'daodao', type:'methodUsed', fromUser:'wangwu',
        projectId:'p1', projectName:'Tinker 主屏',
        extra:'借鉴了"主屏卡片来源是项目事件而不是用户发帖"的设计 · 用在我自己的笔记应用 feed 上',
        ago:'3 小时前', read:false },
      { id:'n3', target:'daodao', type:'wantToTry', fromUser:'lisi',
        projectId:'p1', projectName:'Tinker 主屏',
        ago:'昨天', read:false },
    ],
    availableTools: AVAILABLE_TOOLS,
  }));
}

module.exports = { getTestSeedData };

// Tinker server — Express API
// 提供:
//   GET  /api/state    — 获取整个 state
//   POST /api/action   — { type, payload, currentUser } 触发 mutation
//   GET  /            — webapp/index.html
//
// 数据存储: JSON 文件 (data.json) · 启动时若不存在则从 seed 初始化

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const { getSeedData, AVAILABLE_TOOLS } = require('./seed');
const actions = require('./actions');

const PORT = process.env.PORT || 8788;
const DATA_FILE = path.join(__dirname, 'data.json');
const WEBAPP_DIR = path.join(__dirname, '..', 'webapp');

// ============================================
// 数据加载 / 保存
// ============================================
let state;

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      state = JSON.parse(raw);
      console.log('✓ loaded data.json');
      return;
    } catch (e) {
      console.error('✗ data.json 损坏,从 seed 重建:', e.message);
    }
  }
  state = getSeedData();
  saveData();
  console.log('✓ seeded from initial data');
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('✗ save data.json failed:', e.message);
  }
}

loadData();

// ============================================
// Express setup
// ============================================
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // 允许大 payload (含 base64 图片)

// 静态服务 webapp
app.use(express.static(WEBAPP_DIR));

// ============================================
// API
// ============================================
app.get('/api/state', (req, res) => {
  res.json(state);
});

app.get('/api/tools', (req, res) => {
  res.json(AVAILABLE_TOOLS);
});

app.post('/api/action', (req, res) => {
  const { type, payload } = req.body || {};
  if (!type) return res.status(400).json({ error: 'type required' });
  const action = actions[type];
  if (!action) return res.status(400).json({ error: 'Unknown action: ' + type });
  try {
    const result = action(state, payload || {});
    saveData();
    res.json({ ok: true, result, state });
  } catch (e) {
    console.error('action error:', type, e.message);
    res.status(400).json({ error: e.message });
  }
});

// 重置数据 (开发用)
app.post('/api/reset', (req, res) => {
  state = getSeedData();
  saveData();
  console.log('✓ data reset to seed');
  res.json({ ok: true, state });
});

// ============================================
// 启动
// ============================================
app.listen(PORT, () => {
  console.log(`\n  Tinker / 捣鼓 server`);
  console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  api      http://localhost:${PORT}/api/state`);
  console.log(`  webapp   http://localhost:${PORT}/`);
  console.log(`  data     ${DATA_FILE}`);
  console.log(`\n  POST /api/action { type, payload }`);
  console.log(`  POST /api/reset                  (清回 seed)`);
  console.log('');
});

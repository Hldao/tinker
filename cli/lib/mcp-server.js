// Tinker MCP server · stdio transport
// 把 CLI 的能力以 MCP tool 形式暴露给任何 MCP 兼容 agent (Claude Code / Cursor / Windsurf / Continue.dev)
//
// 启动: tinker mcp
// 配置 Claude Code: ~/.claude/mcp.json 加 { "mcpServers": { "tinker": { "command": "tinker", "args": ["mcp"] } } }
//
// 跟 tinker.js 共享逻辑 · 不重写 API / 状态 / git / LLM

const tinker = require('../bin/tinker.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

// 包装一次 · 所有 tool result 用同一种 shape
function toolResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}
function toolErr(msg, code) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: msg, code: code || 'ERROR' }) }],
  };
}

// === tool 定义 + handler 一体表 · 加新工具就来这加一行 ===
const TOOLS = [
  // === 查询类 ===
  {
    name: 'tinker_list_projects',
    description: '列出当前用户的所有项目 (含 id/slug/status/updateCount)。AI 通常用这个找 projectId 后续 push/ship 用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const cfg = tinker.mustHaveConfig();
      const state = await tinker.apiState(cfg);
      const mine = state.projects.filter(p => p.owner === cfg.handle);
      return toolResult({
        ok: true,
        handle: cfg.handle,
        projects: mine.map(p => ({
          id: p.id, slug: p.slug, name: p.name, desc: p.desc, status: p.status,
          productLink: p.productLink || null,
          updateCount: (p.updates || []).length,
          lastUpdateAt: p.updates && p.updates[0] ? p.updates[0].at : null,
          url: cfg.serverUrl + '/#/p/' + cfg.handle + '/' + p.slug,
        })),
      });
    },
  },
  {
    name: 'tinker_get_state',
    description: '读 prompt-state.json 当前快照 (mute / cooldown / dismissedToday / uiSession 等)。AI 用这个判断当前能不能 prompt 用户。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const state = tinker.loadPromptState();
      const now = Date.now();
      return toolResult({
        ok: true,
        now,
        muted: state.mutedUntil && state.mutedUntil > now
          ? { until: state.mutedUntil, remainingMs: state.mutedUntil - now } : null,
        later: state.laterUntil && state.laterUntil > now
          ? { until: state.laterUntil, remainingMs: state.laterUntil - now } : null,
        dismissedToday: state.dismissedTodayKey === tinker.todayKey(),
        lastPromptedAt: state.lastPromptedAt || null,
        cooldownActive: state.lastPromptedAt && (now - state.lastPromptedAt) < 30 * 60 * 1000,
        uiSession: state.uiSession || null,
        lastPushAtByProject: state.lastPushAtByProject || {},
      });
    },
  },
  {
    name: 'tinker_today_summary',
    description: '今日总结:git commit 数 / Tinker push 数 / Claude Code token 用量。给 AI 收尾对话或回答"今天我都做了啥"用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const cfg = tinker.mustHaveConfig();
      // 复用 cmdGoodnight 的 git + tinker + cc 拉取逻辑 (简化版 · 不调 LLM)
      const { execSync } = require('child_process');
      let gitCommits = [];
      let gitStat = null;
      if (tinker.inGitRepo()) {
        try {
          const since = (() => { const d = new Date(); d.setHours(4, 0, 0, 0); return d.toISOString().slice(0, 10) + ' 04:00'; })();
          gitCommits = execSync(`git log --since="${since}" --no-merges --pretty=format:"%h|%s|%ai"`, { encoding: 'utf-8' })
            .trim().split('\n').filter(Boolean).map(l => { const [sha, msg, at] = l.split('|'); return { sha, msg, at }; });
          const stat = execSync(`git log --since="${since}" --no-merges --shortstat --pretty=format:""`, { encoding: 'utf-8' }).trim();
          let files = 0, ins = 0, del = 0;
          stat.split('\n').forEach(line => {
            const m = line.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
            if (m) { files += +m[1] || 0; ins += +m[2] || 0; del += +m[3] || 0; }
          });
          gitStat = { files, ins, del };
        } catch {}
      }
      let todayUpdates = [];
      try {
        const state = await tinker.apiState(cfg);
        const tk = tinker.todayKey();
        for (const p of state.projects) {
          if (p.owner !== cfg.handle) continue;
          for (const u of (p.updates || [])) {
            const d = new Date(u.at);
            const dk = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
            if (dk === tk) todayUpdates.push({ projectName: p.name, text: u.text, at: u.at, kind: u.kind });
          }
        }
      } catch {}
      const ccUsage = tinker.getClaudeCodeUsageToday();
      const projectCounts = {};
      todayUpdates.forEach(u => { projectCounts[u.projectName] = (projectCounts[u.projectName] || 0) + 1; });
      return toolResult({
        ok: true,
        date: new Date().toISOString().slice(0, 10),
        coding: {
          commits: gitCommits.length,
          files: gitStat ? gitStat.files : 0,
          ins: gitStat ? gitStat.ins : 0,
          del: gitStat ? gitStat.del : 0,
          firstCommit: gitCommits.length > 0 ? gitCommits[gitCommits.length - 1].msg : null,
          lastCommit: gitCommits.length > 0 ? gitCommits[0].msg : null,
        },
        claudeCode: ccUsage && ccUsage.messages > 0 ? {
          messages: ccUsage.messages, sessions: ccUsage.sessions, models: ccUsage.models,
          estimatedUsd: +ccUsage.totalUsd.toFixed(2), estimatedRmb: +ccUsage.totalRmb.toFixed(2),
        } : null,
        tinker: { updates: todayUpdates.length, byProject: projectCounts },
      });
    },
  },
  {
    name: 'tinker_check_triggers',
    description: '评估当前 git repo 里的触发器 · 返回是否命中。命中时 AI 可以根据 result.kind 决定调 tinker_push/ship/stuck/resolve_pending。AI 主动想发的话不需要先 check。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      if (!tinker.inGitRepo()) return toolErr('不在 git 仓库', 'NOT_IN_GIT');
      const state = tinker.loadPromptState();
      const repoCfg = tinker.loadRepoConfig();
      if (!repoCfg) return toolErr('这个 repo 还没绑定 Tinker 项目 · 先 tinker hook install', 'NO_REPO_CONFIG');
      let cfgForUi;
      try { cfgForUi = tinker.mustHaveConfig(); } catch { cfgForUi = null; }
      const result = tinker.evaluateAllTriggers(state, repoCfg, cfgForUi);
      tinker.savePromptState(state);
      if (!result) return toolResult({ ok: true, fired: false });
      return toolResult({
        ok: true,
        fired: true,
        kind: result.kind,
        priority: result.priority,
        msg: stripAnsi(result.msg),
        suggestion: result.suggestion || '',
        project: { id: repoCfg.projectId, name: repoCfg.projectName },
      });
    },
  },

  // === 动作类 ===
  {
    name: 'tinker_push',
    description: '发一笔普通进展到指定项目。message 必填 · project_id 可选 (不填用 repo 绑定的项目)。',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '进展正文 (200-280 字 Tinker voice · 工艺人日志气质)' },
        project_id: { type: 'string', description: '项目 id (p-xxx)。不填时用当前 cwd 绑定的 .tinker/repo.json' },
      },
      required: ['message'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const cfg = tinker.mustHaveConfig();
      const projectId = args.project_id || (tinker.loadRepoConfig() || {}).projectId;
      if (!projectId) return toolErr('需要 project_id (没传 + 当前 repo 没绑定)', 'NO_PROJECT');
      try {
        const result = await tinker.apiAction(cfg, 'addUpdate', { projectId, text: args.message });
        tinker.recordPushAt(projectId);
        return toolResult({
          ok: true,
          updateId: result && (result.result?.id || result.id),
          url: cfg.serverUrl + '/#/p/' + cfg.handle + '/',
        });
      } catch (e) { return toolErr(e.message, 'API_ERROR'); }
    },
  },
  {
    name: 'tinker_ship',
    description: '完工仪式 · 进陈列馆 · 通知 wantToTry 的人。AI 检测到作者说"跑通了 / 完工 / launched" 等明确完工信号时调。',
    inputSchema: {
      type: 'object',
      properties: {
        reflection: { type: 'string', description: '完工感想 200-400 字 Tinker voice' },
        project_id: { type: 'string', description: '项目 id · 不填用 repo 绑定的' },
      },
      required: ['reflection'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const cfg = tinker.mustHaveConfig();
      const projectId = args.project_id || (tinker.loadRepoConfig() || {}).projectId;
      if (!projectId) return toolErr('需要 project_id', 'NO_PROJECT');
      try {
        await tinker.apiAction(cfg, 'exhibitProject', {
          projectId, kind: 'ship', statement: args.reflection, seekingFeedback: true,
        });
        tinker.recordPushAt(projectId);
        return toolResult({ ok: true, kind: 'ship', projectId });
      } catch (e) { return toolErr(e.message, 'API_ERROR'); }
    },
  },
  {
    name: 'tinker_prototype',
    description: '原型仪式 · 进陈列馆作为原型 (还在打磨 · 但能玩了)。',
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: '原型说明 200-400 字' },
        project_id: { type: 'string', description: '项目 id · 不填用 repo 绑定' },
      },
      required: ['statement'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const cfg = tinker.mustHaveConfig();
      const projectId = args.project_id || (tinker.loadRepoConfig() || {}).projectId;
      if (!projectId) return toolErr('需要 project_id', 'NO_PROJECT');
      try {
        await tinker.apiAction(cfg, 'exhibitProject', {
          projectId, kind: 'prototype', statement: args.statement, seekingFeedback: true,
        });
        tinker.recordPushAt(projectId);
        return toolResult({ ok: true, kind: 'prototype', projectId });
      } catch (e) { return toolErr(e.message, 'API_ERROR'); }
    },
  },
  {
    name: 'tinker_stuck',
    description: '标项目为卡住 + 写"卡在哪" + 通知关心的人。AI 检测到作者明显卡住时调。',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '卡在哪 · 简短描述' },
        project_id: { type: 'string', description: '项目 id · 不填用 repo 绑定' },
      },
      required: ['message'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const cfg = tinker.mustHaveConfig();
      const projectId = args.project_id || (tinker.loadRepoConfig() || {}).projectId;
      if (!projectId) return toolErr('需要 project_id', 'NO_PROJECT');
      try {
        await tinker.apiAction(cfg, 'changeProjectStatus', { projectId, newStatus: 'stuck' });
        await tinker.apiAction(cfg, 'addUpdate', { projectId, text: args.message });
        tinker.recordPushAt(projectId);
        return toolResult({ ok: true, marked: 'stuck', projectId });
      } catch (e) { return toolErr(e.message, 'API_ERROR'); }
    },
  },

  // === 控制类 ===
  {
    name: 'tinker_mute',
    description: '静音 / 解除触发器。AI 在作者说"别打扰我 / 让我集中" 时调。duration 支持 30m / 1h / today / forever / off。',
    inputSchema: {
      type: 'object',
      properties: {
        duration: { type: 'string', description: '30m / 1h / 2d / today / forever / off' },
      },
      required: ['duration'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const state = tinker.loadPromptState();
      const now = Date.now();
      const arg = (args.duration || '').trim();
      if (arg === 'off' || arg === 'unmute') {
        state.mutedUntil = null; state.laterUntil = null; state.dismissedTodayKey = null;
        tinker.savePromptState(state);
        return toolResult({ ok: true, action: 'unmuted' });
      }
      let duration = 60 * 60 * 1000;
      const m = arg.match(/^(\d+)(m|h|d)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        duration = m[2] === 'm' ? n * 60 * 1000 : m[2] === 'h' ? n * 60 * 60 * 1000 : n * 24 * 60 * 60 * 1000;
      } else if (arg === 'today') {
        const d = new Date(); d.setHours(28, 0, 0, 0);
        duration = d.getTime() - now;
      } else if (arg === 'forever') {
        state.mutedUntil = Number.MAX_SAFE_INTEGER;
        tinker.savePromptState(state);
        return toolResult({ ok: true, action: 'muted', until: 'forever' });
      }
      state.mutedUntil = now + duration;
      tinker.savePromptState(state);
      return toolResult({ ok: true, action: 'muted', until: state.mutedUntil });
    },
  },
  {
    name: 'tinker_resolve_pending',
    description: '响应 hook 触发的 pending (从 ~/.tinker/pending.json 读)。choice 必填 · 文本动作还需要 message。',
    inputSchema: {
      type: 'object',
      properties: {
        choice: { type: 'string', description: '动作 id: push / ship / prototype / stuck / later / skip-today / mute / mute-30m 等' },
        message: { type: 'string', description: '文本动作必填: push / ship / stuck 等' },
      },
      required: ['choice'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const pending = tinker.loadPending();
      if (!pending) return toolErr('没有 pending · 先调 tinker_check_triggers', 'NO_PENDING');
      const choice = args.choice;
      const text = (args.message || '').trim();
      const state = tinker.loadPromptState();
      const now = Date.now();
      state.lastPromptedAt = now;
      const cfg = tinker.mustHaveConfig();
      try {
        const projectId = pending.projectId;
        if (choice.startsWith('push')) {
          if (!text) return toolErr('文本动作需要 message', 'NEED_MESSAGE');
          await tinker.apiAction(cfg, 'addUpdate', { projectId, text });
          tinker.recordPushAt(projectId);
          tinker.savePoolSample(pending, choice, text, cfg.handle);
        } else if (choice === 'ship' || choice === 'prototype') {
          if (!text) return toolErr('文本动作需要 message', 'NEED_MESSAGE');
          await tinker.apiAction(cfg, 'exhibitProject', { projectId, kind: choice, statement: text, seekingFeedback: true });
          tinker.recordPushAt(projectId);
          tinker.savePoolSample(pending, choice, text, cfg.handle);
        } else if (choice === 'stuck' || choice === 'stuck-quiet') {
          if (!text) return toolErr('文本动作需要 message', 'NEED_MESSAGE');
          await tinker.apiAction(cfg, 'changeProjectStatus', { projectId, newStatus: 'stuck' });
          await tinker.apiAction(cfg, 'addUpdate', { projectId, text });
          tinker.recordPushAt(projectId);
          tinker.savePoolSample(pending, choice, text, cfg.handle);
        } else if (choice === 'later') {
          state.laterUntil = now + 60 * 60 * 1000;
        } else if (choice === 'skip-today') {
          state.dismissedTodayKey = tinker.todayKey();
        } else if (choice === 'mute' || choice === 'mute-24h') {
          state.mutedUntil = now + 24 * 60 * 60 * 1000;
        } else if (choice === 'mute-30m') {
          state.mutedUntil = now + 30 * 60 * 1000;
        } else if (choice === 'skip-once') {
          // no-op · 但仍清 pending
        } else {
          return toolErr('未知 choice: ' + choice, 'UNKNOWN_CHOICE');
        }
        tinker.savePromptState(state);
        tinker.clearPending();
        return toolResult({ ok: true, choice, projectId });
      } catch (e) { return toolErr(e.message, 'API_ERROR'); }
    },
  },

  // === 设置类 (read-only) ===
  {
    name: 'tinker_get_config',
    description: '查 server / handle / LLM 配置 (token 只露后 4 位)。AI 用这个确认自己环境对没对。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const cfg = tinker.loadConfig();
      if (!cfg) return toolErr('还没配置 · 先 tinker login 或者设 TINKER_TOKEN env', 'NO_CONFIG');
      return toolResult({
        ok: true,
        serverUrl: cfg.serverUrl,
        handle: cfg.handle || null,
        tokenSet: !!cfg.token,
        tokenSuffix: cfg.token ? cfg.token.slice(-4) : null,
        llm: cfg.llm ? { provider: cfg.llm.provider, configured: true } : { configured: false },
      });
    },
  },
];

function stripAnsi(s) { return (s || '').toString().replace(/\x1b\[[0-9;]*m/g, ''); }

async function startMcpServer() {
  const server = new Server(
    { name: 'tinker', version: '0.10' },
    { capabilities: { tools: {} } }
  );
  // list_tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));
  // call_tool handler
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find(t => t.name === req.params.name);
    if (!tool) return toolErr('未知 tool: ' + req.params.name, 'UNKNOWN_TOOL');
    try {
      return await tool.handler(req.params.arguments || {});
    } catch (e) {
      return toolErr(e.message || String(e), 'HANDLER_ERROR');
    }
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

module.exports = { startMcpServer };

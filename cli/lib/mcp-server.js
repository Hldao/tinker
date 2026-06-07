// Tinker MCP server · stdio transport
// 把 CLI 的能力以 MCP tool 形式暴露给任何 MCP 兼容 agent (Claude Code / Cursor / Windsurf / Continue.dev)
//
// 启动: tinker mcp
// 配置 Claude Code: ~/.claude/mcp.json 加 { "mcpServers": { "tinker": { "command": "tinker", "args": ["mcp"] } } }
//
// 跟 tinker.js 共享逻辑 · 不重写 API / 状态 / git / LLM

const tinker = require('../bin/tinker.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
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
    description: '发一笔普通进展到指定项目。message 必填 · project_id 可选 (不填用 repo 绑定的项目)。idempotency_key 强烈推荐:AI 重试时同 key 24h 内不重复 push。',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '进展正文 (200-280 字 Tinker voice · 工艺人日志气质)' },
        project_id: { type: 'string', description: '项目 id (p-xxx)。不填时用当前 cwd 绑定的 .tinker/repo.json' },
        idempotency_key: { type: 'string', description: '幂等键 · 同 key 24h 内重复调直接返之前的结果' },
      },
      required: ['message'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const cfg = tinker.mustHaveConfig();
      const projectId = args.project_id || (tinker.loadRepoConfig() || {}).projectId;
      if (!projectId) return toolErr('需要 project_id (没传 + 当前 repo 没绑定)', 'NO_PROJECT');
      try {
        const result = await tinker.withIdempotency(args.idempotency_key, async () => {
          const r = await tinker.apiAction(cfg, 'addUpdate', { projectId, text: args.message });
          tinker.recordPushAt(projectId);
          return r;
        });
        return toolResult({
          ok: true,
          updateId: result && (result.result?.id || result.id),
          url: cfg.serverUrl + '/#/p/' + cfg.handle + '/',
          idempotent: !!(result && result.cacheHit),
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
        idempotency_key: { type: 'string', description: '幂等键 · 防重复 ship' },
      },
      required: ['reflection'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const cfg = tinker.mustHaveConfig();
      const projectId = args.project_id || (tinker.loadRepoConfig() || {}).projectId;
      if (!projectId) return toolErr('需要 project_id', 'NO_PROJECT');
      try {
        const result = await tinker.withIdempotency(args.idempotency_key, async () => {
          await tinker.apiAction(cfg, 'exhibitProject', {
            projectId, kind: 'ship', statement: args.reflection, seekingFeedback: true,
          });
          tinker.recordPushAt(projectId);
          return { kind: 'ship', projectId };
        });
        return toolResult({ ok: true, kind: 'ship', projectId, idempotent: !!(result && result.cacheHit) });
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
        idempotency_key: { type: 'string', description: '幂等键' },
      },
      required: ['statement'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const cfg = tinker.mustHaveConfig();
      const projectId = args.project_id || (tinker.loadRepoConfig() || {}).projectId;
      if (!projectId) return toolErr('需要 project_id', 'NO_PROJECT');
      try {
        const result = await tinker.withIdempotency(args.idempotency_key, async () => {
          await tinker.apiAction(cfg, 'exhibitProject', {
            projectId, kind: 'prototype', statement: args.statement, seekingFeedback: true,
          });
          tinker.recordPushAt(projectId);
          return { kind: 'prototype', projectId };
        });
        return toolResult({ ok: true, kind: 'prototype', projectId, idempotent: !!(result && result.cacheHit) });
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
        idempotency_key: { type: 'string', description: '幂等键' },
      },
      required: ['message'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const cfg = tinker.mustHaveConfig();
      const projectId = args.project_id || (tinker.loadRepoConfig() || {}).projectId;
      if (!projectId) return toolErr('需要 project_id', 'NO_PROJECT');
      try {
        const result = await tinker.withIdempotency(args.idempotency_key, async () => {
          await tinker.apiAction(cfg, 'changeProjectStatus', { projectId, newStatus: 'stuck' });
          await tinker.apiAction(cfg, 'addUpdate', { projectId, text: args.message });
          tinker.recordPushAt(projectId);
          return { marked: 'stuck', projectId };
        });
        return toolResult({ ok: true, marked: 'stuck', projectId, idempotent: !!(result && result.cacheHit) });
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
  {
    name: 'tinker_borrow',
    description: '搜 Tinker 用户的方法 + 踩坑经验 + 上手指南。任何 vibe coding 任务卡住或入门新技术时主动调:遇到错误码搜踩坑 (阿里云邮件 / Supabase 认证 / Vercel 部署) · 新东西入门搜上手指南 (supabase realtime / cloudflare workers / pinecone vector db / vision API) · 找现成方法搜方法 (魔法链接登录 / 图片压缩流程) 都是高价值场景。query 用关键词 (中英混杂都行)。是 vibe coder 互相省时间的核心 tool。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词 · 例: "阿里云 邮件" / "supabase realtime" / "vercel cron 限制"' },
        limit: { type: 'integer', description: '返回条数 · 默认 10', minimum: 1, maximum: 50 },
        kind: { type: 'string', enum: ['method', 'experience', 'learning'], description: '过滤: method 只搜方法 · experience 只搜踩坑经验 · learning 只搜上手指南 · 不传搜全部' },
        methodsOnly: { type: 'boolean', description: '(老参数 · 推荐用 kind=method) 只看方法 · 默认 false' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const cfg = tinker.loadConfig();
      if (!cfg || !cfg.serverUrl) return toolErr('未配置 serverUrl', 'NO_CONFIG');
      const q = (args.query || '').trim();
      if (!q) return toolErr('query 必填', 'NO_QUERY');
      const url = new URL('/api/method/search', cfg.serverUrl);
      url.searchParams.set('q', q);
      url.searchParams.set('limit', String(args.limit || 10));
      if (args.kind && ['method', 'experience', 'learning'].includes(args.kind)) url.searchParams.set('kind', args.kind);
      if (args.methodsOnly) url.searchParams.set('methodsOnly', '1');
      if (cfg.handle) url.searchParams.set('borrower', cfg.handle); // 反馈闭环
      const res = await fetch(url.toString());
      if (!res.ok) return toolErr('搜失败 · HTTP ' + res.status, 'HTTP_' + res.status);
      const data = await res.json();
      return toolResult({ ok: true, query: q, hits: data.hits || [] });
    },
  },
  {
    name: 'tinker_contribute',
    description: '把自己一条 update 标为方法 · 让别人 borrow 能看到 · updateId 不传时用最近一条 push。',
    inputSchema: {
      type: 'object',
      properties: {
        updateId: { type: 'string', description: 'update id · 例 u-xxx · 留空则用最近一条' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const cfg = tinker.mustHaveConfig();
      let updateId = args.updateId;
      if (!updateId) {
        const state = await tinker.apiState(cfg);
        let latest = null;
        for (const p of state.projects || []) {
          for (const u of p.updates || []) {
            if (!latest || u.at > latest.at) latest = u;
          }
        }
        if (!latest) return toolErr('还没记过进展 · 没东西可标', 'NO_UPDATES');
        updateId = latest.id;
      }
      await tinker.apiAction(cfg, 'markAsMethod', { updateId });
      return toolResult({ ok: true, updateId, marked: true });
    },
  },
  // v0.12: 读自己最近 update · AI 起草前 / 用户问"我上次怎么搞的" 时可调
  {
    name: 'tinker_recent_updates',
    description: '拉作者最近 N 条自己的 update · 给 AI 起草前避免重复 / 用户回忆"上次怎么解决的" 用。可按 kind 过滤 (experience / method / ship / stuck / prototype)。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '条数 · 默认 5 · max 50', minimum: 1, maximum: 50 },
        kind: { type: 'string', description: 'all (默认) / experience / method / ship / stuck / prototype' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const cfg = tinker.mustHaveConfig();
      const url = new URL('/api/me/updates', cfg.serverUrl);
      url.searchParams.set('limit', String(args.limit || 5));
      url.searchParams.set('kind', args.kind || 'all');
      const res = await fetch(url.toString(), {
        headers: { 'Authorization': 'Bearer ' + cfg.token },
      });
      if (!res.ok) {
        const body = await res.text();
        return toolErr('拉失败 · HTTP ' + res.status + ' · ' + body.slice(0, 200), 'HTTP_' + res.status);
      }
      const data = await res.json();
      const list = (data.updates || []).map(u => ({
        ...u,
        url: cfg.serverUrl + '/#/p/' + u.ownerHandle + '/' + u.projectSlug,
      }));
      return toolResult({ ok: true, updates: list });
    },
  },
  // v0.12: 标某条 update 为踩坑经验 · 给 AI 检索池埋种子
  {
    name: 'tinker_mark_experience',
    description: '把自己一条 update 标为踩坑经验 · 让 AI 检索 Tinker 时优先取这类 (帮其他人少走弯路)。updateId 不传则取最近一条。',
    inputSchema: {
      type: 'object',
      properties: {
        updateId: { type: 'string', description: 'update id · 例 u-xxx · 留空则用最近一条' },
        unmark: { type: 'boolean', description: '取消标记 (默认 false)' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const cfg = tinker.mustHaveConfig();
      if (args.unmark) {
        if (!args.updateId) return toolErr('unmark 需要 updateId', 'NO_ID');
        await tinker.apiAction(cfg, 'unmarkExperience', { updateId: args.updateId });
        return toolResult({ ok: true, updateId: args.updateId, marked: false });
      }
      let updateId = args.updateId;
      if (!updateId) {
        const state = await tinker.apiState(cfg);
        let latest = null;
        for (const p of state.projects || []) {
          for (const u of p.updates || []) {
            if (!latest || u.at > latest.at) latest = u;
          }
        }
        if (!latest) return toolErr('还没记过进展 · 没东西可标', 'NO_UPDATES');
        updateId = latest.id;
      }
      await tinker.apiAction(cfg, 'markAsExperience', { updateId });
      return toolResult({ ok: true, updateId, marked: true });
    },
  },
  // v0.13: 标某条 update 为上手指南 · Learning Sprint 第二个 lifecycle 产物
  {
    name: 'tinker_mark_learning',
    description: '把自己一条 update 标为上手指南 · 让 AI 检索 Tinker 时优先取这类 (帮其他人快速入门新技术 / SDK / API)。updateId 不传则取最近一条。',
    inputSchema: {
      type: 'object',
      properties: {
        updateId: { type: 'string', description: 'update id · 例 u-xxx · 留空则用最近一条' },
        unmark: { type: 'boolean', description: '取消标记 (默认 false)' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const cfg = tinker.mustHaveConfig();
      if (args.unmark) {
        if (!args.updateId) return toolErr('unmark 需要 updateId', 'NO_ID');
        await tinker.apiAction(cfg, 'unmarkLearning', { updateId: args.updateId });
        return toolResult({ ok: true, updateId: args.updateId, marked: false });
      }
      let updateId = args.updateId;
      if (!updateId) {
        const state = await tinker.apiState(cfg);
        let latest = null;
        for (const p of state.projects || []) {
          for (const u of p.updates || []) {
            if (!latest || u.at > latest.at) latest = u;
          }
        }
        if (!latest) return toolErr('还没记过进展 · 没东西可标', 'NO_UPDATES');
        updateId = latest.id;
      }
      await tinker.apiAction(cfg, 'markAsLearning', { updateId });
      return toolResult({ ok: true, updateId, marked: true });
    },
  },
];

function stripAnsi(s) { return (s || '').toString().replace(/\x1b\[[0-9;]*m/g, ''); }

// === resources · 让 MCP client 订阅 prompt-state 的变化 ===
//
// 资源 URI 表 (subscribe 通过这些 URI 标识):
//   tinker://triggers/active   prompt-state.json 当前触发状态 · 高频变化
//   tinker://state/today       今日 commit/push 摘要 · 低频
//
// 推送策略: 文件监听 + 30s 轮询兜底
// AI agent 订阅后 · 文件变化或轮询差异时收 ResourceUpdatedNotification
const RESOURCES = [
  {
    uri: 'tinker://triggers/active',
    name: 'Tinker 当前触发',
    description: '正在等用户响应的 prompt · push 触发器的当前状态。AI 订阅这个就能在触发器变化时被叫醒。',
    mimeType: 'application/json',
    read: () => {
      const state = tinker.loadPromptState();
      const now = Date.now();
      return {
        now,
        muted: !!(state.mutedUntil && state.mutedUntil > now),
        mutedUntil: state.mutedUntil || null,
        dismissedToday: state.dismissedTodayKey === tinker.todayKey(),
        lastPromptedAt: state.lastPromptedAt || null,
        uiSession: state.uiSession || null,
        lastPushAtByProject: state.lastPushAtByProject || {},
      };
    },
  },
  {
    uri: 'tinker://state/today',
    name: 'Tinker 今日摘要',
    description: '今日 git commit + Tinker push 计数 · ~30s 刷一次。订阅后可以让 AI 在用户大量编码时跟进 push 提醒。',
    mimeType: 'application/json',
    read: async () => {
      const cfg = tinker.loadConfig();
      const git = tinker.gitCommitsTodayQuick ? tinker.gitCommitsTodayQuick() : { count: 0 };
      let tinkerPushed = 0;
      if (cfg && cfg.serverUrl && cfg.token) {
        try {
          const state = await tinker.apiState(cfg);
          const todayStart = new Date(); todayStart.setHours(0,0,0,0);
          for (const p of state.projects || []) {
            for (const u of p.updates || []) {
              if (u.at >= todayStart.getTime()) tinkerPushed++;
            }
          }
        } catch {}
      }
      return { gitCommits: git.count || 0, tinkerPushed, at: Date.now() };
    },
  },
];

async function startMcpServer() {
  const server = new Server(
    { name: 'tinker', version: '0.12' },
    { capabilities: { tools: {}, resources: { subscribe: true, listChanged: false } } }
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

  // list_resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCES.map(r => ({
      uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType,
    })),
  }));

  // read_resource
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const r = RESOURCES.find(x => x.uri === req.params.uri);
    if (!r) throw new Error('未知资源: ' + req.params.uri);
    const data = await r.read();
    return {
      contents: [{
        uri: r.uri, mimeType: r.mimeType,
        text: JSON.stringify(data, null, 2),
      }],
    };
  });

  // 订阅管理 · subscribedUris 是当前订阅 URI 的集合
  // lastSnapshots 记录上次推过的内容 · diff 后才发新通知
  const subscribed = new Set();
  const lastSnapshots = new Map();

  server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    subscribed.add(req.params.uri);
    return {};
  });
  server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscribed.delete(req.params.uri);
    return {};
  });

  // 推送循环 · 每 5s 检查订阅资源 · 内容变了就 notify
  // 文件监听针对 prompt-state.json (高频) · 轮询负责 today 摘要
  const PROMPT_STATE_FILE = path.join(os.homedir(), '.tinker', 'prompt-state.json');
  async function checkAndNotify() {
    for (const uri of subscribed) {
      const r = RESOURCES.find(x => x.uri === uri);
      if (!r) continue;
      try {
        const data = await r.read();
        const key = JSON.stringify(data);
        if (lastSnapshots.get(uri) !== key) {
          lastSnapshots.set(uri, key);
          // 推送 ResourceUpdatedNotification
          await server.notification({
            method: 'notifications/resources/updated',
            params: { uri },
          });
        }
      } catch {}
    }
  }
  const interval = setInterval(checkAndNotify, 5000);
  interval.unref();

  // 文件 watcher · prompt-state.json 变化时立刻检查 (不等 5s 轮询)
  try {
    if (fs.existsSync(PROMPT_STATE_FILE)) {
      fs.watchFile(PROMPT_STATE_FILE, { interval: 1000 }, () => checkAndNotify());
    }
  } catch {}

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

module.exports = { startMcpServer };

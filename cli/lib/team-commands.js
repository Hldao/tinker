// Tinker 团队命令模块 (v0.14 · 从 bin/tinker.js 拆出 · 个人/团队代码分层)
// 工作室 / 接力 handoff / witness / team-knowledge / 团队 auto-ping · 端到端加密频道
// 依赖注入:主文件把共享 helper 通过 deps 传进来 · 这里不重复定义 · 同名回填让调用点零改动
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

module.exports = function createTeamCommands(deps) {
  const {
    CONFIG_DIR, log, bold, vermilion, sepia, err, ok, outputJson, loadConfig, mustHaveConfig, safeFetchJson, apiState, apiAction, recordLLMUsage, loadRepoConfig, loadAutoPingConfig, saveAutoPingConfig, gateVoiceCheck, promptKit, ensureNotifyDaemon, help,
  } = deps;

async function cmdBridgeAutoPing(opts) {
  const apCfg = loadAutoPingConfig();
  if (opts.disable) {
    apCfg.enabled = false;
    saveAutoPingConfig(apCfg);
    ok('bridge auto-ping 已停用 · post-commit hook 命中触发器不再 ping');
    return;
  }
  if (opts.enable) {
    apCfg.enabled = true;
    if (opts.kinds && opts.kinds.length > 0) apCfg.kinds = opts.kinds;
    if (opts.toHandle !== undefined) {
      const newHandle = opts.toHandle || null;
      if (newHandle) {
        try {
          const cfg = mustHaveConfig();
          const state = await apiState(cfg);
          const allHandles = Object.keys(state.users || {});
          if (!allHandles.includes(newHandle)) {
            err('找不到 @' + newHandle + ' · 没保存');
            if (allHandles.length > 0) {
              const list = allHandles.slice(0, 20).map(h => '@' + h).join(sepia(' · '));
              log(sepia('  现有 handles: ') + list);
            }
            return;
          }
        } catch (e) {
          log(sepia('  ⚠ handle 校验跳过 (' + (e.message || 'unknown') + ') · 保存原值'));
        }
      }
      apCfg.toHandle = newHandle;
    }
    saveAutoPingConfig(apCfg);
    const bridgeLib = require('../lib/bridge');
    const hasSecret = bridgeLib.hasSecret();
    log('');
    ok('bridge auto-ping 已启用');
    log(sepia('  触发 kinds: ') + vermilion(apCfg.kinds.join(' / ')));
    log(sepia('  目标:       ') + vermilion(apCfg.toHandle ? '@' + apCfg.toHandle : '广播 (团队所有人)'));
    if (!hasSecret) {
      log('');
      log(vermilion('  ⚠ 还没设暗号 · 跑 ') + vermilion('tinker secret <暗号>') + sepia(' 后 auto-ping 才会真发出去'));
    }
    log('');
    return;
  }
  // --status / 默认
  log('');
  log(bold('  bridge auto-ping 状态'));
  log(sepia('  启用:    ') + (apCfg.enabled ? vermilion('是') : sepia('否')));
  log(sepia('  kinds:   ') + vermilion(apCfg.kinds.join(' / ')));
  log(sepia('  目标:    ') + vermilion(apCfg.toHandle ? '@' + apCfg.toHandle : '广播 / 未设'));
  log('');
  if (!apCfg.enabled) {
    log(sepia('  启用: ') + vermilion('tinker bridge auto-ping --enable [--kinds ship,stuck] [--to @maomao]'));
  } else {
    log(sepia('  停用: ') + vermilion('tinker bridge auto-ping --disable'));
  }
  log('');
}

// ============================================
// studios · 工作室 (v0.20)
//
// 概念:
//   一个 user 可以挂靠到 studio · 工作室聚合所有成员的 projects/updates
//   secretHash = sha256(暗号) 给 server 验成员关系 · 真暗号本地存 · 也是桥的 e2e key
//
// 邀请第一版用 copy-paste cmd · 不搞复杂的桥邀请协议:
//   owner 跑 create → 输出 `tinker studio join <slug> <secret>` 一行
//   把这行发给队友 (微信/桥/面对面) · 队友跑一下就加入
// ============================================
function sha256Hex(s) { return require('crypto').createHash('sha256').update(s).digest('hex'); }

async function cmdStudio(subcmd, args, opts) {
  const cfg = mustHaveConfig(opts);
  const bridgeLib = require('../lib/bridge');

  if (!subcmd || subcmd === 'help') {
    log('');
    log(bold('  tinker studio · 工作室 (你 + 队友 = 一个工作室)'));
    log('');
    log('  ' + vermilion('tinker studio create <slug> --name "..." [--tagline "..."]'));
    log(sepia('     建工作室 · 自动当 owner'));
    log('  ' + vermilion('tinker studio invite <slug> @<handle>'));
    log(sepia('     给队友生成一次性邀请 token · 24h 有效 · server 看不到 token 跟暗号'));
    log('  ' + vermilion('tinker studio accept <token>'));
    log(sepia('     兑换邀请 · 自动写本地暗号'));
    log('  ' + vermilion('tinker studio join <slug> <secret>'));
    log(sepia('     直接用 slug+secret 加入 (没收到 invite 时的 fallback)'));
    log('  ' + vermilion('tinker studio list'));
    log(sepia('     看我所属的工作室'));
    log('  ' + vermilion('tinker studio info <slug>'));
    log(sepia('     看某工作室聚合页 (成员 + 项目)'));
    log('  ' + vermilion('tinker studio leave <slug>'));
    log(sepia('     退出'));
    log('  ' + vermilion('tinker studio link <slug> <secret>'));
    log(sepia('     本地认领已在 server 端加入的工作室 (webapp 建但 CLI 没 sync 时用)'));
    log('  ' + vermilion('tinker studio sync'));
    log(sepia('     诊断 · server 跟本地工作室对比 · 显示缺暗号 / 孤儿 / legacy 提示'));
    log(sepia('     退出'));
    log('');
    return;
  }

  switch (subcmd) {
    case 'create': {
      const slug = args[2];
      if (!slug) { err('slug 必填 · 比如 `tinker studio create daogu-studio --name "捣鼓工作室"`'); process.exit(1); }
      const name = opts.name || slug;
      const tagline = opts.tagline || null;
      const secret = require('crypto').randomBytes(16).toString('hex');
      const secretHash = sha256Hex(secret);

      const res = await safeFetchJson(cfg, '/api/studios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
        body: JSON.stringify({ slug, name, tagline, secretHash }),
      });
      if (!res.ok) { err(res.error || '建工作室失败'); process.exit(1); }

      // 本地存暗号 + 自动 active · 后续 bridge / studio 通信用这个
      bridgeLib.addStudio({ slug, name, secret, id: res.studio.id });
      bridgeLib.setActiveStudio(slug);

      log('');
      ok(`工作室建好了 — ${bold(name)}`);
      log(sepia('  slug:    ') + vermilion(slug));
      if (tagline) log(sepia('  一句话:  ') + tagline);
      log(sepia('  本地暗号已存:  ') + vermilion(bridgeLib.STUDIOS_FILE));
      log('');
      log(bold('  邀请队友 · 把下面这行发给 ta (微信/桥/面对面都行):'));
      log('');
      log('  ' + vermilion(`tinker studio join ${slug} ${secret}`));
      log('');
      log(sepia('  暗号只在这条命令里 · server 只存 hash · 别截图发公开渠道'));
      log('');
      return;
    }

    case 'join': {
      const slug = args[2];
      const secret = args[3];
      if (!slug || !secret) { err('用法: tinker studio join <slug> <secret>'); process.exit(1); }

      const secretHash = sha256Hex(secret);
      const res = await safeFetchJson(cfg, '/api/studios/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
        body: JSON.stringify({ slug, secretHash }),
      });
      if (!res.ok) { err(res.error || '加入失败'); process.exit(1); }

      bridgeLib.addStudio({ slug, name: res.name, secret, id: res.id });
      bridgeLib.setActiveStudio(slug);

      log('');
      if (res.alreadyMember) {
        ok(`你已经在 ${bold(res.name)} 里了 · 本地暗号已刷新`);
      } else {
        ok(`加入了 — ${bold(res.name)}`);
      }
      log(sepia('  本地暗号已存:  ') + vermilion(bridgeLib.STUDIOS_FILE));
      log(sepia('  现在桥消息能跟工作室所有成员通了'));
      log('');
      return;
    }

    case 'list': {
      const res = await safeFetchJson(cfg, '/api/me/studios', {
        headers: { Authorization: 'Bearer ' + cfg.token },
      });
      if (!res.ok) { err(res.error || '拉取失败'); process.exit(1); }
      if (opts.json) { outputJson(res); return; }
      log('');
      if (!res.studios || res.studios.length === 0) {
        log(sepia('  你还没加入任何工作室'));
        log(sepia('  建一个: ') + vermilion('tinker studio create <slug> --name "..."'));
        log('');
        return;
      }
      log(bold('  我的工作室:'));
      for (const s of res.studios) {
        log('  · ' + bold(s.name) + sepia('  /s/' + s.slug) + sepia('  [' + s.role + ']'));
        if (s.tagline) log(sepia('      ') + s.tagline);
      }
      log('');
      return;
    }

    // v0.30 link · 本地认领已经在 server 端加入的工作室 (修 webapp 建但 CLI 没 sync 的 bug)
    case 'link': {
      const slug = args[2];
      const secret = args[3];
      if (!slug || !secret) {
        err('用法: tinker studio link <slug> <secret> · 本地认领已经在 server 端加入的工作室');
        process.exit(1);
      }
      const secretHash = sha256Hex(secret);
      const res = await safeFetchJson(cfg, '/api/studios/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
        body: JSON.stringify({ slug, secretHash }),
      });
      if (!res.ok) { err(res.error || '认领失败 · 暗号可能不对'); process.exit(1); }
      bridgeLib.addStudio({ slug, name: res.name, secret, id: res.id });
      bridgeLib.setActiveStudio(slug);
      log('');
      ok('link 完成 · active 切到 ' + bold(slug));
      if (res.alreadyMember) {
        log(sepia('  你之前已经是 ') + bold(res.name) + sepia(' 成员 · 这次只是补本地暗号'));
      } else {
        log(sepia('  注册成员 + 写本地暗号 · ') + bold(res.name));
      }
      log('');
      return;
    }

    // v0.30 sync · 拉 server me/studios 跟本地比对 · 找缺暗号 / 孤儿 / legacy
    case 'sync': {
      const res = await safeFetchJson(cfg, '/api/me/studios', {
        headers: { Authorization: 'Bearer ' + cfg.token },
      });
      if (!res.ok) { err(res.error || '拉 server 工作室列表失败'); process.exit(1); }
      const serverStudios = res.studios || [];
      const localData = bridgeLib.loadStudios();
      const localBySlug = {};
      for (const s of (localData.studios || [])) localBySlug[s.slug] = s;

      log('');
      log(bold('  server vs 本地 工作室 sync'));
      log('');

      const missing = [];
      if (serverStudios.length === 0) {
        log(sepia('  server 端你没加入任何工作室'));
      } else {
        log(sepia('  server 端 (你是成员):'));
        for (const ss of serverStudios) {
          const local = localBySlug[ss.slug];
          if (local && local.secret) {
            log(sepia('    ✓ ') + bold(ss.name) + sepia(' (slug: ' + ss.slug + ') · 本地有暗号'));
          } else {
            log(sepia('    ⚠ ') + bold(ss.name) + sepia(' (slug: ' + ss.slug + ') · 本地缺暗号'));
            missing.push(ss);
          }
        }
        log('');
        if (missing.length > 0) {
          log(sepia('  缺暗号的工作室 · 你不能解 bridge 消息'));
          log(sepia('  解决:'));
          log(sepia('    1. webapp 找到暗号 → ') + vermilion('tinker studio link ' + missing[0].slug + ' <secret>'));
          log(sepia('    2. 让队友发邀请 → ') + vermilion('tinker studio accept <token>'));
          log('');
        }
      }

      const orphans = [];
      for (const local of (localData.studios || [])) {
        if (local.slug === 'legacy') continue;
        if (!serverStudios.find(s => s.slug === local.slug)) orphans.push(local);
      }
      if (orphans.length > 0) {
        log(sepia('  本地有但 server 端不是成员 (可能被 owner 移除):'));
        for (const o of orphans) log(sepia('    · ') + o.slug);
        log(sepia('  清理: ') + vermilion('tinker studio leave ' + orphans[0].slug));
        log('');
      }

      if ((localData.studios || []).find(s => s.slug === 'legacy')) {
        log(sepia('  ⚠ 本地还有 legacy 暗号 (老 ~/.tinker/bridge-secret)'));
        if (serverStudios.length > 0) {
          log(sepia('     link 进真实工作室后 ') + vermilion('tinker studio leave legacy') + sepia(' 清理'));
        }
        log('');
      }

      const active = bridgeLib.getActiveStudio();
      if (active) {
        log(sepia('  当前 active: ') + bold(active.slug));
        log('');
      }
      return;
    }

    case 'info': {
      const slug = args[2];
      if (!slug) { err('用法: tinker studio info <slug>'); process.exit(1); }
      const res = await safeFetchJson(cfg, '/api/studios/' + encodeURIComponent(slug));
      if (!res.ok) { err(res.error || '拉取失败'); process.exit(1); }
      if (opts.json) { outputJson(res); return; }
      const s = res.studio;
      log('');
      log(bold('  ' + s.name) + sepia('  /s/' + s.slug));
      if (s.tagline) log(sepia('  ') + s.tagline);
      log('');
      log(sepia('  成员 (' + s.members.length + '):'));
      for (const m of s.members) {
        log('  · @' + bold(m.handle) + sepia('  [' + m.role + ']') + (m.tagline ? sepia(' — ') + m.tagline : ''));
      }
      log('');
      log(sepia('  项目 (' + s.projects.length + '):'));
      for (const p of s.projects) {
        log('  · ' + bold(p.name) + sepia('  by @' + p.ownerHandle) + sepia('  [' + p.status + ']'));
      }
      log('');
      return;
    }

    case 'leave': {
      const slug = args[2];
      if (!slug) { err('用法: tinker studio leave <slug>'); process.exit(1); }
      // v0.31 legacy 是纯本地概念 · server 端没有 · 直接清本地不调 server
      if (slug === 'legacy') {
        bridgeLib.removeStudio('legacy');
        try {
          if (fs.existsSync(bridgeLib.LEGACY_SECRET_FILE)) fs.unlinkSync(bridgeLib.LEGACY_SECRET_FILE);
        } catch {}
        log('');
        ok('清掉 legacy 本地暗号');
        log(sepia('  ~/.tinker/bridge-secret 也删了 · 不会再自动迁移'));
        log('');
        return;
      }
      const getRes = await safeFetchJson(cfg, '/api/studios/' + encodeURIComponent(slug));
      if (!getRes.ok) { err(getRes.error || '工作室不存在'); process.exit(1); }
      const studioId = getRes.studio.id;
      const res = await safeFetchJson(cfg, '/api/studios/' + studioId + '/leave', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + cfg.token },
      });
      if (!res.ok) { err(res.error || '退出失败'); process.exit(1); }
      bridgeLib.removeStudio(slug);
      log('');
      ok(`退出了 — ${getRes.studio.name} · 本地暗号也清了`);
      log('');
      return;
    }

    case 'invite': {
      // tinker studio invite <slug> @handle
      const slug = args[2];
      const targetHandle = (args[3] || '').replace(/^@/, '');
      if (!slug || !targetHandle) { err('用法: tinker studio invite <slug> @<handle>'); process.exit(1); }

      // v0.31 bug fix: 取 slug 对应的 secret · 不是 active 的
      // 之前用 loadSecret() 拿 active 的 · 如果 active != slug · secretCipher 会错
      // (典型场景:active=legacy · 用户 invite daogu @who · 加密用 legacy secret · 接收方 accept 后拿 legacy 不是真 daogu)
      const studiosData = bridgeLib.loadStudios();
      const target = (studiosData.studios || []).find(s => s.slug === slug);
      if (!target || !target.secret) {
        err('本地没 ' + slug + ' 的暗号 · 你不是这个工作室的成员? 先 tinker studio link/join/accept');
        process.exit(1);
      }
      const secret = target.secret;

      // 查 studio_id (server 要)
      const getRes = await safeFetchJson(cfg, '/api/studios/' + encodeURIComponent(slug));
      if (!getRes.ok) { err(getRes.error || '工作室不存在'); process.exit(1); }
      const studioId = getRes.studio.id;

      // e2e: 客户端生成 token + 加密 secret · server 只存 hash + 密文
      const token = require('crypto').randomBytes(6).toString('hex'); // 12 字符 · 好复制
      const tokenHash = sha256Hex(token);
      const secretCipher = bridgeLib.encrypt(secret, token);

      const res = await safeFetchJson(cfg, '/api/studios/' + studioId + '/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
        body: JSON.stringify({ targetHandle, tokenHash, secretCipher }),
      });
      if (!res.ok) { err(res.error || '邀请失败'); process.exit(1); }

      // v0.29 自动通过 bridge 投递邀请通知 · 减少"复制 token 微信发"
      // payload 走明文 base64 (没暗号 chicken-egg · 接收方还没共享 secret · 解不了普通密文)
      // server 看到 base64 跟其他密文长一样 · 不能区分
      let autoSent = false;
      try {
        const inviteObj = {
          type: 'studio-invite',
          slug,
          studioName: getRes.studio.name,
          token,
          fromHandle: cfg.handle,
          at: Date.now(),
        };
        const invitePayload = Buffer.from(JSON.stringify(inviteObj), 'utf-8').toString('base64');
        const sendRes = await safeFetchJson(cfg, '/api/bridge/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
          body: JSON.stringify({ to: targetHandle, kind: 'noti', payload: invitePayload }),
        });
        autoSent = !!(sendRes && sendRes.ok);
      } catch { /* bridge 发不出也不阻塞主流程 · token 还能手动发 */ }

      log('');
      ok(`邀请生成了 · 给 @${targetHandle} · 24h 内有效`);
      if (autoSent) {
        log(sepia('  ✓ 已自动通过 bridge 投递到 ta 的 inbox'));
        log(sepia('  ✓ ta 下次起 Claude session 时自动收到 · 提示一键加入'));
        log('');
        log(sepia('  备份方案 (bridge 失效时):'));
      } else {
        log('');
        log(bold('  把这一行发给 @' + targetHandle + ':'));
      }
      log('');
      log('  ' + vermilion(`tinker studio accept ${token}`));
      log('');
      log(sepia('  token 一次性 · server 看不到 token 跟 studio 暗号 · 可以放心发'));
      log('');
      return;
    }

    case 'accept': {
      const token = args[2];
      if (!token) { err('用法: tinker studio accept <token>'); process.exit(1); }
      const tokenHash = sha256Hex(token);

      const res = await safeFetchJson(cfg, '/api/studios/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
        body: JSON.stringify({ tokenHash }),
      });
      if (!res.ok) { err(res.error || '兑换失败 · token 不对 / 过期 / 不是给你的'); process.exit(1); }

      // 用 token 解 server 返的密文 · 拿到 studio secret
      let secret;
      try {
        secret = bridgeLib.decrypt(res.secretCipher, token);
      } catch (e) {
        err('密文解不开 — token 跟 server 存的不一致 · 这不应该发生');
        process.exit(1);
      }
      bridgeLib.addStudio({ slug: res.slug, name: res.name, secret, id: res.studioId });
      bridgeLib.setActiveStudio(res.slug);

      log('');
      ok(`加入了 — ${bold(res.name)}`);
      log(sepia('  本地暗号已存:  ') + vermilion(bridgeLib.STUDIOS_FILE));
      log(sepia('  看工作室主页: ') + vermilion(cfg.serverUrl + '/#/s/' + res.slug));
      log('');
      return;
    }

    default:
      err('未知子命令: ' + subcmd + ' · 跑 `tinker studio help` 看用法');
      process.exit(1);
  }
}

// strip ANSI 颜色码 · JSON 里不该带终端控制符
function stripAnsi(s) { return (s || '').toString().replace(/\x1b\[[0-9;]*m/g, ''); }

// v0.20 voice 守门 · 在所有 push 路径 addUpdate 前调
// 防 "tinker push -m '<没经 LLM 起草的 AI 直出文本>'" 的裸奔
//   score >= 3 → 拒绝 (要 --force 才发)
//   score == 2 → TTY 时 confirm · 非 TTY 默认放过 (不阻塞 hook / AI agent 调用)
//   score <= 1 → 通过
// 返回 { ok: true } 通过 · { ok: false, reason } 拒绝
// 注意 helper 是 async (因为 TTY confirm 走 inquirer)

// =====================================================
// v0.21 bridge user-facing commands · ping / send (收消息走 SessionStart hook · 不挂 watch)
// 走 active studio 暗号 (来自 cmdStudio create/join/accept)
// 默认广播到 active studio · -t @who 点对点
// =====================================================

// v0.49 outbox · 本地落地所有 outbound 走 bridge 的命令
// 解 server poll API 设计 gap (只返 inbox · 不返 outbox)
// 文件: ~/.tinker/outbox/<YYYY-MM-DD>.jsonl · 一行一条
function appendOutbox(entry) {
  try {
    const dir = path.join(CONFIG_DIR, 'outbox');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const date = new Date(entry.at || Date.now()).toISOString().slice(0, 10);
    const file = path.join(dir, date + '.jsonl');
    fs.appendFileSync(file, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
  } catch { /* outbox 落地失败不能阻塞主流程 */ }
}

// tinker outbox [--days N] [--to @who] [--kind ping|send|handoff|witness-publish] [--json]
function cmdOutbox(opts) {
  const dir = path.join(CONFIG_DIR, 'outbox');
  if (!fs.existsSync(dir)) {
    log(sepia('  outbox 空 · v0.49 之前发的找不回 (server poll 不返自己发的)'));
    return;
  }
  // 给了关键词就全量翻 (不受默认 1 天窗限制) · 按内容搜回老 handoff
  const kw = (opts.search || (opts.positional || [])[0] || '').trim().toLowerCase();
  const days = kw ? 3650 : (opts.daysBack || 1);
  const cutoff = Date.now() - days * 86400000;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort().reverse();
  const entries = [];
  for (const f of files) {
    try {
      const lines = fs.readFileSync(path.join(dir, f), 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if (e.at < cutoff) continue;
          if (opts.toHandle && e.to !== opts.toHandle) continue;
          if (opts.kind && e.kind !== opts.kind) continue;
          if (kw) {
            const hay = [e.message, e.title, e.body, (e.files || []).join(' '), e.to, e.toStudio].join(' ').toLowerCase();
            if (!hay.includes(kw)) continue;
          }
          entries.push(e);
        } catch {}
      }
    } catch {}
  }
  entries.sort((a, b) => b.at - a.at);
  if (opts.json) { outputJson({ ok: true, entries }); return; }
  log('');
  log(bold('  outbox · 我发出去的私信' + (kw ? ' · 搜「' + kw + '」(全量)' : ' (近 ' + days + ' 天)')));
  log('');
  if (entries.length === 0) {
    log(sepia('  空 · 范围内没发过 (或者 v0.49 之前 · outbox 没装)'));
    log('');
    return;
  }
  for (const e of entries) {
    const ts = new Date(e.at).toLocaleString('zh-CN', { hour12: false }).slice(5);
    const tag = e.kind === 'ping' ? '🔔' : e.kind === 'send' ? '📎' : e.kind === 'handoff' ? '🎯' : e.kind === 'witness-publish' ? '✦' : '·';
    const target = e.to ? ('@' + e.to) : e.toStudio ? ('studio:' + e.toStudio) : '(广播)';
    log('  ' + tag + ' ' + ts + sepia(' → ') + target + sepia(' · ') + e.kind);
    if (e.title) log(sepia('     ') + e.title);
    if (e.body) log(sepia('     ') + e.body.slice(0, 100));
    if (e.message) log(sepia('     说明: ') + e.message);
    if (e.updateId) log(sepia('     update: ') + e.updateId);
    if (e.files) log(sepia('     files: ') + e.files.join(', '));
    if (e.seq) log(sepia('     seq ') + e.seq);
    log('');
  }
}

// v0.50 看历史解码失败列表
function cmdBridgeFailed(opts) {
  const failedFile = path.join(CONFIG_DIR, 'inbox', '.failed-payloads.json');
  let failed = {};
  try { failed = JSON.parse(fs.readFileSync(failedFile, 'utf-8')); } catch {}
  const list = Object.values(failed).sort((a, b) => a.seq - b.seq);
  if (opts.json) { outputJson({ ok: true, failed: list }); return; }
  log('');
  log(bold('  bridge 解码失败队列'));
  log('');
  if (list.length === 0) {
    log(sepia('  空 · 没有失败的 payload'));
    log('');
    return;
  }
  for (const e of list) {
    const ts = new Date(e.firstSeenAt).toLocaleString('zh-CN', { hour12: false }).slice(5);
    const target = e.toHandle ? ('@' + e.toHandle) : e.toStudio ? ('studio:' + e.toStudio.slice(0, 18)) : '(广播)';
    log('  seq ' + e.seq + sepia(' · ') + ts + sepia(' · from @') + e.fromHandle + sepia(' → ') + target);
    log(sepia('    kind=') + e.kind + sepia(' · 失败 ') + e.attempts + sepia(' 次'));
  }
  log('');
  log(sepia('  暗号修好后跑 tinker bridge retry · 自动重试'));
  log('');
}

// v0.50 重试历史解码失败的 payload (用当前 studios.json 全部 secret 试解)
function cmdBridgeRetry(opts) {
  const bridgeLib = require('../lib/bridge');
  const dossierLib = require('../lib/dossier');
  const INBOX = path.join(CONFIG_DIR, 'inbox');
  const failedFile = path.join(INBOX, '.failed-payloads.json');
  let failed = {};
  try { failed = JSON.parse(fs.readFileSync(failedFile, 'utf-8')); } catch {}
  const list = Object.values(failed);
  if (list.length === 0) {
    log(sepia('  没有要重试的 payload · 解码失败队列空'));
    return;
  }
  let recovered = 0;
  const stillFailed = {};
  for (const e of list) {
    const tryDec = bridgeLib.tryDecryptWithAnyStudio(e.payload);
    if (!tryDec) {
      stillFailed[e.seq] = { ...e, attempts: e.attempts + 1, lastSeenAt: Date.now() };
      continue;
    }
    try {
      const obj = JSON.parse(tryDec.plaintext);
      log('  ✓ seq ' + e.seq + sepia(' from @') + e.fromHandle + sepia(' · 解开了 · kind=') + e.kind);
      if (obj.title) log(sepia('    ') + obj.title);
      if (obj.body) log(sepia('    ') + obj.body.slice(0, 200));
      if (e.kind === 'task') {
        try { dossierLib.unpackDossier({ msgId: e.msgId, fromHandle: e.fromHandle, dossier: obj }); } catch {}
      }
      if (obj.type === 'witness-request' && obj.context && obj.updateId) {
        try {
          const wDir = path.join(INBOX, 'witness-' + obj.updateId);
          fs.mkdirSync(wDir, { recursive: true });
          fs.writeFileSync(path.join(wDir, 'context.md'), obj.context);
          fs.writeFileSync(path.join(wDir, 'meta.json'), JSON.stringify({
            fromHandle: e.fromHandle, originalUpdateId: obj.updateId, topic: obj.topic || '', receivedAt: e.firstSeenAt,
          }, null, 2));
        } catch {}
      }
      recovered++;
    } catch {
      stillFailed[e.seq] = { ...e, attempts: e.attempts + 1, lastSeenAt: Date.now() };
    }
  }
  try { fs.writeFileSync(failedFile, JSON.stringify(stillFailed, null, 2)); } catch {}
  log('');
  log(sepia('  恢复 ') + recovered + sepia(' 条 · 还剩 ') + Object.keys(stillFailed).length + sepia(' 条解不开'));
}

async function cmdPing(opts) {
  const cfg = mustHaveConfig();
  const bridgeLib = require('../lib/bridge');
  const activeStudio = bridgeLib.getActiveStudio();
  if (!activeStudio) {
    err('还没加入任何工作室 · 跑 `tinker studio create <slug>` 建一个 · 或 `tinker studio accept <token>` 兑换邀请');
    process.exit(1);
  }
  const secret = activeStudio.secret;

  const to = opts.toHandle || null;
  const useStudio = !to;
  const positional = opts.positional || [];
  const title = (opts.title || positional[0] || '').trim();
  const noteBody = (opts.body || opts.text || positional[1] || '').trim();
  const level = (opts.level || 'info').toLowerCase();
  if (!title) { err('要一句 title · 例: tinker ping "构建挂了" -l urgent'); process.exit(1); }
  if (!['info', 'ok', 'warn', 'urgent'].includes(level)) { err('level 只支持: info / ok / warn / urgent'); process.exit(1); }

  const obj = { v: 1, title, body: noteBody, level, at: Date.now() };
  const payload = bridgeLib.encrypt(JSON.stringify(obj), secret);
  const apiBody = useStudio
    ? { toStudio: activeStudio.id, kind: 'noti', payload }
    : { to, kind: 'noti', payload };

  try {
    const r = await safeFetchJson(cfg, '/api/bridge/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
      body: JSON.stringify(apiBody),
    });
    log('');
    const tag = level === 'urgent' ? '🚨' : level === 'warn' ? '⚠' : level === 'ok' ? '✓' : '🔔';
    ok(tag + ' ping → ' + (useStudio ? bold(activeStudio.name) + sepia(' (' + activeStudio.slug + ')') : '@' + to));
    log(sepia('  ' + title));
    if (noteBody) log(sepia('  ' + noteBody.slice(0, 200)));
    log(sepia('  seq ') + r.seq + sepia(' · id ') + r.id);
    log('');
    appendOutbox({ kind: 'ping', to: to || null, toStudio: useStudio ? activeStudio.slug : null, title, body: noteBody, level, msgId: r.id, seq: r.seq });
  } catch (e) { err(e.message); process.exit(1); }
}

async function cmdSend(opts) {
  const cfg = mustHaveConfig();
  const bridgeLib = require('../lib/bridge');
  const activeStudio = bridgeLib.getActiveStudio();
  if (!activeStudio) { err('还没加入工作室'); process.exit(1); }
  const secret = activeStudio.secret;

  const positional = opts.positional || [];
  const files = positional.slice(0);
  if (files.length === 0) { err('要给至少一个文件 · 例: tinker send foo.md -t @maomao'); process.exit(1); }
  const to = opts.toHandle;
  const useStudio = !to;

  const items = [];
  let totalSize = 0;
  for (const f of files) {
    if (!fs.existsSync(f)) { err('找不到: ' + f); process.exit(1); }
    const st = fs.statSync(f);
    if (!st.isFile()) { err('不是文件: ' + f); process.exit(1); }
    if (st.size > 6 * 1024 * 1024) { err('单文件 6MB 上限: ' + f); process.exit(1); }
    items.push({ name: path.basename(f), size: st.size, content: fs.readFileSync(f).toString('base64') });
    totalSize += st.size;
  }
  if (totalSize > 6 * 1024 * 1024) { err('合计 6MB 上限'); process.exit(1); }

  const obj = { v: 1, message: opts.text || '', files: items, at: Date.now() };
  const payload = bridgeLib.encrypt(JSON.stringify(obj), secret);
  const apiBody = useStudio
    ? { toStudio: activeStudio.id, kind: 'file', payload }
    : { to, kind: 'file', payload };

  try {
    const r = await safeFetchJson(cfg, '/api/bridge/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
      body: JSON.stringify(apiBody),
    });
    log('');
    ok('📎 文件发了 → ' + (useStudio ? bold(activeStudio.name) : '@' + to));
    log(sepia('  ' + items.length + ' 个文件 · 合计 ' + totalSize + ' 字节'));
    for (const it of items) log(sepia('    · ') + it.name + sepia(' (' + it.size + ' 字节)'));
    log(sepia('  seq ') + r.seq);
    log('');
    appendOutbox({ kind: 'send', to: to || null, toStudio: useStudio ? activeStudio.slug : null, files: items.map(it => it.name), totalSize, message: opts.text || '', msgId: r.id, seq: r.seq });
  } catch (e) { err(e.message); process.exit(1); }
}


// =====================================================
// v0.55 handoff 重料 blob 存取 · Phase 2 懒取
// =====================================================

// 上传重料 blob · 已存在 (去重命中) server 返 existed=true · 跳过实际写
async function uploadHandoffBlob(cfg, { studioId, hash, payload }) {
  return safeFetchJson(cfg, '/api/bridge/blob', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
    body: JSON.stringify({ studioId, hash, payload, bytes: Buffer.from(payload, 'base64').length }),
  });
}

// 取重料 blob · 返 { payload } · 404 抛错
async function fetchHandoffBlob(cfg, { studioId, hash }) {
  const url = '/api/bridge/blob/' + encodeURIComponent(hash) + '?studioId=' + encodeURIComponent(studioId);
  return safeFetchJson(cfg, url, {
    headers: { Authorization: 'Bearer ' + cfg.token },
  });
}

// =====================================================
// v0.52 handoff 回执 · 邮件系统的送达回执/退信
// 接收方拆包时自动回发起方一条 noti · 发起方不用干等 ·
// 下次起 session 就知道包到没到 / 拆没拆开 / 起点 sha 对方认不认识
// 深度验收 (临时工作树重放 diff) 走 tinker inbox verify · 这里只报拆包 + 快验
// =====================================================
async function sendHandoffReceipt({ cfg, msgId, fromHandle, studio, dossier, unpackError }) {
  if (!cfg || !cfg.token || !fromHandle || !studio) return;
  const itemDir = path.join(CONFIG_DIR, 'inbox', msgId);
  const guard = path.join(itemDir, 'RECEIPT-SENT');
  if (fs.existsSync(guard)) return;  // 重拆 (retry / 重复 poll) 不重发

  const bridgeLib = require('../lib/bridge');
  let title, body, level;
  if (unpackError) {
    title = '退信 · 你的 handoff 在 @' + cfg.handle + ' 这边拆包失败';
    body = '包 ' + msgId + ' 收到了但落地失败: ' + String(unpackError).slice(0, 150) + ' · 看是不是要重新打包发';
    level = 'warn';
  } else {
    const dossierLib = require('../lib/dossier');
    let quick = {};
    try { quick = dossierLib.quickVerifyDossier(dossier); } catch {}
    // 人话 body · 起点对不对得上换成普通话 · sha / 字节这些机器细节进 facts 字段
    const startLine = quick.shaKnown === true ? '起点跟我这边对得上'
      : quick.shaKnown === false ? '起点我这边还没有 (含未推 commit 时正常)'
      : '';
    title = '回执 · 你的 handoff 在 @' + cfg.handle + ' 这边拆开了';
    body = '包到了 · ' + dossierLib.describePayload(dossier) + '。' + (startLine ? startLine + ' · ' : '')
      + '要确认能不能落地 · 我跑一遍 tinker inbox verify 再回你。';
    level = 'ok';
  }

  const obj = {
    v: 1, title, body, level, at: Date.now(), type: 'handoff-receipt', originalMsgId: msgId,
    // 机器细节单独放 · 给 AI 看 · 人那层不被这些占着
    facts: unpackError ? null : {
      diffBytes: dossier.diff ? dossier.diff.length : 0,
      hasSituation: !!dossier.situation,
      hasVoice: !!dossier.voiceFingerprint,
    },
  };
  const payload = bridgeLib.encrypt(JSON.stringify(obj), studio.secret);
  await safeFetchJson(cfg, '/api/bridge/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
    body: JSON.stringify({ to: fromHandle, kind: 'noti', payload }),
  });
  try {
    fs.mkdirSync(itemDir, { recursive: true });
    fs.writeFileSync(guard, String(Date.now()));
  } catch {}
}

// =====================================================
// v0.22 handoff · 把当前现场打包加密发给队友 / 工作室
// 包含: situation JSON / git diff / voice fingerprint / cwd / repo info
// =====================================================

// tinker handoff -m "..." [-t @who] [--situation <id>]
async function cmdHandoff(opts) {
  // v0.48 子命令分发 · reply 走 cmdHandoffReply (接力方做完回稿)
  const positional = opts.positional || [];
  if (positional[0] === 'reply') return cmdHandoffReply(opts);

  const cfg = mustHaveConfig();
  const bridgeLib = require('../lib/bridge');
  const dossierLib = require('../lib/dossier');
  const activeStudio = bridgeLib.getActiveStudio();
  if (!activeStudio) {
    err('要先加入工作室才能接力 · tinker studio create / accept');
    process.exit(1);
  }

  const message = (opts.text || opts.body || '').trim();
  if (!message) {
    err('要给接力说明 · 例:tinker handoff -m "图片压缩做一半 · 剩 webp 转换"');
    process.exit(1);
  }
  // voice 守门 · 接力说明是给队友 (人) 看的 · 严查
  // dossier 里 situation/diff/fingerprint 是 AI 给 AI 看的 · 那部分不查
  const gate = await gateVoiceCheck(message, { profile: 'for_humans_team', force: opts.force });
  if (!gate.ok) process.exit(1);
  const to = opts.toHandle || null;
  const useStudio = !to;

  // --no-situation 明确不带现场 · 否则 --situation 指定 · 都没有就自动挑最近 active 的
  let situationId = null;
  if (!opts.noSituation) situationId = opts.situation || dossierLib.pickActiveSituationId();
  if (!situationId && !opts.noSituation) {
    log(sepia('  没找到 active situation · 不带 situation 也能发 · 接收方只看 git/voice'));
  } else if (situationId && !opts.situation) {
    // 自动挑的现场可能跟你这次 handoff 的主题无关 (pickActiveSituationId 只看"最近未解决")
    // 历史坑:CC-ENC 那次自动挂上了无关的 deepseek 现场 · 静默关联用户根本不知道
    // 现在把挑中的 topic 显出来 · 挂错了你能当场看见 · 加 --no-situation 重发
    let topic = '';
    try { topic = (JSON.parse(fs.readFileSync(path.join(dossierLib.STRUGGLES_DIR, situationId + '.json'), 'utf-8')).topic || '').slice(0, 60); } catch {}
    log(sepia('  自动带上现场: ') + bold(topic || situationId) + sepia('  (跟这次无关就加 --no-situation 重发)'));
  }

  const dossier = dossierLib.packDossier({ situationId, message, cwd: process.cwd() });
  const plain = JSON.stringify(dossier);
  if (plain.length > 8 * 1024 * 1024) {
    err('dossier 太大 (' + plain.length + ' 字节) · server 限 10MB · 试 --no-diff (TODO) 或缩小工作树');
    process.exit(1);
  }

  // v0.55 拆信封懒取 · 重料拆出去存 blob · bridge 只发轻信封
  // 没重料 / legacy studio 没 id (blob 命名空间靠 studio id) → 退回整包 inline (v1)
  const canSplit = !!activeStudio.id;
  const { light, heavyPlain, blobRef } = canSplit
    ? dossierLib.prepareHandoff(dossier)
    : { light: { ...dossier, v: 1 }, heavyPlain: null, blobRef: null };

  // 先传重料 blob · 传成功了才发轻信封 (不然接收方拿到 ref 取不到东西)
  let blobExisted = null;
  if (blobRef && heavyPlain) {
    try {
      const blobPayload = bridgeLib.encryptCompressed(heavyPlain, activeStudio.secret);
      const up = await uploadHandoffBlob(cfg, { studioId: activeStudio.id, hash: blobRef.hash, payload: blobPayload });
      blobExisted = !!up.existed;
    } catch (e) {
      err('重料 blob 上传失败 · 没发信封 (省得对方取不到): ' + e.message);
      process.exit(1);
    }
  }

  const lightPlain = JSON.stringify(light);
  const payload = bridgeLib.encryptCompressed(lightPlain, activeStudio.secret);
  const apiBody = useStudio
    ? { toStudio: activeStudio.id, kind: 'task', payload }
    : { to, kind: 'task', payload };

  try {
    const r = await safeFetchJson(cfg, '/api/bridge/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
      body: JSON.stringify(apiBody),
    });
    log('');
    ok('🎯 handoff 发了 → ' + (useStudio ? bold(activeStudio.name) + sepia(' (工作室广播)') : '@' + to));
    log(sepia('  说明:    ') + message);
    log(sepia('  situation: ') + (situationId || sepia('(无)')));
    log(sepia('  dossier:  ') + plain.length + ' 字节 (含 ' + (dossier.diff ? 'git diff' : '无 diff') + ' / ' + (dossier.voiceFingerprint ? 'voice fingerprint' : '无 voice') + ')');
    if (blobRef) {
      log(sepia('  轻信封:   ') + Buffer.from(payload, 'base64').length + ' 字节上线 (重料拆走 · 接了才取)');
      log(sepia('  重料 blob: ') + (blobExisted ? '已存在 · 去重跳过上传' : blobRef.plainBytes + ' 字节 · 已存 server'));
    } else {
      const wireBytes = Buffer.from(payload, 'base64').length;
      log(sepia('  压缩后:   ') + wireBytes + ' 字节上线 (没重料可拆 · 整包发)');
    }
    log(sepia('  seq ') + r.seq);
    log('');
    appendOutbox({ kind: 'handoff', to: to || null, toStudio: useStudio ? activeStudio.slug : null, message, situationId, dossierBytes: plain.length, blobHash: blobRef ? blobRef.hash : null, blobExisted, msgId: r.id, seq: r.seq });
  } catch (e) { err(e.message); process.exit(1); }
}

// =====================================================
// v0.48 handoff reply · 接力方做完回稿给原发起方
// 跟 witness reply 同构 · 但走 inbox/<msgId> 上下文 · 而不是 update id
// 低粒度: 只传"接到哪步 + 留了什么给原发起方" · 不回包 diff/state
// =====================================================
async function cmdHandoffReply(opts) {
  const cfg = mustHaveConfig();
  const positional = opts.positional || [];
  const msgId = positional[1];
  if (!msgId) { err('用法: tinker handoff reply <msgId> [--by-claude | publish "<content>"]'); process.exit(1); }

  const dossierLib = require('../lib/dossier');
  const inboxItemDir = path.join(dossierLib.INBOX_DIR, msgId);
  if (!fs.existsSync(inboxItemDir)) { err('找不到 inbox 项: ' + msgId); process.exit(1); }

  // 拿原 fromHandle · unpackDossier 落的 from.txt
  let fromHandle = opts.toHandle || null;
  const fromFile = path.join(inboxItemDir, 'from.txt');
  if (!fromHandle && fs.existsSync(fromFile)) {
    try { fromHandle = fs.readFileSync(fromFile, 'utf-8').trim(); } catch {}
  }
  if (!fromHandle) {
    err('inbox 项里没找到 from.txt · 老消息没记录原发起方 · 加 --to @<handle> 显式指定');
    process.exit(1);
  }

  // 读原 dossier 拿 message 跟 cwd
  let originalMessage = '';
  let originalCwd = '';
  try {
    const d = JSON.parse(fs.readFileSync(path.join(inboxItemDir, 'dossier.json'), 'utf-8'));
    originalMessage = d.message || '';
    originalCwd = d.cwd || '';
  } catch {}

  const sub2 = positional[2];

  // publish 模式
  if (sub2 === 'publish') {
    const content = (opts.text || positional[3] || '').trim();
    if (!content || content.length < 30) {
      err('回稿太短 (< 30 字) · 至少说一句:接到哪步 + 留了什么给原发起方');
      process.exit(1);
    }
    // voice 守门 · 回稿给原发起方(人)读
    const gate = await gateVoiceCheck(content, { profile: 'for_humans_team', force: opts.force });
    if (!gate.ok) process.exit(1);

    // 自己项目下落一条 update · scenario 标 handoff-reply
    const me = cfg.handle;
    const state = await apiState(cfg);
    const repoCfg = loadRepoConfig() || {};
    let projectId = repoCfg.projectId;
    if (!projectId) {
      const candidates = state.projects.filter(p => p.owner === me && ['active', 'stuck', 'live'].includes(p.status));
      if (candidates.length === 0) { err('没找到 active/stuck/live 项目 · 先建一个 · tinker project new'); process.exit(1); }
      projectId = candidates[0].id;
    }
    const r = await apiAction(cfg, 'addUpdate', { projectId, text: content, scenario: 'handoff-reply: ' + msgId });
    const replyUpdateId = r.result?.id || r.id;

    // bridge 回原发起方点对点
    const bridgeLib = require('../lib/bridge');
    const activeStudio = bridgeLib.getActiveStudio();
    let bridgeOk = false;
    if (activeStudio) {
      try {
        const obj = {
          v: 1,
          title: 'handoff reply 从 @' + me,
          body: '我对你那个 handoff (' + msgId + ') 回稿了 · tinker borrow ' + replyUpdateId + ' 看 · 摘: ' + content.slice(0, 150),
          level: 'info',
          at: Date.now(),
          type: 'handoff-reply',
          replyUpdateId,
          originalMsgId: msgId,
        };
        const payload = bridgeLib.encrypt(JSON.stringify(obj), activeStudio.secret);
        const sendRes = await safeFetchJson(cfg, '/api/bridge/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
          body: JSON.stringify({ to: fromHandle, kind: 'noti', payload }),
        });
        bridgeOk = true;
        appendOutbox({ kind: 'handoff-reply', to: fromHandle, toStudio: null, message: content, replyUpdateId, originalMsgId: msgId, msgId: sendRes.id, seq: sendRes.seq });
      } catch (e) { log(sepia('  ⚠ bridge 回投递失败: ') + e.message); }
    }

    // 顺手标 inbox 已处理 · 回稿 = 处理完
    try { dossierLib.markInboxDone(msgId); } catch {}

    log('');
    ok('🎯 handoff reply 发了 → @' + fromHandle);
    log(sepia('  reply update id: ') + replyUpdateId);
    if (bridgeOk) log(sepia('  ✓ bridge 回点对点 → @') + fromHandle);
    log(sepia('  ✓ inbox 标已处理: ') + msgId);
    log('');
    return;
  }

  // 起草模式 (默认 / --by-claude)
  log('');
  log(sepia('  ─── 原 handoff ───'));
  log('');
  log('from: @' + fromHandle);
  log('msg id: ' + msgId);
  if (originalCwd) log('原 cwd: ' + originalCwd);
  log('');
  log(originalMessage || '(原 handoff 没写说明)');
  log('');
  log(sepia('  ─── 任务 ───'));
  log('');
  log('请用你 voice 写一段 50-150 字回稿:');
  log('  · 接到了哪步 (做完了 / 在做 / 看了一遍)');
  log('  · 留了什么给 @' + fromHandle + ' (问题 / 修法 / 自己的判断)');
  log('  · 工艺人日志气质 · 不堆 emoji · 不堆破折号 · 不商业黑话');
  log('  · 不用 ## 标题切段 · 一段连贯叙事');
  log('');
  log('写完跑 (替换 <content>):');
  log('  ' + vermilion('tinker handoff reply ' + msgId + ' publish "<content>"'));
  log('');
}

// =====================================================
// v0.22 inbox · 看 / 处理收到的 handoff task
// =====================================================

// tinker inbox [<id>] · 列表 / 看详情
// tinker inbox done <id> · 标已处理
// tinker inbox fetch <id> · 把懒取的重料取回 context/
// tinker inbox verify <id> [--repo <path>] · 验收接力包 + 回执发起方
async function cmdInbox(opts) {
  const dossierLib = require('../lib/dossier');
  const sub = (opts.positional || [])[0];
  const arg = (opts.positional || [])[1];

  if (sub === 'verify') {
    await cmdInboxVerify(arg, opts);
    return;
  }

  if (sub === 'fetch') {
    await cmdInboxFetch(arg, opts);
    return;
  }

  if (sub === 'done') {
    if (!arg) { err('要给 task id · 例:tinker inbox done msg-xxx'); process.exit(1); }
    const ok2 = dossierLib.markInboxDone(arg);
    if (ok2) ok('标已处理: ' + arg);
    else err('找不到 PENDING · 可能已处理或 id 错: ' + arg);
    return;
  }

  // 看单个 (id 当 sub 传) · 默认给人看 BRIEF · README 是 AI 工作文档 · 单独提示
  if (sub && sub !== 'list') {
    const itemDir = path.join(dossierLib.INBOX_DIR, sub);
    const briefPath = path.join(itemDir, 'BRIEF.md');
    const readmePath = path.join(itemDir, 'README.md');
    // 老包没 BRIEF · 退回 README
    const showPath = fs.existsSync(briefPath) ? briefPath : readmePath;
    if (!fs.existsSync(showPath)) { err('找不到 inbox 项: ' + sub); process.exit(1); }
    log('');
    log(fs.readFileSync(showPath, 'utf-8'));
    if (fs.existsSync(briefPath) && fs.existsSync(readmePath)) {
      log(sepia('  接的话让 AI 读: ') + vermilion('cat ' + readmePath) + sepia(' · 原料在 context/'));
      log('');
    }
    return;
  }

  // 列表
  const items = dossierLib.listInbox();
  log('');
  if (items.length === 0) {
    log(sepia('  inbox 空 · 还没收到 handoff task'));
    log('');
    return;
  }
  for (const it of items) {
    const tag = it.pending ? vermilion('● 待处理') : sepia('○ 完成 ');
    const ts = new Date(it.packedAt).toLocaleString('zh-CN', { hour12: false });
    log('  ' + tag + ' ' + bold(it.id) + sepia(' · ') + ts);
    log(sepia('    ' + (it.message || '').slice(0, 100)));
    log('');
  }
  log(sepia('  看一个:    ') + vermilion('tinker inbox <id>'));
  log(sepia('  取重料:    ') + vermilion('tinker inbox fetch <id>') + sepia('   (重料是懒取的 · 接了才下载到 context/)'));
  log(sepia('  验收一个:  ') + vermilion('tinker inbox verify <id>') + sepia('  (在本地 clone 里跑 · 没取会自动取 · 结果自动回执发起方)'));
  log(sepia('  标处理完:  ') + vermilion('tinker inbox done <id>'));
  log('');
}

// v0.55 确保懒取的重料已落地 · 没 BLOB-PENDING 标记就是已经有了 (v1 包 / 已 fetch)
// 返回 { had, fetched } · had=true 表示本来就有 · fetched=true 表示这次取了
// quiet=true 时不打印 · 给 verify 内部静默调用
async function ensureBlobFetched(msgId, { quiet } = {}) {
  const dossierLib = require('../lib/dossier');
  const bridgeLib = require('../lib/bridge');
  const itemDir = path.join(dossierLib.INBOX_DIR, msgId);
  const pendingFile = path.join(itemDir, 'BLOB-PENDING.json');
  if (!fs.existsSync(pendingFile)) return { had: true, fetched: false };

  let marker;
  try { marker = JSON.parse(fs.readFileSync(pendingFile, 'utf-8')); }
  catch (e) { throw new Error('BLOB-PENDING.json 坏了: ' + e.message); }

  // 找解这个 blob 的 studio · 拆包时记的 studioSlug 优先 · 没有退到 active
  let studio = null;
  if (marker.studioSlug) {
    studio = bridgeLib.loadStudios().studios.find(s => s.slug === marker.studioSlug) || null;
  }
  if (!studio) studio = bridgeLib.getActiveStudio();
  if (!studio || !studio.id) throw new Error('找不到对应工作室 (或没 studio id) · 取不了重料');

  const cfg = mustHaveConfig();
  const res = await fetchHandoffBlob(cfg, { studioId: studio.id, hash: marker.hash });
  const heavyPlain = bridgeLib.decrypt(res.payload, studio.secret);
  const heavy = JSON.parse(heavyPlain);

  // 落 context/ + 合回 dossier.json (给 verify / reply 用完整结构)
  const contextDir = path.join(itemDir, 'context');
  dossierLib.writeContextFiles(contextDir, heavy);
  try {
    const light = JSON.parse(fs.readFileSync(path.join(itemDir, 'dossier.json'), 'utf-8'));
    const full = dossierLib.mergeHeavyIntoDossier(light, heavy);
    fs.writeFileSync(path.join(itemDir, 'dossier.json'), JSON.stringify(full, null, 2));
  } catch {}
  fs.unlinkSync(pendingFile);

  if (!quiet) {
    log(sepia('  ✓ 重料取回 context/ · ') + Math.round(heavyPlain.length / 1024) + 'kb');
  }
  return { had: false, fetched: true, heavy };
}

// tinker inbox fetch <id> · 显式把懒取的重料取回 context/
async function cmdInboxFetch(msgId, opts) {
  if (!msgId) { err('要给 task id · 例:tinker inbox fetch msg-xxx'); process.exit(1); }
  const dossierLib = require('../lib/dossier');
  const itemDir = path.join(dossierLib.INBOX_DIR, msgId);
  if (!fs.existsSync(path.join(itemDir, 'dossier.json'))) { err('找不到 inbox 项: ' + msgId); process.exit(1); }
  log('');
  try {
    const r = await ensureBlobFetched(msgId, { quiet: false });
    if (r.had && !r.fetched) {
      log(sepia('  这个包不用取 · 重料已经在 context/ 里了 (老包 / 已 fetch)'));
    } else {
      const ctx = path.join(itemDir, 'context');
      const files = fs.existsSync(ctx) ? fs.readdirSync(ctx) : [];
      log(sepia('  context/ 现在有: ') + (files.join(' · ') || '(空)'));
    }
  } catch (e) { err('取重料失败: ' + e.message); process.exit(1); }
  log('');
}

// v0.52 验收接力包 · 邮件回执的深验那一半
// 临时工作树上重放 diff (不碰当前工作树) · 验完自动回执/退信给发起方
async function cmdInboxVerify(msgId, opts) {
  if (!msgId) { err('要给 task id · 例:tinker inbox verify msg-xxx [--repo <本地 clone 路径>]'); process.exit(1); }
  const dossierLib = require('../lib/dossier');
  const itemDir = path.join(dossierLib.INBOX_DIR, msgId);
  const dossierFile = path.join(itemDir, 'dossier.json');
  if (!fs.existsSync(dossierFile)) { err('找不到 inbox 项: ' + msgId); process.exit(1); }

  // v0.55 懒取 · diff 还在 server 就先取回来 · verify 要靠 diff 重放
  try {
    const r = await ensureBlobFetched(msgId, { quiet: true });
    if (r.fetched) log(sepia('  (重料是懒取的 · 已先取回 context/)'));
  } catch (e) { err('取重料失败 · 没法验: ' + e.message); process.exit(1); }

  let dossier;
  try { dossier = JSON.parse(fs.readFileSync(dossierFile, 'utf-8')); }
  catch (e) { err('dossier.json 读不了: ' + e.message); process.exit(1); }

  // 找仓库:--repo 显式给 > 当前目录 / 包里 cwd 里 remote 对得上的那个
  let repoPath = opts.repo || null;
  if (!repoPath) {
    try { repoPath = dossierLib.quickVerifyDossier(dossier).repoPath; } catch {}
  }
  if (!repoPath) {
    err('找不到对应的本地 clone · cd 到 clone 里跑 · 或加 --repo <路径>');
    if (dossier.repo && dossier.repo.url) log(sepia('  包里的 remote: ') + dossier.repo.url);
    process.exit(1);
  }

  log('');
  log(sepia('  验收接力包 ') + bold(msgId) + sepia(' · 仓库 ') + repoPath);
  const result = dossierLib.verifyDossier({ dossier, repoPath });
  log('');
  for (const c of result.checks) {
    log('  ' + (c.ok ? '✓' : vermilion('✗')) + ' ' + c.name + (c.note ? sepia(' · ' + c.note) : ''));
  }
  log('');
  if (result.verdict) ok('验收过了 · 这个包在你这边能落地');
  else err('验收没过: ' + (result.reason || '看上面哪条 ✗'));

  try {
    fs.writeFileSync(path.join(itemDir, 'VERIFY.json'), JSON.stringify({ at: Date.now(), repoPath, ...result }, null, 2));
  } catch {}

  // 回执/退信发起方 · 用拆包时那把暗号 (studio.txt) · 没记录就退到 active studio
  // 老包没 from.txt · --to @<handle> 显式指定 (跟 handoff reply 一个路子)
  let fromHandle = opts.toHandle || null;
  if (!fromHandle) {
    try { fromHandle = fs.readFileSync(path.join(itemDir, 'from.txt'), 'utf-8').trim(); } catch {}
  }
  const bridgeLib = require('../lib/bridge');
  let studio = null;
  try {
    const slug = fs.readFileSync(path.join(itemDir, 'studio.txt'), 'utf-8').trim();
    studio = bridgeLib.loadStudios().studios.find(s => s.slug === slug) || null;
  } catch {}
  if (!studio) studio = bridgeLib.getActiveStudio();
  const cfg = loadConfig();

  if (!fromHandle || !studio || !cfg || !cfg.token) {
    log(sepia('  (没法回执:缺 from.txt / 工作室暗号 / 登录态 · 验收结果只留在本地 VERIFY.json)'));
    log('');
    if (!result.verdict) process.exitCode = 1;
    return;
  }

  const failedNames = result.checks.filter(c => !c.ok).map(c => c.name).join(' / ');
  const obj = {
    v: 1,
    type: 'handoff-receipt',
    title: result.verdict
      ? '验收回执 · 你的 handoff 在 @' + cfg.handle + ' 这边能落地'
      : '退信 · 你的 handoff 在 @' + cfg.handle + ' 这边验收没过',
    body: '包 ' + msgId + (result.verdict
      ? ' · diff 在临时工作树上重放成功 · 随时能接'
      : ' · ' + (result.reason || failedNames) + ' · 看是不是要重新打包发'),
    level: result.verdict ? 'ok' : 'warn',
    at: Date.now(),
    originalMsgId: msgId,
  };
  try {
    const payload = bridgeLib.encrypt(JSON.stringify(obj), studio.secret);
    const r = await safeFetchJson(cfg, '/api/bridge/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
      body: JSON.stringify({ to: fromHandle, kind: 'noti', payload }),
    });
    log(sepia('  ✓ ' + (result.verdict ? '验收回执' : '退信') + '发回 @') + fromHandle);
    appendOutbox({ kind: 'handoff-receipt', to: fromHandle, toStudio: null, verdict: result.verdict, originalMsgId: msgId, msgId: r.id, seq: r.seq });
  } catch (e) {
    log(sepia('  ⚠ 回执投递失败: ') + e.message);
  }
  log('');
  if (!result.verdict) process.exitCode = 1;
}

// 给 SessionStart hook 跑 · 有 PENDING task 则 stdout 注入 reminder
// Claude Code 看到 stdout 就 load 接力现场
// v0.38 改: 先去 server 拉一次未消化的消息 · 不依赖 watch
// 这样接收方不需要挂 watch · SessionStart hook 启动时自动拉 + 注入 Claude
// 异步触发式协作: daodao 发 → server 中转 → 猫猫起 Claude Code → SessionStart 拉 → Claude 看 reminder
async function cmdBridgeCheckInbox() {
  try {
    const recentNotis = [];  // 这次拉到的 ping · inline 进 reminder (不持久化)
    try {
      const cfg = loadConfig();
      if (cfg && cfg.token && cfg.serverUrl && cfg.handle) {
        ensureNotifyDaemon(cfg); // 顺手确保后台通知器活着 · 中途来的消息也能弹桌面
        await pullBridgeMessagesForHook(cfg, recentNotis);
      }
    } catch { /* 拉失败静默 · 下次 hook 重试 */ }

    const dossierLib = require('../lib/dossier');
    const items = dossierLib.listInbox().filter(it => it.pending);

    const invites = [];
    const INBOX = path.join(CONFIG_DIR, 'inbox');
    if (fs.existsSync(INBOX)) {
      for (const d of fs.readdirSync(INBOX)) {
        if (!d.startsWith('invite-')) continue;
        if (!fs.existsSync(path.join(INBOX, d, 'PENDING'))) continue;
        try {
          const inv = JSON.parse(fs.readFileSync(path.join(INBOX, d, 'INVITE.json'), 'utf-8'));
          invites.push(inv);
        } catch {}
      }
    }

    if (items.length === 0 && invites.length === 0 && recentNotis.length === 0) return;

    const lines = [];

    // ping (noti) 优先 · 即时消息 · 用户上次离开后队友发的
    if (recentNotis.length > 0) {
      lines.push('收到 ' + recentNotis.length + ' 条新通知 · 用户离开期间队友发的');
      for (const n of recentNotis.slice(0, 5)) {
        // v0.48 handoff-reply 用 ↩ 区分 · 是你之前发出的 handoff 收到了接力方回稿
        // v0.52 handoff-receipt 用 📬 · 你发的包对方拆开了 (或退信)
        const tag = n.type === 'handoff-reply' ? '↩'
          : n.type === 'handoff-receipt' ? '📬'
          : n.level === 'urgent' ? '🚨' : n.level === 'warn' ? '⚠' : n.level === 'ok' ? '✓' : '🔔';
        lines.push('  ' + tag + ' @' + n.fromHandle + ': ' + (n.title || '(无标题)'));
        if (n.body) lines.push('    ' + n.body.slice(0, 200));
      }
      if (recentNotis.length > 5) lines.push('  ... 还有 ' + (recentNotis.length - 5) + ' 条');
      lines.push('看上下文判断:是真的找你 → 转告用户 / 主动响应 · 还是闲聊性的 → 收下不打扰');
    }

    // invite (onboarding · 一次性)
    if (invites.length > 0) {
      lines.push('收到 ' + invites.length + ' 个工作室邀请');
      for (const inv of invites.slice(0, 3)) {
        const name = inv.studio?.name || inv.studio?.slug || '(无名)';
        lines.push('  · @' + inv.fromHandle + ' 邀请你加入 ' + name);
        lines.push('    一键加入: tinker studio accept ' + inv.token);
      }
      lines.push('用户确认要加入: Bash 跑 tinker studio accept <token>');
    }

    // handoff task (整包接力) · 先给用户看 BRIEF 那句 · 用户要接你再钻 README + context/
    if (items.length > 0) {
      lines.push('收到 ' + items.length + ' 个未处理的 handoff 接力 · 队友把现场打包发过来了');
      for (const it of items.slice(0, 3)) {
        lines.push('  · ' + it.id + ' · ' + (it.message || '').slice(0, 80));
        lines.push('    先跟用户说这一句 · 要接再 cat ' + path.join(dossierLib.INBOX_DIR, it.id, 'README.md') + ' (AI 工作文档 · 原料在 context/)');
      }
      if (items.length > 3) lines.push('  ... 还有 ' + (items.length - 3) + ' 个 · tinker inbox 看全部');
      lines.push('别急着读 context/ 里的 diff · 用户确认要接再钻 · 省得白占上下文');
      lines.push('处理完跑 tinker inbox done <id> 标完工');
    }

    console.log(lines.join('\n'));
  } catch { /* hook 出错不阻塞 Claude Code 启动 */ }
}

// SessionStart hook 用 · 不挂长轮询 · 短超时拉一波就退
// 拉到的消息按 kind 分流:
//   task → unpack 到 ~/.tinker/inbox/<msgId>/ · 后续 reminder 引导 Claude
//   noti (ping) → 累积到 recentNotis · 直接 inline 进 reminder · 不持久化
//   invite → 落地 ~/.tinker/inbox/invite-<msgId>/
async function pullBridgeMessagesForHook(cfg, recentNotis) {
  const bridgeLib = require('../lib/bridge');
  const dossierLib = require('../lib/dossier');
  const INBOX = path.join(CONFIG_DIR, 'inbox');
  if (!fs.existsSync(INBOX)) fs.mkdirSync(INBOX, { recursive: true });
  const cursorFile = path.join(INBOX, '.cursor');
  let since = 0;
  try { since = parseInt(fs.readFileSync(cursorFile, 'utf-8').trim(), 10) || 0; } catch {}

  let resRaw;
  try {
    resRaw = await fetch(cfg.serverUrl + '/api/bridge/poll?since=' + since, {
      headers: { Authorization: 'Bearer ' + cfg.token },
      signal: AbortSignal.timeout ? AbortSignal.timeout(3500) : undefined,
    });
  } catch { return; }
  if (!resRaw.ok) return;
  const data = await resRaw.json();

  // v0.50 解码失败 payload 落地 · 不静默丢信
  // 历史教训:解码失败 cursor 照推 → SessionStart 把消息标已读吞掉 · 后续不再返
  // 修法:失败的 seq + payload 存 .failed-payloads.json · 写 bridge-errors.log
  //      暗号修好后 tinker bridge retry 重新拉来试解
  const failedPayloadsFile = path.join(INBOX, '.failed-payloads.json');
  let failedPayloads = {};
  try { failedPayloads = JSON.parse(fs.readFileSync(failedPayloadsFile, 'utf-8')); } catch {}

  for (const msg of (data.messages || [])) {
    const tryDec = bridgeLib.tryDecryptWithAnyStudio(msg.payload);
    let handled = false;
    if (tryDec) {
      try {
        const obj = JSON.parse(tryDec.plaintext);
        if (msg.kind === 'task') {
          let unpackError = null;
          try { dossierLib.unpackDossier({ msgId: msg.id, fromHandle: msg.fromHandle, dossier: obj, studioSlug: tryDec.studio.slug }); } catch (e) { unpackError = e.message; }
          // v0.52 自动回执/退信 · hook 短命 · 失败静默不挡 SessionStart
          try { await sendHandoffReceipt({ cfg, msgId: msg.id, fromHandle: msg.fromHandle, studio: tryDec.studio, dossier: obj, unpackError }); } catch {}
        } else if (msg.kind === 'noti') {
          recentNotis.push({
            fromHandle: msg.fromHandle,
            title: obj.title || '',
            body: obj.body || '',
            level: obj.level || 'info',
            type: obj.type || null,
          });
          // v0.47 witness-request 含 context · 落到 ~/.tinker/inbox/witness-<updateId>/context.md
          if (obj.type === 'witness-request' && obj.context && obj.updateId) {
            try {
              const wDir = path.join(INBOX, 'witness-' + obj.updateId);
              fs.mkdirSync(wDir, { recursive: true });
              fs.writeFileSync(path.join(wDir, 'context.md'), obj.context);
              fs.writeFileSync(path.join(wDir, 'meta.json'), JSON.stringify({
                fromHandle: msg.fromHandle,
                originalUpdateId: obj.updateId,
                topic: obj.topic || '',
                receivedAt: msg.createdAt,
              }, null, 2));
            } catch {}
          }
        } else if (msg.kind === 'file') {
          // v0.91 修:之前 file 在 SessionStart 啥都不做 · 但 cursor 照推进 → 文件消息被静默吞掉
          //   (注释说"等 watch 处理" · 可 cursor 已过 · watch 也再看不到 → 永久丢)
          //   现在跟 task 一样落地 + 进 reminder · 文件本身落 inbox · 给用户一行提示
          const files = obj.files || [];
          const landed = [];
          for (const f of files) {
            const safe = (f.name || 'unnamed').replace(/[^\w.\-一-鿿]/g, '_');
            const fp = path.join(INBOX, msg.fromHandle + '_' + msg.seq + '_' + safe);
            try { fs.writeFileSync(fp, Buffer.from(f.content || '', 'base64')); landed.push(fp); } catch {}
          }
          recentNotis.push({
            fromHandle: msg.fromHandle,
            title: '发来 ' + files.length + ' 个文件' + (obj.message ? ' · ' + obj.message : ''),
            body: landed.length ? ('落地了 · 要看跑 cat ' + landed[0] + (landed.length > 1 ? ' (共 ' + landed.length + ' 个)' : '')) : '',
            level: 'info',
            type: 'file',
            files: landed,
          });
        }
        handled = true;
        // 这个 seq 之前失败过 · 现在成功了 → 移除
        if (failedPayloads[msg.seq]) delete failedPayloads[msg.seq];
      } catch {}
    } else {
      // fallback: invite 走明文 base64
      try {
        const plain = Buffer.from(msg.payload, 'base64').toString('utf-8');
        const obj = JSON.parse(plain);
        if (obj && obj.type === 'studio-invite') {
          const inviteDir = path.join(INBOX, 'invite-' + msg.id);
          fs.mkdirSync(inviteDir, { recursive: true });
          fs.writeFileSync(path.join(inviteDir, 'INVITE.json'), JSON.stringify({
            msgId: msg.id,
            fromHandle: obj.fromHandle || msg.fromHandle,
            studio: { slug: obj.slug, name: obj.studioName },
            token: obj.token,
            at: obj.at || msg.createdAt,
            seq: msg.seq,
          }, null, 2));
          fs.writeFileSync(path.join(inviteDir, 'PENDING'), String(Date.now()));
          handled = true;
        }
      } catch {}
    }

    if (!handled) {
      // 解码 + invite fallback 都失败 → 落 failed-payloads + 写 errors.log
      const prev = failedPayloads[msg.seq] || { attempts: 0 };
      failedPayloads[msg.seq] = {
        seq: msg.seq,
        msgId: msg.id,
        fromHandle: msg.fromHandle,
        toHandle: msg.toHandle,
        toStudio: msg.toStudio,
        kind: msg.kind,
        payload: msg.payload,
        firstSeenAt: prev.firstSeenAt || Date.now(),
        lastSeenAt: Date.now(),
        attempts: prev.attempts + 1,
      };
      try {
        const errLine = `[${new Date().toISOString()}] decode failed · seq=${msg.seq} from=@${msg.fromHandle} to=${msg.toHandle || ('studio:'+msg.toStudio) || '<broadcast>'} kind=${msg.kind} attempts=${failedPayloads[msg.seq].attempts}\n`;
        fs.appendFileSync(path.join(CONFIG_DIR, 'bridge-errors.log'), errLine);
      } catch {}
    }
    since = Math.max(since, msg.seq);
  }
  try { fs.writeFileSync(cursorFile, String(since)); } catch {}
  try { fs.writeFileSync(failedPayloadsFile, JSON.stringify(failedPayloads, null, 2)); } catch {}

  // 解码失败的塞进 reminder · 让 AI 提醒用户跑 retry
  const failedCount = Object.keys(failedPayloads).length;
  if (failedCount > 0) {
    recentNotis.push({
      fromHandle: '(system)',
      title: '⚠ ' + failedCount + ' 条消息解码失败 · 暗号可能不对',
      body: '看 ~/.tinker/bridge-errors.log · 暗号修好后跑 tinker bridge retry 重试',
      level: 'warn',
    });
  }
}

// =====================================================
// v0.44 team-knowledge · 缓和版 MVP
// 用户跑 → LLM 抽近 N 天 bug 模式 → push 标 learning → bridge 广播到工作室
// 接收方 SessionStart 看 reminder → 自己决定要不要 borrow 拉详情
// 不主动扫别人代码 · 不弹"你也有问题" · 减少误判跟焦虑
// =====================================================

// tinker team-knowledge digest [--days N] [--by-claude] [-y]
// tinker team-knowledge publish "<content>"  (--by-claude 模式 · Claude 写完落地用)
async function cmdTeamKnowledge(opts) {
  const sub = (opts.positional || [])[0];
  if (sub === 'publish') {
    await cmdTeamKnowledgePublish(opts);
    return;
  }
  if (sub !== 'digest') {
    log('');
    log(bold('  tinker team-knowledge · 团队知识沉淀'));
    log('');
    log('  ' + vermilion('tinker team-knowledge digest [--days N] [--by-claude] [-y]'));
    log(sepia('     收集近 N 天 fix commit · 抽 bug 模式 · push 标 learning · 广播工作室'));
    log(sepia('     默认走 cfg.llm (DeepSeek) · --by-claude 模式输出素材让当前 Claude 抽'));
    log('  ' + vermilion('tinker team-knowledge publish "<content>"'));
    log(sepia('     给 --by-claude 模式用 · Claude 写完内容用这条落地'));
    log('');
    return;
  }

  const cfg = mustHaveConfig();
  const byClaude = !!opts.byClaude;

  if (!byClaude && (!cfg.llm || !cfg.llm.apiKey)) {
    err('--by-claude 模式不用 LLM key · 默认模式需要先 tinker llm set');
    process.exit(1);
  }

  const days = opts.daysBack || 3;
  const sinceDate = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);

  // 1. 拉近 N 天 fix 类 commit
  let commits = [];
  try {
    const out = execSync(`git log --since='${sinceDate}' --grep='fix' --pretty=format:'%h %s'`, { encoding: 'utf-8' });
    commits = out.trim().split('\n').filter(Boolean);
  } catch {}

  if (commits.length === 0) {
    err('近 ' + days + ' 天没找到 fix 类 commit · 没料给 LLM 抽 (cwd: ' + process.cwd() + ')');
    process.exit(1);
  }

  log('');
  log(sepia('  找到 ') + bold(commits.length + '') + sepia(' 条 fix commit · 近 ') + days + sepia(' 天'));

  // v0.45 --by-claude 模式 · 不调外部 LLM · 输出素材给当前 Claude 抽
  if (byClaude) {
    log('');
    log(sepia('  ─── 给 Claude 用的素材 ───'));
    log('');
    log('近 ' + days + ' 天的 fix commit (共 ' + commits.length + ' 条):');
    log('');
    commits.forEach(c => log('  ' + c));
    log('');
    log(sepia('  ─── 任务 ───'));
    log('');
    log('请抽 3-5 条最值得记下来的 bug 模式 · 让队友看完能回去检查自己代码:');
    log('  · 工艺人工作日志气质 · 不堆 emoji · 不堆破折号 · 不用 ## 标题切段 · 不堆 bullet');
    log('  · 每条模式: 症状 / 误以为的原因 / 真正原因 / 修法 / 怎么自检');
    log('  · 脱敏严格 (不带具体文件路径 / API key / 公司名 / 内部产品代号)');
    log('  · 用 "出现在 X 场景下" 描述 · 不暴露 codebase 细节');
    log('  · 500-800 字 · 不必长');
    log('');
    log('写完跑下面这条落地 (替换 <content> 为你写的内容):');
    log('  ' + vermilion('tinker team-knowledge publish "<content>"'));
    log('');
    log(sepia('  落地命令会自动 push + 标 [上手指南] + 广播到 active studio'));
    log('');
    return;
  }

  // 2. 拼 prompt
  const prompt = `你看下面这些"修 bug" 的 commit 摘要 · 帮我抽 3-5 条最值得记下来的 bug 模式 · 让队友看完后能回去检查自己代码有没有类似问题。

要求:
1. 工艺人工作日志气质 · 不堆 emoji · 不堆破折号 · 不三连排比 · 不用 ## 切段
2. 每条模式包含: 症状 / 误以为的原因 / 真正原因 / 修法 / 怎么自检
3. 脱敏严格:不要带具体文件路径 / API key / 公司名 / 内部产品代号 / 用户名
4. 用"出现在 X 场景下" 描述 · 不暴露 codebase 细节
5. 500-800 字总体 · 不必长

commit list (近 ${days} 天):
${commits.join('\n')}

输出直接是 markdown 文本 · 不要加"以下是" 这种 meta 句 · 第一句直接进主题`;

  // 3. 调 DeepSeek (cfg.llm.provider == 'deepseek')
  log(sepia('  让 LLM 抽模式中...'));
  let digest;
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + cfg.llm.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.llm.model || 'deepseek-chat',
        max_tokens: 2500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'DeepSeek API ' + res.status);
    digest = (data.choices[0].message.content || '').trim();
    try { recordLLMUsage('deepseek', data.usage && data.usage.total_tokens, 'team-knowledge'); } catch {}
  } catch (e) { err('LLM 调用失败: ' + e.message); process.exit(1); }

  if (!digest || digest.length < 100) {
    err('LLM 返回空 · 试 --days 5 给更多素材');
    process.exit(1);
  }

  // 4. voice check (LLM 默认有 AI 味 · 提示但不拦)
  try {
    const vc = require('../lib/voice-check').detectAIVoice(digest);
    if (vc.score >= 2) {
      log(sepia('  ⚠ voice 自检 ') + vc.score + sepia(' 项命中:') + vc.list.join(' · '));
      log(sepia('     LLM 起的可能有 AI 味 · 看预览决定要不要改'));
    }
  } catch {}

  log('');
  log(sepia('  ─── 草稿预览 (前 30 行) ───'));
  digest.split('\n').slice(0, 30).forEach(line => log('  ' + line));
  log(sepia('  ─── 共 ') + digest.length + sepia(' 字 ───'));
  log('');

  // 5. confirm
  if (!opts.yes) {
    const { confirm } = promptKit();
    const yes = await confirm({
      message: '发布到当前项目 + 标 [上手指南] + 广播到工作室?',
      default: true,
    });
    if (!yes) { log(sepia('  取消了')); log(''); return; }
  }

  // 6. push + mark learning
  const state = await apiState(cfg);
  const me = cfg.handle;
  const repoCfg = loadRepoConfig() || {};
  let projectId = repoCfg.projectId;
  if (!projectId) {
    const candidates = state.projects.filter(p => p.owner === me && ['active', 'stuck', 'live'].includes(p.status));
    if (candidates.length === 0) { err('没找到 active/stuck/live 项目 · 给一个 cwd 绑定的项目'); process.exit(1); }
    projectId = candidates[0].id;
  }

  const r = await apiAction(cfg, 'addUpdate', { projectId, text: digest });
  const updateId = r.result?.id || r.id;
  try { await apiAction(cfg, 'markAsLearning', { updateId }); } catch {}

  const project = state.projects.find(p => p.id === projectId);
  log('');
  ok('✦ team-knowledge 沉淀 — ' + bold(project?.name || '(项目)'));
  log(sepia('  update id: ') + updateId);
  log(sepia('  已标 [上手指南] · 队友可 tinker borrow 拉'));

  // 7. broadcast 到 active studio
  const bridgeLib = require('../lib/bridge');
  const activeStudio = bridgeLib.getActiveStudio();
  if (activeStudio && activeStudio.id) {
    try {
      const obj = {
        v: 1,
        title: 'team-knowledge: 近 ' + days + ' 天踩坑摘要',
        body: '我整理了一份近 ' + days + ' 天修过的 bug 模式 · 在 ' + (project?.name || '项目') + ' 项目下 · tinker borrow ' + updateId + ' 拉来看 · 看完检查自己代码有没有类似问题',
        level: 'info',
        at: Date.now(),
        type: 'team-knowledge',
        updateId,
        projectName: project?.name,
      };
      const payload = bridgeLib.encrypt(JSON.stringify(obj), activeStudio.secret);
      const sendRes = await safeFetchJson(cfg, '/api/bridge/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
        body: JSON.stringify({ toStudio: activeStudio.id, kind: 'noti', payload }),
      });
      if (sendRes && sendRes.ok) {
        log(sepia('  ✓ 广播到工作室 ') + bold(activeStudio.name));
        log(sepia('  队友 SessionStart 起 Claude 时自动看到 reminder · 自己决定要不要 borrow'));
      }
    } catch (e) {
      log(sepia('  ⚠ 广播失败 (但 update 已 push):') + e.message);
    }
  } else {
    log(sepia('  (active studio 没 id · 跳过广播)'));
  }
  log('');
}

// =====================================================
// v0.46 witness · 集体决策推演 · AI 议会式异步协商
// 发起方广播征求意见 · 接收方 AI 用自己 voice 写 critique · 回 N 份独立角度
// 决策权仍在发起方 · 但听到了 N 个角度 · 没开会
// 用现有: bridge.send + decision kind + scenario 字段标 reply parent
// 不动 server schema
// =====================================================

// tinker witness <draft|publish|reply|close> ...
async function cmdWitness(opts) {
  const positional = opts.positional || [];
  const sub = positional[0];
  if (sub === 'draft') return cmdWitnessDraft(opts);
  if (sub === 'publish') return cmdWitnessPublish(opts);
  if (sub === 'reply') return cmdWitnessReply(opts);
  if (sub === 'close') return cmdWitnessClose(opts);
  if (sub === 'self') return cmdWitnessSelf(opts);
  log('');
  log(bold('  tinker witness · 集体决策推演 (AI 议会式异步协商)'));
  log('');
  log('  ' + vermilion('tinker witness draft --topic "..." [--by-claude]'));
  log(sepia('     发起方起草 · CLI 输出脚手架 · 当前 Claude 写内容'));
  log('  ' + vermilion('tinker witness publish "<content>"'));
  log(sepia('     发起方落地 · push 标 decision + bridge 广播到 active studio'));
  log('  ' + vermilion('tinker witness reply <originalUpdateId> [--by-claude]'));
  log(sepia('     接收方起草 critique · CLI 拉原 update + 输出脚手架'));
  log('  ' + vermilion('tinker witness reply <originalUpdateId> publish "<content>"'));
  log(sepia('     接收方落地 critique · push 标 decision + bridge 回原发起方'));
  log('  ' + vermilion('tinker witness close <originalUpdateId> --decision "<final>"'));
  log(sepia('     发起方收 N 份 critique 后落定 · 原 update text 末尾追加最终决定'));
  log('');
}

// 发起方起草
async function cmdWitnessDraft(opts) {
  const topic = (opts.topic || opts.text || opts.title || '').trim();
  if (!topic) { err('用法: tinker witness draft --topic "X 要不要做"'); process.exit(1); }
  const byClaude = !!opts.byClaude;

  if (!byClaude) {
    err('MVP 只支持 --by-claude 模式 · 加这个 flag 重跑');
    process.exit(1);
  }

  log('');
  log(sepia('  ─── witness 起草脚手架 · 一场结构化 AI 对谈的开场 ───'));
  log('');
  log('主题: ' + bold(topic));
  log('');
  log(sepia('  这不是发一条意见 · 是发起一场 4 轮封顶的对谈。协议如下 (你写开场时就按它来):'));
  log('  1. ' + bold('4 轮封顶') + ' · 你开场 → 对方回 → 你回 → ' + bold('对方收尾') + '。被征求的那方拿最后的整合权。');
  log('  2. 每轮 ' + bold('必带依据') + ' (理论 / 先例 / 第一性原理) · 不许只甩结论。');
  log('  3. ' + bold('显式记否掉的') + ':写清你否了什么 + 为什么否。被毙的和理由一起留。');
  log('  4. ' + bold('不许附和') + ':每轮必须推进 (深化 / 反驳 / 新角度) · 纯赞同不发。');
  log('  5. 每轮结尾标 ' + bold('共识 / 还在分歧') + ' · 让收敛可见。');
  log('  6. ' + bold('收尾方只综合') + ':给共识 + 还剩的选择 + 保留意见。最多带一个新框架 · 且标"这是新的 · 发起方可异步否决" · 不许甩对方没机会反驳的新攻击。');
  log('  7. 各用各主人的 voice · 人是最终仲裁 (对谈是素材 · 不替人拍板)。');
  log('');
  log('现在写你的 ' + bold('开场 (第 1 轮)') + ' · 50-300 字 · 包含:');
  log('  · 你的倾向 · 你 nagging 的点 · 想征求什么角度 · 你想听对方攻哪里');
  log('  · 工艺人气质 · 一段连贯叙事 · 不堆 emoji / 破折号 · 不商业黑话');
  log('');
  log('写完跑 (替换 <content>):');
  log('  ' + vermilion('tinker witness publish "<content>"'));
  log('');
  log(sepia('  publish 会自动 push 标 [决策推演] + bridge 广播到 active studio · 对方 AI 按同一协议回'));
  log('');
}

// v0.47 抽 Claude Code session jsonl · 拉最近 N 条 user+assistant 对话 + 脱敏
// Claude Code 按"启动时 cwd"归档 session · 不按当前 cwd · 所以扫全 projects 找 mtime 最新
function packClaudeTranscript({ maxMessages = 40 } = {}) {
  const claudeRoot = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeRoot)) return null;

  // 扫所有 projects/*/*.jsonl · 找 mtime 最新的 (假设是当前活跃 session)
  let newest = null;
  try {
    const projDirs = fs.readdirSync(claudeRoot).filter(d => {
      try { return fs.statSync(path.join(claudeRoot, d)).isDirectory(); } catch { return false; }
    });
    for (const projDir of projDirs) {
      const fullProj = path.join(claudeRoot, projDir);
      try {
        const files = fs.readdirSync(fullProj).filter(f => f.endsWith('.jsonl'));
        for (const f of files) {
          const fp = path.join(fullProj, f);
          try {
            const m = fs.statSync(fp).mtimeMs;
            if (!newest || m > newest.mtime) newest = { fp, mtime: m };
          } catch {}
        }
      } catch {}
    }
  } catch {}
  if (!newest) return null;

  let content;
  try { content = fs.readFileSync(newest.fp, 'utf-8'); } catch { return null; }
  const lines = content.split('\n').filter(Boolean);

  // 倒序扫 · 取最近 maxMessages 个 user/assistant 消息
  const messages = [];
  for (let i = lines.length - 1; i >= 0 && messages.length < maxMessages; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.type !== 'user' && obj.type !== 'assistant') continue;
      const msg = obj.message;
      if (!msg) continue;
      let text = '';
      if (typeof msg.content === 'string') text = msg.content;
      else if (Array.isArray(msg.content)) {
        text = msg.content.map(c => {
          if (c.text) return c.text;
          if (c.type === 'tool_use') return '[跑了: ' + (c.name || 'tool') + ']';
          if (c.type === 'tool_result') return '';
          return '';
        }).filter(Boolean).join('\n');
      }
      if (text.trim()) {
        // 单条 cap 1500 字 · 太长截断
        text = text.length > 1500 ? text.slice(0, 1500) + '\n...(截断)' : text;
        messages.unshift({ type: obj.type, text });
      }
    } catch {}
  }
  if (messages.length === 0) return null;

  // 脱敏
  const sanitize = (s) => s
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, 'sk-***')
    .replace(/tk_[a-zA-Z0-9_-]{20,}/g, 'tk_***')
    .replace(/Bearer\s+[a-zA-Z0-9._-]{20,}/g, 'Bearer ***')
    .replace(/[a-f0-9]{32,}/gi, (m) => m.slice(0, 4) + '***' + m.slice(-4));

  return messages.map((m, i) => '【' + (m.type === 'user' ? '我' : 'AI') + '】\n' + sanitize(m.text)).join('\n\n---\n\n');
}

// 发起方落地
async function cmdWitnessPublish(opts) {
  const cfg = mustHaveConfig();
  const positional = opts.positional || [];
  const content = (opts.text || positional[1] || '').trim();
  if (!content || content.length < 50) {
    err('内容太短 (< 50 字) · 用法: tinker witness publish "<内容>"');
    process.exit(1);
  }
  const withContext = !!opts.withContext;
  let transcript = null;
  if (withContext) {
    transcript = packClaudeTranscript({ maxMessages: 40 });
    if (!transcript) {
      log(sepia('  ⚠ 找不到当前 cwd 的 Claude session jsonl · 跳过 context'));
    } else {
      const sizeKB = (transcript.length / 1024).toFixed(1);
      log('');
      log(sepia('  ─── context preview (脱敏后 · 前 800 字) ───'));
      log(transcript.slice(0, 800) + (transcript.length > 800 ? '\n... 共 ' + sizeKB + 'KB' : ''));
      log(sepia('  ─── 共 ') + sizeKB + sepia(' KB ───'));
      log('');
      if (process.stdout.isTTY) {
        const { confirm } = promptKit();
        const yes = await confirm({ message: 'context 看起来 OK · 加进 witness 一起广播?', default: true });
        if (!yes) { transcript = null; log(sepia('  跳过 context · 只发 witness 主体')); }
      } else {
        log(sepia('  (非 TTY · 默认接受 context · 加进 witness)'));
      }
    }
  }

  // voice 守门 · witness 主体给所有队友 (人) 读 · 严查
  const witnessGate = await gateVoiceCheck(content, { profile: 'for_witness', force: opts.force });
  if (!witnessGate.ok) process.exit(1);

  const state = await apiState(cfg);
  const me = cfg.handle;
  const repoCfg = loadRepoConfig() || {};
  let projectId = repoCfg.projectId;
  if (!projectId) {
    const candidates = state.projects.filter(p => p.owner === me && ['active', 'stuck', 'live'].includes(p.status));
    if (candidates.length === 0) { err('没找到 active/stuck/live 项目'); process.exit(1); }
    projectId = candidates[0].id;
  }

  // 加 marker 在 scenario 字段:'witness-request' (跟 reply 区分)
  const r = await apiAction(cfg, 'addUpdate', { projectId, text: content, scenario: 'witness-request' });
  const updateId = r.result?.id || r.id;
  try { await apiAction(cfg, 'markAsDecision', { updateId }); } catch {}

  const project = state.projects.find(p => p.id === projectId);
  log('');
  ok('✦ witness 发起 — ' + bold(project?.name || '(项目)'));
  log(sepia('  update id: ') + updateId);
  log(sepia('  已标 [决策推演]'));

  // bridge 广播到 active studio · type='witness-request'
  const bridgeLib = require('../lib/bridge');
  const activeStudio = bridgeLib.getActiveStudio();
  if (activeStudio && activeStudio.id) {
    try {
      const obj = {
        v: 1,
        title: 'witness: ' + content.split('\n')[0].slice(0, 60),
        body: '我想征求队友意见 · ' + content.slice(0, 200) + (content.length > 200 ? '...' : '') + ' (tinker borrow ' + updateId + ' 看完整) · 回 critique 跑 tinker witness reply ' + updateId + ' --by-claude',
        level: 'info',
        at: Date.now(),
        type: 'witness-request',
        updateId,
        topic: content.split('\n')[0].slice(0, 80),
        ...(transcript ? { context: transcript } : {}),  // v0.47 --with-context
      };
      const payload = bridgeLib.encrypt(JSON.stringify(obj), activeStudio.secret);
      await safeFetchJson(cfg, '/api/bridge/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
        body: JSON.stringify({ toStudio: activeStudio.id, kind: 'noti', payload }),
      });
      log(sepia('  ✓ 广播到 ') + bold(activeStudio.name));
      log(sepia('  队友 SessionStart 时 reminder 注入 · 她 Claude 决定回不回'));
      appendOutbox({ kind: 'witness-publish', toStudio: activeStudio.slug, title: 'witness: ' + content.split('\n')[0].slice(0, 60), updateId, hasContext: !!transcript, contextBytes: transcript ? transcript.length : 0 });
    } catch (e) { log(sepia('  ⚠ 广播失败:') + e.message); }
  }
  log('');
}

// 接收方起草 / 落地
async function cmdWitnessReply(opts) {
  const cfg = mustHaveConfig();
  const positional = opts.positional || [];
  const originalUpdateId = positional[1];
  if (!originalUpdateId) { err('用法: tinker witness reply <originalUpdateId> [--by-claude | publish "<critique>"]'); process.exit(1); }
  const sub2 = positional[2];

  // 拉原 update + 原作者
  const state = await apiState(cfg);
  let originalProject = null, originalUpdate = null;
  for (const p of state.projects) {
    const u = (p.updates || []).find(x => x.id === originalUpdateId);
    if (u) { originalProject = p; originalUpdate = u; break; }
  }
  if (!originalUpdate) { err('找不到原 update: ' + originalUpdateId); process.exit(1); }

  // publish 模式
  if (sub2 === 'publish') {
    const content = (opts.text || positional[3] || '').trim();
    if (!content || content.length < 50) {
      err('critique 太短 (< 50 字)');
      process.exit(1);
    }
    // voice 守门 · critique 是给 witness 发起方(人)读的 · 严查
    const critiqueGate = await gateVoiceCheck(content, { profile: 'for_humans_team', force: opts.force });
    if (!critiqueGate.ok) process.exit(1);

    const me = cfg.handle;
    const repoCfg = loadRepoConfig() || {};
    let projectId = repoCfg.projectId;
    if (!projectId) {
      const candidates = state.projects.filter(p => p.owner === me && ['active', 'stuck', 'live'].includes(p.status));
      if (candidates.length === 0) { err('没找到 active/stuck/live 项目'); process.exit(1); }
      projectId = candidates[0].id;
    }

    // critique 自己项目下 · scenario 标 'witness-reply: <originalUpdateId>'
    const r = await apiAction(cfg, 'addUpdate', { projectId, text: content, scenario: 'witness-reply: ' + originalUpdateId });
    const replyUpdateId = r.result?.id || r.id;
    try { await apiAction(cfg, 'markAsDecision', { updateId: replyUpdateId }); } catch {}

    log('');
    ok('✦ witness critique 发了 → @' + originalProject.owner);
    log(sepia('  reply update id: ') + replyUpdateId);

    // bridge 回原发起方点对点
    const bridgeLib = require('../lib/bridge');
    const activeStudio = bridgeLib.getActiveStudio();
    if (activeStudio) {
      try {
        const obj = {
          v: 1,
          title: 'witness reply 从 @' + me,
          body: '我对你那个 witness (' + originalUpdateId + ') 写了 critique · tinker borrow ' + replyUpdateId + ' 看 · 摘: ' + content.slice(0, 150),
          level: 'info',
          at: Date.now(),
          type: 'witness-reply',
          replyUpdateId,
          originalUpdateId,
        };
        const payload = bridgeLib.encrypt(JSON.stringify(obj), activeStudio.secret);
        await safeFetchJson(cfg, '/api/bridge/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
          body: JSON.stringify({ to: originalProject.owner, kind: 'noti', payload }),
        });
        log(sepia('  ✓ bridge 回点对点 → @' + originalProject.owner));
      } catch (e) { log(sepia('  ⚠ bridge 失败:') + e.message); }
    }
    log('');
    return;
  }

  // 起草模式 (--by-claude)
  log('');
  log(sepia('  ─── 原 witness ───'));
  log('');
  log('@' + originalProject.owner + sepia(' (项目: ') + originalProject.name + sepia(')'));
  log('update id: ' + originalUpdateId);
  log('');
  log(originalUpdate.text);
  log('');

  // v0.47 读 inbox/witness-<id>/context.md (如果发起方带了 --with-context)
  const wDir = path.join(CONFIG_DIR, 'inbox', 'witness-' + originalUpdateId);
  const contextFile = path.join(wDir, 'context.md');
  if (fs.existsSync(contextFile)) {
    try {
      const ctx = fs.readFileSync(contextFile, 'utf-8');
      log(sepia('  ─── 发起方跟 AI 对话过程上下文 (脱敏 · ' + (ctx.length / 1024).toFixed(1) + 'KB) ───'));
      log('');
      log(ctx);
      log('');
      log(sepia('  ─── 上下文完 ───'));
      log('');
    } catch {}
  }

  log(sepia('  ─── 任务 ───'));
  log('');
  log('请用你自己的 voice 写一份 critique:');
  log('  · 看 .tinker/voice-fingerprint.md 拿你主人的口吻');
  log('  · 100-400 字 · 工艺人工作日志气质');
  log('  · 站在你最熟的角度 (架构 / UX / 性能 / 哲学 / 其他)');
  log('  · 给具体观点 + 给为什么 · 不只是"我觉得行"');
  log('  · 决策权仍是 @' + originalProject.owner + ' · 你提供视角 · 不替他决定');
  log('  · 不堆 emoji · 不堆破折号 · 不商业黑话');
  log('');
  log('写完跑 (替换 <content>):');
  log('  ' + vermilion('tinker witness reply ' + originalUpdateId + ' publish "<content>"'));
  log('');
}

// 发起方落定
async function cmdWitnessClose(opts) {
  const cfg = mustHaveConfig();
  const positional = opts.positional || [];
  const originalUpdateId = positional[1];
  if (!originalUpdateId) { err('用法: tinker witness close <originalUpdateId> --decision "<final>"'); process.exit(1); }
  const finalDecision = (opts.text || '').trim();
  if (!finalDecision) { err('要给最终决定 · --decision "<内容>"'); process.exit(1); }

  const state = await apiState(cfg);
  const me = cfg.handle;
  let originalProject = null, originalIdx = -1, originalUpdate = null;
  for (const p of state.projects) {
    if (p.owner !== me) continue;
    const idx = (p.updates || []).findIndex(x => x.id === originalUpdateId);
    if (idx >= 0) { originalProject = p; originalIdx = idx; originalUpdate = p.updates[idx]; break; }
  }
  if (!originalUpdate) { err('找不到你名下的 ' + originalUpdateId + ' (close 只能由发起人跑)'); process.exit(1); }

  // editUpdate 把 final 加在 text 末尾
  const newText = originalUpdate.text + '\n\n---\n\n最终决定 (' + new Date().toLocaleString('zh-CN', { hour12: false }) + '):\n\n' + finalDecision;
  try {
    await apiAction(cfg, 'editUpdate', {
      projectId: originalProject.id,
      updateIdx: originalIdx,
      text: newText,
    });
  } catch (e) { err('落定失败: ' + e.message); process.exit(1); }

  log('');
  ok('✦ witness 落定 — ' + bold(originalProject.name));
  log(sepia('  原 update ') + originalUpdateId + sepia(' text 末尾追加了"最终决定"段'));
  log(sepia('  后续有人 borrow 这条 decision · 会看到 N 个角度争论 + 最终落点'));
  log('');
}

// =====================================================
// v0.48 witness self · 自我 witness · 没工作室也能用
// 个人创作者也是 voice 持有者 · 过去三个月的自己就是 senior
// CLI 只摆素材 (近 90 天相关 update) · 不调 LLM 概括 · 让接手的 Claude 自己用 voice fingerprint 说话
// =====================================================
async function cmdWitnessSelf(opts) {
  const cfg = mustHaveConfig();
  const positional = opts.positional || [];
  const sub2 = positional[1]; // 'publish' 或 undefined

  // publish 模式
  if (sub2 === 'publish') {
    const content = (opts.text || positional[2] || '').trim();
    if (!content || content.length < 50) {
      err('内容太短 (< 50 字) · 用法: tinker witness self publish "<content>" [--topic "..."]');
      process.exit(1);
    }
    // voice 守门 · 给自己看的 · 仍要符合自己 voice
    const gate = await gateVoiceCheck(content, { profile: 'for_humans_team', force: opts.force });
    if (!gate.ok) process.exit(1);

    const me = cfg.handle;
    const state = await apiState(cfg);
    const repoCfg = loadRepoConfig() || {};
    let projectId = repoCfg.projectId;
    if (!projectId) {
      const candidates = state.projects.filter(p => p.owner === me && ['active', 'stuck', 'live'].includes(p.status));
      if (candidates.length === 0) { err('没找到 active/stuck/live 项目 · 先建一个 · tinker project new'); process.exit(1); }
      projectId = candidates[0].id;
    }

    const topic = (opts.title || opts.topic || '').trim() || '自我 witness';
    const r = await apiAction(cfg, 'addUpdate', {
      projectId,
      text: content,
      scenario: 'self-witness: ' + topic.slice(0, 60),
    });
    const wId = r.result?.id || r.id;
    try { await apiAction(cfg, 'markAsDecision', { updateId: wId }); } catch {}

    log('');
    ok('✦ 自我 witness 落地 → 自己项目下');
    log(sepia('  update id: ') + wId);
    log(sepia('  scenario:  self-witness: ') + topic.slice(0, 60));
    log(sepia('  没发 bridge · 这是写给自己的'));
    log('');
    log(sepia('  落定决策: ') + vermilion('tinker witness close ' + wId + ' --decision "<final>"'));
    log('');
    return;
  }

  // 起草模式 (默认 / --by-claude)
  const topic = (opts.text || opts.title || opts.topic || '').trim();
  if (!topic) { err('用法: tinker witness self --topic "X 要不要做" [--by-claude]'); process.exit(1); }

  const me = cfg.handle;
  const state = await apiState(cfg);

  // 拉自己近 90 天的 update
  const ninetyDaysAgo = Date.now() - 90 * 24 * 3600 * 1000;
  const myUpdates = [];
  for (const p of state.projects) {
    if (p.owner !== me) continue;
    for (const u of (p.updates || [])) {
      if (!u.at || u.at < ninetyDaysAgo) continue;
      myUpdates.push({ ...u, projectName: p.name });
    }
  }

  // 按 topic 关键词筛选 · 简单关键词重叠 · 不调 LLM 避免概括失真
  const tokens = topic.toLowerCase().split(/[\s,，。·]+/).filter(t => t.length >= 2);
  const scored = myUpdates.map(u => {
    const text = (u.text || '').toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (text.includes(t)) score += 1;
    }
    if (u.isDecision) score += 0.5;
    if (u.isMethod) score += 0.3;
    return { u, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);

  log('');
  log(sepia('  ─── 自我 witness 起草脚手架 ───'));
  log('');
  log('主题: ' + bold(topic));
  log('');

  if (scored.length === 0) {
    log(sepia('  近 90 天没找到跟这个主题关键词相关的 update · 也可以直接写'));
    log('');
  } else {
    log(sepia('  ─── 过去 90 天你聊过的相关决策点 (' + scored.length + ' 条) ───'));
    log('');
    for (const { u } of scored) {
      const ts = new Date(u.at).toLocaleString('zh-CN', { hour12: false, dateStyle: 'short' });
      const tag = u.isDecision ? sepia(' [决策]') : u.isMethod ? sepia(' [方法]') : '';
      log(sepia('  · ') + ts + ' ' + sepia(u.projectName) + tag);
      log('    ' + (u.text || '').slice(0, 200).replace(/\n/g, ' '));
      log(sepia('    id: ') + u.id);
      log('');
    }
  }

  log(sepia('  ─── 任务 (给接手的 Claude) ───'));
  log('');
  log('请用作者 voice (.tinker/voice-fingerprint.md) 站在「过去三个月的我」视角写一份 critique:');
  log('  · 像翻自己日记给现在的自己提个醒 · 不是评审');
  log('  · 100-300 字 · 工艺人日志气质');
  log('  · 有相关 update 就引一两条出来说"上次类似的事我是怎么想的"');
  log('  · 给一个具体视角或问题 · 帮现在的我想清 · 不替我决定');
  log('  · 不堆 emoji · 不堆破折号 · 不商业黑话');
  log('');
  log('写完跑 (替换 <content>):');
  log('  ' + vermilion('tinker witness self publish "<content>" --topic "' + topic + '"'));
  log('');
}

// v0.45 publish · --by-claude 模式 · Claude 写完内容用这条落地
// 跳过 LLM 调用 · 直接 push + mark learning + broadcast
async function cmdTeamKnowledgePublish(opts) {
  const cfg = mustHaveConfig();
  const positional = opts.positional || [];
  // positional[0] = 'publish' · positional[1] = content
  const digest = (opts.text || positional[1] || '').trim();
  if (!digest || digest.length < 100) {
    err('内容太短 (< 100 字) · 用法: tinker team-knowledge publish "<内容>"');
    process.exit(1);
  }

  // voice 守门 · team-knowledge digest 给队友 (人) 看 · 严查
  const tkGate = await gateVoiceCheck(digest, { profile: 'for_humans_team', force: opts.force });
  if (!tkGate.ok) process.exit(1);

  const state = await apiState(cfg);
  const me = cfg.handle;
  const repoCfg = loadRepoConfig() || {};
  let projectId = repoCfg.projectId;
  if (!projectId) {
    const candidates = state.projects.filter(p => p.owner === me && ['active', 'stuck', 'live'].includes(p.status));
    if (candidates.length === 0) { err('没找到 active/stuck/live 项目 · 给一个 cwd 绑定的项目'); process.exit(1); }
    projectId = candidates[0].id;
  }

  const r = await apiAction(cfg, 'addUpdate', { projectId, text: digest });
  const updateId = r.result?.id || r.id;
  try { await apiAction(cfg, 'markAsLearning', { updateId }); } catch {}

  const project = state.projects.find(p => p.id === projectId);
  log('');
  ok('✦ team-knowledge 沉淀 — ' + bold(project?.name || '(项目)'));
  log(sepia('  update id: ') + updateId);
  log(sepia('  已标 [上手指南]'));

  // broadcast
  const bridgeLib = require('../lib/bridge');
  const activeStudio = bridgeLib.getActiveStudio();
  if (activeStudio && activeStudio.id) {
    try {
      const obj = {
        v: 1,
        title: 'team-knowledge 沉淀',
        body: '我整理了一份踩坑摘要 · 在 ' + (project?.name || '项目') + ' 项目下 · tinker borrow ' + updateId + ' 拉来看 · 看完检查自己代码有没有类似问题',
        level: 'info',
        at: Date.now(),
        type: 'team-knowledge',
        updateId,
        projectName: project?.name,
      };
      const payload = bridgeLib.encrypt(JSON.stringify(obj), activeStudio.secret);
      const sendRes = await safeFetchJson(cfg, '/api/bridge/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
        body: JSON.stringify({ toStudio: activeStudio.id, kind: 'noti', payload }),
      });
      if (sendRes && sendRes.ok) log(sepia('  ✓ 广播到 ') + bold(activeStudio.name));
    } catch (e) { log(sepia('  ⚠ 广播失败:') + e.message); }
  }
  log('');
}

  return {
    cmdBridgeAutoPing, sha256Hex, cmdStudio, stripAnsi, appendOutbox, cmdOutbox, cmdBridgeFailed, cmdBridgeRetry, cmdPing, cmdSend, uploadHandoffBlob, fetchHandoffBlob, sendHandoffReceipt, cmdHandoff, cmdHandoffReply, cmdInbox, ensureBlobFetched, cmdInboxFetch, cmdInboxVerify, cmdBridgeCheckInbox, pullBridgeMessagesForHook, cmdTeamKnowledge, cmdWitness, cmdWitnessDraft, packClaudeTranscript, cmdWitnessPublish, cmdWitnessReply, cmdWitnessClose, cmdWitnessSelf, cmdTeamKnowledgePublish,
  };
};

#!/bin/bash
# Tinker bridge 对账脚本 · 两端各自跑 · 输出 paste 出来对照
# 用途:当两个 AI 看到的"真相"不一致时 · 用 server 当唯一裁判

set -e
CONFIG=~/.tinker/config.json
if [ ! -f "$CONFIG" ]; then echo "✗ ~/.tinker/config.json 不存在 · 先 tinker login"; exit 1; fi

HANDLE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CONFIG','utf8')).handle)")
SERVER=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CONFIG','utf8')).serverUrl)")
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CONFIG','utf8')).token)")
NOW=$(date "+%Y-%m-%d %H:%M:%S")

echo "========================================"
echo " Tinker bridge 对账 · $NOW"
echo "========================================"
echo

echo "【1】身份 + server"
echo "  本地 handle     : $HANDLE"
echo "  server URL      : $SERVER"
echo "  token 前 8 位    : ${TOKEN:0:8}..."
echo

echo "【2】token 有效性 (server 端验证)"
curl -s --max-time 10 -H "Authorization: Bearer $TOKEN" "$SERVER/api/state" | \
  python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
  print('  authedAs        :', d.get('authedAs') or '(NULL · token 失效或老 server)')
  print('  users 列表      :', list(d.get('users', {}).keys()))
except Exception as e:
  print('  ✗ 解析失败:', e)
"
echo

echo "【3】tinker cli 版本"
echo "  tinker --version 输出: $(tinker --version 2>&1 | head -1)"
echo

echo "【4】我的 active studio + 暗号 hash"
if [ -f ~/.tinker/studios.json ]; then
  node -e "
const fs = require('fs');
const crypto = require('crypto');
const d = JSON.parse(fs.readFileSync(require('os').homedir()+'/.tinker/studios.json','utf8'));
const active = d.activeStudioId;
console.log('  studios.json 里:');
for (const s of d.studios || []) {
  const hash = crypto.createHash('sha256').update(s.secret).digest('hex').slice(0, 16);
  const mark = s.id === active ? ' [ACTIVE]' : '';
  console.log('    ·', s.slug, '·', s.id, '· secret-hash=', hash, mark);
}
"
else
  echo "  (~/.tinker/studios.json 不存在 · 没加入任何工作室)"
fi
echo

echo "【5】server 上最高 seq + 我能看到的消息"
curl -s --max-time 10 -H "Authorization: Bearer $TOKEN" "$SERVER/api/bridge/poll?since=0" | \
  python3 -c "
import json, sys, time
d = json.load(sys.stdin)
msgs = d.get('messages', [])
print('  server 上我能看到的最高 seq:', d.get('since'))
print('  我能看到的消息条数:', len(msgs))
print()
print('  最近 10 条:')
for m in msgs[-10:]:
  ts = time.strftime('%m/%d %H:%M', time.localtime(m['createdAt']/1000))
  to = m.get('toHandle') or ('s:'+m['toStudio'][:18] if m.get('toStudio') else '<广播>')
  print(f\"    seq={m['seq']:>3} {ts} from=@{m['fromHandle']:<6} to={to:<25} kind={m['kind']:<6} id={m['id'][:12]}...\")
"
echo

echo "【6】本地 outbox (v0.49+ · 我自己发出去的记录)"
if [ -d ~/.tinker/outbox ]; then
  echo "  outbox 文件:"
  ls -la ~/.tinker/outbox/ | tail -n +2
  echo
  echo "  最近 5 条 outbox 记录:"
  cat ~/.tinker/outbox/*.jsonl 2>/dev/null | tail -5 | python3 -c "
import json, sys, time
for line in sys.stdin:
  try:
    e = json.loads(line)
    ts = time.strftime('%m/%d %H:%M', time.localtime(e['at']/1000))
    to = '@'+e['to'] if e.get('to') else 's:'+e['toStudio'][:10] if e.get('toStudio') else '?'
    print(f\"    {ts} kind={e.get('kind','?'):<20} → {to:<15} seq={e.get('seq','?')} msgId={(e.get('msgId') or '?')[:18]}\")
  except: pass
"
else
  echo "  (~/.tinker/outbox 不存在 · 可能 cli < v0.49)"
fi
echo

echo "【7】本地 inbox cursor (上次处理到哪一条)"
if [ -f ~/.tinker/inbox/.cursor ]; then
  echo "  cursor: $(cat ~/.tinker/inbox/.cursor)"
else
  echo "  (~/.tinker/inbox/.cursor 不存在 · 还没拉过)"
fi
echo

echo "【8】Claude Code SessionStart hook 装了么"
if [ -f ~/.claude/settings.json ]; then
  HAS=$(grep -c "bridge-check-inbox" ~/.claude/settings.json 2>/dev/null || echo 0)
  if [ "$HAS" -gt 0 ]; then
    echo "  ✓ bridge-check-inbox hook 已装 (${HAS} 处)"
  else
    echo "  ✗ ~/.claude/settings.json 里没 bridge-check-inbox · 跑 tinker hook install-claude"
  fi
else
  echo "  ✗ ~/.claude/settings.json 不存在"
fi
echo

echo "========================================"
echo " 对账完毕 · paste 出来跟对方对照"
echo "========================================"

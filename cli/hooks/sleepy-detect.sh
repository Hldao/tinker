#!/bin/bash
# Tinker · UserPromptSubmit hook
# 听到 "晚安 / 收工 / 累了" 等收工类话 → 跑 tinker maybe-goodnight
# 命中条件 → maybe-goodnight 输出一行 reminder · 走 stdout 注入 Claude Code 对话
# 不命中 → 静默 exit 0
#
# 装: ~/.claude/settings.json hooks.UserPromptSubmit 指向这个脚本
# 跑: 由 Claude Code 自动调用 · 每次用户提交 prompt 前

set -e

# 读 stdin JSON · 取 prompt 字段
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | /usr/bin/python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('prompt',''), end='')" 2>/dev/null || echo "")

# 空 prompt → 静默
[ -z "$PROMPT" ] && exit 0

# 收工类关键词 · 严格列表 · 避免 "累了去找咖啡" 误触发
# 用 awk 正则匹配 · 不依赖 grep -P (mac BSD grep 不带 PCRE)
HIT=$(echo "$PROMPT" | awk '
  /晚安|收工|今天就这样|今天先这样|今晚先这样|去睡了|睡觉了|要睡了|睡了|明天再说|明儿再说|不做了|今天不做了|累了今天|今天累了|休息了|休息一下今天/ { print "1"; exit }
  /^[[:space:]]*(gn|good ?night|bye)[[:space:]!.~]*$/ { print "1"; exit }
')

[ -z "$HIT" ] && exit 0

# 命中 · 跑 tinker maybe-goodnight · 它自己判断今日是否值得收尾
# stdout 输出（如果有）会被 Claude Code 当作 additional context 注入对话
OUTPUT=$(tinker maybe-goodnight 2>/dev/null || echo "")
[ -z "$OUTPUT" ] && exit 0

# 输出 reminder · 包成 system-reminder 让 Claude Code 当上下文看
printf '<system-reminder>\n[tinker · 收工感知器]\n%s</system-reminder>\n' "$OUTPUT"

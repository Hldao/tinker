---
name: tinker-todo
description: 帮 Tinker 用户记待办、勾完成、派活、把个人待办同步成团队任务。涉及 tinker todo add/list/done/reopen/rm/assign/promote。待办是私密协作层(个人只自己见 / 团队工作室成员互见)，不进公开 feed，跟 push/ship 那种公开进展分开。用户说"记个待办 / 回头做 / 这事别忘 / 派给某某 / 我有哪些待办"这类话时看这个。
---

# 待办：todo add / list / done / assign / promote

待办是 Tinker 的**私密协作层**，跟公开的进展分开：

- **personal** 个人待办 · 只有本人看得见
- **team** 团队任务 · 同一个工作室的成员之间互见 · 但对 Tinker 大众不公开
- 两层都**不进公开 feed**。要发公开进展用 `tinker push`，不是 todo。

## 命令一览

- `tinker todo` 或 `tinker todo list` 看待办（分个人/团队，未完的在上面，每条带后 6 位短 id）
- `tinker todo add "买菜"` 记一条个人待办（也可以 `-m "买菜"`）
  - `--due 2026-07-10` 加截止日期
  - `--team` 记成团队任务（默认放你唯一的工作室；在多个工作室里就用 `--studio <slug>` 指定）
  - `-t @handle` 团队任务直接派给某人
- `tinker todo done <短id>` 勾完成（`--undo`，或 `tinker todo reopen <短id>` 重新打开）
- `tinker todo rm <短id>` 删（只能删自己建的）
- `tinker todo assign <短id> -t @handle` 把团队任务派给某人
- `tinker todo promote <短id> [--studio <slug>] [-t @handle]` 把个人待办同步成团队任务，摆上团队台面
- id 用 list 里显示的**后 6 位**就行（待办 id 是 UUIDv7，区分度在尾部）。所有子命令都支持 `--json`

## 什么时候主动帮用户记

用户说这类话、且确实是件要做的事（不是随口）时，可以建议或直接帮他 `tinker todo add`：

- "记个待办 / 回头做 / 这事别忘了 / 加个 todo" → 个人待办
- "这个派给猫猫 / 让某某去做" → 团队任务 + `-t @猫猫`（handle 别猜拼音，是 `@猫猫` 不是 `@maomao`，写错对方收不到）
- "我这周要做啥 / 看下待办 / 还有啥没做" → `tinker todo list`

**跟 push 的分界线**：待办 = 还没做的事（私密）；push = 已经做完的进展（公开）。别把待办发成公开 update，也别把已完成的进展记成待办。

## 注意

- 待办**不走 voice 守门**（不是对外发布的内容，怎么写都行，不用像 push 那样避 AI 腔）。
- 团队任务要你在那个工作室里才能建、才能派；派给的人也得是工作室成员。
- 团队任务只有**创建者**能删（免得误删别人派的活）。

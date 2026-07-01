---
name: tinker-borrow
description: Tinker 方法库。用户聊到某项技术、撞到报错、想入门一个新东西时，先去方法库搜别人的手艺注入回答；用户做通了一件别人能复用的事、想沉淀成方法，或缺个方法想求人指路时，帮他标记 / 发求方法。涉及 tinker borrow / seek / contribute / mark-experience / mark-learning / mark-decision。
---

# 方法库：borrow / seek / contribute

## 搜别人的手艺（borrow）

用户聊到某技术、报错、想入门 X 时，先搜方法库，把别人踩过的路注入你的回答：

```bash
tinker borrow "<关键词>" --json --limit 5
tinker borrow "<关键词>" --kind learning   # 限定类型：method / experience / learning / decision
tinker borrow <updateId>                    # 直接拉某条详情
```

搜到有用的，复述 1-2 句要点给用户，别整段贴。用了别人的方法，`tinker used <updateId>` 给作者一个真实复用反馈。

## 沉淀方法（contribute）

用户做通了一件别人能复用的事，说"把这个沉淀成方法 / 存成方法"：

```bash
tinker contribute [updateId]   # 把某条 update 升格成方法，进方法库
```

按性质细分升格：

- `tinker mark-experience <updateId>` 踩坑经验，别人撞到同样坑能学
- `tinker mark-learning <updateId>` 上手指南，帮别人快速入门新技术
- `tinker mark-decision <updateId>` 决策推演，工具/方案选型留痕

## 求方法（seek）

用户说"帮我发个求方法 / 我缺个 X 的方法 / 求人指路"：

```bash
tinker seek -m "缺什么方法"
```

进方法库的「有人在找」。**注意：这不是 ship 的求反馈**，两者别混。

## 判断

聊到技术就 borrow 基本安全，成本低收益高。contribute / seek 是动作类，看上下文判断是不是真到那一步了，别用户随口一提就发。

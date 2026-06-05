# 贡献指南

> **在加任何功能之前**，请先读 [`docs/01-product-spec.md`](docs/01-product-spec.md) 的 8+1 哲学。
> Tinker 的核心是"做减法比做加法需要更多勇气"。

## 本地开发

```bash
# server
cd server
cp .env.example .env       # 编辑配置
npm install
node index.js              # http://localhost:8788

# webapp 自动通过 server 静态服务
# 没有独立 build 步骤
# 浏览器访问 http://localhost:8788/

# CLI (可选)
cd ../cli
npm install
npm link                   # 全局 `tinker`
tinker login
```

## 跑测试

```bash
cd server
node --test test/*.test.js   # 全部测试 (built-in · 无依赖)
node --test test/actions.test.js   # 单文件
```

## 哲学速查 — 加新功能前必问 9 个问题

1. **工程**: 长期维护成本?
2. **法律**: 合规红线?
3. **情感**: 让用户更焦虑还是更安心?
4. **真实**: 让数据更真实还是更"看起来繁荣"?
5. **运营**: 上线后谁来持续维护?
6. **行为可执行性**: 用户那个时刻真的会做这个操作吗?
7. **视角对称性**: 不同用户群体的能力/信息差异是什么?
8. **情感时刻不数据化**: 把善意/事件商品化吗?
9. **反技术中心化**: 假设用户懂代码吗? 不懂代码的人能用吗?

**任一答案不理想 → 默认不做。**

## 不做清单 (写进规则)

| 不做 | 哲学 |
|---|---|
| 推荐算法 / 热门 / trending | 第 8 条 真实 > 看起来繁荣 |
| 点赞总数 / 收藏数 / 浏览量 | §6.7 不数据化 |
| 等级 / 守护者 / verified | §6.7 |
| 粉丝数 / 关注者数显示 | §6.7 |
| "X 天月入 $Y" 标题党 | §11 反 AI 焦虑营销 |
| 引诱通知 / 红点焦虑 | §6 |
| 编辑推荐 / 周报 / 热门项目 | 第 8 条 |
| 嵌套评论盖楼 | 战场化 |
| 黑话造梗 / 周边 | 第 6 条 |

## 代码风格

- **JavaScript** (不用 TypeScript · 保持简单)
- **prettier 默认配置** (已有 `.prettierrc.json`)
- **不引入复杂依赖**，能用 Node built-in 就不装包

## Commit message 规范

```
<type>(<scope>): <subject>

<body 多行 · 说明 why 不只是 what>

Co-Authored-By: ... <如有>
```

Types: `feat` `fix` `refactor` `docs` `test` `infra` `deploy` `chore`

示例:
```
feat(server): 加 setUserHandle 让小伙伴开自己工作室

alpha 期不做认证 · trust 用户填的 handle · 不存在则创建。
后期加 OAuth 时这里要改。
```

## PR 流程

1. fork 到自己的 fork
2. 开 branch: `git checkout -b feat/xxx`
3. 跑测试: `node --test test/`
4. 跑 prettier (可选): `npx prettier --write server/`
5. 推到自己的 fork
6. 开 PR · 描述里说**这条 PR 怎么过 9 个判断问题**

## 砍功能比加功能更值得 PR

我们更欢迎"我删除了 X · 因为它违反 §Y"这种 PR。具体例子参考 prototype v0.13 那次"砍 5 项过度设计"的 commit。

## 联系

- Issues: <https://github.com/Hldao/tinker/issues>
- 维护者: @Hldao

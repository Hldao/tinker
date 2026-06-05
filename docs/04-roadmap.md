# Roadmap

> 这份 roadmap 是判断"什么时候做什么"的备忘 · 不是承诺。
> 优先级会随真实用户反馈调整。

## v0.2 (现在 · 2026-06)
- [x] 生产化基础设施 (atomic write / 日志 / rate limit / 健康检查)
- [x] 多用户支持 (alpha · trust handle)
- [x] 真实时间戳 (at instead of ago strings)
- [x] Docker + 部署 runbook
- [x] 20 个 actions 测试
- [ ] 部署到真实 VPS + 真域名 (用户处理中)
- [ ] CI 推送 `.github/workflows/ci.yml` (gh OAuth scope 问题)

## v0.3 (alpha → beta 过渡 · 待小伙伴反馈后定)

按优先级:

### 高优先 (用户反馈强烈才做)
- **OAuth 真实认证**: 让多人用更安全 · GitHub OAuth 最自然
- **SQLite 迁移**: JSON 文件多写并发瓶颈
- **数据备份到对象存储**: cron + ossutil
- **Sentry 集成**: 错误追踪
- **UptimeRobot 监控**: 5min 健康轮询

### 中优先 (alpha 期间观察是否真需要)
- **数据导出**: 用户主权 · export 自己的全部数据 JSON
- **删除工作室 / 项目**: 当前只能 archive · V2 给真删
- **handle 冲突保护**: 注册时检查 + 改名 token
- **手机响应式**: 当前桌面优先 · 手机能看但不顺
- **PWA**: addToHomescreen 体验

### 低优先 (可能砍)
- **CLI 多 commit 总结**: 已部分实现 (`--since`) · 更好的 LLM prompt
- **CLI VSCode/Cursor 扩展**: 看 CLI 是否真有人用再说
- **实时同步 (SSE/WebSocket)**: 当前用户量没必要
- **离线写入 (PWA + queue)**: 用户反馈再说

## v1.0 (生产 · 多个独立用户群)

候选功能 · 但必须先验证假设:
- **多租户**: 不同团队独立 server 不混
- **付费 / Hobby / Pro plan**: 如果商业化
- **Email / Web 通知 / 微信集成**: 离线召回
- **AI 助手 panel**: 帮创作者总结自己的进展

## 永远不做 (写进哲学)

- **推荐算法 / 热门 / trending**
- **点赞总数 / 浏览量 / 粉丝数**
- **等级 / verified 徽章**
- **打卡 / 连续天数 / streak**
- **AI 焦虑营销内容** ("X 天月入 $Y")
- **嵌套盖楼评论**
- **黑话造梗 / 实体周边**

详见 [`docs/01-product-spec.md`](01-product-spec.md) 的不做清单。

## 决策原则

每个 roadmap 项目落地前过 9 个判断问题:
1. 工程 / 2. 法律 / 3. 情感 / 4. 真实 / 5. 运营
6. 行为可执行性 / 7. 视角对称性
8. 情感时刻不数据化 / 9. 反技术中心化

**任一项答案不理想 → 默认不做。**

## 我们怎么决定优先级

按 (按高 → 低):
1. **不做就阻塞 alpha 用户继续用** (e.g. handle 冲突 / 数据丢)
2. **真实用户反馈"我想要 X"** 且不违反哲学
3. **降低我们维护负担** (e.g. 监控 · 备份)
4. **拓展场景** (e.g. CLI · 扩展)

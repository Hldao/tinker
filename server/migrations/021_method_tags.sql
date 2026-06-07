-- v0.84 方法主题 tag · 让方法可按 #主题 跨用户聚类
-- 比如 #supabase #auth #部署 · 用户搜某主题能找到所有相关方法
--
-- 设计选择: 用 JSON TEXT 列存数组 · 不建 method_tags 关系表
-- 理由:
-- - tag 列表查询少 · 主要是按 tag 显示 (前端 group by 在 webapp 算)
-- - 数据量 < 1000 时 · JSON 性能完全足够 · 不需 relation 表 + JOIN
-- - 编辑简单: UPDATE methods SET tags = ? WHERE id = ? 一行搞定
-- - 后续如果按 tag 跨用户查 · 加 LIKE 查就行
--
-- 格式: '["supabase","auth"]' (JSON 数组 string)
-- 空 / 没 tag: NULL

ALTER TABLE methods ADD COLUMN tags TEXT;

-- v0.78 backfill: 给 v0.78 之前 contribute 的 3 段 petfinder 哲学补 scenario
-- 这是 v0.78 加 scenario 字段那次 dogfood 的副作用 · 当时 LLM reason 没存
-- migration runner 跑一次 · 后续 update 都走 addUpdate 的 scenario 路径
--
-- 数据来源: contribute --from-file --auto 输出的 LLM picks reasoning
-- 跑 N 次结果一样 (UPDATE 本身幂等) · 但 runner 只跑一次

UPDATE updates SET scenario = '揭示理论闭环与用户真实行为的落差 · 给出可复用的检查方法'
  WHERE id = 'u-1780831404176rrv3' AND (scenario IS NULL OR scenario = '');

UPDATE updates SET scenario = '指出多用户场景的信息能力差异 · 避免一刀切设计'
  WHERE id = 'u-17808314042795qop' AND (scenario IS NULL OR scenario = '');

UPDATE updates SET scenario = '记录砍掉的功能及其代价 · 防止后人重蹈覆辙'
  WHERE id = 'u-17808314043358fx3' AND (scenario IS NULL OR scenario = '');

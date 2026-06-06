-- ============================================================
-- 合并账号: @daodao (seed 占位) → @380855352 (真实邮箱注册)
-- 最终结果: 单一 @daodao 账号，绑定真实邮箱 380855352@qq.com，
--          拥有所有原 daodao 项目 + 380855352 自己的数据
--
-- 执行步骤:
--   1. 先跑 PART 1 看 dry-run 数字，确认合并范围
--   2. 跑 PART 2 实际合并 (一个 TRANSACTION，失败自动回滚)
--   3. 跑 PART 3 验证结果
--
-- ECS 上执行:
--   docker exec -i tinker-server sqlite3 /data/tinker.db < merge-daodao-to-380855352.sql
-- 或者进容器交互式跑:
--   docker exec -it tinker-server sqlite3 /data/tinker.db
--   .read /path/to/merge-daodao-to-380855352.sql
-- ============================================================

.headers on
.mode column
.width 12 20 30 20 50

-- ============================================================
-- PART 1 · DRY RUN: 看会改多少行
-- ============================================================

SELECT '==[ 当前两个用户 ]==' AS step;
SELECT id, handle, email, name, tagline FROM users WHERE handle IN ('daodao', '380855352');

SELECT '==[ daodao 名下的项目 (会过户) ]==' AS step;
SELECT id, name, slug, status FROM projects
  WHERE owner_id = (SELECT id FROM users WHERE handle='daodao');

SELECT '==[ daodao 在各表的 user_id 引用数 ]==' AS step;
SELECT 'projects.owner_id' AS tbl,
       (SELECT COUNT(*) FROM projects WHERE owner_id = (SELECT id FROM users WHERE handle='daodao')) AS cnt;
SELECT 'method_used' AS tbl,
       (SELECT COUNT(*) FROM method_used WHERE user_id = (SELECT id FROM users WHERE handle='daodao')) AS cnt;
SELECT 'reactions' AS tbl,
       (SELECT COUNT(*) FROM reactions WHERE user_id = (SELECT id FROM users WHERE handle='daodao')) AS cnt;
SELECT 'tinkered' AS tbl,
       (SELECT COUNT(*) FROM tinkered WHERE user_id = (SELECT id FROM users WHERE handle='daodao')) AS cnt;
SELECT 'notes' AS tbl,
       (SELECT COUNT(*) FROM notes WHERE user_id = (SELECT id FROM users WHERE handle='daodao')) AS cnt;
SELECT 'notifications.target' AS tbl,
       (SELECT COUNT(*) FROM notifications WHERE target_user_id = (SELECT id FROM users WHERE handle='daodao')) AS cnt;
SELECT 'notifications.from' AS tbl,
       (SELECT COUNT(*) FROM notifications WHERE from_user_id = (SELECT id FROM users WHERE handle='daodao')) AS cnt;
SELECT 'api_tokens' AS tbl,
       (SELECT COUNT(*) FROM api_tokens WHERE user_id = (SELECT id FROM users WHERE handle='daodao')) AS cnt;
SELECT 'sessions' AS tbl,
       (SELECT COUNT(*) FROM sessions WHERE user_id = (SELECT id FROM users WHERE handle='daodao')) AS cnt;
SELECT 'auth_tokens' AS tbl,
       (SELECT COUNT(*) FROM auth_tokens WHERE user_id = (SELECT id FROM users WHERE handle='daodao')) AS cnt;

SELECT '==[ 380855352 已有数据 (合并后保留 · 跟 daodao 数据合体) ]==' AS step;
SELECT 'projects.owner_id' AS tbl,
       (SELECT COUNT(*) FROM projects WHERE owner_id = (SELECT id FROM users WHERE handle='380855352')) AS cnt;
SELECT 'reactions' AS tbl,
       (SELECT COUNT(*) FROM reactions WHERE user_id = (SELECT id FROM users WHERE handle='380855352')) AS cnt;
SELECT 'tinkered' AS tbl,
       (SELECT COUNT(*) FROM tinkered WHERE user_id = (SELECT id FROM users WHERE handle='380855352')) AS cnt;
SELECT 'method_used' AS tbl,
       (SELECT COUNT(*) FROM method_used WHERE user_id = (SELECT id FROM users WHERE handle='380855352')) AS cnt;
SELECT 'sessions' AS tbl,
       (SELECT COUNT(*) FROM sessions WHERE user_id = (SELECT id FROM users WHERE handle='380855352')) AS cnt;

-- ============================================================
-- PART 2 · 实际合并 (TRANSACTION 包裹 · 任何 step 出错自动回滚)
-- ============================================================

SELECT '==[ 开始合并 · TRANSACTION ]==' AS step;

BEGIN TRANSACTION;

-- 2a. projects.owner_id: daodao → 380855352
UPDATE projects SET owner_id = (SELECT id FROM users WHERE handle='380855352')
  WHERE owner_id = (SELECT id FROM users WHERE handle='daodao');

-- 2b. method_used.user_id (复合主键 update_id+user_id · OR IGNORE 防冲突)
UPDATE OR IGNORE method_used SET user_id = (SELECT id FROM users WHERE handle='380855352')
  WHERE user_id = (SELECT id FROM users WHERE handle='daodao');

-- 2c. reactions.user_id (复合主键 project_id+user_id+type · OR IGNORE 防冲突)
UPDATE OR IGNORE reactions SET user_id = (SELECT id FROM users WHERE handle='380855352')
  WHERE user_id = (SELECT id FROM users WHERE handle='daodao');

-- 2d. tinkered.user_id (UNIQUE parent_project_id+user_id · OR IGNORE 防冲突)
UPDATE OR IGNORE tinkered SET user_id = (SELECT id FROM users WHERE handle='380855352')
  WHERE user_id = (SELECT id FROM users WHERE handle='daodao');

-- 2e. notes.user_id (无 UNIQUE 约束 · 直接 UPDATE)
UPDATE notes SET user_id = (SELECT id FROM users WHERE handle='380855352')
  WHERE user_id = (SELECT id FROM users WHERE handle='daodao');

-- 2f. notifications.target_user_id + from_user_id
UPDATE notifications SET target_user_id = (SELECT id FROM users WHERE handle='380855352')
  WHERE target_user_id = (SELECT id FROM users WHERE handle='daodao');
UPDATE notifications SET from_user_id = (SELECT id FROM users WHERE handle='380855352')
  WHERE from_user_id = (SELECT id FROM users WHERE handle='daodao');

-- 2g. api_tokens / sessions / auth_tokens
UPDATE api_tokens SET user_id = (SELECT id FROM users WHERE handle='380855352')
  WHERE user_id = (SELECT id FROM users WHERE handle='daodao');
UPDATE sessions SET user_id = (SELECT id FROM users WHERE handle='380855352')
  WHERE user_id = (SELECT id FROM users WHERE handle='daodao');
UPDATE auth_tokens SET user_id = (SELECT id FROM users WHERE handle='380855352')
  WHERE user_id = (SELECT id FROM users WHERE handle='daodao');

-- 2h. 给 daodao 改名 (占住 handle 占位 · 避免下一步 UNIQUE 冲突)
UPDATE users SET handle = '__daodao_archived' WHERE handle = 'daodao';

-- 2i. 把 380855352 重命名为 daodao
--     name 字段: 如果是默认 '380855352' 改成 '捣鼓自己'，否则保留
--     tagline: 如果是默认 '刚进来捣鼓...' 或空，恢复成 daodao 原 tagline
UPDATE users
SET handle = 'daodao',
    name = CASE
      WHEN name = '380855352' OR name IS NULL OR name = ''
        THEN '捣鼓自己'
      ELSE name
    END,
    tagline = CASE
      WHEN tagline IS NULL OR tagline = '' OR tagline = '刚进来捣鼓...'
        THEN '在做 Tinker · 也喜欢看别人怎么捣鼓小东西'
      ELSE tagline
    END,
    updated_at = strftime('%s', 'now') * 1000
WHERE handle = '380855352';

-- 2j. 删掉占位的 __daodao_archived (CASCADE 自动清残留 sub-row)
DELETE FROM users WHERE handle = '__daodao_archived';

COMMIT;

-- ============================================================
-- PART 3 · 验证结果
-- ============================================================

SELECT '==[ 合并后 · 现存所有用户 ]==' AS step;
SELECT id, handle, email, name, tagline FROM users;

SELECT '==[ 合并后 · daodao 拥有的项目 ]==' AS step;
SELECT id, name, slug, status FROM projects
  WHERE owner_id = (SELECT id FROM users WHERE handle='daodao');

SELECT '==[ 合并后 · daodao 的统计 ]==' AS step;
SELECT 'projects' AS tbl,
       (SELECT COUNT(*) FROM projects WHERE owner_id = (SELECT id FROM users WHERE handle='daodao')) AS cnt
UNION ALL SELECT 'reactions',
       (SELECT COUNT(*) FROM reactions WHERE user_id = (SELECT id FROM users WHERE handle='daodao'))
UNION ALL SELECT 'tinkered',
       (SELECT COUNT(*) FROM tinkered WHERE user_id = (SELECT id FROM users WHERE handle='daodao'))
UNION ALL SELECT 'method_used',
       (SELECT COUNT(*) FROM method_used WHERE user_id = (SELECT id FROM users WHERE handle='daodao'))
UNION ALL SELECT 'notes',
       (SELECT COUNT(*) FROM notes WHERE user_id = (SELECT id FROM users WHERE handle='daodao'))
UNION ALL SELECT 'sessions',
       (SELECT COUNT(*) FROM sessions WHERE user_id = (SELECT id FROM users WHERE handle='daodao'));

SELECT '==[ 合并完成 · session 不会断 · 浏览器刷新就能看到 ]==' AS step;

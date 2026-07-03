-- v1.x 待办 · 私密协作层 · 不进公开 feed(决策:待办私密层 / 进展保持公开)
-- 两个 scope:
--   personal · 只有 owner 自己看得见
--   team     · 工作室成员之间看得见 · 但对 Tinker 大众不公开
-- 互通:团队任务派给个人(assignee_id)· 个人任务同步成团队(scope personal→team + 填 studio_id)

CREATE TABLE IF NOT EXISTS todos (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL DEFAULT 'personal',   -- personal | team
  owner_id    TEXT NOT NULL,                        -- 创建者
  assignee_id TEXT,                                 -- 负责人(团队任务用 · 空 = 待认领)
  studio_id   TEXT,                                 -- 团队任务归哪个工作室(personal 时为空)
  text        TEXT NOT NULL,
  due         TEXT,                                 -- ISO 日期 YYYY-MM-DD · 可空
  done        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  done_at     INTEGER,
  FOREIGN KEY (owner_id)    REFERENCES users(id)   ON DELETE CASCADE,
  FOREIGN KEY (assignee_id) REFERENCES users(id)   ON DELETE SET NULL,
  FOREIGN KEY (studio_id)   REFERENCES studios(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_todos_owner    ON todos(owner_id);
CREATE INDEX IF NOT EXISTS idx_todos_assignee ON todos(assignee_id);
CREATE INDEX IF NOT EXISTS idx_todos_studio   ON todos(studio_id);

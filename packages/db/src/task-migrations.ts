/**
 * The task store's schema.
 *
 * These are **authoritative** state: tasks, their relations and their history.
 * They are never rebuilt from a disposable index, and an index rebuild that
 * fails must not touch a single row here.
 *
 * The tables live in the same database as the project registry, because a
 * task belongs to a project and the project id is the foreign key.
 */

export interface TaskMigration {
  version: number
  name: string
  sql: string
}

export const TASK_MIGRATIONS: readonly TaskMigration[] = [
  {
    version: 1,
    name: "tasks",
    sql: `
      CREATE TABLE IF NOT EXISTS tasks (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        public_key    TEXT NOT NULL,
        title         TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        acceptance    TEXT NOT NULL DEFAULT '',
        type          TEXT NOT NULL DEFAULT 'feature',
        state         TEXT NOT NULL
                      CHECK(state IN ('backlog','ready','in_progress','review','done','archived')),
        priority      INTEGER NOT NULL DEFAULT 2 CHECK(priority BETWEEN 0 AND 3),
        worktree_id   TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
        verification  TEXT NOT NULL DEFAULT 'not_configured'
                      CHECK(verification IN ('not_configured','not_run','passed','failed','stale','waived')),
        waiver_actor  TEXT,
        waiver_reason TEXT,
        waiver_scope  TEXT,
        waiver_at     INTEGER,
        revision      INTEGER NOT NULL DEFAULT 1,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        UNIQUE(project_id, public_key)
      );

      CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id, state);
      CREATE INDEX IF NOT EXISTS tasks_worktree ON tasks(worktree_id);

      CREATE TABLE IF NOT EXISTS task_edges (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        from_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        to_task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        relation   TEXT NOT NULL CHECK(relation IN ('blocks','parent','related')),
        created_at INTEGER NOT NULL,
        CHECK(from_task_id <> to_task_id),
        UNIQUE(from_task_id, to_task_id, relation)
      );

      CREATE INDEX IF NOT EXISTS task_edges_project ON task_edges(project_id);
      CREATE INDEX IF NOT EXISTS task_edges_to ON task_edges(to_task_id);
      CREATE INDEX IF NOT EXISTS task_edges_from ON task_edges(from_task_id);

      -- The audit ledger. Append-only: a task's history is a record of what
      -- happened, not a view of the current row.
      CREATE TABLE IF NOT EXISTS task_events (
        id           TEXT PRIMARY KEY,
        task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        sequence     INTEGER NOT NULL,
        actor        TEXT NOT NULL,
        operation    TEXT NOT NULL,
        changes_json TEXT NOT NULL,
        evidence_ref TEXT,
        created_at   INTEGER NOT NULL,
        UNIQUE(task_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, sequence);
    `,
  },
]

export const LATEST_TASK_VERSION = TASK_MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
)

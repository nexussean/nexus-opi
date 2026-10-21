/**
 * The memory schema.
 *
 * Memories are **authoritative** state: a decision a human made is a fact
 * about the project, and losing it loses something that cannot be rebuilt
 * from a disposable index.
 *
 * The tombstone table is the reason a deleted memory cannot come back by
 * accident: the deletion is recorded, and a re-import sees it.
 */

export interface MemoryMigration {
  version: number
  name: string
  sql: string
}

export const MEMORY_MIGRATIONS: readonly MemoryMigration[] = [
  {
    version: 1,
    name: "memory",
    sql: `
      CREATE TABLE IF NOT EXISTS memories (
        id             TEXT PRIMARY KEY,
        project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        worktree_id    TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
        kind           TEXT NOT NULL,
        title          TEXT NOT NULL,
        body           TEXT NOT NULL,
        trust          TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        source_hash    TEXT,
        supersedes_id  TEXT REFERENCES memories(id) ON DELETE SET NULL,
        created_at     INTEGER NOT NULL,
        expires_at     INTEGER
      );

      CREATE INDEX IF NOT EXISTS memories_project ON memories(project_id, trust);
      CREATE INDEX IF NOT EXISTS memories_supersedes ON memories(supersedes_id);

      -- A deleted memory leaves a tombstone, so a later re-import cannot
      -- silently resurrect it.
      CREATE TABLE IF NOT EXISTS memory_tombstones (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title      TEXT NOT NULL,
        reason     TEXT NOT NULL,
        actor      TEXT NOT NULL,
        deleted_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS memory_tombstones_project
        ON memory_tombstones(project_id);

      -- A handoff is a session report. It is bounded, structured, and
      -- separate from the memories it refers to.
      CREATE TABLE IF NOT EXISTS handoffs (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
        task_id     TEXT,
        session_id  TEXT,
        body_json   TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS handoffs_task ON handoffs(task_id, created_at);
      CREATE INDEX IF NOT EXISTS handoffs_project ON handoffs(project_id, created_at);

      -- A session's link to a project, so a session can be resumed.
      CREATE TABLE IF NOT EXISTS sessions (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        worktree_id  TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
        current_task_id TEXT,
        last_seen_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_id);
    `,
  },
]

export const LATEST_MEMORY_VERSION = MEMORY_MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
)

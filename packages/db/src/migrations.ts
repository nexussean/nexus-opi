/**
 * Versioned, idempotent schema migrations.
 *
 * Every migration is applied inside a transaction and recorded in
 * `schema_migrations`. Re-running the migrator is a no-op. A migration that
 * fails leaves the database on the previous version.
 */

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "registry",
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id             TEXT PRIMARY KEY,
        key            TEXT NOT NULL UNIQUE,
        strategy       TEXT NOT NULL,
        canonical_root TEXT NOT NULL,
        common_dir     TEXT,
        git_dir        TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worktrees (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        key          TEXT NOT NULL UNIQUE,
        root         TEXT NOT NULL,
        kind         TEXT NOT NULL,
        branch       TEXT,
        head         TEXT,
        last_seen_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS worktrees_project ON worktrees(project_id);

      CREATE TABLE IF NOT EXISTS project_aliases (
        alias_key  TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "index-jobs",
    sql: `
      CREATE TABLE IF NOT EXISTS index_jobs (
        id               TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL,
        worktree_id      TEXT NOT NULL,
        kind             TEXT NOT NULL,
        dedupe_key       TEXT NOT NULL,
        payload          TEXT NOT NULL,
        state            TEXT NOT NULL,
        attempts         INTEGER NOT NULL DEFAULT 0,
        max_attempts     INTEGER NOT NULL DEFAULT 3,
        run_after        INTEGER NOT NULL,
        lease_expires_at INTEGER,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        last_error       TEXT
      );

      -- One outstanding job per dedupe key. A finished job does not block a
      -- later one, so the same file can be re-indexed.
      CREATE UNIQUE INDEX IF NOT EXISTS index_jobs_dedupe
        ON index_jobs(dedupe_key) WHERE state IN ('pending', 'running');

      CREATE INDEX IF NOT EXISTS index_jobs_ready ON index_jobs(state, run_after);
      CREATE INDEX IF NOT EXISTS index_jobs_project ON index_jobs(project_id, worktree_id);
    `,
  },
]

export const LATEST_VERSION = MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0)

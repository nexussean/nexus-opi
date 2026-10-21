/**
 * The verification schema.
 *
 * Gates are **authoritative** state: they are what the user approved, and
 * an approval that survives a restart is the point.
 *
 * A run is also authoritative — it is a record of what happened, and the
 * evidence a task's completion rests on. The index is disposable; this is
 * not.
 */

export interface VerificationMigration {
  version: number
  name: string
  sql: string
}

export const VERIFICATION_MIGRATIONS: readonly VerificationMigration[] = [
  {
    version: 1,
    name: "verification",
    sql: `
      CREATE TABLE IF NOT EXISTS verification_gates (
        id                TEXT PRIMARY KEY,
        project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        executable        TEXT NOT NULL,
        args_json         TEXT NOT NULL,
        cwd               TEXT NOT NULL DEFAULT '.',
        kind              TEXT NOT NULL,
        description       TEXT NOT NULL DEFAULT '',
        scope_json        TEXT NOT NULL DEFAULT '[]',
        required_types_json TEXT NOT NULL DEFAULT '[]',
        timeout_ms        INTEGER NOT NULL,
        output_cap_bytes  INTEGER NOT NULL,
        risk              TEXT NOT NULL DEFAULT 'safe',
        state             TEXT NOT NULL DEFAULT 'proposed'
                          CHECK(state IN ('proposed','approved','retired')),
        approved_by       TEXT,
        approved_at       INTEGER,
        config_revision   INTEGER NOT NULL DEFAULT 1,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS verification_gates_project
        ON verification_gates(project_id, state);

      CREATE TABLE IF NOT EXISTS verification_runs (
        id               TEXT PRIMARY KEY,
        gate_id          TEXT NOT NULL,
        project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id          TEXT,
        outcome          TEXT NOT NULL
                         CHECK(outcome IN ('passed','failed','timeout','cancelled','error')),
        exit_code        INTEGER,
        signal           TEXT,
        output           TEXT NOT NULL DEFAULT '',
        truncated        INTEGER NOT NULL DEFAULT 0,
        output_digest    TEXT NOT NULL,
        head             TEXT NOT NULL DEFAULT '',
        scope_hash       TEXT NOT NULL DEFAULT '',
        config_revision  INTEGER NOT NULL,
        started_at       INTEGER NOT NULL,
        finished_at      INTEGER NOT NULL,
        duration_ms      INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS verification_runs_gate
        ON verification_runs(gate_id, started_at);
      CREATE INDEX IF NOT EXISTS verification_runs_task
        ON verification_runs(task_id, started_at);
      CREATE INDEX IF NOT EXISTS verification_runs_project
        ON verification_runs(project_id, started_at);
    `,
  },
]

export const LATEST_VERIFICATION_VERSION = VERIFICATION_MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
)

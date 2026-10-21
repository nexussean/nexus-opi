import { Database } from "bun:sqlite"
import { backoffMs, type EnqueueInput, type Job, type JobQueue, type JobState } from "@opi/core"

export interface SqliteJobQueueOptions {
  path: string
  /** Default lease duration for a claimed job. */
  leaseMs?: number
}

interface Row {
  id: string
  project_id: string
  worktree_id: string
  kind: string
  dedupe_key: string
  payload: string
  state: JobState
  attempts: number
  max_attempts: number
  run_after: number
  lease_expires_at: number | null
  created_at: number
  updated_at: number
  last_error: string | null
}

function toJob(row: Row): Job {
  return {
    id: row.id,
    projectId: row.project_id,
    worktreeId: row.worktree_id,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    state: row.state,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after,
    ...(row.lease_expires_at !== null ? { leaseExpiresAt: row.lease_expires_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
  }
}

/**
 * A durable job queue on SQLite.
 *
 * The queue is the durable record; a worker is disposable. A job that is
 * running when the process dies is recovered by lease expiry, not lost.
 */
export class SqliteJobQueue implements JobQueue {
  #db: Database
  #leaseMs: number

  constructor(options: SqliteJobQueueOptions) {
    this.#leaseMs = options.leaseMs ?? 60_000
    this.#db = new Database(options.path, { create: true })
    this.#db.exec("PRAGMA journal_mode = WAL")
    this.#db.exec("PRAGMA foreign_keys = ON")
    this.#db.exec("PRAGMA busy_timeout = 5000")
    // The schema is owned by the registry's migrator; this only ensures the
    // table exists when the queue is used on its own.
    this.#db.exec(`
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
      CREATE UNIQUE INDEX IF NOT EXISTS index_jobs_dedupe
        ON index_jobs(dedupe_key) WHERE state IN ('pending', 'running');
      CREATE INDEX IF NOT EXISTS index_jobs_ready ON index_jobs(state, run_after);
    `)
  }

  async enqueue(input: EnqueueInput): Promise<Job> {
    const now = Date.now()
    const runAfter = now + (input.delayMs ?? 0)
    const id = crypto.randomUUID()
    try {
      this.#db
        .query(
          `INSERT INTO index_jobs
             (id, project_id, worktree_id, kind, dedupe_key, payload, state, attempts, max_attempts, run_after, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.worktreeId,
          input.kind,
          input.dedupeKey,
          JSON.stringify(input.payload ?? {}),
          input.maxAttempts ?? 3,
          runAfter,
          now,
          now,
        )
    } catch (error) {
      // The unique index rejected it: an equivalent job is already outstanding.
      const existing = this.#db
        .query("SELECT * FROM index_jobs WHERE dedupe_key = ? AND state IN ('pending','running')")
        .get(input.dedupeKey) as Row | undefined
      if (existing) return toJob(existing)
      throw error
    }
    return toJob(this.#get(id)!)
  }

  #get(id: string): Row | undefined {
    return this.#db.query("SELECT * FROM index_jobs WHERE id = ?").get(id) as Row | undefined
  }

  async claim(options: { leaseMs?: number } = {}): Promise<Job | undefined> {
    const now = Date.now()
    const leaseMs = options.leaseMs ?? this.#leaseMs
    return this.#db.transaction(() => {
      const row = this.#db
        .query(
          `SELECT * FROM index_jobs
            WHERE state = 'pending' AND run_after <= ?
            ORDER BY run_after ASC, created_at ASC
            LIMIT 1`,
        )
        .get(now) as Row | undefined
      if (!row) return undefined
      this.#db
        .query("UPDATE index_jobs SET state = 'running', lease_expires_at = ?, updated_at = ? WHERE id = ?")
        .run(now + leaseMs, now, row.id)
      return toJob({ ...row, state: "running", lease_expires_at: now + leaseMs, updated_at: now })
    })()
  }

  async renewLease(id: string, leaseMs = this.#leaseMs): Promise<boolean> {
    const now = Date.now()
    const result = this.#db
      .query("UPDATE index_jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND state = 'running'")
      .run(now + leaseMs, now, id)
    return result.changes > 0
  }

  async complete(id: string): Promise<void> {
    this.#db
      .query("UPDATE index_jobs SET state = 'done', lease_expires_at = NULL, updated_at = ? WHERE id = ?")
      .run(Date.now(), id)
  }

  async fail(id: string, error: string): Promise<Job | undefined> {
    const now = Date.now()
    return this.#db.transaction(() => {
      const row = this.#get(id)
      if (!row) return undefined
      const attempts = row.attempts + 1
      if (attempts >= row.max_attempts) {
        this.#db
          .query(
            "UPDATE index_jobs SET state = 'failed', attempts = ?, last_error = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
          )
          .run(attempts, error, now, id)
        return toJob({ ...row, state: "failed", attempts, last_error: error, updated_at: now })
      }
      const runAfter = now + backoffMs(attempts)
      this.#db
        .query(
          "UPDATE index_jobs SET state = 'pending', attempts = ?, last_error = ?, run_after = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
        )
        .run(attempts, error, runAfter, now, id)
      return toJob({
        ...row,
        state: "pending",
        attempts,
        last_error: error,
        run_after: runAfter,
        updated_at: now,
      })
    })()
  }

  async cancel(id: string): Promise<boolean> {
    const result = this.#db
      .query("UPDATE index_jobs SET state = 'cancelled', lease_expires_at = NULL, updated_at = ? WHERE id = ? AND state IN ('pending','running')")
      .run(Date.now(), id)
    return result.changes > 0
  }

  async recoverAbandoned(): Promise<number> {
    const now = Date.now()
    const result = this.#db
      .query(
        "UPDATE index_jobs SET state = 'pending', lease_expires_at = NULL, updated_at = ? WHERE state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?",
      )
      .run(now, now)
    return result.changes
  }

  async get(id: string): Promise<Job | undefined> {
    const row = this.#get(id)
    return row ? toJob(row) : undefined
  }

  async list(filter: { state?: JobState; projectId?: string; worktreeId?: string } = {}): Promise<Job[]> {
    const clauses: string[] = []
    const values: (string | number | null)[] = []
    if (filter.state) {
      clauses.push("state = ?")
      values.push(filter.state)
    }
    if (filter.projectId) {
      clauses.push("project_id = ?")
      values.push(filter.projectId)
    }
    if (filter.worktreeId) {
      clauses.push("worktree_id = ?")
      values.push(filter.worktreeId)
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
    const rows = this.#db.query(`SELECT * FROM index_jobs ${where} ORDER BY created_at`).all(...values) as Row[]
    return rows.map(toJob)
  }

  async stats(filter: { projectId?: string } = {}): Promise<Record<JobState, number>> {
    const where = filter.projectId ? "WHERE project_id = ?" : ""
    const values = filter.projectId ? [filter.projectId] : []
    const rows = this.#db
      .query(`SELECT state, COUNT(*) AS count FROM index_jobs ${where} GROUP BY state`)
      .all(...values) as { state: JobState; count: number }[]
    const out: Record<JobState, number> = { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 }
    for (const row of rows) out[row.state] = row.count
    return out
  }

  async prune(olderThanMs: number): Promise<number> {
    const cutoff = Date.now() - olderThanMs
    const result = this.#db
      .query("DELETE FROM index_jobs WHERE state IN ('done','failed','cancelled') AND updated_at <= ?")
      .run(cutoff)
    return result.changes
  }

  close() {
    this.#db.close()
  }
}

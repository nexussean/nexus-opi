import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { Gate, GateKind, GateRisk, GateRun, GateState } from "@opi/core"
import { LIMITS } from "@opi/core"
import { LATEST_VERIFICATION_VERSION, VERIFICATION_MIGRATIONS } from "./verification-migrations.ts"

export interface VerificationStoreOptions {
  path: string
  busyTimeoutMs?: number
}

export interface ProposeGateInput {
  projectId: string
  id: string
  executable: string
  args?: string[]
  cwd?: string
  kind?: GateKind
  description?: string
  scope?: string[]
  requiredForTypes?: string[]
  timeoutMs?: number
  outputCapBytes?: number
  risk?: GateRisk
  actor?: string
}

export interface VerificationMutationResult<T> {
  ok: boolean
  value?: T
  error?: string
  reason?: string
  required?: string
}

/**
 * The durable gate and run store.
 *
 * A gate's approval is a human decision, and it is **attributed**: who
 * approved it and when. A run is a record of what happened, and it is
 * append-only — a run is never edited, because editing it would edit the
 * evidence a task's completion rests on.
 */
export class SqliteVerificationStore {
  #db: Database

  constructor(options: VerificationStoreOptions) {
    mkdirSync(dirname(options.path), { recursive: true })
    this.#db = new Database(options.path, { create: true })
    this.#db.exec("PRAGMA journal_mode = WAL")
    this.#db.exec("PRAGMA foreign_keys = ON")
    this.#db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`)
    this.#migrate()
  }

  #migrate() {
    // Its own ledger, like the task store. The registry, the task store and
    // this one share a database file and must not share a version counter.
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS verification_schema_migrations (
         version    INTEGER PRIMARY KEY,
         name       TEXT NOT NULL,
         applied_at INTEGER NOT NULL
       )`,
    )
    const applied = new Set(
      (
        this.#db
          .query("SELECT version FROM verification_schema_migrations")
          .all() as { version: number }[]
      ).map((row) => row.version),
    )
    for (const migration of VERIFICATION_MIGRATIONS) {
      if (applied.has(migration.version)) continue
      this.#db.transaction(() => {
        this.#db.exec(migration.sql)
        this.#db
          .query(
            "INSERT INTO verification_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(migration.version, migration.name, Date.now())
      })()
    }
  }

  get version(): number {
    const row = this.#db
      .query("SELECT MAX(version) AS version FROM verification_schema_migrations")
      .get() as { version: number | null }
    return row?.version ?? 0
  }

  get migrated(): boolean {
    return this.version === LATEST_VERIFICATION_VERSION
  }

  close(): void {
    this.#db.close()
  }

  // --------------------------------------------------------------- reading

  /** A gate by id. */
  get(projectId: string, id: string): Gate | undefined {
    const row = this.#db
      .query("SELECT * FROM verification_gates WHERE project_id = ? AND id = ?")
      .get(projectId, id) as Record<string, unknown> | undefined
    return row ? toGate(row) : undefined
  }

  /** Every gate in a project, optionally filtered by state. */
  list(projectId: string, states?: readonly GateState[]): Gate[] {
    const rows = (
      states && states.length > 0
        ? this.#db
            .query(
              `SELECT * FROM verification_gates WHERE project_id = ? AND state IN (${states
                .map(() => "?")
                .join(",")}) ORDER BY id`,
            )
            .all(projectId, ...states)
        : this.#db
            .query("SELECT * FROM verification_gates WHERE project_id = ? ORDER BY id")
            .all(projectId)
    ) as Record<string, unknown>[]
    return rows.map(toGate)
  }

  /** The runs of a gate, newest first. */
  runs(gateId: string, limit = 20): GateRun[] {
    const rows = this.#db
      .query("SELECT * FROM verification_runs WHERE gate_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(gateId, limit) as Record<string, unknown>[]
    return rows.map(toRun)
  }

  /** The runs of a task, newest first. */
  runsForTask(taskId: string, limit = 20): GateRun[] {
    const rows = this.#db
      .query("SELECT * FROM verification_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(taskId, limit) as Record<string, unknown>[]
    return rows.map(toRun)
  }

  // -------------------------------------------------------------- mutating

  /**
   * Propose a gate.
   *
   * A proposal is **not** an approval. The gate starts in `proposed` and
   * does not run until a human approves it.
   */
  propose(input: ProposeGateInput): VerificationMutationResult<Gate> {
    const id = input.id.trim()
    if (!id) {
      return { ok: false, error: "A gate needs an id.", reason: "invalid_id" }
    }
    if (!input.executable.trim()) {
      return { ok: false, error: "A gate needs an executable.", reason: "invalid_executable" }
    }
    if (this.get(input.projectId, id)) {
      return { ok: false, error: `A gate named ${id} already exists.`, reason: "duplicate_gate" }
    }

    const now = Date.now()
    try {
      this.#db
        .query(
          `INSERT INTO verification_gates
             (id, project_id, executable, args_json, cwd, kind, description, scope_json,
              required_types_json, timeout_ms, output_cap_bytes, risk, state, config_revision,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 1, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.executable,
          JSON.stringify(input.args ?? []),
          input.cwd ?? ".",
          input.kind ?? "custom",
          input.description ?? "",
          JSON.stringify(input.scope ?? []),
          JSON.stringify(input.requiredForTypes ?? []),
          Math.min(LIMITS.maxTimeoutMs, Math.max(1_000, input.timeoutMs ?? LIMITS.defaultTimeoutMs)),
          Math.min(
            LIMITS.maxOutputCapBytes,
            Math.max(1_024, input.outputCapBytes ?? LIMITS.defaultOutputCapBytes),
          ),
          input.risk ?? "safe",
          now,
          now,
        )
    } catch (error) {
      return { ok: false, error: (error as Error).message, reason: "insert_failed" }
    }

    const gate = this.get(input.projectId, id)
    return gate ? { ok: true, value: gate } : { ok: false, error: "The gate could not be read back." }
  }

  /**
   * Approve a gate.
   *
   * The approver is recorded. An approval with no approver is not an
   * approval, and the gate does not run.
   */
  approve(projectId: string, id: string, approver: string): VerificationMutationResult<Gate> {
    const gate = this.get(projectId, id)
    if (!gate) return { ok: false, error: "No such gate.", reason: "not_found" }
    if (!approver.trim()) {
      return {
        ok: false,
        error: "An approval must name who approved it.",
        reason: "missing_approver",
      }
    }
    if (gate.state === "approved") {
      return { ok: false, error: "That gate is already approved.", reason: "already_approved" }
    }
    const now = Date.now()
    this.#db
      .query(
        "UPDATE verification_gates SET state = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND project_id = ?",
      )
      .run(approver, now, now, id, projectId)
    const updated = this.get(projectId, id)
    return updated
      ? { ok: true, value: updated }
      : { ok: false, error: "The gate could not be read back." }
  }

  /**
   * Retire a gate.
   *
   * A retired gate does not run. Its runs are kept: they are evidence about
   * a moment in time, and deleting them would erase the record of what was
   * verified.
   */
  retire(projectId: string, id: string): VerificationMutationResult<Gate> {
    const gate = this.get(projectId, id)
    if (!gate) return { ok: false, error: "No such gate.", reason: "not_found" }
    const now = Date.now()
    this.#db
      .query("UPDATE verification_gates SET state = 'retired', updated_at = ? WHERE id = ? AND project_id = ?")
      .run(now, id, projectId)
    const updated = this.get(projectId, id)
    return updated
      ? { ok: true, value: updated }
      : { ok: false, error: "The gate could not be read back." }
  }

  /**
   * Change a gate's definition.
   *
   * The config revision is bumped, which makes every run of the old
   * definition **stale**. A gate that was changed cannot inherit the
   * evidence of the gate it used to be.
   */
  redefine(
    projectId: string,
    id: string,
    changes: {
      executable?: string
      args?: string[]
      cwd?: string
      scope?: string[]
      requiredForTypes?: string[]
      timeoutMs?: number
      outputCapBytes?: number
      risk?: GateRisk
      description?: string
    },
  ): VerificationMutationResult<Gate> {
    const gate = this.get(projectId, id)
    if (!gate) return { ok: false, error: "No such gate.", reason: "not_found" }

    const sets: string[] = []
    const values: (string | number | null)[] = []
    if (changes.executable !== undefined) {
      sets.push("executable = ?")
      values.push(changes.executable)
    }
    if (changes.args !== undefined) {
      sets.push("args_json = ?")
      values.push(JSON.stringify(changes.args))
    }
    if (changes.cwd !== undefined) {
      sets.push("cwd = ?")
      values.push(changes.cwd)
    }
    if (changes.scope !== undefined) {
      sets.push("scope_json = ?")
      values.push(JSON.stringify(changes.scope))
    }
    if (changes.requiredForTypes !== undefined) {
      sets.push("required_types_json = ?")
      values.push(JSON.stringify(changes.requiredForTypes))
    }
    if (changes.timeoutMs !== undefined) {
      sets.push("timeout_ms = ?")
      values.push(Math.min(LIMITS.maxTimeoutMs, Math.max(1_000, changes.timeoutMs)))
    }
    if (changes.outputCapBytes !== undefined) {
      sets.push("output_cap_bytes = ?")
      values.push(Math.min(LIMITS.maxOutputCapBytes, Math.max(1_024, changes.outputCapBytes)))
    }
    if (changes.risk !== undefined) {
      sets.push("risk = ?")
      values.push(changes.risk)
    }
    if (changes.description !== undefined) {
      sets.push("description = ?")
      values.push(changes.description)
    }
    if (sets.length === 0) return { ok: true, value: gate }

    const now = Date.now()
    this.#db
      .query(
        `UPDATE verification_gates SET ${sets.join(", ")}, config_revision = config_revision + 1, updated_at = ?
         WHERE id = ? AND project_id = ?`,
      )
      // The placeholder order must match the statement: the SET columns
      // first, then `updated_at`, then the WHERE clause.
      .run(...values, now, id, projectId)
    const updated = this.get(projectId, id)
    return updated
      ? { ok: true, value: updated }
      : { ok: false, error: "The gate could not be read back." }
  }

  /**
   * Record a run.
   *
   * A run is append-only. It is never edited and never deleted, because it
   * is the evidence a task's completion rests on.
   */
  recordRun(run: GateRun): VerificationMutationResult<GateRun> {
    try {
      this.#db
        .query(
          `INSERT INTO verification_runs
             (id, gate_id, project_id, task_id, outcome, exit_code, signal, output, truncated,
              output_digest, head, scope_hash, config_revision, started_at, finished_at, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.gateId,
          run.projectId,
          run.taskId ?? null,
          run.outcome,
          run.exitCode ?? null,
          run.signal ?? null,
          run.output,
          run.truncated ? 1 : 0,
          run.outputDigest,
          run.head,
          run.scopeHash,
          run.configRevision,
          run.startedAt,
          run.finishedAt,
          run.durationMs,
        )
    } catch (error) {
      return { ok: false, error: (error as Error).message, reason: "insert_failed" }
    }
    return { ok: true, value: run }
  }
}

/** Read a gate row. */
function toGate(row: Record<string, unknown>): Gate {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    executable: String(row.executable),
    args: JSON.parse(String(row.args_json)) as string[],
    cwd: String(row.cwd),
    kind: String(row.kind) as GateKind,
    description: String(row.description),
    scope: JSON.parse(String(row.scope_json)) as string[],
    requiredForTypes: JSON.parse(String(row.required_types_json)) as string[],
    timeoutMs: Number(row.timeout_ms),
    outputCapBytes: Number(row.output_cap_bytes),
    risk: String(row.risk) as GateRisk,
    state: String(row.state) as GateState,
    ...(row.approved_by ? { approvedBy: String(row.approved_by) } : {}),
    ...(row.approved_at ? { approvedAt: Number(row.approved_at) } : {}),
    configRevision: Number(row.config_revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** Read a run row. */
function toRun(row: Record<string, unknown>): GateRun {
  return {
    id: String(row.id),
    gateId: String(row.gate_id),
    projectId: String(row.project_id),
    ...(row.task_id ? { taskId: String(row.task_id) } : {}),
    outcome: String(row.outcome) as GateRun["outcome"],
    ...(row.exit_code !== null && row.exit_code !== undefined
      ? { exitCode: Number(row.exit_code) }
      : {}),
    ...(row.signal ? { signal: String(row.signal) } : {}),
    output: String(row.output),
    truncated: Number(row.truncated) === 1,
    outputDigest: String(row.output_digest),
    head: String(row.head),
    scopeHash: String(row.scope_hash),
    configRevision: Number(row.config_revision),
    startedAt: Number(row.started_at),
    finishedAt: Number(row.finished_at),
    durationMs: Number(row.duration_ms),
  }
}

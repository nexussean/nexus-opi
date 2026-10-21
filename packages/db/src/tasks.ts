import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import {
  checkTransition,
  findCycle,
  wouldCreateCycle,
  type TaskWaiver,
} from "@opi/core"
import type {
  Task,
  TaskEdge,
  TaskEvent,
  TaskPriority,
  TaskRelation,
  TaskState,
  TaskType,
  VerificationState,
} from "@opi/core"
import { LATEST_TASK_VERSION, TASK_MIGRATIONS } from "./task-migrations.ts"

export interface TaskStoreOptions {
  /** Path to the database. The same file the project registry uses. */
  path: string
  busyTimeoutMs?: number
}

/** The result of a mutation. */
export interface MutationResult<T> {
  ok: boolean
  /** The mutated entity, when the mutation succeeded. */
  value?: T
  /** Why it failed. */
  error?: string
  /** A stable, machine-readable reason. */
  reason?: string
  /** What the caller must do to succeed. */
  required?: string
}

export interface CreateTaskInput {
  projectId: string
  title: string
  publicKey?: string
  description?: string
  acceptance?: string
  type?: TaskType
  state?: TaskState
  priority?: TaskPriority
  worktreeId?: string
  actor?: string
}

export interface UpdateTaskInput {
  taskId: string
  /** The revision the caller expects to find. */
  expectedRevision: number
  actor?: string
  title?: string
  description?: string
  acceptance?: string
  type?: TaskType
  priority?: TaskPriority
  worktreeId?: string | null
  /**
   * The task's verification state.
   *
   * This is **not** a free field. It is the *derived* evidence state, and it
   * is set by the verification service when it evaluates a task's gates —
   * never by a caller. It is on the input because the service needs to write
   * it, not because a model may.
   */
  verification?: VerificationState
}

export interface TransitionInput {
  taskId: string
  to: TaskState
  expectedRevision: number
  actor?: string
  /** A waiver, when the caller is waiving the evidence requirement. */
  waiver?: TaskWaiver
  /** A reference to evidence, recorded on the event. */
  evidenceRef?: string
}

export interface LinkInput {
  projectId: string
  /** The predecessor. For `blocks`, this must finish first. */
  from: string
  /** The successor. */
  to: string
  relation: TaskRelation
  actor?: string
}

/**
 * The durable task store.
 *
 * Tasks are **authoritative state**. Nothing here is derived from the code
 * index, and a failed index rebuild cannot touch a row in this table.
 *
 * Every mutation is a transaction that also appends to the audit ledger, so
 * the history and the row can never disagree.
 */
export class SqliteTaskStore {
  #db: Database

  constructor(options: TaskStoreOptions) {
    mkdirSync(dirname(options.path), { recursive: true })
    this.#db = new Database(options.path, { create: true })
    this.#db.exec("PRAGMA journal_mode = WAL")
    this.#db.exec("PRAGMA foreign_keys = ON")
    this.#db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`)
    this.#migrate()
  }

  #migrate() {
    // The task store has its **own** migration ledger.
    //
    // The registry and the task store share one database file, and they
    // would otherwise share `schema_migrations` too. They would then
    // clobber each other: the registry records version 2, the task store
    // sees "version 1 is already applied" and skips its own first
    // migration — leaving the `tasks` table missing. Separate ledgers mean
    // each store tracks its own version.
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS task_schema_migrations (
         version    INTEGER PRIMARY KEY,
         name       TEXT NOT NULL,
         applied_at INTEGER NOT NULL
       )`,
    )
    const applied = new Set(
      (
        this.#db.query("SELECT version FROM task_schema_migrations").all() as { version: number }[]
      ).map((row) => row.version),
    )
    for (const migration of TASK_MIGRATIONS) {
      if (applied.has(migration.version)) continue
      this.#db.transaction(() => {
        this.#db.exec(migration.sql)
        this.#db
          .query("INSERT INTO task_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, Date.now())
      })()
    }
  }

  get version(): number {
    const row = this.#db
      .query("SELECT MAX(version) AS version FROM task_schema_migrations")
      .get() as { version: number | null }
    return row?.version ?? 0
  }

  get migrated(): boolean {
    return this.version === LATEST_TASK_VERSION
  }

  close(): void {
    this.#db.close()
  }

  // ---------------------------------------------------------------- reading

  /** A task by its internal id. */
  get(taskId: string): Task | undefined {
    const row = this.#db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | Record<string, unknown>
      | undefined
    return row ? toTask(row) : undefined
  }

  /** A task by the key a human types. */
  getByKey(projectId: string, publicKey: string): Task | undefined {
    const row = this.#db
      .query("SELECT * FROM tasks WHERE project_id = ? AND public_key = ?")
      .get(projectId, publicKey) as Record<string, unknown> | undefined
    return row ? toTask(row) : undefined
  }

  /** Every task in a project, optionally filtered by state. */
  list(projectId: string, states?: readonly TaskState[]): Task[] {
    const rows = (
      states && states.length > 0
        ? this.#db
            .query(
              `SELECT * FROM tasks WHERE project_id = ? AND state IN (${states.map(() => "?").join(",")})
               ORDER BY priority DESC, created_at ASC, public_key ASC`,
            )
            .all(projectId, ...states)
        : this.#db
            .query(
              "SELECT * FROM tasks WHERE project_id = ? ORDER BY priority DESC, created_at ASC, public_key ASC",
            )
            .all(projectId)
    ) as Record<string, unknown>[]
    return rows.map(toTask)
  }

  /** The relations in a project. */
  edges(projectId: string): TaskEdge[] {
    const rows = this.#db.query("SELECT * FROM task_edges WHERE project_id = ?").all(projectId) as {
      from_task_id: string
      to_task_id: string
      relation: TaskRelation
    }[]
    return rows.map((row) => ({ from: row.from_task_id, to: row.to_task_id, relation: row.relation }))
  }

  /**
   * Delete a task and everything attached to it.
   *
   * The edges and the history go with it — a task's history is part of the
   * task, not a separate record that outlives it.
   */
  delete(taskId: string): MutationResult<boolean> {
    const task = this.get(taskId)
    if (!task) return { ok: false, error: "No such task.", reason: "not_found" }
    try {
      this.#db.transaction(() => {
        this.#db.query("DELETE FROM task_events WHERE task_id = ?").run(taskId)
        this.#db.query("DELETE FROM task_edges WHERE from_task_id = ? OR to_task_id = ?").run(taskId, taskId)
        this.#db.query("DELETE FROM tasks WHERE id = ?").run(taskId)
      })()
    } catch (error) {
      return { ok: false, error: (error as Error).message, reason: "delete_failed" }
    }
    return { ok: true, value: true }
  }

  /** A task's history, oldest first. */
  history(taskId: string): TaskEvent[] {    const rows = this.#db
      .query("SELECT * FROM task_events WHERE task_id = ? ORDER BY sequence ASC")
      .all(taskId) as Record<string, unknown>[]
    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      sequence: Number(row.sequence),
      actor: String(row.actor),
      operation: String(row.operation),
      changes: JSON.parse(String(row.changes_json)) as Record<string, unknown>,
      ...(row.evidence_ref ? { evidenceRef: String(row.evidence_ref) } : {}),
      createdAt: Number(row.created_at),
    }))
  }

  // -------------------------------------------------------------- mutating

  /**
   * Create a task.
   *
   * The public key is unique within the project. If none is given, one is
   * derived from the title, and a numeric suffix is added if it collides.
   */
  create(input: CreateTaskInput): MutationResult<Task> {
    const title = input.title.trim()
    if (!title) {
      return { ok: false, error: "A task needs a title.", reason: "invalid_title" }
    }
    const actor = input.actor ?? "system"
    const now = Date.now()
    const id = crypto.randomUUID()

    // An explicit key is used as given. A derived key is normalised, because
    // it came from a title and a title is prose.
    const key = input.publicKey?.trim()
      ? this.#ensureUniqueKey(input.projectId, input.publicKey.trim())
      : this.#deriveKey(input.projectId, title)
    if (!key) {
      return { ok: false, error: "A task key cannot be empty.", reason: "invalid_key" }
    }

    const state = input.state ?? "backlog"
    const verification: VerificationState = "not_configured"

    try {
      this.#db.transaction(() => {
        this.#db
          .query(
            `INSERT INTO tasks
               (id, project_id, public_key, title, description, acceptance, type, state, priority,
                worktree_id, verification, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            id,
            input.projectId,
            key,
            title,
            input.description ?? "",
            input.acceptance ?? "",
            input.type ?? "feature",
            state,
            input.priority ?? 2,
            input.worktreeId ?? null,
            verification,
            now,
            now,
          )
        this.#appendEvent(id, actor, "created", {
          publicKey: key,
          title,
          state,
          priority: input.priority ?? 2,
          type: input.type ?? "feature",
        })
      })()
    } catch (error) {
      return { ok: false, error: (error as Error).message, reason: "insert_failed" }
    }

    const task = this.get(id)
    return task ? { ok: true, value: task } : { ok: false, error: "The task could not be read back." }
  }

  /**
   * Update a task's fields.
   *
   * The expected revision must match. A mismatch is a **conflict**, and the
   * caller's change is not applied: the person who edited the task first is
   * not overwritten by a stale write.
   */
  update(input: UpdateTaskInput): MutationResult<Task> {
    const task = this.get(input.taskId)
    if (!task) return { ok: false, error: "No such task.", reason: "not_found" }
    if (task.revision !== input.expectedRevision) {
      return {
        ok: false,
        error: `This task is at revision ${task.revision}, not ${input.expectedRevision}.`,
        reason: "revision_conflict",
        required: "Read the task again and reapply the change.",
      }
    }

    const changes: Record<string, unknown> = {}
    const sets: string[] = []
    const values: (string | number | null)[] = []

    const set = (column: string, value: string | number | null, label = column): void => {
      if ((task as unknown as Record<string, unknown>)[label] === value) return
      changes[label] = value
      sets.push(`${column} = ?`)
      values.push(value)
    }

    if (input.title !== undefined) set("title", input.title.trim(), "title")
    if (input.description !== undefined) set("description", input.description, "description")
    if (input.acceptance !== undefined) set("acceptance", input.acceptance, "acceptance")
    if (input.type !== undefined) set("type", input.type, "type")
    if (input.priority !== undefined) set("priority", input.priority, "priority")
    if (input.worktreeId !== undefined) {
      set("worktree_id", input.worktreeId, "worktreeId")
    }
    // `verification` is deliberately not settable here. It is the derived
    // evidence state, and `setVerification` is the only path that writes it.

    if (sets.length === 0) {
      return { ok: true, value: task }
    }

    const now = Date.now()
    try {
      this.#db.transaction(() => {
        // The parameter order must match the order of the placeholders in
        // the statement: the SET columns first, then `updated_at`, then the
        // WHERE clause. Getting this wrong writes the timestamp into the
        // first column instead of raising an error.
        this.#db
          .query(
            `UPDATE tasks SET ${sets.join(", ")}, revision = revision + 1, updated_at = ?
             WHERE id = ? AND revision = ?`,
          )
          .run(...values, now, input.taskId, input.expectedRevision)
        this.#appendEvent(input.taskId, input.actor ?? "system", "updated", changes)
      })()
    } catch (error) {
      return { ok: false, error: (error as Error).message, reason: "update_failed" }
    }

    const updated = this.get(input.taskId)
    return updated ? { ok: true, value: updated } : { ok: false, error: "The task could not be read back." }
  }

  /**
   * Record a task's **derived** verification state.
   *
   * This is the only path by which a task's verification state changes, and
   * it is not reachable from a tool call: the verification service calls it
   * after evaluating the task's gates. A model cannot set a task to `passed`.
   *
   * The change is audited like any other, so the history shows when the
   * evidence changed and what it changed to.
   */
  setVerification(
    taskId: string,
    verification: VerificationState,
    options: { actor?: string; expectedRevision?: number; waiver?: TaskWaiver } = {},
  ): MutationResult<Task> {
    const task = this.get(taskId)
    if (!task) return { ok: false, error: "No such task.", reason: "not_found" }
    if (
      options.expectedRevision !== undefined &&
      task.revision !== options.expectedRevision
    ) {
      return {
        ok: false,
        error: `This task is at revision ${task.revision}, not ${options.expectedRevision}.`,
        reason: "revision_conflict",
        required: "Read the task again and reapply the change.",
      }
    }
    if (task.verification === verification && !options.waiver) {
      return { ok: true, value: task }
    }

    const now = Date.now()
    const waiver = options.waiver
    try {
      this.#db.transaction(() => {
        this.#db
          .query(
            `UPDATE tasks
             SET verification = ?,
                 waiver_actor = ?, waiver_reason = ?, waiver_scope = ?, waiver_at = ?,
                 revision = revision + 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            verification,
            waiver?.actor ?? null,
            waiver?.reason ?? null,
            waiver?.scope ?? null,
            waiver?.at ?? null,
            now,
            taskId,
          )
        this.#appendEvent(taskId, options.actor ?? "system", "evidence", {
          verification: { from: task.verification, to: verification },
        })
      })()
    } catch (error) {
      return { ok: false, error: (error as Error).message, reason: "update_failed" }
    }

    const updated = this.get(taskId)
    return updated
      ? { ok: true, value: updated }
      : { ok: false, error: "The task could not be read back." }
  }

  /**
   * Move a task to another state.
   *
   * The transition must be legal and the evidence must be sufficient. A
   * refusal explains which, and never applies anything.
   */
  transition(input: TransitionInput): MutationResult<Task> {
    const task = this.get(input.taskId)
    if (!task) return { ok: false, error: "No such task.", reason: "not_found" }
    if (task.revision !== input.expectedRevision) {
      return {
        ok: false,
        error: `This task is at revision ${task.revision}, not ${input.expectedRevision}.`,
        reason: "revision_conflict",
        required: "Read the task again and reapply the change.",
      }
    }

    const decision = checkTransition(task, input.to, input.waiver ? { waiver: input.waiver } : {})
    if (!decision.ok) {
      return {
        ok: false,
        error: decision.message,
        reason: decision.reason,
        ...(decision.required ? { required: decision.required } : {}),
      }
    }

    const now = Date.now()
    const waiver = input.waiver
    try {
      this.#db.transaction(() => {
        this.#db
          .query(
            `UPDATE tasks
             SET state = ?, verification = ?,
                 waiver_actor = ?, waiver_reason = ?, waiver_scope = ?, waiver_at = ?,
                 revision = revision + 1, updated_at = ?
             WHERE id = ? AND revision = ?`,
          )
          .run(
            input.to,
            decision.verification,
            waiver?.actor ?? null,
            waiver?.reason ?? null,
            waiver?.scope ?? null,
            waiver?.at ?? null,
            now,
            input.taskId,
            input.expectedRevision,
          )
        this.#appendEvent(
          input.taskId,
          input.actor ?? "system",
          waiver ? "waived" : "transitioned",
          { from: task.state, to: input.to, verification: decision.verification },
          input.evidenceRef,
        )
      })()
    } catch (error) {
      return { ok: false, error: (error as Error).message, reason: "transition_failed" }
    }

    const updated = this.get(input.taskId)
    return updated ? { ok: true, value: updated } : { ok: false, error: "The task could not be read back." }
  }

  /**
   * Link two tasks.
   *
   * A `blocks` edge that would create a cycle is refused: there is no order
   * that satisfies it, so no task in the cycle could ever be ready.
   */
  link(input: LinkInput): MutationResult<TaskEdge> {
    const from = this.get(input.from)
    const to = this.get(input.to)
    if (!from || !to) return { ok: false, error: "No such task.", reason: "not_found" }
    if (from.id === to.id) {
      return { ok: false, error: "A task cannot depend on itself.", reason: "self_reference" }
    }
    if (from.projectId !== to.projectId) {
      return {
        ok: false,
        error: "Two tasks from different projects cannot be linked.",
        reason: "project_crossover",
      }
    }

    const existing = this.edges(from.projectId)
    if (existing.some((edge) => edge.from === from.id && edge.to === to.id && edge.relation === input.relation)) {
      return { ok: false, error: "Those tasks are already linked that way.", reason: "duplicate_edge" }
    }

    if (input.relation === "blocks") {
      if (wouldCreateCycle(existing, from.id, to.id)) {
        return {
          ok: false,
          error: "That link would create a dependency cycle.",
          reason: "cycle",
          required: "Remove the link that closes the cycle first.",
        }
      }
    }
    const id = crypto.randomUUID()
    const now = Date.now()
    try {
      this.#db.transaction(() => {
        this.#db
          .query(
            `INSERT INTO task_edges (id, project_id, from_task_id, to_task_id, relation, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(id, from.projectId, from.id, to.id, input.relation, now)
        this.#appendEvent(to.id, input.actor ?? "system", "linked", {
          from: from.publicKey,
          relation: input.relation,
        })
      })()
    } catch (error) {
      return { ok: false, error: (error as Error).message, reason: "link_failed" }
    }

    return { ok: true, value: { from: from.id, to: to.id, relation: input.relation } }
  }

  /** Remove a link. */
  unlink(input: {
    projectId: string
    from: string
    to: string
    relation: TaskRelation
    actor?: string
  }): MutationResult<boolean> {
    const from = this.get(input.from)
    const to = this.get(input.to)
    if (!from || !to) return { ok: false, error: "No such task.", reason: "not_found" }
    try {
      this.#db.transaction(() => {
        this.#db
          .query(
            "DELETE FROM task_edges WHERE from_task_id = ? AND to_task_id = ? AND relation = ?",
          )
          .run(from.id, to.id, input.relation)
        this.#appendEvent(to.id, input.actor ?? "system", "unlinked", {
          from: from.publicKey,
          relation: input.relation,
        })
      })()
    } catch (error) {
      return { ok: false, error: (error as Error).message, reason: "unlink_failed" }
    }
    return { ok: true, value: true }
  }

  /** Is the dependency graph acyclic? */
  hasCycle(projectId: string): boolean {
    return findCycle(this.edges(projectId)) !== undefined
  }

  // ------------------------------------------------------------- internals

  /** Append to the audit ledger. The sequence is per task and monotonic. */
  #appendEvent(
    taskId: string,
    actor: string,
    operation: string,
    changes: Record<string, unknown>,
    evidenceRef?: string,
  ): void {
    const row = this.#db
      .query("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM task_events WHERE task_id = ?")
      .get(taskId) as { sequence: number }
    this.#db
      .query(
        `INSERT INTO task_events
           (id, task_id, sequence, actor, operation, changes_json, evidence_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        taskId,
        Number(row.sequence) + 1,
        actor,
        operation,
        JSON.stringify(changes),
        evidenceRef ?? null,
        Date.now(),
      )
  }

  /** Derive a public key from a title, avoiding collisions within the project. */
  #deriveKey(projectId: string, wanted: string): string {
    const base =
      wanted
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "task"
    return this.#ensureUniqueKey(projectId, base)
  }

  /**
   * Add a suffix to a key until it is unique within the project.
   *
   * The key is used as given apart from the suffix, so an explicit key like
   * `PI-0012` keeps its case.
   */
  #ensureUniqueKey(projectId: string, base: string): string {
    let candidate = base
    let counter = 2
    while (this.getByKey(projectId, candidate)) {
      candidate = `${base}-${counter}`
      counter += 1
      // A pathological title must not loop forever.
      if (counter > 1000) {
        candidate = `${base}-${crypto.randomUUID().slice(0, 8)}`
        break
      }
    }
    return candidate
  }
}

/** Read a task row. */
function toTask(row: Record<string, unknown>): Task {
  const waiver =
    row.waiver_actor && row.waiver_reason && row.waiver_scope && row.waiver_at
      ? {
          actor: String(row.waiver_actor),
          reason: String(row.waiver_reason),
          scope: String(row.waiver_scope),
          at: Number(row.waiver_at),
        }
      : undefined
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    publicKey: String(row.public_key),
    title: String(row.title),
    description: String(row.description),
    acceptance: String(row.acceptance),
    type: String(row.type) as TaskType,
    state: String(row.state) as TaskState,
    priority: Number(row.priority) as TaskPriority,
    ...(row.worktree_id ? { worktreeId: String(row.worktree_id) } : {}),
    verification: String(row.verification) as VerificationState,
    ...(waiver ? { waiver } : {}),
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

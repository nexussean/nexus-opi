import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type {
  Handoff,
  Memory,
  MemoryKind,
  Provenance,
  Tombstone,
  TrustState,
} from "@opi/core"
import { MEMORY_LIMITS } from "@opi/core"
import { LATEST_MEMORY_VERSION, MEMORY_MIGRATIONS } from "./memory-migrations.ts"

export interface MemoryStoreOptions {
  path: string
  busyTimeoutMs?: number
}

export interface ProposeMemoryInput {
  projectId: string
  kind: MemoryKind
  title: string
  body: string
  provenance: Provenance
  worktreeId?: string
  expiresAt?: number
  actor?: string
}

export interface MemoryMutationResult<T> {
  ok: boolean
  value?: T
  error?: string
  reason?: string
  required?: string
}

/**
 * The durable memory store.
 *
 * The store is the only place a memory's trust changes, and each change has
 * a **named path**: a human confirming it, a gate verifying it, the agent
 * reporting it, or a human superseding it. There is no path by which a
 * memory's *content* raises its own trust — a README cannot talk its way
 * into being a decision.
 */
export class SqliteMemoryStore {
  #db: Database

  constructor(options: MemoryStoreOptions) {
    mkdirSync(dirname(options.path), { recursive: true })
    this.#db = new Database(options.path, { create: true })
    this.#db.exec("PRAGMA journal_mode = WAL")
    this.#db.exec("PRAGMA foreign_keys = ON")
    this.#db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`)
    this.#migrate()
  }

  #migrate() {
    // Its own ledger. The registry, the task store, the verification store
    // and this one share a database file and must not share a version
    // counter.
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS memory_schema_migrations (
         version    INTEGER PRIMARY KEY,
         name       TEXT NOT NULL,
         applied_at INTEGER NOT NULL
       )`,
    )
    const applied = new Set(
      (
        this.#db.query("SELECT version FROM memory_schema_migrations").all() as { version: number }[]
      ).map((row) => row.version),
    )
    for (const migration of MEMORY_MIGRATIONS) {
      if (applied.has(migration.version)) continue
      this.#db.transaction(() => {
        this.#db.exec(migration.sql)
        this.#db
          .query("INSERT INTO memory_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, Date.now())
      })()
    }
  }

  get version(): number {
    const row = this.#db
      .query("SELECT MAX(version) AS version FROM memory_schema_migrations")
      .get() as { version: number | null }
    return row?.version ?? 0
  }

  get migrated(): boolean {
    return this.version === LATEST_MEMORY_VERSION
  }

  close(): void {
    this.#db.close()
  }

  // --------------------------------------------------------------- reading

  /** A memory by id. */
  get(id: string): Memory | undefined {
    const row = this.#db.query("SELECT * FROM memories WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined
    return row ? toMemory(row) : undefined
  }

  /** Every memory in a project. */
  list(projectId: string, trust?: readonly TrustState[]): Memory[] {
    const rows = (
      trust && trust.length > 0
        ? this.#db
            .query(
              `SELECT * FROM memories WHERE project_id = ? AND trust IN (${trust.map(() => "?").join(",")})
               ORDER BY created_at DESC`,
            )
            .all(projectId, ...trust)
        : this.#db
            .query("SELECT * FROM memories WHERE project_id = ? ORDER BY created_at DESC")
            .all(projectId)
    ) as Record<string, unknown>[]
    return rows.map(toMemory)
  }

  /** The tombstones of a project. */
  tombstones(projectId: string): Tombstone[] {
    const rows = this.#db
      .query("SELECT * FROM memory_tombstones WHERE project_id = ? ORDER BY deleted_at DESC")
      .all(projectId) as Record<string, unknown>[]
    return rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      title: String(row.title),
      reason: String(row.reason),
      actor: String(row.actor),
      deletedAt: Number(row.deleted_at),
    }))
  }

  // -------------------------------------------------------------- mutating

  /**
   * Propose a memory.
   *
   * A proposal is `proposed` — untrusted. It is a lead, and it is searched
   * separately from the constraints. The only way it becomes a constraint is
   * a `confirm` or a `verify`.
   */
  propose(input: ProposeMemoryInput): MemoryMutationResult<Memory> {
    const title = input.title.trim()
    if (!title) return { ok: false, error: "A memory needs a title.", reason: "invalid_title" }
    if (title.length > MEMORY_LIMITS.titleMaxLength) {
      return { ok: false, error: "The title is too long.", reason: "title_too_long" }
    }
    if (input.body.length > MEMORY_LIMITS.bodyMaxLength) {
      return { ok: false, error: "The body is too long.", reason: "body_too_long" }
    }
    // A memory with no source and no evidence is a guess. It may be
    // proposed, but it may not be a `verified_fact`: a fact needs a fact's
    // evidence.
    if (input.kind === "verified_fact" && !input.provenance.sourceHash) {
      return {
        ok: false,
        error: "A verified fact needs the hash of the source it was verified against.",
        reason: "missing_source_hash",
      }
    }

    const id = crypto.randomUUID()
    const now = Date.now()
    try {
      this.#db
        .query(
          `INSERT INTO memories
             (id, project_id, worktree_id, kind, title, body, trust, provenance_json,
              source_hash, supersedes_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.worktreeId ?? null,
          input.kind,
          title,
          input.body,
          "proposed",
          JSON.stringify(input.provenance),
          input.provenance.sourceHash ?? null,
          now,
          input.expiresAt ?? null,
        )
    } catch (error) {
      return { ok: false, error: (error as Error).message, reason: "insert_failed" }
    }

    const memory = this.get(id)
    return memory
      ? { ok: true, value: memory }
      : { ok: false, error: "The memory could not be read back." }
  }

  /**
   * Confirm a memory.
   *
   * A human, by name. The memory becomes a `human_decision` — a constraint.
   * This is the path the model cannot take: the store records who confirmed
   * it, and the tool that reaches it does not accept a model as the actor.
   */
  confirm(projectId: string, id: string, actor: string): MemoryMutationResult<Memory> {
    const memory = this.get(id)
    if (!memory) return { ok: false, error: "No such memory.", reason: "not_found" }
    if (!actor.trim()) {
      return {
        ok: false,
        error: "A confirmation must name who confirmed it.",
        reason: "missing_actor",
      }
    }
    if (memory.trust === "superseded") {
      return {
        ok: false,
        error: "A superseded memory cannot be confirmed. Propose a new one.",
        reason: "superseded",
      }
    }
    const now = Date.now()
    this.#db
      .query(
        "UPDATE memories SET trust = 'human_confirmed', provenance_json = ? WHERE id = ? AND project_id = ?",
      )
      .run(
        JSON.stringify({ ...memory.provenance, origin: "human" as const }),
        id,
        projectId,
      )
    // A confirmed memory is a decision, and the decision is recorded on it.
    this.#db.query("UPDATE memories SET kind = 'human_decision' WHERE id = ?").run(id)
    const updated = this.get(id)
    void now
    return updated
      ? { ok: true, value: updated }
      : { ok: false, error: "The memory could not be read back." }
  }

  /**
   * Mark a memory as verified by a gate.
   *
   * The gate's run is the evidence, and the source hash is what the fact is
   * about. Without the source hash, this is refused: a `verified_fact`
   * without one is a claim, not a fact.
   */
  verify(
    projectId: string,
    id: string,
    options: { source: string; sourceHash: string; evidenceRef?: string },
  ): MemoryMutationResult<Memory> {
    const memory = this.get(id)
    if (!memory) return { ok: false, error: "No such memory.", reason: "not_found" }
    if (!options.source.trim() || !options.sourceHash.trim()) {
      return {
        ok: false,
        error: "A verified fact needs the source and the hash it was verified against.",
        reason: "missing_source",
      }
    }
    this.#db
      .query(
        "UPDATE memories SET trust = 'gate_verified', kind = 'verified_fact', provenance_json = ?, source_hash = ? WHERE id = ? AND project_id = ?",
      )
      .run(
        JSON.stringify({
          ...memory.provenance,
          source: options.source,
          sourceHash: options.sourceHash,
          ...(options.evidenceRef ? { evidenceRef: options.evidenceRef } : {}),
          origin: "gate" as const,
        }),
        options.sourceHash,
        id,
        projectId,
      )
    const updated = this.get(id)
    return updated
      ? { ok: true, value: updated }
      : { ok: false, error: "The memory could not be read back." }
  }

  /**
   * Supersede a memory.
   *
   * The old memory becomes `superseded` — retained for history, never
   * retrieved by default. The new memory records what it replaces.
   */
  supersede(
    projectId: string,
    id: string,
    replacement: { title: string; body: string; actor: string; provenance?: Provenance },
  ): MemoryMutationResult<Memory> {
    const memory = this.get(id)
    if (!memory) return { ok: false, error: "No such memory.", reason: "not_found" }
    if (!replacement.actor.trim()) {
      return {
        ok: false,
        error: "A supersession must name who made it.",
        reason: "missing_actor",
      }
    }
    const newId = crypto.randomUUID()
    const now = Date.now()
    try {
      this.#db.transaction(() => {
        this.#db
          .query("UPDATE memories SET trust = 'superseded' WHERE id = ? AND project_id = ?")
          .run(id, projectId)
        this.#db
          .query(
            `INSERT INTO memories
               (id, project_id, worktree_id, kind, title, body, trust, provenance_json,
                source_hash, supersedes_id, created_at, expires_at)
             VALUES (?, ?, ?, 'human_decision', ?, ?, 'human_confirmed', ?, ?, ?, ?, NULL)`,
          )
          .run(
            newId,
            projectId,
            memory.worktreeId ?? null,
            replacement.title.trim() || memory.title,
            replacement.body,
            JSON.stringify({
              ...memory.provenance,
              ...(replacement.provenance ?? {}),
              origin: "human" as const,
            }),
            memory.provenance.sourceHash ?? null,
            id,
            now,
          )
      })()
    } catch (error) {
      return { ok: false, error: (error as Error).message, reason: "supersede_failed" }
    }
    const created = this.get(newId)
    return created
      ? { ok: true, value: created }
      : { ok: false, error: "The memory could not be read back." }
  }

  /**
   * Delete a memory, leaving a tombstone.
   *
   * The tombstone is the point: without it, a later re-import could
   * silently resurrect what was deleted.
   */
  delete(
    projectId: string,
    id: string,
    options: { reason: string; actor: string },
  ): MemoryMutationResult<boolean> {
    const memory = this.get(id)
    if (!memory) return { ok: false, error: "No such memory.", reason: "not_found" }
    if (!options.actor.trim()) {
      return {
        ok: false,
        error: "A deletion must name who did it.",
        reason: "missing_actor",
      }
    }
    try {
      this.#db.transaction(() => {
        this.#db
          .query(
            `INSERT INTO memory_tombstones (id, project_id, title, reason, actor, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            memory.id,
            projectId,
            memory.title,
            options.reason || "no reason given",
            options.actor,
            Date.now(),
          )
        this.#db.query("DELETE FROM memories WHERE id = ?").run(id)
      })()
    } catch (error) {
      return { ok: false, error: (error as Error).message, reason: "delete_failed" }
    }
    return { ok: true, value: true }
  }

  // ------------------------------------------------------------- handoffs

  /** Record a handoff. */
  recordHandoff(
    projectId: string,
    handoff: Handoff,
    options: { worktreeId?: string; sessionId?: string } = {},
  ): MemoryMutationResult<string> {
    const id = crypto.randomUUID()
    try {
      this.#db
        .query(
          `INSERT INTO handoffs (id, project_id, worktree_id, task_id, session_id, body_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          projectId,
          options.worktreeId ?? null,
          handoff.taskId ?? null,
          options.sessionId ?? handoff.sessionId ?? null,
          JSON.stringify(handoff),
          handoff.createdAt || Date.now(),
        )
    } catch (error) {
      return { ok: false, error: (error as Error).message, reason: "insert_failed" }
    }
    return { ok: true, value: id }
  }

  /** The handoffs of a task, newest first. */
  handoffsForTask(taskId: string, limit = 20): Handoff[] {
    const rows = this.#db
      .query("SELECT body_json FROM handoffs WHERE task_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(taskId, limit) as { body_json: string }[]
    return rows.map((row) => JSON.parse(row.body_json) as Handoff)
  }

  /** The most recent handoff of a task. */
  latestHandoff(taskId: string): Handoff | undefined {
    return this.handoffsForTask(taskId, 1)[0]
  }

  /** The most recent handoff of a project. */
  latestHandoffForProject(projectId: string): Handoff | undefined {
    const row = this.#db
      .query("SELECT body_json FROM handoffs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(projectId) as { body_json: string } | undefined
    return row ? (JSON.parse(row.body_json) as Handoff) : undefined
  }

  // ------------------------------------------------------------- sessions

  /** Link a session to a project. */
  linkSession(
    sessionId: string,
    projectId: string,
    options: { worktreeId?: string; currentTaskId?: string } = {},
  ): MemoryMutationResult<boolean> {
    try {
      this.#db
        .query(
          `INSERT INTO sessions (id, project_id, worktree_id, current_task_id, last_seen_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             project_id = excluded.project_id,
             worktree_id = excluded.worktree_id,
             current_task_id = excluded.current_task_id,
             last_seen_at = excluded.last_seen_at`,
        )
        .run(
          sessionId,
          projectId,
          options.worktreeId ?? null,
          options.currentTaskId ?? null,
          Date.now(),
        )
    } catch (error) {
      return { ok: false, error: (error as Error).message, reason: "link_failed" }
    }
    return { ok: true, value: true }
  }

  /** A session's link. */
  session(sessionId: string): {
    id: string
    projectId: string
    worktreeId?: string
    currentTaskId?: string
    lastSeenAt: number
  } | undefined {
    const row = this.#db.query("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
      | Record<string, unknown>
      | undefined
    if (!row) return undefined
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      ...(row.worktree_id ? { worktreeId: String(row.worktree_id) } : {}),
      ...(row.current_task_id ? { currentTaskId: String(row.current_task_id) } : {}),
      lastSeenAt: Number(row.last_seen_at),
    }
  }

  /** The sessions of a project. */
  sessions(projectId: string): { id: string; currentTaskId?: string; lastSeenAt: number }[] {
    const rows = this.#db
      .query("SELECT id, current_task_id, last_seen_at FROM sessions WHERE project_id = ? ORDER BY last_seen_at DESC")
      .all(projectId) as { id: string; current_task_id: string | null; last_seen_at: number }[]
    return rows.map((row) => ({
      id: row.id,
      ...(row.current_task_id ? { currentTaskId: row.current_task_id } : {}),
      lastSeenAt: row.last_seen_at,
    }))
  }
}

/** Read a memory row. */
function toMemory(row: Record<string, unknown>): Memory {
  const provenance = JSON.parse(String(row.provenance_json)) as Provenance
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    ...(row.worktree_id ? { worktreeId: String(row.worktree_id) } : {}),
    kind: String(row.kind) as MemoryKind,
    title: String(row.title),
    body: String(row.body),
    trust: String(row.trust) as TrustState,
    provenance,
    ...(row.supersedes_id ? { supersedesId: String(row.supersedes_id) } : {}),
    createdAt: Number(row.created_at),
    ...(row.expires_at ? { expiresAt: Number(row.expires_at) } : {}),
    // The staleness is recomputed by the caller; a stored value would be a
    // claim about the world that goes out of date on its own.
    stale: false,
  }
}

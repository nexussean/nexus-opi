import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { ProjectIdentity, ResolvedProject } from "@opi/contracts"
import type { ProjectRegistry } from "@opi/core"
import { LATEST_VERSION, MIGRATIONS } from "./migrations.ts"

export interface SqliteRegistryOptions {
  /** Path to the registry database. */
  path: string
  /** Busy timeout in milliseconds. */
  busyTimeoutMs?: number
}

/**
 * The durable project registry.
 *
 * Project ids are minted once and stored, so a project keeps its identity
 * across restarts. A moved project keeps its id only after an explicit
 * relink, which records an alias from the new key to the original.
 */
export class SqliteProjectRegistry implements ProjectRegistry {
  #db: Database
  #path: string

  constructor(options: SqliteRegistryOptions) {
    this.#path = options.path
    mkdirSync(dirname(options.path), { recursive: true })
    this.#db = new Database(options.path, { create: true })
    this.#db.exec("PRAGMA journal_mode = WAL")
    this.#db.exec("PRAGMA foreign_keys = ON")
    this.#db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`)
    this.#migrate()
  }

  #migrate() {
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    INTEGER PRIMARY KEY,
         name       TEXT NOT NULL,
         applied_at INTEGER NOT NULL
       )`,
    )
    const applied = new Set(
      this.#db.query("SELECT version FROM schema_migrations").all().map((row: any) => row.version as number),
    )
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue
      this.#db.transaction(() => {
        this.#db.exec(migration.sql)
        this.#db
          .query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, Date.now())
      })()
    }
  }

  get path(): string {
    return this.#path
  }

  get version(): number {
    const row = this.#db.query("SELECT MAX(version) AS version FROM schema_migrations").get() as
      | { version: number | null }
      | undefined
    return row?.version ?? 0
  }

  /** True when the schema is at the expected version. */
  get migrated(): boolean {
    return this.version === LATEST_VERSION
  }

  #projectIdForKey(key: string): string | undefined {
    const alias = this.#db.query("SELECT project_id FROM project_aliases WHERE alias_key = ?").get(key) as
      | { project_id: string }
      | undefined
    if (alias) return alias.project_id
    const row = this.#db.query("SELECT id FROM projects WHERE key = ?").get(key) as { id: string } | undefined
    return row?.id
  }

  async resolve(resolved: ResolvedProject): Promise<ProjectIdentity> {
    const now = Date.now()
    const projectId = this.#projectIdForKey(resolved.key) ?? crypto.randomUUID()
    const worktreeId = this.#worktreeIdForKey(resolved.worktree.key) ?? crypto.randomUUID()

    this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT INTO projects (id, key, strategy, canonical_root, common_dir, git_dir, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             canonical_root = excluded.canonical_root,
             common_dir    = excluded.common_dir,
             git_dir       = excluded.git_dir,
             updated_at    = excluded.updated_at`,
        )
        .run(
          projectId,
          resolved.key,
          resolved.strategy,
          resolved.canonicalRoot,
          resolved.commonDir ?? null,
          resolved.gitDir ?? null,
          now,
          now,
        )

      this.#db
        .query(
          `INSERT INTO worktrees (id, project_id, key, root, kind, branch, head, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             root         = excluded.root,
             kind         = excluded.kind,
             branch       = excluded.branch,
             head         = excluded.head,
             last_seen_at = excluded.last_seen_at`,
        )
        .run(
          worktreeId,
          projectId,
          resolved.worktree.key,
          resolved.worktree.root,
          resolved.worktree.kind,
          resolved.worktree.branch ?? null,
          resolved.worktree.head ?? null,
          now,
        )
    })()

    return this.#identity(projectId, worktreeId, resolved)
  }

  #worktreeIdForKey(key: string): string | undefined {
    const row = this.#db.query("SELECT id FROM worktrees WHERE key = ?").get(key) as { id: string } | undefined
    return row?.id
  }

  #identity(projectId: string, worktreeId: string, resolved: ResolvedProject): ProjectIdentity {
    const project = this.#db.query("SELECT * FROM projects WHERE id = ?").get(projectId) as any
    const worktree = this.#db.query("SELECT * FROM worktrees WHERE id = ?").get(worktreeId) as any
    const parent = resolved.parent
      ? (() => {
          const parentId = this.#projectIdForKey(resolved.parent.key) ?? crypto.randomUUID()
          return { id: parentId, canonicalRoot: resolved.parent.canonicalRoot }
        })()
      : undefined

    return {
      id: projectId,
      strategy: project.strategy,
      canonicalRoot: project.canonical_root,
      ...(project.common_dir ? { commonDir: project.common_dir } : {}),
      ...(project.git_dir ? { gitDir: project.git_dir } : {}),
      worktree: {
        id: worktreeId,
        projectId,
        root: worktree.root,
        kind: worktree.kind,
        ...(worktree.branch ? { branch: worktree.branch } : {}),
        ...(worktree.head ? { head: worktree.head } : {}),
      },
      ...(parent ? { parent } : {}),
    }
  }

  async relink(projectId: string, canonicalRoot: string): Promise<ProjectIdentity> {
    const project = this.#db.query("SELECT * FROM projects WHERE id = ?").get(projectId) as any
    if (!project) throw new Error(`No project with id ${projectId}`)
    const key = project.strategy === "git" ? `git:${project.common_dir ?? canonicalRoot}` : `path:${canonicalRoot}`
    this.#db
      .query("INSERT OR REPLACE INTO project_aliases (alias_key, project_id, created_at) VALUES (?, ?, ?)")
      .run(key, projectId, Date.now())
    this.#db
      .query("UPDATE projects SET canonical_root = ?, updated_at = ? WHERE id = ?")
      .run(canonicalRoot, Date.now(), projectId)
    return this.identity(projectId)
  }

  /** Read a project's current identity without resolving a path. */
  identity(projectId: string): ProjectIdentity {
    const project = this.#db.query("SELECT * FROM projects WHERE id = ?").get(projectId) as any
    if (!project) throw new Error(`No project with id ${projectId}`)
    const worktree = this.#db
      .query("SELECT * FROM worktrees WHERE project_id = ? ORDER BY last_seen_at DESC LIMIT 1")
      .get(projectId) as any
    if (!worktree) throw new Error(`No worktree for project ${projectId}`)
    return this.#identity(project.id, worktree.id, {
      key: project.key,
      strategy: project.strategy,
      canonicalRoot: project.canonical_root,
      worktree: { key: worktree.key, root: worktree.root, kind: worktree.kind },
    })
  }

  async list(): Promise<ProjectIdentity[]> {
    const rows = this.#db.query("SELECT id FROM projects ORDER BY created_at").all() as { id: string }[]
    return rows.map((row) => this.identity(row.id))
  }

  close() {
    this.#db.close()
  }
}

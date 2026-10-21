import { realpath } from "node:fs/promises"
import type { ProjectIdentity, ResolvedProject } from "@opi/contracts"

export interface ProjectRegistry {
  /**
   * Assign stable ids to a resolved project. The same key must always produce
   * the same id.
   */
  resolve(resolved: ResolvedProject): Promise<ProjectIdentity>
  /**
   * Re-point a project at a new canonical root, keeping its id. Used when a
   * non-git project is moved and the user confirms the relink.
   */
  relink(projectId: string, canonicalRoot: string): Promise<ProjectIdentity>
  list(): Promise<ProjectIdentity[]>
}

/**
 * A registry that keeps its state in memory.
 *
 * The SQLite registry (OPI-007) is the durable one. This exists so the
 * resolver can be exercised without a database, and so the adapter can fall
 * back when the database is unavailable — the plan's availability rule is
 * that a database failure must not stop OpenCode working.
 */
export class MemoryProjectRegistry implements ProjectRegistry {
  /** key -> id */
  #ids = new Map<string, string>()
  /** id -> key */
  #keys = new Map<string, string>()
  #identities = new Map<string, ProjectIdentity>()
  /** new key -> the original key it was relinked from */
  #aliases = new Map<string, string>()

  #idFor(key: string): string {
    const existing = this.#ids.get(key)
    if (existing) return existing
    const id = crypto.randomUUID()
    this.#ids.set(key, id)
    this.#keys.set(id, key)
    return id
  }

  async resolve(resolved: ResolvedProject): Promise<ProjectIdentity> {
    // A relinked path resolves through to the original key, and so to the
    // original id.
    const projectKey = this.#aliases.get(resolved.key) ?? resolved.key
    const projectId = this.#idFor(projectKey)
    const worktreeId = this.#idFor(resolved.worktree.key)

    const identity: ProjectIdentity = {
      id: projectId,
      strategy: resolved.strategy,
      canonicalRoot: resolved.canonicalRoot,
      ...(resolved.commonDir ? { commonDir: resolved.commonDir } : {}),
      ...(resolved.gitDir ? { gitDir: resolved.gitDir } : {}),
      worktree: {
        id: worktreeId,
        projectId,
        root: resolved.worktree.root,
        kind: resolved.worktree.kind,
        ...(resolved.worktree.branch ? { branch: resolved.worktree.branch } : {}),
        ...(resolved.worktree.head ? { head: resolved.worktree.head } : {}),
      },
      ...(resolved.parent
        ? {
            parent: {
              id: this.#idFor(resolved.parent.key),
              canonicalRoot: resolved.parent.canonicalRoot,
            },
          }
        : {}),
    }

    this.#identities.set(projectId, identity)
    return identity
  }

  async relink(projectId: string, canonicalRoot: string): Promise<ProjectIdentity> {
    const existing = this.#identities.get(projectId)
    if (!existing) throw new Error(`No project with id ${projectId}`)
    // The key must be canonical, exactly as `resolve` computes it, or the
    // alias will never be found.
    const root = await realpath(canonicalRoot).catch(() => canonicalRoot)
    const originalKey = this.#keys.get(projectId)
    if (!originalKey) throw new Error(`No project with id ${projectId}`)
    const key = existing.strategy === "git" ? `git:${existing.commonDir ?? root}` : `path:${root}`
    this.#aliases.set(key, originalKey)
    const relinked: ProjectIdentity = { ...existing, canonicalRoot: root }
    this.#identities.set(projectId, relinked)
    return relinked
  }

  async list(): Promise<ProjectIdentity[]> {
    return [...this.#identities.values()]
  }
}

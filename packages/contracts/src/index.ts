/**
 * Versioned public contracts.
 *
 * Everything the plugin, the CLI, the dashboard and any future MCP adapter
 * exchange goes through these types. The core never depends on OpenCode.
 */

export const SCHEMA_VERSION = "1"

/** Every service result carries one of these. Never claim more than you have. */
export type ResultStatus = "ok" | "partial" | "stale" | "error"

/**
 * How much is known about a relationship.
 *
 * `resolved` means a unique binding was proven. `syntactic` means the edge came
 * from a parse, not a binding. `unresolved` means the target could not be
 * identified at all — which is not the same as "there is no edge".
 */
export type Confidence = "resolved" | "syntactic" | "ambiguous" | "unresolved" | "stale"

export interface SourceRef {
  /** Path relative to the worktree root. Never absolute. */
  path: string
  startLine?: number
  endLine?: number
  /** Content hash of the file when the reference was taken. */
  hash?: string
  confidence?: Confidence
}

/** The envelope every tool and every API route returns. */
export interface Envelope<T> {
  schema_version: string
  status: ResultStatus
  project_id: string
  worktree_id?: string
  data?: T
  warnings: string[]
  sources: SourceRef[]
  truncated: boolean
}

export function envelope<T>(input: {
  status: ResultStatus
  projectId: string
  worktreeId?: string
  data?: T
  warnings?: string[]
  sources?: SourceRef[]
  truncated?: boolean
}): Envelope<T> {
  return {
    schema_version: SCHEMA_VERSION,
    status: input.status,
    project_id: input.projectId,
    ...(input.worktreeId ? { worktree_id: input.worktreeId } : {}),
    ...(input.data === undefined ? {} : { data: input.data }),
    warnings: input.warnings ?? [],
    sources: input.sources ?? [],
    truncated: input.truncated ?? false,
  }
}

/** How a project's identity was established. */
export type IdentityStrategy = "git" | "path"

/** Whether a checkout is the main working tree or a linked worktree. */
export type WorktreeKind = "root" | "linked"

export interface WorktreeIdentity {
  id: string
  projectId: string
  /** Canonical absolute path of this checkout. */
  root: string
  kind: WorktreeKind
  branch?: string
  head?: string
}

export interface ProjectIdentity {
  id: string
  strategy: IdentityStrategy
  /** Canonical absolute path of the project's primary checkout. */
  canonicalRoot: string
  /** Absolute path of the shared `.git` directory, for git projects. */
  commonDir?: string
  /** Absolute path of this checkout's `.git` directory. */
  gitDir?: string
  worktree: WorktreeIdentity
  /** The enclosing project, for a nested repository or submodule. */
  parent?: { id: string; canonicalRoot: string }
}

/** A project as resolved from the filesystem, before ids are assigned. */
export interface ResolvedProject {
  /** Registry key. `git:<commonDir>` or `path:<canonicalRoot>`. */
  key: string
  strategy: IdentityStrategy
  canonicalRoot: string
  commonDir?: string
  gitDir?: string
  worktree: {
    /** Registry key. `git:<gitDir>` or `path:<root>`. */
    key: string
    root: string
    kind: WorktreeKind
    branch?: string
    head?: string
  }
  parent?: { key: string; canonicalRoot: string }
}

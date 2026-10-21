import { envelope, type Envelope } from "@opi/contracts"
import { errorEnvelope } from "../errors/index.ts"
import type { FeatureFlags } from "../flags/index.ts"
import { resolveProject, type ProjectRegistry, type ResolveOptions } from "../project/index.ts"
import type { JobQueue, JobState } from "../queue/types.ts"
import type { MetricsSink } from "../telemetry/index.ts"

export type StatusAction = "summary" | "doctor" | "index_status" | "reindex"

/** What the indexer reports. */
export interface IndexStatus {
  available: boolean
  state?: "fresh" | "stale" | "building" | "absent"
  filesIndexed?: number
  symbolsIndexed?: number
  epoch?: number
  lastIndexedAt?: number
  coverage?: number
  languages?: string[]
  reason?: string
}

export interface IndexStatusProvider {
  status(projectId: string, worktreeId: string): Promise<IndexStatus>
  reindex(projectId: string, worktreeId: string): Promise<void>
}

export interface StatusDeps {
  registry: ProjectRegistry
  metrics: MetricsSink
  flags: FeatureFlags
  /** Present once an indexer exists. */
  index?: IndexStatusProvider
  /** Where the registry database lives, for `doctor`. */
  registryPath?: string
  /** The plugin's own version. */
  version?: string
  /** The background work queue, when one is running. */
  queue?: JobQueue
}

export interface StatusInput {
  action: StatusAction
  /** Trusted directory. Always the session's location, never a model-supplied path. */
  directory: string
  boundary?: string
}

export interface StatusReport {
  project: {
    id: string
    strategy: string
    canonicalRoot: string
    worktree: { id: string; root: string; kind: string; branch?: string; head?: string }
    parent?: { id: string; canonicalRoot: string }
  }
  index: IndexStatus
  features: Readonly<Record<string, boolean>>
  queue?: Record<JobState, number>
  diagnostics: string[]
}

/**
 * The `pi_status` service.
 *
 * Every action returns the same envelope shape. Nothing here can be pointed at
 * a directory the model chose: the directory comes from the caller's trusted
 * runtime context.
 */
export async function status(input: StatusInput, deps: StatusDeps): Promise<Envelope<StatusReport>> {
  const started = Date.now()
  try {
    const identity = await resolveProject(input.directory, deps.registry, {
      ...(input.boundary ? { boundary: input.boundary } : {}),
    })
    if (!identity) {
      throw new Error("The directory could not be resolved to a project.")
    }

    const diagnostics: string[] = []
    const index = await reportIndex(input.action, identity.id, identity.worktree.id, deps, diagnostics)

    if (input.action === "doctor") {
      if (deps.registryPath) diagnostics.push(`registry: ${deps.registryPath}`)
      diagnostics.push(`plugin version: ${deps.version ?? "unknown"}`)
      diagnostics.push(`flags: ${Object.entries(deps.flags.list()).filter(([, on]) => on).map(([name]) => name).join(", ") || "none enabled"}`)
    }

    const queueStats = deps.queue ? await deps.queue.stats({ projectId: identity.id }) : undefined

    const report: StatusReport = {
      project: {
        id: identity.id,
        strategy: identity.strategy,
        canonicalRoot: identity.canonicalRoot,
        worktree: {
          id: identity.worktree.id,
          root: identity.worktree.root,
          kind: identity.worktree.kind,
          ...(identity.worktree.branch ? { branch: identity.worktree.branch } : {}),
          ...(identity.worktree.head ? { head: identity.worktree.head } : {}),
        },
        ...(identity.parent ? { parent: identity.parent } : {}),
      },
      index,
      features: deps.flags.list(),
      ...(queueStats ? { queue: queueStats } : {}),
      diagnostics,
    }

    deps.metrics.increment("pi_status.calls", { action: input.action })
    deps.metrics.observe("pi_status.duration", Date.now() - started, { action: input.action })

    return envelope<StatusReport>({
      status: index.available ? "ok" : "partial",
      projectId: identity.id,
      worktreeId: identity.worktree.id,
      data: report,
      warnings: index.available ? [] : [index.reason ?? "The index is not available."],
    })
  } catch (error) {
    deps.metrics.increment("pi_status.errors", { action: input.action })
    return errorEnvelope(error, { projectId: "unknown" }) as Envelope<StatusReport>
  }
}

async function reportIndex(
  action: StatusAction,
  projectId: string,
  worktreeId: string,
  deps: StatusDeps,
  diagnostics: string[],
): Promise<IndexStatus> {
  if (!deps.index) {
    const reason = "No indexer is registered yet, so the index status is unknown."
    if (action === "reindex") diagnostics.push("reindex requested, but no indexer is registered yet.")
    return { available: false, state: "absent", reason }
  }
  if (action === "reindex") {
    await deps.index.reindex(projectId, worktreeId)
    diagnostics.push("reindex requested.")
  }
  return deps.index.status(projectId, worktreeId)
}

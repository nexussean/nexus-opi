/**
 * The durable job queue.
 *
 * A job is a unit of background work — indexing a file, rebuilding a graph
 * segment, running a check. Jobs are persisted, deduplicated, retried with
 * backoff, and leased so that a crashed worker's jobs are recovered rather
 * than lost.
 */

export type JobState = "pending" | "running" | "done" | "failed" | "cancelled"

export type JobKind = string

export interface Job {
  id: string
  projectId: string
  worktreeId: string
  kind: JobKind
  /** Stable key used to collapse duplicates while a job is outstanding. */
  dedupeKey: string
  /** Kind-specific data. Must be JSON-serialisable. */
  payload: Record<string, unknown>
  state: JobState
  attempts: number
  maxAttempts: number
  /** Epoch milliseconds before which the job must not run. */
  runAfter: number
  /** Epoch milliseconds after which a running job is considered abandoned. */
  leaseExpiresAt?: number
  createdAt: number
  updatedAt: number
  lastError?: string
}

export interface EnqueueInput {
  projectId: string
  worktreeId: string
  kind: JobKind
  dedupeKey: string
  payload?: Record<string, unknown>
  maxAttempts?: number
  /** Delay before the job first runs. Used for debouncing. */
  delayMs?: number
}

export interface JobQueue {
  /**
   * Add a job. If an equivalent job is already outstanding, the existing one
   * is returned and no new row is created.
   */
  enqueue(input: EnqueueInput): Promise<Job>
  /** Take the next runnable job and lease it. Returns undefined when idle. */
  claim(options?: { leaseMs?: number }): Promise<Job | undefined>
  /** Extend the lease on a running job. */
  renewLease(id: string, leaseMs?: number): Promise<boolean>
  complete(id: string): Promise<void>
  /** Mark a job failed. It is retried with backoff until `maxAttempts`. */
  fail(id: string, error: string): Promise<Job | undefined>
  /** Cancel a job, whether it is pending or running. */
  cancel(id: string): Promise<boolean>
  /** Requeue jobs whose lease expired. Returns how many were recovered. */
  recoverAbandoned(): Promise<number>
  get(id: string): Promise<Job | undefined>
  list(filter?: { state?: JobState; projectId?: string; worktreeId?: string }): Promise<Job[]>
  stats(filter?: { projectId?: string }): Promise<Record<JobState, number>>
  /** Remove finished jobs older than `olderThanMs`. */
  prune(olderThanMs: number): Promise<number>
}

export interface JobHandlerContext {
  signal: AbortSignal
  job: Job
}

export type JobHandler = (job: Job, context: JobHandlerContext) => Promise<void>

/** Exponential backoff, capped. */
export function backoffMs(attempts: number, base = 500, cap = 60_000): number {
  return Math.min(cap, base * 2 ** Math.max(0, attempts - 1))
}

/** A stable key for a file-scoped job. */
export function fileJobKey(projectId: string, worktreeId: string, path: string, hash: string): string {
  return `${projectId}:${worktreeId}:file:${path}:${hash}`
}

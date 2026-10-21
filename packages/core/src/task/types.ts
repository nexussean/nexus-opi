/**
 * The task model.
 *
 * A task is a work item with a **workflow state** and, separately, a
 * **verification state**. The separation is the whole point: the plan's
 * `done` transition requires verified evidence, but the verification service
 * does not exist yet, and a board that requires a waiver on every card is a
 * board nobody trusts.
 *
 * See [ADR-0022](../../docs/adr/0022-done-is-unverified-when-no-gates-are-configured.md).
 */

/**
 * Where a task is in its workflow.
 *
 * `ready` is a **recorded** state, not a derived one. A task whose
 * predecessors are unfinished stays in `backlog`; the board may show it as
 * "waiting for dependency", but the task's own state is not rewritten.
 */
export type TaskState =
  | "backlog"
  | "ready"
  | "in_progress"
  | "review"
  | "done"
  | "archived"

/**
 * What is known about a task's evidence.
 *
 * These are distinct states, and no false "passing" indication is allowed.
 * `not_configured` means the project has no gate policy — it is **not** a
 * pass, and a surface that shows a task must not collapse it into one.
 */
export type VerificationState =
  | "not_configured"
  | "not_run"
  | "passed"
  | "failed"
  | "stale"
  | "waived"

export type TaskType = "feature" | "bug" | "chore" | "docs" | "refactor" | "test"

/** Priority, 0 (lowest) to 3 (highest). */
export type TaskPriority = 0 | 1 | 2 | 3

/**
 * How two tasks are related.
 *
 * - `blocks` — the predecessor must finish first. This is the only relation
 *   that affects readiness.
 * - `parent` — hierarchy, for grouping. Does not affect readiness.
 * - `related` — a soft link. Does not affect readiness.
 */
export type TaskRelation = "blocks" | "parent" | "related"

/** A recorded waiver. A waiver is attributed, scoped and explained. */
export interface TaskWaiver {
  /** Who waived it. Never empty. */
  actor: string
  /** Why. Never empty. */
  reason: string
  /** What the waiver covers — a gate id, or a scope description. */
  scope: string
  /** Epoch milliseconds. */
  at: number
}

export interface Task {
  /** Internal id. Stable for the life of the task. */
  id: string
  /** The project this task belongs to. */
  projectId: string
  /**
   * The human-facing key, unique within the project.
   *
   * This is what a person types. It is the identity a human recognises, and
   * it does not change when the task is moved or edited.
   */
  publicKey: string
  title: string
  description: string
  /** What "done" means for this task, in the task's own words. */
  acceptance: string
  type: TaskType
  state: TaskState
  priority: TaskPriority
  /**
   * The worktree this task is scoped to, when it is scoped to one.
   *
   * A task scoped to a worktree is about that branch's code. An unscoped task
   * is about the project.
   */
  worktreeId?: string
  /** The verification state. See `VerificationState`. */
  verification: VerificationState
  /** The waiver, when the task was waived. */
  waiver?: TaskWaiver
  /**
   * The revision. Incremented on every mutation.
   *
   * A write must state the revision it expects to find. A mismatch is a
   * conflict, not a race to be won.
   */
  revision: number
  createdAt: number
  updatedAt: number
}

/** A recorded event in a task's history. */
export interface TaskEvent {
  id: string
  taskId: string
  /** Monotonic per task. The audit ledger's order. */
  sequence: number
  /** Who did it. A human name, an agent, or "system". */
  actor: string
  /** What happened: `created`, `updated`, `transitioned`, `linked`, `unlinked`, `waived`. */
  operation: string
  /** The fields that changed, and their new values. */
  changes: Record<string, unknown>
  /** A reference to evidence, when the event carries any. */
  evidenceRef?: string
  createdAt: number
}

/** A relation between two tasks. */
export interface TaskEdge {
  /** The predecessor. For `blocks`, this must finish first. */
  from: string
  /** The successor. */
  to: string
  relation: TaskRelation
}

/** The states from which a task may be archived. */
export const ARCHIVABLE: readonly TaskState[] = ["done", "backlog", "ready", "in_progress", "review"]

/** The states that count as finished for the purposes of a `blocks` edge. */
export const TERMINAL: readonly TaskState[] = ["done", "archived"]

export function isTerminal(state: TaskState): boolean {
  return TERMINAL.includes(state)
}

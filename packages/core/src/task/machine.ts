import type { Task, TaskState, TaskWaiver, VerificationState } from "./types.ts"

/**
 * The task state machine.
 *
 * Two things are checked on every transition: the **workflow** transition is
 * legal, and the **evidence** is sufficient. A transition that is legal in
 * the workflow but unsupported by evidence is refused, and the refusal says
 * what is missing.
 *
 * See [ADR-0022](../../docs/adr/0022-done-is-unverified-when-no-gates-are-configured.md)
 * for why the evidence rule has an exception.
 */

/** Why a transition was refused. */
export interface TransitionRefusal {
  ok: false
  /** A stable, machine-readable reason. */
  reason:
    | "illegal_transition"
    | "unverified"
    | "waiver_required"
    | "stale_evidence"
    | "revision_conflict"
  /** A human-readable explanation. Never contains a path outside the project. */
  message: string
  /** What the caller would have to do to make the transition legal. */
  required?: string
}

export interface TransitionAccepted {
  ok: true
  /** The state after the transition. */
  state: TaskState
  /** The verification state after the transition. */
  verification: VerificationState
}

export type TransitionResult = TransitionAccepted | TransitionRefusal

/**
 * The legal workflow transitions.
 *
 * The plan's state machine, minus the edges that are about *meaning* rather
 * than position. `backlog → blocked` and `ready → blocked` are gone: the plan
 * says the UI may show "waiting for dependency" without changing the task's
 * recorded state, and a `blocked` state that means "a dependency is
 * unfinished" is exactly the kind of thing that disagrees with the dependency
 * graph. The dependency graph is the source of truth for that.
 */
const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  backlog: ["ready", "in_progress", "archived"],
  ready: ["in_progress", "backlog", "archived"],
  in_progress: ["review", "ready", "archived"],
  review: ["done", "in_progress", "archived"],
  done: ["in_progress", "archived"],
  archived: [],
}

/** Can a task move from one state to another, ignoring evidence? */
export function isLegalTransition(from: TaskState, to: TaskState): boolean {
  if (from === to) return true
  return TRANSITIONS[from].includes(to)
}

/** The states a task may move to from here. */
export function allowedTransitions(from: TaskState): readonly TaskState[] {
  return TRANSITIONS[from]
}

/**
 * Can this task be `done`?
 *
 * The rule: `done` needs `passed` or `waived` evidence — *unless* the project
 * has no gate policy at all, in which case there is nothing to fail and the
 * task is `not_configured`.
 *
 * The exception is the deviation from the plan, and it is deliberate. See
 * ADR-0022.
 */
export function canComplete(task: Pick<Task, "verification">): TransitionResult | { ok: true } {
  switch (task.verification) {
    case "passed":
    case "waived":
    case "not_configured":
      return { ok: true }
    case "not_run":
      return {
        ok: false,
        reason: "unverified",
        message: "The required checks have not been run against this revision.",
        required: "Run the required gates, or record a waiver.",
      }
    case "failed":
      return {
        ok: false,
        reason: "unverified",
        message: "A required check failed.",
        required: "Fix the failure and re-run the checks, or record a waiver.",
      }
    case "stale":
      return {
        ok: false,
        reason: "stale_evidence",
        message: "The checks passed, but the code or configuration changed since they ran.",
        required: "Re-run the checks against the current revision.",
      }
  }
}

/**
 * Check a transition.
 *
 * @param task the task as it currently stands
 * @param to the state being moved to
 * @param options.waiver a waiver supplied with this transition
 */
export function checkTransition(
  task: Task,
  to: TaskState,
  options: { waiver?: TaskWaiver } = {},
): TransitionResult {
  if (!isLegalTransition(task.state, to)) {
    return {
      ok: false,
      reason: "illegal_transition",
      message: `A task cannot move from ${task.state} to ${to}.`,
      required: `Allowed from ${task.state}: ${allowedTransitions(task.state).join(", ") || "nothing"}.`,
    }
  }

  if (to !== "done") {
    return { ok: true, state: to, verification: task.verification }
  }

  // Moving to `done`. A waiver supplied with the transition satisfies the
  // evidence requirement immediately.
  if (options.waiver) {
    if (!options.waiver.actor.trim() || !options.waiver.reason.trim() || !options.waiver.scope.trim()) {
      return {
        ok: false,
        reason: "waiver_required",
        message: "A waiver must name who waived it, why, and what it covers.",
        required: "Supply an actor, a reason and a scope.",
      }
    }
    return { ok: true, state: to, verification: "waived" }
  }

  const completion = canComplete(task)
  if (!completion.ok) return completion

  return { ok: true, state: to, verification: task.verification }
}

/**
 * Is this task's evidence something a reader should trust at a glance?
 *
 * A task in a project with no gate policy is not verified. Saying so plainly
 * is the difference between a board that informs and a board that reassures.
 */
export function isVerified(task: Pick<Task, "verification">): boolean {
  return task.verification === "passed" || task.verification === "waived"
}

/**
 * A short, honest description of the task's evidence.
 *
 * Used wherever a task is listed, so that no surface can show a task as
 * finished without saying what its evidence is.
 */
export function verificationNote(task: Pick<Task, "verification" | "waiver">): string {
  switch (task.verification) {
    case "passed":
      return "Verified: the required checks passed on this revision."
    case "waived":
      return `Waived by ${task.waiver?.actor ?? "unknown"}: ${task.waiver?.reason ?? "no reason given"}.`
    case "not_configured":
      return "Unverified: this project has no check policy, so nothing was required."
    case "not_run":
      return "Unverified: the required checks have not been run."
    case "failed":
      return "Unverified: a required check failed."
    case "stale":
      return "Unverified: the checks passed, but the code has changed since they ran."
  }
}

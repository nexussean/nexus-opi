import type { TaskType, VerificationState } from "../task/types.ts"
import type { Gate, GateRun } from "./types.ts"
import { checkStaleness, evaluateEvidence } from "./evidence.ts"

/**
 * The completion invariant.
 *
 * A task's verification state is **derived** from the gates that are required
 * for it and the runs of those gates. It is not a field anybody sets.
 *
 * This is the piece that makes the plan's rule true: "`done` requires
 * passing required gates on the relevant worktree revision ... or recorded
 * waiver." It is also where ADR-0022's exception lives: a project with no
 * required gates has nothing to fail, and the task is `not_configured` rather
 * than `passed`.
 */

/** Why a task is in the verification state it is in. */
export interface EvidenceSummary {
  /** The state the task should have. */
  state: VerificationState
  /** A plain explanation. */
  reason: string
  /** The gates that were required, and what each one says. */
  gates: {
    id: string
    kind: string
    state: VerificationState
    reason: string
    /** The files that changed since the run, when the evidence is stale. */
    changed?: string[]
  }[]
  /** The gates that are required for this task but have never run. */
  missing: string[]
}

/** What the caller wants to know about. */
export interface EvaluateOptions {
  /** The task's type. It decides which gates are required. */
  taskType: TaskType | string
  /** The gates registered for the project. */
  gates: readonly Gate[]
  /** The runs, of any gate. */
  runs: readonly GateRun[]
  /** The project root. */
  root: string
  /** The worktree's current HEAD. */
  head: string
}

/**
 * Which gates are required for a task of this type?
 *
 * A gate with no `requiredForTypes` is required for **no** task type: it is
 * available to run, but it is not a condition of completion. A gate that
 * lists a type is required for that type.
 */
export function requiredGates(
  gates: readonly Gate[],
  taskType: TaskType | string,
): Gate[] {
  return gates.filter((gate) => gate.requiredForTypes.includes(taskType))
}

/**
 * The verification state a task should have.
 *
 * The states are, in order of severity:
 *
 * - `failed` — a required gate failed.
 * - `stale` — a required gate passed, but the code has changed since.
 * - `not_run` — a required gate has never run.
 * - `passed` — every required gate passed on this revision.
 * - `not_configured` — no gate is required for this task type.
 *
 * The order matters. A task with one failing gate and one unrun gate is
 * `failed`, not `not_run`: the failure is the more urgent fact.
 */
export function evaluateTask(options: EvaluateOptions): EvidenceSummary {
  const required = requiredGates(options.gates, options.taskType)
  if (required.length === 0) {
    return {
      state: "not_configured",
      reason: "No check is required for this kind of task in this project.",
      gates: [],
      missing: [],
    }
  }

  const summaries: EvidenceSummary["gates"] = []
  const missing: string[] = []
  let state: VerificationState = "passed"
  let reason = "Every required check passed on this revision."

  for (const gate of required) {
    const gateRuns = options.runs.filter((run) => run.gateId === gate.id)
    const outcome = evaluateEvidence(gate, gateRuns, options.root, options.head)
    const changed = outcome.state === "stale" ? staleFiles(gate, gateRuns, options) : undefined
    summaries.push({
      id: gate.id,
      kind: gate.kind,
      state: outcome.state,
      reason: outcome.reason,
      ...(changed ? { changed } : {}),
    })
    if (outcome.state === "not_run") missing.push(gate.id)

    // The most severe state wins.
    if (outcome.state === "failed") {
      if (state !== "failed") {
        state = "failed"
        reason = outcome.reason
      }
    } else if (outcome.state === "stale") {
      if (state === "passed" || state === "not_run") {
        state = "stale"
        reason = outcome.reason
      }
    } else if (outcome.state === "not_run") {
      if (state === "passed") {
        state = "not_run"
        reason = outcome.reason
      }
    }
  }

  return { state, reason, gates: summaries, missing }
}

/** The files that changed since a gate's last run, when it is stale. */
function staleFiles(
  gate: Gate,
  runs: readonly GateRun[],
  options: EvaluateOptions,
): string[] {
  const latest = [...runs]
    .filter((run) => run.gateId === gate.id)
    .sort((a, b) => b.startedAt - a.startedAt)[0]
  if (!latest) return []
  return checkStaleness(latest, gate, options.root, options.head).changed
}

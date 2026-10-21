import {
  findBlocked,
  nextTask,
  toList,
  toView,
  verificationNote,
  type Task,
  type TaskEdge,
} from "../task/index.ts"

/**
 * The command layer.
 *
 * A slash command is a **prompt a person can run**. It gathers what OPI
 * knows and turns it into something an agent can act on, with the reasoning
 * included rather than hidden.
 *
 * The commands do not decide anything. The state machine decides what a task
 * may be, the evidence rules decide whether it is done, and this module only
 * *reports*. A command that says "work on this" is saying what the rules
 * already said.
 *
 * See [ADR-0025](../../docs/adr/0025-a-command-reports-the-rules-it-does-not-make-them.md).
 */

export interface CommandContext {
  /** The project id. */
  projectId: string
  /** The project's tasks. */
  tasks: readonly Task[]
  /** The project's relations. */
  edges: readonly TaskEdge[]
  /** The gates registered for the project. */
  gates: { id: string; kind: string; state: string; description: string; requiredForTypes: string[] }[]
  /** The project root. */
  root: string
  /** The worktree's HEAD, when it has one. */
  head?: string
}

/**
 * The board, as a person reads it.
 *
 * The waiting list comes first, because a blocked task is the thing a person
 * needs to know about. The next task is what to do about it.
 */
export function formatBoard(context: CommandContext): string {
  const lines: string[] = []
  const byState = new Map<string, Task[]>()
  for (const task of context.tasks) {
    const list = byState.get(task.state) ?? []
    list.push(task)
    byState.set(task.state, list)
  }

  const order = ["in_progress", "review", "ready", "backlog", "done", "archived"]
  for (const state of order) {
    const list = byState.get(state)
    if (!list || list.length === 0) continue
    lines.push(`${state}:`)
    for (const task of list) {
      const blocked = findBlocked(context.tasks, context.edges).find(
        (problem) => problem.taskKey === task.publicKey,
      )
      const waiting = blocked ? `  (waiting for ${blocked.blockedBy.join(", ")})` : ""
      const verified = task.verification === "passed" || task.verification === "waived"
      lines.push(`  ${task.publicKey}  ${task.title}${verified ? "" : "  [unverified]"}${waiting}`)
    }
    lines.push("")
  }

  if (context.tasks.length === 0) {
    lines.push("The board is empty.")
    lines.push("")
  }

  const next = nextTask(context.tasks, context.edges)
  if (next) {
    lines.push(`Next: ${next.publicKey} — ${next.title}`)
    lines.push("")
  } else if (context.tasks.length > 0) {
    // `nextTask` only considers tasks that have *not* started, so a board
    // where everything is in progress or blocked has no "next" — but saying
    // "nothing is ready" when something is in progress is wrong.
    const inProgress = context.tasks.filter((task) => task.state === "in_progress")
    if (inProgress.length > 0) {
      const names = inProgress.map((task) => task.publicKey).join(", ")
      lines.push(
        `Nothing new to start. ${names} ${inProgress.length === 1 ? "is" : "are"} in progress.`,
      )
    } else {
      lines.push("Nothing is ready to start. Every task is waiting for a dependency.")
    }
    lines.push("")
  }

  const gates = context.gates
  if (gates.length > 0) {
    lines.push("Checks:")
    for (const gate of gates) {
      const state = gate.state === "approved" ? "approved" : `${gate.state} — it does not run`
      lines.push(`  ${gate.id}  (${gate.kind}, ${state})`)
    }
    lines.push("")
  }

  return lines.join("\n").trimEnd()
}

/**
 * The next task, with what it needs and what it is waiting for.
 *
 * The "what it needs" is the checks that are required for its type and have
 * not passed. It is the part a person cannot work out from the task title.
 */
export function formatNext(context: CommandContext): string {
  const next = nextTask(context.tasks, context.edges)
  if (!next) {
    // `nextTask` only considers tasks that have not started. A board where
    // everything is in progress has no "next task", but it is not stuck, and
    // saying it is would be wrong.
    const inProgress = context.tasks.filter((task) => task.state === "in_progress")
    if (inProgress.length > 0) {
      const lines = [
        `Nothing new to start. ${inProgress.map((task) => task.publicKey).join(", ")} ${inProgress.length === 1 ? "is" : "are"} in progress.`,
      ]
      const waiting = findBlocked(context.tasks, context.edges)
      if (waiting.length > 0) {
        lines.push("These are waiting:")
        for (const problem of waiting) {
          lines.push(`  ${problem.taskKey} — waiting for ${problem.blockedBy.join(", ")}`)
        }
      }
      return lines.join("\n")
    }
    const waiting = findBlocked(context.tasks, context.edges)
    if (waiting.length === 0) {
      return "There is nothing ready to work on, and nothing is waiting for a dependency."
    }
    const lines = ["Nothing is ready to work on. These are waiting:"]
    for (const problem of waiting) {
      lines.push(`  ${problem.taskKey} — waiting for ${problem.blockedBy.join(", ")}`)
    }
    return lines.join("\n")
  }

  const view = toView(next, { edges: context.edges, tasks: [...context.tasks] })
  const lines = [
    `Next task: ${view.key} — ${view.title}`,
    "",
    `State: ${view.state}`,
    `Evidence: ${view.verification_note}`,
  ]
  if (view.acceptance) {
    lines.push("")
    lines.push("Done means:")
    lines.push(`  ${view.acceptance}`)
  }
  const required = context.gates.filter((gate) => gate.requiredForTypes.includes(next.type))
  if (required.length > 0) {
    lines.push("")
    lines.push("Checks this task needs:")
    for (const gate of required) {
      lines.push(`  ${gate.id} (${gate.kind}) — ${gate.state === "approved" ? "approved" : "not approved, so it does not run"}`)
    }
  }
  const blocked = findBlocked(context.tasks, context.edges).find(
    (problem) => problem.taskKey === next.publicKey,
  )
  if (blocked) {
    lines.push("")
    lines.push(`Waiting for: ${blocked.blockedBy.join(", ")}`)
  }
  return lines.join("\n")
}

/**
 * The tasks that are waiting, and on what.
 */
export function formatBlockers(context: CommandContext): string {
  const waiting = findBlocked(context.tasks, context.edges)
  if (waiting.length === 0) {
    return "Nothing is waiting for a dependency."
  }
  const lines = ["Waiting for a dependency:"]
  for (const problem of waiting) {
    lines.push(`  ${problem.taskKey} — waiting for ${problem.blockedBy.join(", ")}`)
  }
  return lines.join("\n")
}

/**
 * The evidence for a task, and what is missing.
 *
 * This is the command that answers "can I close this?", and it never says
 * "yes" on its own. It reports what the rules say, and the rules are the
 * state machine's.
 */
export function formatReview(context: CommandContext, taskKey: string): string {
  const task = context.tasks.find((candidate) => candidate.publicKey === taskKey)
  if (!task) {
    return `There is no task named ${taskKey}.`
  }
  const view = toView(task, { edges: context.edges, tasks: [...context.tasks] })
  const lines = [
    `${view.key} — ${view.title}`,
    "",
    `State: ${view.state}`,
    `Evidence: ${view.verification_note}`,
  ]
  if (view.acceptance) {
    lines.push("")
    lines.push("Done means:")
    lines.push(`  ${view.acceptance}`)
  }

  const required = context.gates.filter((gate) => gate.requiredForTypes.includes(task.type))
  if (required.length > 0) {
    lines.push("")
    lines.push("Required checks:")
    for (const gate of required) {
      lines.push(`  ${gate.id} (${gate.kind}) — ${gate.state}`)
    }
  }

  lines.push("")
  lines.push(
    task.state === "done"
      ? "This task is done. Reopen it if the work changed."
      : "This task can only reach 'done' on evidence that is current, or on a recorded waiver.",
  )
  return lines.join("\n")
}

/**
 * A handoff, as a person reads it.
 *
 * The format is the plan's structured handoff, rendered. It is a *report*:
 * it says what happened, and it never says the work is correct.
 */
export function formatHandoff(
  context: CommandContext,
  handoff: {
    taskKey?: string
    status?: string
    completed: string[]
    blockers: string[]
    nextActions: string[]
    evidence: { kind: string; id?: string; outcome: string }[]
  },
): string {
  const lines: string[] = []
  if (handoff.taskKey) {
    lines.push(`Task: ${handoff.taskKey}${handoff.status ? ` (${handoff.status})` : ""}`)
  }
  if (handoff.completed.length > 0) {
    lines.push("")
    lines.push("Done:")
    for (const item of handoff.completed) lines.push(`  - ${item}`)
  }
  if (handoff.evidence.length > 0) {
    lines.push("")
    lines.push("Evidence:")
    for (const item of handoff.evidence) {
      lines.push(`  - ${item.kind}${item.id ? ` ${item.id}` : ""}: ${item.outcome}`)
    }
  }
  if (handoff.blockers.length > 0) {
    lines.push("")
    lines.push("Blocked by:")
    for (const item of handoff.blockers) lines.push(`  - ${item}`)
  }
  if (handoff.nextActions.length > 0) {
    lines.push("")
    lines.push("Next:")
    for (const item of handoff.nextActions) lines.push(`  - ${item}`)
  }
  if (context.head) {
    lines.push("")
    lines.push(`Worktree HEAD: ${context.head}`)
  }
  return lines.join("\n")
}

/**
 * The task list, as a person reads it.
 *
 * A short list: a person wants the shape of the work, not every task.
 */
export function formatList(context: CommandContext, limit = 30): string {
  const list = toList(context.tasks, context.edges, { limit })
  if (list.tasks.length === 0) {
    return "There are no tasks."
  }
  const lines: string[] = []
  for (const task of list.tasks) {
    const verified = task.verified ? "" : "  [unverified]"
    lines.push(`${task.key.padEnd(24)} ${task.state.padEnd(12)} ${task.title}${verified}`)
  }
  if (list.waiting.length > 0) {
    lines.push("")
    lines.push("Waiting for a dependency:")
    for (const problem of list.waiting) {
      lines.push(`  ${problem.key} — waiting for ${problem.blocked_by.join(", ")}`)
    }
  }
  if (list.truncated) {
    lines.push("")
    lines.push(`Only the first ${list.count} of ${list.total} tasks are shown.`)
  }
  return lines.join("\n")
}

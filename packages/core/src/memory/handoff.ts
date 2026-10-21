import type { Memory } from "./types.ts"

/**
 * The handoff.
 *
 * A handoff is a **session report**, not an architecture fact. It says what
 * happened in one session so the next one can pick up. It never becomes a
 * decision by being read — promotion is a separate, deliberate act.
 *
 * The shape is fixed, so a handoff is machine-readable: a resumed session
 * does not have to parse prose to know what is blocked.
 */

/** What a handoff reports about a piece of evidence. */
export interface HandoffEvidence {
  /** What kind of evidence it is. */
  kind: "test_run" | "gate_run" | "waiver" | "file"
  /** The id of the thing, when it has one. */
  id?: string
  /** What it said. */
  outcome: string
}

/** A decision a handoff depends on. */
export interface HandoffDecision {
  /** The memory's id. */
  memoryId: string
  /** The trust it has. */
  trust: string
  /** Its title, so a reader does not have to fetch it. */
  title?: string
}

/** The worktree state a handoff was taken against. */
export interface HandoffWorktree {
  /** The project root. */
  root?: string
  /** The worktree's HEAD. */
  head?: string
  /** The code index's epoch. */
  indexEpoch?: number
}

/**
 * A handoff.
 *
 * Every field is optional except the ones that make it useful, and the whole
 * thing is bounded: it is a summary, and a summary that runs to ten thousand
 * words is not a summary.
 */
export interface Handoff {
  /** The task this handoff is about. */
  taskId?: string
  /** The task's key, for a human. */
  taskKey?: string
  /** The task's state when the handoff was taken. */
  status?: string
  /** What was finished. */
  completed: string[]
  /** The evidence behind it. */
  evidence: HandoffEvidence[]
  /** The decisions it rests on. */
  decisions: HandoffDecision[]
  /** What is in the way. */
  blockers: string[]
  /** What to do next. */
  nextActions: string[]
  /** The worktree state it was taken against. */
  worktree: HandoffWorktree
  /** When it was taken. */
  createdAt: number
  /** The session it came from. */
  sessionId?: string
}

/** The limits on a handoff. */
export const HANDOFF_LIMITS = {
  /** The most items in any one list. */
  maxItems: 20,
  /** The longest a single item may be. */
  maxItemLength: 400,
  /** The most handoffs kept for a task. */
  maxPerTask: 20,
} as const

/**
 * An empty handoff.
 *
 * The lists are empty rather than absent, so a consumer never has to check
 * whether a field exists.
 */
export function emptyHandoff(): Handoff {
  return {
    completed: [],
    evidence: [],
    decisions: [],
    blockers: [],
    nextActions: [],
    worktree: {},
    createdAt: Date.now(),
  }
}

/**
 * Bound a handoff.
 *
 * A handoff that arrives from an agent is untrusted input, and it must not
 * be able to make the stored record arbitrarily large. The lists are capped
 * and the items in them are truncated.
 */
export function boundHandoff(handoff: Handoff): Handoff {
  const bound = (items: string[]): string[] =>
    items
      .slice(0, HANDOFF_LIMITS.maxItems)
      .map((item) =>
        item.length > HANDOFF_LIMITS.maxItemLength
          ? `${item.slice(0, HANDOFF_LIMITS.maxItemLength - 1)}…`
          : item,
      )
  return {
    ...handoff,
    completed: bound(handoff.completed),
    blockers: bound(handoff.blockers),
    nextActions: bound(handoff.nextActions),
    evidence: handoff.evidence.slice(0, HANDOFF_LIMITS.maxItems),
    decisions: handoff.decisions.slice(0, HANDOFF_LIMITS.maxItems),
  }
}

/**
 * A handoff as a short, readable summary.
 *
 * This is what a resumed session reads first. It is bounded on purpose: a
 * handoff is a summary, and the full record is one lookup away.
 */
export function summariseHandoff(handoff: Handoff, memories: Memory[] = []): string {
  const byId = new Map(memories.map((memory) => [memory.id, memory]))
  const lines: string[] = []
  if (handoff.taskKey) lines.push(`Task: ${handoff.taskKey}${handoff.status ? ` (${handoff.status})` : ""}`)
  if (handoff.completed.length > 0) {
    lines.push("Done:")
    for (const item of handoff.completed) lines.push(`  - ${item}`)
  }
  if (handoff.decisions.length > 0) {
    lines.push("Decisions:")
    for (const decision of handoff.decisions) {
      const memory = byId.get(decision.memoryId)
      const title = decision.title ?? memory?.title ?? decision.memoryId
      const stale = memory?.stale ? " (stale)" : ""
      lines.push(`  - ${title} [${decision.trust}${stale}]`)
    }
  }
  if (handoff.blockers.length > 0) {
    lines.push("Blocked by:")
    for (const item of handoff.blockers) lines.push(`  - ${item}`)
  }
  if (handoff.nextActions.length > 0) {
    lines.push("Next:")
    for (const item of handoff.nextActions) lines.push(`  - ${item}`)
  }
  if (handoff.evidence.length > 0) {
    lines.push("Evidence:")
    for (const evidence of handoff.evidence) {
      lines.push(`  - ${evidence.kind}${evidence.id ? ` ${evidence.id}` : ""}: ${evidence.outcome}`)
    }
  }
  return lines.join("\n")
}

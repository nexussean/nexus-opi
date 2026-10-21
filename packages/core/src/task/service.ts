import { findBlocked, nextTask } from "./dag.ts"
import { verificationNote } from "./machine.ts"
import type { Task, TaskEdge, TaskEvent, TaskState } from "./types.ts"

/**
 * The task service.
 *
 * It turns the store's rows into the shapes the tool returns. It owns no
 * state of its own — the store is authoritative — and it makes no decision
 * the state machine has not already made.
 *
 * The one thing it does own is the **presentation of evidence**. A task's
 * verification state is always reported, and a task that is done but
 * unverified says so. A surface that shows a task without its evidence
 * reintroduces exactly the lie ADR-0022 exists to prevent.
 */

/** A task as the tool returns it. */
export interface TaskView {
  id: string
  key: string
  title: string
  state: TaskState
  type: string
  priority: number
  /** The acceptance criteria, when there are any. */
  acceptance?: string
  /** The description, when there is one. */
  description?: string
  /** The verification state. Never omitted. */
  verification: string
  /** A plain statement of what the evidence is. */
  verification_note: string
  /** True when the task is done and its evidence is sound. */
  verified: boolean
  /** The revision. A write must state it. */
  revision: number
  /** The tasks that block this one, by key. */
  blocked_by?: string[]
  /** The worktree this task is scoped to. */
  worktree_id?: string
  created_at?: number
  updated_at?: number
}

export interface TaskListResult {
  tasks: TaskView[]
  /** The tasks that are waiting for a dependency, by key. */
  waiting: { key: string; blocked_by: string[] }[]
  /** The next task to work on, if there is one. */
  next?: TaskView
  /** The number of tasks returned, and the number that exist. */
  count: number
  total: number
  /** True when the list was cut short. */
  truncated: boolean
}

export interface TaskHistoryResult {
  key: string
  events: {
    sequence: number
    actor: string
    operation: string
    changes: Record<string, unknown>
    evidence_ref?: string
    at: number
  }[]
}

/** The states a task may be in. */
export const TASK_STATES: readonly TaskState[] = [
  "backlog",
  "ready",
  "in_progress",
  "review",
  "done",
  "archived",
]

/** The relations two tasks may have. */
export const TASK_RELATIONS = ["blocks", "parent", "related"] as const

/**
 * A task as the tool returns it.
 *
 * The verification state and its note are always present. A caller that
 * shows this to a person cannot accidentally show a task as finished without
 * also showing whether it is proven.
 */
export function toView(
  task: Task,
  context: { edges?: readonly TaskEdge[]; tasks?: readonly Task[] } = {},
): TaskView {
  const blockers: string[] = []
  if (context.edges && context.tasks) {
    const byId = new Map(context.tasks.map((candidate) => [candidate.id, candidate]))
    for (const edge of context.edges) {
      if (edge.to !== task.id || edge.relation !== "blocks") continue
      blockers.push(byId.get(edge.from)?.publicKey ?? edge.from)
    }
  }
  return {
    id: task.id,
    key: task.publicKey,
    title: task.title,
    state: task.state,
    type: task.type,
    priority: task.priority,
    ...(task.acceptance ? { acceptance: task.acceptance } : {}),
    ...(task.description ? { description: task.description } : {}),
    verification: task.verification,
    verification_note: verificationNote(task),
    verified: task.verification === "passed" || task.verification === "waived",
    revision: task.revision,
    ...(blockers.length > 0 ? { blocked_by: blockers } : {}),
    ...(task.worktreeId ? { worktree_id: task.worktreeId } : {}),
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  }
}

/**
 * A list of tasks, with the waiting list and the next task.
 *
 * The list is bounded. A board with a thousand tasks is not something a
 * model should read in one call.
 */
export function toList(
  tasks: readonly Task[],
  edges: readonly TaskEdge[],
  options: { limit?: number; states?: readonly TaskState[] } = {},
): TaskListResult {
  const limit = options.limit ?? 50
  const filtered = options.states?.length
    ? tasks.filter((task) => options.states!.includes(task.state))
    : [...tasks]
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const views = filtered.slice(0, limit).map((task) => toView(task, { edges, tasks }))
  const waiting = findBlocked(tasks, edges).map((problem) => ({
    key: problem.taskKey,
    blocked_by: problem.blockedBy,
  }))
  const next = nextTask(tasks, edges)
  return {
    tasks: views,
    waiting,
    ...(next ? { next: toView(next, { edges, tasks }) } : {}),
    count: views.length,
    total: filtered.length,
    truncated: filtered.length > views.length,
  }
}

/** A task's history. */
export function toHistory(task: Task, events: readonly TaskEvent[]): TaskHistoryResult {
  return {
    key: task.publicKey,
    events: events.map((event) => ({
      sequence: event.sequence,
      actor: event.actor,
      operation: event.operation,
      changes: event.changes,
      ...(event.evidenceRef ? { evidence_ref: event.evidenceRef } : {}),
      at: event.createdAt,
    })),
  }
}

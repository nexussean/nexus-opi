import type { Task, TaskEdge, TaskRelation, TaskState } from "./types.ts"
import { isTerminal } from "./types.ts"

/**
 * The dependency graph.
 *
 * `blocks` is the only relation that affects readiness. `parent` and
 * `related` are organisational, and treating them as dependencies is a bug
 * that hides in a board: a task that is "related" to something unfinished
 * would look stuck.
 */

export interface DependencyProblem {
  /** The public key of the task that cannot be made ready. */
  taskKey: string
  /** The public keys of the predecessors that are not finished. */
  blockedBy: string[]
}

/**
 * Would adding this edge create a cycle?
 *
 * A cycle in a `blocks` graph is a validation error, not a runtime
 * condition: there is no order that satisfies it, so no task in it can ever
 * be ready. It is caught at insertion.
 */
export function wouldCreateCycle(
  edges: readonly TaskEdge[],
  from: string,
  to: string,
): boolean {
  // The new edge is `from -> to`, meaning `from` blocks `to`. A cycle exists
  // if `to` can already reach `from` — then the new edge closes the loop.
  //
  // The new edge is **not** added to the graph before the search. Adding it
  // would make the search find the edge it is testing for, and every link
  // would look like a cycle.
  if (from === to) return true

  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.relation !== "blocks") continue
    // An existing edge in the same direction is not a new constraint.
    if (edge.from === from && edge.to === to) continue
    const list = adjacency.get(edge.from) ?? []
    list.push(edge.to)
    adjacency.set(edge.from, list)
  }

  // Walk from `to`, looking for `from`. If it is reachable, the new edge
  // closes a cycle.
  const seen = new Set<string>()
  const stack = [to]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === from) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const next of adjacency.get(current) ?? []) stack.push(next)
  }
  return false
}

/**
 * The predecessors of a task that must finish first.
 *
 * Only `blocks` edges count. A `blocks` edge means the predecessor must
 * reach a terminal state before the successor is ready.
 */
export function blockersOf(
  taskId: string,
  edges: readonly TaskEdge[],
): { id: string; relation: TaskRelation }[] {
  return edges
    .filter((edge) => edge.to === taskId && edge.relation === "blocks")
    .map((edge) => ({ id: edge.from, relation: edge.relation }))
}

/**
 * Is this task ready to start?
 *
 * A task is ready when every task that blocks it has finished. A task that
 * is *not* ready is not "blocked" as a state — it is a task in `backlog`
 * waiting for a dependency, and the board says so.
 */
export function isReady(
  task: Pick<Task, "id" | "state">,
  tasks: readonly Task[],
  edges: readonly TaskEdge[],
): boolean {
  if (task.state !== "backlog" && task.state !== "ready") return false
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]))
  for (const blocker of blockersOf(task.id, edges)) {
    const predecessor = byId.get(blocker.id)
    // A missing predecessor is treated as unfinished. A task whose
    // predecessor was deleted is not ready, and saying so is honest.
    if (!predecessor) return false
    if (!isTerminal(predecessor.state)) return false
  }
  return true
}

/**
 * The tasks that are not ready, and why.
 *
 * This is what the board shows as "waiting for dependency". The task's own
 * state is untouched.
 */
export function findBlocked(
  tasks: readonly Task[],
  edges: readonly TaskEdge[],
): DependencyProblem[] {
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]))
  const problems: DependencyProblem[] = []
  for (const task of tasks) {
    if (task.state !== "backlog" && task.state !== "ready") continue
    const blockedBy: string[] = []
    for (const blocker of blockersOf(task.id, edges)) {
      const predecessor = byId.get(blocker.id)
      if (!predecessor || !isTerminal(predecessor.state)) {
        blockedBy.push(predecessor?.publicKey ?? blocker.id)
      }
    }
    if (blockedBy.length > 0) problems.push({ taskKey: task.publicKey, blockedBy })
  }
  return problems
}

/**
 * The next task to work on.
 *
 * Ready means: in `backlog` or `ready`, every blocker finished, and not
 * already in progress. The ordering is by priority, then by how long the task
 * has been waiting, then by key — so the answer is stable.
 */
export function nextTask(
  tasks: readonly Task[],
  edges: readonly TaskEdge[],
): Task | undefined {
  const ready = tasks.filter((task) => isReady(task, tasks, edges))
  if (ready.length === 0) return undefined
  return [...ready].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return a.publicKey.localeCompare(b.publicKey)
  })[0]
}

/**
 * The tasks that a task blocks — the other direction of the graph.
 */
export function dependentsOf(taskId: string, edges: readonly TaskEdge[]): string[] {
  return edges.filter((edge) => edge.from === taskId && edge.relation === "blocks").map((edge) => edge.to)
}

/**
 * A cycle in the `blocks` graph, if there is one.
 *
 * Used to check a whole graph, not a single edge. Returns the task ids in
 * the cycle.
 */
export function findCycle(edges: readonly TaskEdge[]): string[] | undefined {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.relation !== "blocks") continue
    const list = adjacency.get(edge.from) ?? []
    list.push(edge.to)
    adjacency.set(edge.from, list)
  }

  const state = new Map<string, "visiting" | "done">()
  const stack: string[] = []
  let found: string[] | undefined

  const visit = (node: string): boolean => {
    const current = state.get(node)
    if (current === "done") return false
    if (current === "visiting") {
      const start = stack.indexOf(node)
      found = stack.slice(start === -1 ? 0 : start)
      return true
    }
    state.set(node, "visiting")
    stack.push(node)
    for (const next of adjacency.get(node) ?? []) {
      if (visit(next)) return true
    }
    stack.pop()
    state.set(node, "done")
    return false
  }

  for (const node of adjacency.keys()) {
    if (visit(node)) return found
  }
  return undefined
}

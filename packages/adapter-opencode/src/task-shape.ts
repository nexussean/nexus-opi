/**
 * The `pi.task` tool, in two shapes.
 *
 * ## Why
 *
 * The surface-shape experiment measured the **fixture's** two shapes: one tool
 * per action, and one tool with an `action` argument. The single tool won on
 * both models — 1.21× cheaper per success on minimax, 1.03× on deepseek — and
 * the mechanism was visible in the call counts: with six separate tools, a
 * model called `task_list` 10, 15 and 10 times for one question.
 *
 * But the fixture is a **different product**. It has no revision, no audit
 * history, and no guarded transitions, so it cannot answer the write
 * questions at all, and a write comparison across the two backends would
 * measure the difference in the backends rather than the difference in the
 * interfaces.
 *
 * This module puts the **product's** own task tool in two shapes, over the
 * **same** SQLite store, with the same guard, the same semantics and the same
 * audit history. Only the interface differs, which is what the comparison
 * needs.
 *
 * ## The two shapes
 *
 * - `action` — one tool, `pi.task`, with an `action` argument. This is what
 *   ships.
 * - `split` — one tool per action: `pi.task_list`, `pi.task_get`,
 *   `pi.task_create`, and so on. Each carries only the arguments that action
 *   needs, and each has its own description.
 *
 * The split shape is the one the benchmark said was worse, applied to the
 * product. If the result holds, the product's shape is confirmed on the
 * product's own store.
 */

export type TaskShape = "action" | "split"

/** The actions `pi.task` accepts. */
export const TASK_ACTIONS = [
  "list",
  "get",
  "create",
  "update",
  "transition",
  "link",
  "unlink",
  "history",
  "delete",
] as const

export type TaskAction = (typeof TASK_ACTIONS)[number]

/**
 * The tool name for an action, in the split shape.
 *
 * `pi.task_list` and not `pi.list`: the split shape keeps the product's
 * namespace, so both shapes present tools under `pi.` and a model that has
 * seen one does not have to learn a new namespace to use the other.
 */
export function splitToolName(action: TaskAction): string {
  return `task_${action}`
}

/**
 * The arguments each action needs, in the split shape.
 *
 * The split shape's whole argument is that each action carries **only** what
 * it needs. `pi.task_list` has no `task` argument, because listing does not
 * need one; `pi.task_get` has no `state`, because getting does not change
 * one. A split that carried every argument on every tool would not be a
 * split at all.
 */
export const ACTION_ARGUMENTS: Record<TaskAction, string[]> = {
  list: ["state", "limit"],
  get: ["task"],
  create: ["title", "description", "acceptance", "type", "priority", "state"],
  update: ["task", "title", "description", "acceptance", "type", "priority", "expected_revision"],
  transition: ["task", "state", "expected_revision"],
  link: ["task", "relation", "other"],
  unlink: ["task", "relation", "other"],
  history: ["task"],
  delete: ["task", "expected_revision"],
}

/**
 * The description each action's tool carries, in the split shape.
 *
 * The action's own name is in the tool's name, so the description says what
 * the action **does** rather than repeating the name.
 */
export const ACTION_DESCRIPTIONS: Record<TaskAction, string> = {
  list: "List the project's tasks, with what each is waiting for.",
  get: "One task, with its acceptance criteria and its verification evidence.",
  create: "Create a task.",
  update: "Change a task's title, criteria, priority or type.",
  transition: "Move a task to another state.",
  link: "Relate two tasks. 'blocks' makes one wait for the other.",
  unlink: "Remove a relation.",
  history: "What happened to a task, in order.",
  delete: "Remove a task, its links and its history.",
}

/**
 * The shape a plugin instance should use.
 *
 * `action` is the default, because it is what ships. `split` is the arm the
 * benchmark measures against it.
 */
export function taskShapeFor(value: unknown): TaskShape {
  return value === "split" ? "split" : "action"
}

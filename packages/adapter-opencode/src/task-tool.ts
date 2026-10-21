/**
 * The product's task tool, in two shapes.
 *
 * The surface-shape experiment measured the **fixture's** two shapes and found
 * that one tool with an `action` argument beat one tool per action, on both
 * models. But the fixture is a different product: it has no revision, no
 * audit history and no guarded transitions, so it cannot answer the write
 * questions at all.
 *
 * This module puts the **product's** task tool in both shapes, over the same
 * SQLite store, with the same guard and the same audit history. Only the
 * interface differs, which is what the comparison needs.
 *
 * The body below is the shipping implementation, unchanged. The two shapes
 * differ only in how they present it.
 */
import type { Plugin } from "@opencode/plugin"
import type { SqliteProjectRegistry, SqliteTaskStore } from "@opi/db"
import {
  resolveProject,
  toHistory,
  toList,
  toView,
  type Task,
  type TaskEdge,
  type TaskState,
} from "@opi/core"
import { descriptionFor } from "./descriptions.ts"
import { MINIMAL_ARGUMENTS, MINIMAL_SPLIT_ARGUMENTS, MINIMAL_SPLIT_DESCRIPTIONS } from "./schema-size.ts"
import {
  ACTION_DESCRIPTIONS,
  splitToolName,
  TASK_ACTIONS,
  type TaskAction,
  type TaskShape,
} from "./task-shape.ts"

/**
 * The editor the tools are registered with.
 *
 * The plugin package does not export the editor's type, so it is described by
 * what the tools need: a way to add a tool.
 */
interface ToolEditor {
  add: (definition: {
    name: string
    description: string
    input: Record<string, unknown>
    options?: { namespace?: string }
    execute: (input: unknown) => Promise<ToolReply>
  }) => void
}

/** The task store the tools read and write. */
type TaskStore = SqliteTaskStore
/** The project registry the tools resolve their project through. */
type ProjectRegistry = SqliteProjectRegistry

/** The states a task can be in. */
const TASK_STATES = ["backlog", "ready", "in_progress", "review", "done", "archived"] as const
/** The kinds of work a task can be. */
const TASK_TYPES = ["feature", "bug", "chore", "docs", "refactor", "test"] as const
/** The relations two tasks can have. */
const TASK_RELATIONS = ["blocks", "parent", "related"] as const

/**
 * The properties each action's tool carries, in the split shape.
 *
 * The descriptions are the same ones the single tool uses, so the two shapes
 * differ in **structure** and not in what they tell the model.
 */
const ACTION_PROPERTIES: Record<TaskAction, Record<string, unknown>> = {
  list: {
    state: { type: "string", description: "Only return tasks in this state." },
    limit: { type: "number", description: "Maximum tasks to return. Default 50." },
  },
  get: {
    task: { type: "string", description: "The task's key, e.g. 'PI-0012'." },
  },
  create: {
    title: { type: "string", description: "The task's title." },
    description: { type: "string", description: "What the task is about." },
    acceptance: { type: "string", description: "What 'done' means for this task, in the task's own words." },
    type: { type: "string", enum: TASK_TYPES, description: "What kind of work this is." },
    priority: { type: "number", description: "0 (lowest) to 3 (highest)." },
    state: { type: "string", enum: TASK_STATES, description: "The state to create it in. Default backlog." },
  },
  update: {
    task: { type: "string", description: "The task's key, e.g. 'PI-0012'." },
    title: { type: "string", description: "The task's new title." },
    description: { type: "string", description: "What the task is about." },
    acceptance: { type: "string", description: "What 'done' means for this task." },
    type: { type: "string", enum: TASK_TYPES, description: "What kind of work this is." },
    priority: { type: "number", description: "0 (lowest) to 3 (highest)." },
    expected_revision: { type: "number", description: "The revision you read. Required." },
  },
  transition: {
    task: { type: "string", description: "The task's key, e.g. 'PI-0012'." },
    state: { type: "string", enum: TASK_STATES, description: "The state to move to." },
    expected_revision: { type: "number", description: "The revision you read. Required." },
  },
  link: {
    task: { type: "string", description: "The task's key, e.g. 'PI-0012'." },
    relation: { type: "string", enum: TASK_RELATIONS, description: "How the two tasks relate." },
    other: { type: "string", description: "The other task's key." },
  },
  unlink: {
    task: { type: "string", description: "The task's key, e.g. 'PI-0012'." },
    relation: { type: "string", enum: TASK_RELATIONS, description: "The relation to remove." },
    other: { type: "string", description: "The other task's key." },
  },
  history: {
    task: { type: "string", description: "The task's key, e.g. 'PI-0012'." },
  },
  delete: {
    task: { type: "string", description: "The task's key, e.g. 'PI-0012'." },
    expected_revision: { type: "number", description: "The revision you read. Required." },
  },
}

export { TASK_ACTIONS }

/**
 * The reply envelope.
 *
 * Every tool answers with the same shape: the data, the warnings, and where
 * it came from. A caller that gets `status: "error"` knows the tool did not
 * answer, and does not have to guess from an empty result.
 */
export interface ToolReply {
  content: string
}

/** The reply function the tools answer with. */
export type ReplyFn = (data: unknown, warnings?: string[], status?: string) => ToolReply

/**
 * The reply shape every tool returns.
 *
 * The tools answer with a JSON envelope: the data, the warnings, and where it
 * came from. A caller that gets `status: "error"` knows the tool did not
 * answer, and does not have to guess from an empty result.
 */
export interface ToolReply {
  content: string
}

/** The reply function the tools answer with. */

/**
 * Register the task tool, in the shape the instance is configured for.
 *
 * The body is the shipping implementation, unchanged. The two shapes differ
 * only in how they present it, so a difference in the measurement is a
 * difference in the **interface** and not in the behaviour.
 */
export function registerTaskTools(options: {
  editor: ToolEditor
  ctx: Plugin.Context
  tasks: TaskStore
  registry: ProjectRegistry
  shape: TaskShape
  descriptionVariant: "baseline" | "revised"
  schemaSize: "full" | "minimal"
  makeReply: (identity: { id: string; worktree: { id: string } }) => ReplyFn
}): void {
  const { editor, ctx, tasks, registry, shape, descriptionVariant, schemaSize, makeReply } = options

  /**
   * The task tool's argument descriptions.
   *
   * The minimal variant says what each argument **is**. Anything about *when*
   * it is required is stated once, in the tool's description, rather than on
   * every argument — which is the point: the same information in fewer bytes.
   */
  const argDescription = (key: string, full: string): string => {
    if (schemaSize !== "minimal") return full
    return MINIMAL_ARGUMENTS[descriptionVariant].task?.[key] ?? full
  }

  /**
   * A split tool's own description.
   *
   * The split shape does not have a `pi.task` description to shorten, so it
   * gets the action's description — and it gets the **same** treatment as
   * the single tool's: the minimal wording when the size is minimal, and
   * the variant's wording either way.
   */
  const splitDescription = (
    action: TaskAction,
    wording: "baseline" | "revised",
    size: "full" | "minimal",
  ): string => {
    const actionDescription = ACTION_DESCRIPTIONS[action]
    if (size === "minimal") {
      // The minimal wording for the split shape. It is the action's
      // description, shortened, and it names the action's subject.
      const minimal = MINIMAL_SPLIT_DESCRIPTIONS[wording]?.[action]
      if (minimal) return minimal
    }
    return actionDescription
  }

  /**
   * A split tool's argument description.
   *
   * The action's own arguments carry their own descriptions. The minimal
   * variant uses the same shortened forms as the single tool, so the size
   * lever is the same lever in both shapes.
   */
  const splitArgumentDescription = (
    action: TaskAction,
    key: string,
    full: string,
  ): string => {
    if (schemaSize !== "minimal") return full
    const minimal = MINIMAL_SPLIT_ARGUMENTS[descriptionVariant]?.[action]?.[key]
    if (minimal) return minimal
    return full
  }

  if (shape === "split") {
    // One tool per action. Each carries only the arguments that action needs,
    // and each has its own description.
    //
    // The descriptions and the argument descriptions come from the **same
    // variants** the single-tool shape uses. They used to be fixed text, which
    // meant the structure arm also changed the wording and the size at once,
    // and a difference in the result could not be attributed to the
    // structure.
    for (const action of TASK_ACTIONS) {
      const action_ = action as TaskAction
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const key of Object.keys(ACTION_PROPERTIES[action_])) {
        const definition = ACTION_PROPERTIES[action_][key] as {
          type: string
          enum?: readonly string[]
          description?: string
        }
        properties[key] = {
          ...definition,
          description: splitArgumentDescription(action_, key, definition.description ?? ""),
        }
      }
      if (action_ === "get" || action_ === "history" || action_ === "unlink" || action_ === "link") {
        required.push("task")
      }
      if (action_ === "create") required.push("title")
      if (action_ === "update" || action_ === "transition" || action_ === "delete") {
        required.push("expected_revision")
      }
      editor.add({
        name: splitToolName(action_),
        description: splitDescription(action_, descriptionVariant, schemaSize),
        input: {
          type: "object",
          properties,
          ...(required.length ? { required } : {}),
          additionalProperties: false,
        },
        options: { namespace: "pi" },
        execute: (input: unknown) =>
          runTaskAction(action_, input, { ctx, tasks, registry, makeReply }),
      })
    }
    return
  }

  editor.add({
    name: "task",
    description: descriptionFor(descriptionVariant, "task", schemaSize),
    input: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: TASK_ACTIONS,
          description: "The operation to run.",
        },
        task: {
          type: "string",
          description: argDescription("task", "The task's key, e.g. 'PI-0012'. Required for everything but list and create."),
        },
        title: { type: "string", description: argDescription("title", "The task's title. For create and update.") },
        description: { type: "string", description: argDescription("description", "What the task is about. For create and update.") },
        acceptance: {
          type: "string",
          description: argDescription("acceptance", "What 'done' means for this task, in the task's own words."),
        },
        type: {
          type: "string",
          enum: TASK_TYPES,
          description: "What kind of work this is.",
        },
        priority: { type: "number", description: "0 (lowest) to 3 (highest)." },
        state: {
          type: "string",
          enum: TASK_STATES,
          description: "The state to move to. For transition.",
        },
        expected_revision: {
          type: "number",
          description: argDescription("expected_revision", "The revision you read. Required for update and transition."),
        },
        relation: {
          type: "string",
          enum: TASK_RELATIONS,
          description: "How the two tasks relate. For link and unlink.",
        },
        other: { type: "string", description: "The other task's key. For link and unlink." },
        waiver: {
          type: "object",
          description: "Waive the check requirement. Needs an actor, a reason and a scope.",
        },
        limit: { type: "number", description: "Maximum tasks to return. Default 50." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    options: { namespace: "pi" },
    execute: (input: unknown) =>
      runTaskAction(String((input as Record<string, unknown>)?.action ?? "list"), input, {
        ctx,
        tasks,
        registry,
        makeReply,
      }),
  })
}

/**
 * The task tool's implementation.
 *
 * It is the shipping code, unchanged: the same store, the same guard, the same
 * audit history. The two shapes call it with the same arguments.
 */
async function runTaskAction(
  TASK_ACTION: string,
  input: unknown,
  context: {
    ctx: Plugin.Context
    tasks: TaskStore
    registry: ProjectRegistry
    makeReply: (identity: { id: string; worktree: { id: string } }) => ReplyFn
  },
): Promise<ToolReply> {
  const { ctx, tasks, registry } = context
        const args = (input ?? {}) as Record<string, unknown>
        const action = TASK_ACTION

        // The project comes from the trusted location, never from the model.
        const identity = await resolveProject(ctx.location.directory, registry)
        if (!identity) {
          return {
            content: JSON.stringify({
              schema_version: "1",
              status: "error",
              data: undefined,
              warnings: ["The project could not be resolved, so its tasks cannot be reached."],
              sources: [],
              truncated: false,
            }),
          }
        }
        const projectId = identity.id

        /** Find a task by key, or by internal id. */
        const find = (reference: string | undefined) => {
          if (!reference) return undefined
          return tasks.getByKey(projectId, reference) ?? tasks.get(reference)
        }

        const reply = context.makeReply({ id: projectId, worktree: { id: identity.worktree.id } })

        switch (action) {
          case "list": {
            const all = tasks.list(projectId)
            const edges = tasks.edges(projectId)
            const states = Array.isArray(args.state)
              ? (args.state as TaskState[])
              : args.state
                ? [String(args.state) as TaskState]
                : undefined
            const limit = typeof args.limit === "number" ? args.limit : undefined
            return reply(toList(all, edges, { ...(limit ? { limit } : {}), ...(states ? { states } : {}) }))
          }
          case "get": {
            const task = find(args.task as string | undefined)
            if (!task) return reply(undefined, ["No task with that key."], "error")
            const edges = tasks.edges(projectId)
            return reply(toView(task, { edges, tasks: tasks.list(projectId) }))
          }
          case "create": {
            const title = String(args.title ?? "").trim()
            if (!title) return reply(undefined, ["A task needs a title."], "error")
            const result = tasks.create({
              projectId,
              title,
              ...(args.description ? { description: String(args.description) } : {}),
              ...(args.acceptance ? { acceptance: String(args.acceptance) } : {}),
              ...(args.type ? { type: String(args.type) as Task["type"] } : {}),
              ...(typeof args.priority === "number" ? { priority: args.priority as Task["priority"] } : {}),
              actor: "agent",
            })
            if (!result.ok || !result.value) {
              return reply(undefined, [result.error ?? "The task could not be created."], "error")
            }
            return reply(toView(result.value))
          }
          case "update": {
            const task = find(args.task as string | undefined)
            if (!task) return reply(undefined, ["No task with that key."], "error")
            const expected = typeof args.expected_revision === "number" ? args.expected_revision : undefined
            if (expected === undefined) {
              return reply(
                undefined,
                ["An update needs the revision you read. Read the task, then pass it."],
                "error",
              )
            }
            const result = tasks.update({
              taskId: task.id,
              expectedRevision: expected,
              ...(args.title !== undefined ? { title: String(args.title) } : {}),
              ...(args.description !== undefined ? { description: String(args.description) } : {}),
              ...(args.acceptance !== undefined ? { acceptance: String(args.acceptance) } : {}),
              ...(args.type !== undefined ? { type: String(args.type) as Task["type"] } : {}),
              ...(typeof args.priority === "number" ? { priority: args.priority as Task["priority"] } : {}),
              actor: "agent",
            })
            if (!result.ok || !result.value) {
              return reply(undefined, [result.error ?? "The task could not be updated."], "error")
            }
            return reply(toView(result.value))
          }
          case "transition": {
            const task = find(args.task as string | undefined)
            if (!task) return reply(undefined, ["No task with that key."], "error")
            const to = String(args.state ?? "") as TaskState
            const expected = typeof args.expected_revision === "number" ? args.expected_revision : undefined
            if (expected === undefined) {
              return reply(
                undefined,
                ["A transition needs the revision you read. Read the task, then pass it."],
                "error",
              )
            }
            const waiverInput = args.waiver as
              | { actor?: string; reason?: string; scope?: string }
              | undefined
            const result = tasks.transition({
              taskId: task.id,
              to,
              expectedRevision: expected,
              actor: "agent",
              ...(waiverInput
                ? {
                    waiver: {
                      actor: String(waiverInput.actor ?? ""),
                      reason: String(waiverInput.reason ?? ""),
                      scope: String(waiverInput.scope ?? ""),
                      at: Date.now(),
                    },
                  }
                : {}),
            })
            if (!result.ok || !result.value) {
              return reply(
                undefined,
                [result.error ?? "The task could not be moved.", ...(result.required ? [result.required] : [])],
                "error",
              )
            }
            return reply(toView(result.value))
          }
          case "link": {
            const from = find(args.task as string | undefined)
            const to = find(args.other as string | undefined)
            if (!from || !to) return reply(undefined, ["Both tasks must exist."], "error")
            const result = tasks.link({
              projectId,
              from: from.id,
              to: to.id,
              relation: String(args.relation ?? "related") as TaskEdge["relation"],
              actor: "agent",
            })
            if (!result.ok) return reply(undefined, [result.error ?? "The tasks could not be linked."], "error")
            return reply({ from: from.publicKey, to: to.publicKey, relation: args.relation })
          }
          case "unlink": {
            const from = find(args.task as string | undefined)
            const to = find(args.other as string | undefined)
            if (!from || !to) return reply(undefined, ["Both tasks must exist."], "error")
            const result = tasks.unlink({
              projectId,
              from: from.id,
              to: to.id,
              relation: String(args.relation ?? "related") as TaskEdge["relation"],
              actor: "agent",
            })
            if (!result.ok) return reply(undefined, [result.error ?? "The tasks could not be unlinked."], "error")
            return reply({ from: from.publicKey, to: to.publicKey, relation: args.relation })
          }
          case "history": {
            const task = find(args.task as string | undefined)
            if (!task) return reply(undefined, ["No task with that key."], "error")
            return reply(toHistory(task, tasks.history(task.id)))
          }
          case "delete": {
            const task = find(args.task as string | undefined)
            if (!task) return reply(undefined, ["No task with that key."], "error")
            const result = tasks.delete(task.id)
            if (!result.ok) {
              return reply(undefined, [result.error ?? "The task could not be deleted."], "error")
            }
            return reply({ deleted: task.publicKey })
          }
          default:
            return reply(undefined, [`Unknown action ${action}.`], "error")
        }
}

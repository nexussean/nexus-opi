import { Plugin } from "@opencode/plugin"
import { readFileSync } from "node:fs"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { CallRecorder, instrument } from "./calls.ts"
import { SEED_CARDS } from "../harness/board.ts"

/**
 * Benchmark plugin for the tool-surface question (ADR-0018).
 *
 * The same task service is exposed through two different tool surfaces:
 *
 *   separate — one tool per action, each with its own description and schema
 *   actions  — one tool with an `action` argument covering every action
 *
 * Only the *input surface* differs. The output format, the store and the
 * behaviour are identical, so any difference in the measurement is attributable
 * to the tool shape alone.
 */

export type TaskShape = "separate" | "actions"

/**
 * The shapes the benchmark can run.
 *
 * `none` is the **control**: the plugin registers no tools at all, so the
 * model has to answer from the filesystem. Without it, "0 calls" is
 * uninterpretable — it may mean the model did not need the tool, or that it
 * never found it.
 */
export type BenchShape = TaskShape | "none"

export const COLUMNS = ["backlog", "todo", "in_progress", "review", "done"] as const
export type Column = (typeof COLUMNS)[number]

export interface Card {
  id: string
  title: string
  body?: string
  status: string
  priority?: "low" | "medium" | "high" | "urgent"
  labels?: string[]
  order: number
}

const PRIORITIES = ["low", "medium", "high", "urgent"] as const

/**
 * The board, from the **shared** definition.
 *
 * The fixture's board, the SQLite arms' board and the read tasks'
 * expectations are one board. They were three: the fixture had a `todo`
 * column the store does not have, and different priorities, so a surface
 * could "win" on a board it found easier.
 */
export function seed(): Card[] {
  const words = ["low", "medium", "high", "urgent"] as const
  const order = new Map<string, number>()
  return SEED_CARDS.map((card) => {
    const index = order.get(card.state) ?? 0
    order.set(card.state, index + 1)
    return {
      id: card.key,
      title: card.title,
      status: card.state,
      order: index,
      priority: words[card.priority]!,
      ...(card.labels?.length ? { labels: card.labels } : {}),
    }
  })
}

class Board {
  #cards = seed()
  #next = 6

  list(filter: { status?: string; id?: string }): Card[] {
    let cards = this.#cards
    if (filter.id) return cards.filter((card) => card.id === filter.id)
    if (filter.status) cards = cards.filter((card) => card.status === filter.status)
    return [...cards].sort((a, b) => a.status.localeCompare(b.status) || a.order - b.order)
  }

  get(id: string): Card | undefined {
    return this.#cards.find((card) => card.id === id)
  }

  add(input: {
    title?: string
    body?: string
    status?: string
    priority?: string
    labels?: string[]
  }): Card | { error: string } {
    const title = typeof input.title === "string" ? input.title.trim() : ""
    if (!title) return { error: "A card needs a title." }
    const status = input.status && COLUMNS.includes(input.status as Column) ? input.status : "backlog"
    const card: Card = {
      id: `kb-bench${String(this.#next++).padStart(2, "0")}`,
      title,
      status,
      order: this.list({ status }).length,
    }
    if (input.body?.trim()) card.body = input.body.trim()
    if (input.priority && (PRIORITIES as readonly string[]).includes(input.priority)) {
      card.priority = input.priority as Card["priority"]
    }
    if (input.labels?.length) card.labels = input.labels
    this.#cards.push(card)
    return card
  }

  update(
    id: string,
    patch: {
      title?: string
      body?: string
      status?: string
      priority?: string | null
      labels?: string[]
    },
  ): Card | { error: string } {
    const card = this.get(id)
    if (!card) return { error: `No card with id ${id}.` }
    if (patch.title !== undefined) {
      const title = patch.title.trim()
      if (!title) return { error: "A card needs a title." }
      card.title = title
    }
    if (patch.body !== undefined) card.body = patch.body.trim() || undefined
    if (patch.priority !== undefined) {
      if (patch.priority === null) delete card.priority
      else if ((PRIORITIES as readonly string[]).includes(patch.priority)) {
        card.priority = patch.priority as Card["priority"]
      }
    }
    if (patch.labels !== undefined) card.labels = patch.labels.length ? patch.labels : undefined
    return card
  }

  move(id: string, status: string, index?: number): Card | { error: string } {
    const card = this.get(id)
    if (!card) return { error: `No card with id ${id}.` }
    if (!COLUMNS.includes(status as Column)) return { error: `No column with id ${status}.` }
    card.status = status
    const siblings = this.list({ status }).filter((entry) => entry.id !== id)
    const position = index === undefined ? siblings.length : Math.max(0, Math.min(index, siblings.length))
    siblings.splice(position, 0, card)
    siblings.forEach((entry, i) => (entry.order = i))
    return card
  }

  remove(id: string): Card | { error: string } {
    const card = this.get(id)
    if (!card) return { error: `No card with id ${id}.` }
    this.#cards = this.#cards.filter((entry) => entry.id !== id)
    return card
  }
}

function isError(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value
}

function result(value: unknown) {
  if (isError(value)) return { content: JSON.stringify({ error: value.error }) }
  return { content: JSON.stringify({ ok: true, card: value }) }
}

function listResult(cards: Card[]) {
  return {
    content: JSON.stringify({
      ok: true,
      cards: cards.map((card) => ({
        id: card.id,
        title: card.title,
        status: card.status,
        priority: card.priority ?? null,
        labels: card.labels ?? [],
      })),
    }),
  }
}

const prioritySchema = { type: "string", enum: [...PRIORITIES] }
const labelsSchema = { type: "array", items: { type: "string" } }
const statusSchema = {
  type: "string",
  description: "Column id: backlog, todo, in_progress, review or done.",
}

interface ToolDef {
  name: string
  description: string
  input: Record<string, unknown>
  run: (input: unknown) => { content: string }
}

/**
 * A call that does not fit the tool's schema.
 *
 * ADR-0018 names **malformed calls** as one of the four things the measurement
 * counts, and it is the metric most likely to differ between the shapes: a
 * wide surface with one schema per action can express "this action needs an
 * id", while a single action-argument tool has to say so in prose and hope
 * the model reads it.
 *
 * The first run could not measure it, because the fixture's tools returned
 * their errors as ordinary **successful** results — the call was counted as
 * fine. A malformed call is now a thrown error, so the recorder sees it as a
 * failure and the run's `failedCalls` counts it.
 */
export class MalformedCall extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MalformedCall"
  }
}

/**
 * What each action needs, for the single-tool shape.
 *
 * The `separate` shape says this **in its schema**: `task_get` declares
 * `required: ["id"]`, and the model can see it in the catalog. The `actions`
 * shape has one schema for every action, so it cannot say it there — the
 * requirement has to be checked at runtime instead.
 *
 * That is the structural difference the measurement is about, and it has to be
 * implemented on both sides or the comparison is not fair: a runtime check
 * that the `separate` shape does not have would make the `actions` shape look
 * worse for the wrong reason.
 */
const ACTION_REQUIREMENTS: Record<string, string[]> = {
  list: [],
  get: ["id"],
  create: ["title"],
  update: ["id"],
  move: ["id", "status"],
  remove: ["id"],
}

/**
 * Check a call's arguments against the tool's schema.
 *
 * Only the constraints that can be expressed in the schema are checked: the
 * required properties, the enum values, and the declared types. Anything the
 * schema does not state is not a malformed call, and is not the tool's fault.
 */
export function validate(
  tool: string,
  input: unknown,
  schema: { required?: string[]; properties?: Record<string, { type?: string; enum?: string[] }> },
): void {
  const args = (input ?? {}) as Record<string, unknown>
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null || args[key] === "") {
      throw new MalformedCall(`${tool}: "${key}" is required.`)
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties?.[key]
    if (!property || value === undefined || value === null) continue
    if (property.enum && !property.enum.includes(String(value))) {
      throw new MalformedCall(
        `${tool}: "${key}" must be one of ${property.enum.join(", ")}; got "${String(value)}".`,
      )
    }
    if (property.type === "string" && typeof value !== "string") {
      throw new MalformedCall(`${tool}: "${key}" must be a string.`)
    }
    if (property.type === "number" && typeof value !== "number") {
      throw new MalformedCall(`${tool}: "${key}" must be a number.`)
    }
    if (property.type === "array" && !Array.isArray(value)) {
      throw new MalformedCall(`${tool}: "${key}" must be an array.`)
    }
  }
}

/** The single tool used by the `actions` shape. */
function actionsTool(actions: Record<string, (input: never) => { content: string }>): ToolDef {
  const description = [
    "Manage kanban task cards.",
    "",
    "action:",
    "- list: read cards. Optional `status` filters by column, `id` fetches one card.",
    "- get: read one card. Requires `id`.",
    "- create: make a card. Requires `title`; optional `body`, `status`, `priority`, `labels`.",
    "- update: change a card. Requires `id`; optional `title`, `body`, `status`, `priority`, `labels`.",
    "- move: move a card to a column. Requires `id` and `status`; optional `index`.",
    "- remove: delete a card. Requires `id`.",
  ].join("\n")

  return {
    name: "task",
    description,
    input: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "create", "update", "move", "remove"],
          description: "The operation to perform.",
        },
        id: { type: "string", description: "Card id. Required by get, update, move and remove." },
        title: { type: "string", description: "Card title. Required by create." },
        body: { type: "string", description: "Card details." },
        status: { ...statusSchema, description: `${statusSchema.description} Used by create, update and move.` },
        priority: { ...prioritySchema, description: "Card priority." },
        labels: { ...labelsSchema, description: "Card labels." },
        index: { type: "number", description: "Position within the target column." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    run: (input) => {
      const args = (input ?? {}) as Record<string, unknown>
      const name = String(args.action ?? "")
      const handler = actions[name]
      if (!handler) return { content: JSON.stringify({ error: `Unknown action ${name}.` }) }
      // The per-action requirements, checked at runtime because one schema
      // cannot express them.
      for (const key of ACTION_REQUIREMENTS[name] ?? []) {
        if (args[key] === undefined || args[key] === null || args[key] === "") {
          throw new MalformedCall(`task: action "${name}" requires "${key}".`)
        }
      }
      return handler(args as never)
    },
  }
}

/** The six tools used by the `separate` shape. */
function separateTools(actions: Record<string, (input: never) => { content: string }>): ToolDef[] {
  return [
    {
      name: "task_list",
      description:
        "Read kanban task cards. Optionally filter by `status` (a column id) or fetch one card by `id`.",
      input: {
        type: "object",
        properties: {
          status: { ...statusSchema, description: "Only return cards in this column." },
          id: { type: "string", description: "Fetch a single card by id." },
        },
        additionalProperties: false,
      },
      run: (input) => actions.list((input ?? {}) as never),
    },
    {
      name: "task_get",
      description: "Read one kanban task card by its id.",
      input: {
        type: "object",
        properties: { id: { type: "string", description: "Card id." } },
        required: ["id"],
        additionalProperties: false,
      },
      run: (input) => actions.get((input ?? {}) as never),
    },
    {
      name: "task_create",
      description: "Create a kanban task card.",
      input: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short imperative title." },
          body: { type: "string", description: "Card details." },
          status: { ...statusSchema, description: "Column id. Defaults to backlog." },
          priority: { ...prioritySchema, description: "Card priority." },
          labels: { ...labelsSchema, description: "Card labels." },
        },
        required: ["title"],
        additionalProperties: false,
      },
      run: (input) => actions.create((input ?? {}) as never),
    },
    {
      name: "task_update",
      description:
        "Change an existing kanban task card. Passing `status` moves it to that column.",
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "Card id." },
          title: { type: "string", description: "New title." },
          body: { type: "string", description: "New details." },
          status: { ...statusSchema, description: "Move to this column id." },
          priority: { ...prioritySchema, description: "New priority." },
          labels: { ...labelsSchema, description: "New labels." },
        },
        required: ["id"],
        additionalProperties: false,
      },
      run: (input) => actions.update((input ?? {}) as never),
    },
    {
      name: "task_move",
      description: "Move a kanban task card to a column.",
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "Card id." },
          status: { ...statusSchema, description: "Target column id." },
          index: { type: "number", description: "Position within the target column." },
        },
        required: ["id", "status"],
        additionalProperties: false,
      },
      run: (input) => actions.move((input ?? {}) as never),
    },
    {
      name: "task_remove",
      description: "Delete a kanban task card.",
      input: {
        type: "object",
        properties: { id: { type: "string", description: "Card id." } },
        required: ["id"],
        additionalProperties: false,
      },
      run: (input) => actions.remove((input ?? {}) as never),
    },
  ]
}

export default Plugin.define({
  id: "opi-bench",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as {
      taskShape?: BenchShape
      benchDir?: string
      /**
       * The namespace the tools are published under.
       *
       * It has to be **unique per benchmark instance**. A plugin registered
       * globally and a plugin registered by a project both claim the same
       * namespace, and one of them wins — silently, and in a way that sends
       * the model's calls to a plugin instance whose log is somewhere else.
       *
       * The harness passes a unique namespace per run, so the calls it
       * measures are always the ones it can see.
       */
      namespace?: string
    }
    // A plugin installed **globally** has no per-location options, and the
    // shared service does not load project-config plugins at all (the compat
    // doc, §12.3). So the benchmark is driven by a **file in the location**,
    // which the harness writes before the location boots.
    //
    // The file is named, not a directory, so it cannot collide with the
    // output directory the plugin creates.
    const configFile = resolve(ctx.location.directory, ".bench-config.json")
    let config: { shape?: BenchShape; namespace?: string; benchDir?: string } = {}
    try {
      config = JSON.parse(readFileSync(configFile, "utf8")) as typeof config
    } catch {
      // No config file. The defaults apply.
    }

    const requestedShape = options.taskShape ?? config.shape
    const shape: BenchShape =
      requestedShape === "actions"
        ? "actions"
        : requestedShape === "none"
          ? "none"
          : "separate"
    /**
     * Where the plugin's own output goes.
     *
     * A globally-installed plugin is set up once, for whichever location the
     * server happens to start in, so this path is fixed for the server's
     * life. It therefore has to be **absolute and known to the harness** —
     * otherwise the model calls the tool and the call lands in a log the
     * harness never reads. That is exactly what happened: 38 calls, zero
     * recorded.
     */
    const benchDir = resolve(
      options.benchDir ??
        process.env.OPI_BENCH_DIR ??
        config.benchDir ??
        resolve(ctx.location.directory, ".bench"),
    )
    const eventLog = resolve(benchDir, "events.ndjson")
    /**
     * The namespace the tools are published under.
     *
     * A globally-installed plugin is set up **once per server**, not once
     * per location, so this is fixed for the server's life. It therefore has
     * to be **stable**: the harness measures calls to one namespace, and a
     * per-run namespace would leave the model calling a namespace the
     * harness is not watching.
     *
     * The *shape* can still vary per location, because the tools are
     * re-registered when the location's plugin activates.
     */
    const namespace = options.namespace ?? process.env.OPI_BENCH_NAMESPACE ?? "opi"

    const board = new Board()

    // Record what this activation actually saw, before anything else can fail.
    await mkdir(benchDir, { recursive: true }).catch(() => {})
    await writeFile(
      resolve(benchDir, "setup.json"),
      `${JSON.stringify(
        {
          shape,
          namespace,
          location: ctx.location.directory,
          options: ctx.options ?? null,
          at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    ).catch(() => {})

    const actions = {
      list: (input: { status?: string; id?: string }) => listResult(board.list(input)),
      get: (input: { id: string }) => {
        const card = board.get(input.id)
        if (!card) return { content: JSON.stringify({ error: `No card with id ${input.id}.` }) }
        return { content: JSON.stringify({ ok: true, card }) }
      },
      create: (input: {
        title?: string
        body?: string
        status?: string
        priority?: string
        labels?: string[]
      }) => result(board.add(input)),
      update: (input: {
        id: string
        title?: string
        body?: string
        status?: string
        priority?: string | null
        labels?: string[]
      }) => result(board.update(input.id, input)),
      move: (input: { id: string; status: string; index?: number }) =>
        result(board.move(input.id, input.status, input.index)),
      remove: (input: { id: string }) => result(board.remove(input.id)),
    }

    const defs: ToolDef[] =
      shape === "actions"
        ? [actionsTool(actions)]
        : shape === "none"
          ? []
          : separateTools(actions)

    /**
     * The board, on disk, for the `none` shape.
     *
     * The control is supposed to measure what the model does when there is
     * no tool: it reads the board from the filesystem and reconstructs the
     * answer. That only works if there **is** a board on the filesystem.
     *
     * The first version of the control had no board file at all — the
     * fixture's board lived only in the plugin's memory — so the model found
     * an empty directory and answered "there is no card kb-seed01 in this
     * workspace". The control was measuring the cost of finding *nothing*,
     * which is not the thing it is the control for.
     *
     * The board is written in a plain, readable form, so the cost of reading
     * it is the cost a real board would cost.
     */
    if (shape === "none") {
      await mkdir(benchDir, { recursive: true })
      await writeFile(
        resolve(benchDir, "board.json"),
        `${JSON.stringify({ cards: seed() }, null, 2)}\n`,
        "utf8",
      )
    }

    // The plugin's **own** call log. The counter has to live inside the
    // plugin: the first measurement inferred calls from the event stream,
    // which is the thing under test, and which carries no record of a call
    // whose Code Mode wrapper failed.
    const callLog = resolve(benchDir, "calls.ndjson")
    const recorder = new CallRecorder((call) => {
      void appendFile(callLog, `${JSON.stringify(call)}\n`, "utf8").catch(() => {})
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: namespace, description: "Benchmark task tools" })
      for (const def of defs) {
        // The action is the tool's own name, or the `action` argument for the
        // single-tool shape. It is what the calls are grouped by.
        const action = shape === "actions" ? "task" : def.name
        // The call is validated against the tool's own schema **before** it
        // runs, so a malformed call is a failure the recorder sees. The
        // validator throws, and `instrument` records a throw as a failure.
        const run = instrument(
          `${namespace}.${def.name}`,
          action,
          (input) => {
            validate(def.name, input, def.input as Parameters<typeof validate>[2])
            return def.run(input)
          },
          recorder,
        )
        editor.add({
          name: def.name,
          description: def.description,
          input: def.input,
          // Left in Code Mode's catalog on purpose. `codemode: false` removes a
          // tool from that catalog, and the default agent reaches tools through
          // Code Mode, so the tool would be unreachable.
          options: { namespace },
          execute: async (input: unknown) => run(input),
        })
      }
    })

    // Record the declared surface so the harness can measure the static schema
    // overhead this shape adds to every request.
    await mkdir(benchDir, { recursive: true })
    await writeFile(
      resolve(benchDir, "tools.json"),
      `${JSON.stringify(
        {
          shape,
          tools: defs.map((def) => ({
            name: `${namespace}.${def.name}`,
            description: def.description,
            input: def.input,
          })),
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          await appendFile(eventLog, `${JSON.stringify(event)}\n`, "utf8").catch(() => {})
        }
      } catch {
        // The plugin is unloading.
      }
    })()

    return () => controller.abort()
  },
})

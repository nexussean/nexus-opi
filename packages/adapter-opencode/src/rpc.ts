import { Rpc } from "@opencode/plugin"

/**
 * The dashboard's RPC contract.
 *
 * The browser never reads the database and never touches the plugin's
 * internals. It talks to this contract, and the plugin serves it from the same
 * core the tools use — so the dashboard and the agent cannot disagree about
 * what a task is or whether it is done.
 *
 * See [ADR-0026](../../../docs/adr/0026-the-dashboard-reads-through-rpc-and-is-optional.md).
 */

const emptyObject = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

const taskSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    key: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    acceptance: { type: "string" },
    state: { type: "string" },
    type: { type: "string" },
    priority: { type: "number" },
    worktree_id: { type: "string" },
    /** The evidence state. Never omitted. */
    verification: { type: "string" },
    /** A plain statement of the evidence. */
    verification_note: { type: "string" },
    /** True when the task is done *and* its evidence is sound. */
    verified: { type: "boolean" },
    /** True when the task is waiting for a dependency. */
    waiting: { type: "boolean" },
    /** What it is waiting for. */
    blocked_by: { type: "array", items: { type: "string" } },
    revision: { type: "number" },
    created_at: { type: "number" },
    updated_at: { type: "number" },
  },
  required: ["id", "key", "title", "state", "verification", "verified", "revision"],
  additionalProperties: false,
} as const

const gateSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string" },
    description: { type: "string" },
    /** The command, for display. It is never executed from here. */
    command: { type: "string" },
    scope: { type: "array", items: { type: "string" } },
    required_for: { type: "array", items: { type: "string" } },
    risk: { type: "string" },
    state: { type: "string" },
    approved_by: { type: "string" },
    config_revision: { type: "number" },
  },
  required: ["id", "kind", "state", "risk", "config_revision"],
  additionalProperties: false,
} as const

const runSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    gate_id: { type: "string" },
    task_id: { type: "string" },
    outcome: { type: "string" },
    exit_code: { type: "number" },
    output: { type: "string" },
    truncated: { type: "boolean" },
    head: { type: "string" },
    started_at: { type: "number" },
    finished_at: { type: "number" },
    duration_ms: { type: "number" },
    /** True when the code changed since the run. */
    stale: { type: "boolean" },
  },
  required: ["id", "gate_id", "outcome", "started_at", "stale"],
  additionalProperties: false,
} as const

const memorySchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string" },
    trust: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    stale: { type: "boolean" },
    /** True when the memory may be acted on as true. */
    constraint: { type: "boolean" },
    source: { type: "string" },
    evidence_ref: { type: "string" },
    origin: { type: "string" },
    supersedes: { type: "string" },
    created_at: { type: "number" },
  },
  required: ["id", "kind", "trust", "title", "stale", "constraint", "origin", "created_at"],
  additionalProperties: false,
} as const

const eventSchema = {
  type: "object",
  properties: {
    sequence: { type: "number" },
    actor: { type: "string" },
    operation: { type: "string" },
    changes: { type: "object" },
    evidence_ref: { type: "string" },
    at: { type: "number" },
  },
  required: ["sequence", "actor", "operation", "at"],
  additionalProperties: false,
} as const

/**
 * The RPC the dashboard reads.
 *
 * Five methods, each one a page of the plan's information architecture. The
 * dashboard is a **view**: it has no state of its own and no rules of its own.
 */
export const Opi = Rpc.define({
  id: "opi",
  methods: {
    /** The project's shape: its tasks, what is next, what is waiting, its health. */
    overview: {
      input: emptyObject,
      output: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          worktree_id: { type: "string" },
          root: { type: "string" },
          tasks: { type: "array", items: taskSchema },
          /** The next task, if there is one. */
          next: taskSchema,
          /** The tasks waiting for a dependency. */
          waiting: { type: "array", items: taskSchema },
          gates: { type: "array", items: gateSchema },
          index: {
            type: "object",
            properties: {
              available: { type: "boolean" },
              state: { type: "string" },
              files_indexed: { type: "number" },
              symbols_indexed: { type: "number" },
              epoch: { type: "number" },
              languages: { type: "array", items: { type: "string" } },
            },
            required: ["available", "state"],
            additionalProperties: false,
          },
        },
        required: ["project_id", "tasks", "gates", "index"],
        additionalProperties: false,
      },
    },

    /** The board: every task, grouped by state, with the waiting list. */
    board: {
      input: emptyObject,
      output: {
        type: "object",
        properties: {
          tasks: { type: "array", items: taskSchema },
          waiting: { type: "array", items: taskSchema },
          columns: { type: "array", items: { type: "string" } },
        },
        required: ["tasks", "waiting", "columns"],
        additionalProperties: false,
      },
    },

    /** One task, with its acceptance criteria, evidence and history. */
    task: {
      input: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          task: taskSchema,
          events: { type: "array", items: eventSchema },
          runs: { type: "array", items: runSchema },
          dependencies: { type: "array", items: taskSchema },
        },
        required: ["task", "events", "runs", "dependencies"],
        additionalProperties: false,
      },
    },

    /** The decisions, the proposals and the superseded records — separately. */
    memory: {
      input: emptyObject,
      output: {
        type: "object",
        properties: {
          constraints: { type: "array", items: memorySchema },
          leads: { type: "array", items: memorySchema },
          superseded: { type: "array", items: memorySchema },
        },
        required: ["constraints", "leads", "superseded"],
        additionalProperties: false,
      },
    },

    /** The gates, their runs, and whether each run is still valid. */
    quality: {
      input: emptyObject,
      output: {
        type: "object",
        properties: {
          gates: { type: "array", items: gateSchema },
          runs: { type: "array", items: runSchema },
          /** True when the project has turned check execution on. */
          execution_enabled: { type: "boolean" },
        },
        required: ["gates", "runs", "execution_enabled"],
        additionalProperties: false,
      },
    },
  },
  events: {
    /**
     * The project's state changed.
     *
     * The dashboard uses it to refresh rather than poll. The payload is
     * empty on purpose: the dashboard re-reads through the same methods, so
     * there is one shape of the truth.
     */
    changed: {
      schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
})

export type OpiDefinition = typeof Opi

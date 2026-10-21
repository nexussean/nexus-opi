import type { Plugin } from "@opencode/plugin"
import {
  checkStaleness,
  findBlocked,
  resolveProject,
  toView,
  withStaleness,
  type Gate,
  type GateRun,
  type Memory,
  type Task,
  type TaskEdge,
} from "@opi/core"
import type { SqliteMemoryStore, SqliteTaskStore, SqliteVerificationStore } from "@opi/db"
import { Opi } from "./rpc.ts"

/**
 * The dashboard's RPC handlers.
 *
 * Every method reads the **same** stores the tools read, through the **same**
 * functions. The dashboard is a view; it has no rules of its own, so it cannot
 * disagree with the agent about what a task is or whether it is done.
 *
 * See [ADR-0026](../../../docs/adr/0026-the-dashboard-reads-through-rpc-and-is-optional.md).
 */

/** What the handlers need from the plugin. */
export interface RpcSources {
  registry: {
    resolve: (resolved: unknown) => Promise<{ id: string; worktree: { id: string } }>
  }
  tasks: SqliteTaskStore
  verification: SqliteVerificationStore
  memories: SqliteMemoryStore
  /** The project root. */
  root: () => string
  /** The worktree's HEAD. */
  head: () => string
  /** The index's health. */
  index: () => {
    available: boolean
    state: string
    filesIndexed: number
    symbolsIndexed: number
    epoch: number
    languages: string[]
  }
}

/** A task as the dashboard sees it. */
function taskView(
  task: Task,
  context: { edges: readonly TaskEdge[]; tasks: readonly Task[] },
): Record<string, unknown> {
  const view = toView(task, { edges: context.edges, tasks: context.tasks })
  const blocked = findBlocked(context.tasks, context.edges).find(
    (problem) => problem.taskKey === task.publicKey,
  )
  return {
    ...view,
    waiting: blocked !== undefined,
    ...(blocked ? { blocked_by: blocked.blockedBy } : {}),
  }
}

/** A gate as the dashboard sees it. */
function gateView(gate: Gate): Record<string, unknown> {
  return {
    id: gate.id,
    kind: gate.kind,
    description: gate.description,
    command: [gate.executable, ...gate.args].join(" "),
    scope: gate.scope,
    required_for: gate.requiredForTypes,
    risk: gate.risk,
    state: gate.state,
    approved_by: gate.approvedBy ?? "",
    config_revision: gate.configRevision,
  }
}

/** A run as the dashboard sees it. */
function runView(run: GateRun, stale: boolean): Record<string, unknown> {
  return {
    id: run.id,
    gate_id: run.gateId,
    task_id: run.taskId ?? "",
    outcome: run.outcome,
    exit_code: run.exitCode ?? null,
    output: run.output.slice(0, 4_000),
    truncated: run.truncated,
    head: run.head,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    duration_ms: run.durationMs,
    stale,
  }
}

/** A memory as the dashboard sees it. */
function memoryView(memory: Memory): Record<string, unknown> {
  return {
    id: memory.id,
    kind: memory.kind,
    trust: memory.trust,
    title: memory.title,
    body: memory.body,
    stale: memory.stale,
    constraint: memory.trust === "human_confirmed" || memory.trust === "gate_verified",
    source: memory.provenance.source ?? "",
    evidence_ref: memory.provenance.evidenceRef ?? "",
    origin: memory.provenance.origin,
    supersedes: memory.supersedesId ?? "",
    created_at: memory.createdAt,
  }
}

/**
 * Register the dashboard's RPC.
 */
export async function registerRpc(ctx: Plugin.Context, sources: RpcSources): Promise<void> {
  const rpc = ctx.rpc as Plugin.Context["rpc"] | undefined
  if (!rpc?.register) return

  /** The project id, resolved from the plugin's own location. */
  const project = async (): Promise<{ id: string; worktreeId: string } | undefined> => {
    const identity = await resolveProject(sources.root(), sources.registry as never)
    if (!identity) return undefined
    return { id: identity.id, worktreeId: identity.worktree.id }
  }

  await rpc.register(Opi, {
    overview: async () => {
      const resolved = await project()
      if (!resolved) {
        return {
          project_id: "",
          worktree_id: "",
          root: sources.root(),
          tasks: [],
          waiting: [],
          gates: [],
          index: { available: false, state: "absent", files_indexed: 0, symbols_indexed: 0, epoch: 0, languages: [] },
        }
      }
      const tasks = sources.tasks.list(resolved.id)
      const edges = sources.tasks.edges(resolved.id)
      const waiting = findBlocked(tasks, edges)
      const next = tasks
        .filter((task) => task.state === "backlog" || task.state === "ready")
        .find((task) => !waiting.some((problem) => problem.taskKey === task.publicKey))
      return {
        project_id: resolved.id,
        worktree_id: resolved.worktreeId,
        root: sources.root(),
        tasks: tasks.map((task) => taskView(task, { edges, tasks })),
        ...(next ? { next: taskView(next, { edges, tasks }) } : {}),
        waiting: waiting.map((problem) => {
          const task = tasks.find((candidate) => candidate.publicKey === problem.taskKey)
          return task ? taskView(task, { edges, tasks }) : undefined
        }).filter(Boolean),
        gates: sources.verification.list(resolved.id).map(gateView),
        index: sources.index(),
      }
    },

    board: async () => {
      const resolved = await project()
      if (!resolved) return { tasks: [], waiting: [], columns: [] }
      const tasks = sources.tasks.list(resolved.id)
      const edges = sources.tasks.edges(resolved.id)
      const waiting = findBlocked(tasks, edges)
      return {
        tasks: tasks.map((task) => taskView(task, { edges, tasks })),
        waiting: waiting.map((problem) => {
          const task = tasks.find((candidate) => candidate.publicKey === problem.taskKey)
          return task ? taskView(task, { edges, tasks }) : undefined
        }).filter(Boolean),
        // The board's columns. There is no "Blocked" column: a task waiting
        // for a dependency is still `backlog`, and showing it as a column
        // would make the displayed state and the recorded state differ.
        columns: ["backlog", "ready", "in_progress", "review", "done"],
      }
    },

    task: async (input) => {
      const resolved = await project()
      if (!resolved) {
        return { task: undefined, events: [], runs: [], dependencies: [] }
      }
      const key = String((input as { key?: string })?.key ?? "")
      const task = sources.tasks.getByKey(resolved.id, key) ?? sources.tasks.get(key)
      if (!task) return { task: undefined, events: [], runs: [], dependencies: [] }
      const tasks = sources.tasks.list(resolved.id)
      const edges = sources.tasks.edges(resolved.id)
      const dependencies = tasks.filter((candidate) =>
        edges.some(
          (edge) => edge.to === task.id && edge.from === candidate.id && edge.relation === "blocks",
        ),
      )
      const gates = sources.verification.list(resolved.id)
      const runs = sources.verification.runsForTask(task.id, 20)
      return {
        task: taskView(task, { edges, tasks }),
        events: sources.tasks.history(task.id).map((event) => ({
          sequence: event.sequence,
          actor: event.actor,
          operation: event.operation,
          changes: event.changes,
          evidence_ref: event.evidenceRef ?? "",
          at: event.createdAt,
        })),
        runs: runs.map((run) => {
          const gate = gates.find((candidate) => candidate.id === run.gateId)
          if (!gate) return runView(run, false)
          return runView(run, checkStaleness(run, gate, sources.root(), sources.head()).stale)
        }),
        dependencies: dependencies.map((candidate) => taskView(candidate, { edges, tasks })),
      }
    },

    memory: async () => {
      const resolved = await project()
      if (!resolved) return { constraints: [], leads: [], superseded: [] }
      const all = withStaleness(sources.memories.list(resolved.id), sources.root())
      const constraints = all.filter(
        (memory) => memory.trust === "human_confirmed" || memory.trust === "gate_verified",
      )
      const leads = all.filter(
        (memory) =>
          memory.trust !== "superseded" &&
          memory.trust !== "human_confirmed" &&
          memory.trust !== "gate_verified",
      )
      const superseded = all.filter((memory) => memory.trust === "superseded")
      return {
        constraints: constraints.map(memoryView),
        leads: leads.map(memoryView),
        superseded: superseded.map(memoryView),
      }
    },

    quality: async () => {
      const resolved = await project()
      if (!resolved) return { gates: [], runs: [], execution_enabled: false }
      const gates = sources.verification.list(resolved.id)
      const runs = gates.flatMap((gate) => sources.verification.runs(gate.id, 10))
      return {
        gates: gates.map(gateView),
        runs: runs.map((run) => {
          const gate = gates.find((candidate) => candidate.id === run.gateId)
          if (!gate) return runView(run, false)
          return runView(run, checkStaleness(run, gate, sources.root(), sources.head()).stale)
        }),
        execution_enabled: false,
      }
    },
  })
}

import { Plugin } from "@opencode/plugin"
import { registerCommands } from "./commands.ts"
import { registerRpc } from "./rpc-handlers.ts"
import { registerSkill } from "./skill.ts"
import { openCallLog } from "./call-log.ts"
import { startAudit } from "./audit-source.ts"
import { registerTaskTools } from "./task-tool.ts"
import { taskShapeFor } from "./task-shape.ts"
import { schemaSizeFor } from "./schema-size.ts"
import { descriptionFor, variantFor } from "./descriptions.ts"
import { guidanceVariantFor } from "./guidance.ts"
import { triggerVariantFor } from "./triggers.ts"
import { readFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  MemoryFeatureFlags,
  MetricsSink,
  boundHandoff,
  checkStaleness,
  detectGates,
  describeArgv,
  emptyHandoff,
  resolveProject,
  run as runVerification,
  evaluate as evaluateVerification,
  search as searchMemories,
  status,
  summariseHandoff,
  toHistory,
  toList,
  toView,
  withStaleness,
  TASK_RELATIONS,
  TASK_STATES,
  type Gate,
  type GateRun,
  type Memory,
  type StatusAction,
  type Task,
  type TaskEdge,
  type TaskState,
} from "@opi/core"
import {
  BUDGETS,
  GRAPH_ACTIONS,
  PersistentIndex,
  assembleContext,
  contextSources,
  graphSources,
  ProjectWatcher,
  buildPathFilter,
  queryGraph,
} from "@opi/retrieval"
import { SqliteJobQueue, SqliteMemoryStore, SqliteProjectRegistry, SqliteTaskStore, SqliteVerificationStore, defaultDataDir, ensureDir, indexDir, indexPath, registryPath } from "@opi/db"

/**
 * The OpenCode adapter.
 *
 * It owns nothing authoritative. It translates OpenCode's context into core
 * calls, and returns core's envelopes. The project it reports is always the
 * one OpenCode is working in — taken from `ctx.location`, never from the
 * model.
 */
export const PLUGIN_ID = "opencode-project-intelligence"
/**
 * The plugin's version.
 *
 * It is **one** number, in one place, and the release build copies it into
 * the bundle's manifest. A version written twice is a version that means
 * nothing: the bundle would claim one version and the source another.
 */
export const PLUGIN_VERSION = "0.1.0"

const ACTIONS: StatusAction[] = ["summary", "doctor", "index_status", "reindex"]

/** The actions `pi_task` accepts. */
const TASK_ACTIONS = [
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

/**
 * The actions `pi_memory` accepts.
 *
 * There is no `confirm`. A memory's trust comes from a person, and the
 * person confirms it through the CLI. The model can propose and report, and
 * it cannot make a decision authoritative.
 */
const MEMORY_ACTIONS = ["search", "list", "propose", "handoff", "resume"] as const

/** A memory as the tool returns it. */
function toMemoryView(
  memory: Memory,
  options: { includeBody?: boolean } = {},
): Record<string, unknown> {
  return {
    id: memory.id,
    kind: memory.kind,
    trust: memory.trust,
    title: memory.title,
    ...(options.includeBody === false ? {} : { body: memory.body }),
    stale: memory.stale,
    constraint: memory.trust === "human_confirmed" || memory.trust === "gate_verified",
    ...(memory.provenance.source ? { source: memory.provenance.source } : {}),
    ...(memory.provenance.evidenceRef ? { evidence_ref: memory.provenance.evidenceRef } : {}),
    origin: memory.provenance.origin,
    ...(memory.supersedesId ? { supersedes: memory.supersedesId } : {}),
    created_at: memory.createdAt,
  }
}

/** The actions `pi_verify` accepts. */const VERIFY_ACTIONS = [
  "list_gates",
  "propose_gates",
  "configure_gate",
  "run",
  "results",
  "waive",
  "evaluate_task",
] as const

/** A gate as the tool returns it. */
function toGateView(gate: Gate): Record<string, unknown> {
  return {
    id: gate.id,
    kind: gate.kind,
    description: gate.description,
    // The command is shown so a human can review it. It is display only —
    // the runner uses the argv array.
    command: describeArgv(gate),
    cwd: gate.cwd,
    scope: gate.scope,
    required_for: gate.requiredForTypes,
    timeout_ms: gate.timeoutMs,
    risk: gate.risk,
    state: gate.state,
    approved_by: gate.approvedBy ?? null,
    config_revision: gate.configRevision,
  }
}

/** A run as the tool returns it. */
function toRunView(run: GateRun): Record<string, unknown> {
  return {
    id: run.id,
    gate_id: run.gateId,
    task_id: run.taskId ?? null,
    outcome: run.outcome,
    exit_code: run.exitCode ?? null,
    output: run.output,
    truncated: run.truncated,
    output_digest: run.outputDigest,
    head: run.head,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    duration_ms: run.durationMs,
  }
}

/** The worktree's HEAD, or a placeholder when it cannot be read. */
function headOf(root: string): string {
  try {
    return readFileSync(join(root, ".git", "HEAD"), "utf8").trim()
  } catch {
    // A project that is not a git repository, or a worktree whose HEAD
    // cannot be read. The run records an empty head, which is honest.
    return ""
  }
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const dataDir = defaultDataDir()
    // SQLite creates the file but not the directory it lives in, and the
    // registry's directory is the same one the indexes live in.
    ensureDir(dataDir)
    indexDir(dataDir)
    const registry = new SqliteProjectRegistry({ path: registryPath(dataDir) })
    const queue = new SqliteJobQueue({ path: registryPath(dataDir).replace(/\.sqlite$/, "-jobs.sqlite") })
    // Tasks are authoritative state. They live in the same database as the
    // registry, because a task belongs to a project.
    const tasks = new SqliteTaskStore({ path: registryPath(dataDir) })
    // Gates and their runs. A gate's approval is a human decision, and it
    // has to survive a restart for it to mean anything.
    const verification = new SqliteVerificationStore({ path: registryPath(dataDir) })
    // Memories. A decision a human made is authoritative state, and losing
    // it loses something no index can rebuild.
    const memories = new SqliteMemoryStore({ path: registryPath(dataDir) })
    const metrics = new MetricsSink()
    const flags = new MemoryFeatureFlags()
    // The index is worktree-scoped: two worktrees of one repository have
    // different contents and must not share an index. The key is the
    // worktree's own directory, not the project id — every worktree of a
    // project shares that id.
    //
    // A plugin that throws during setup loses its *entire* tool surface, so
    // the index must never be the reason the plugin fails to load. If the
    // database cannot be opened, the index degrades to an in-memory one and
    // the tools still answer — with less history, but with an answer.
    const indexPathFor = indexPath(ctx.location.directory, dataDir)
    let index: PersistentIndex
    let indexPersistent = true
    try {
      index = new PersistentIndex({ root: ctx.location.directory, path: indexPathFor })
    } catch {
      index = new PersistentIndex({ root: ctx.location.directory })
      indexPersistent = false
    }

    // The index is prepared lazily and in the background: a plugin's setup
    // must not block on parsing a repository.
    let indexReady: Promise<void> | undefined
    const ensureIndex = async () => {
      if (!indexReady) {
        // A persisted index is reused; only what changed is re-read. A full
        // rebuild happens only when the stored index does not cover the tree.
        indexReady = index
          .refresh()
          .then(() => undefined)
          .catch(async () => {
            await index.rebuild()
          })
          .then(
            () => undefined,
            () => undefined,
          )
      }
      await indexReady
    }

    // The watcher is a hint that something changed; the content hash decides
    // whether anything an indexer cares about actually did.
    let refreshing: Promise<void> | undefined
    const scheduleRefresh = (paths?: string[]) => {
      if (refreshing) return
      refreshing = new Promise<void>((resolve) => {
        setTimeout(() => {
          refreshing = undefined
          // A targeted refresh re-reads only the files that changed. A full
          // refresh walks the tree, and is what the reconciliation sweep uses.
          const work = paths?.length ? index.reindexPaths(paths) : index.refresh()
          void work.then(
            () => resolve(),
            () => resolve(),
          )
        }, 400)
      })
    }

    // The watcher uses the project's own ignore rules, so a file the indexer
    // would skip never produces a change event.
    const pathFilter = await buildPathFilter({ root: ctx.location.directory })

    const watcher = new ProjectWatcher({
      root: ctx.location.directory,
      onChange: (paths) => scheduleRefresh(paths),
      debounceMs: 300,
      ignore: (path) => !pathFilter(path),
    })

    // A watcher can miss events — a checkout, an editor that renames a tree,
    // an editor that writes outside the watched root. A periodic sweep
    // reconciles the index against the tree so the index cannot stay wrong.
    const RECONCILE_MS = 5 * 60 * 1000
    const reconcile = setInterval(() => {
      void index.refresh().then(
        () => {},
        () => {},
      )
    }, RECONCILE_MS)
    if (typeof reconcile === "object" && "unref" in reconcile) reconcile.unref()

    const indexProvider = {
      async status() {
        const stats = index.stats()
        if (stats.files === 0 && stats.failures.length === 0) {
          return { available: false, state: "absent" as const, reason: "The index has not been built yet." }
        }
        return {
          available: true,
          state: (stats.failures.length > 0 ? "stale" : "fresh") as "stale" | "fresh",
          filesIndexed: stats.files,
          symbolsIndexed: stats.symbols,
          epoch: stats.epoch,
          languages: stats.languages,
          ...(indexPersistent
            ? {}
            : {
                reason:
                  "The index is not persisted: the database could not be opened, so it lives in memory and is rebuilt on every start.",
              }),
          ...(stats.failures.length > 0 ? { reason: `${stats.failures.length} file(s) could not be indexed.` } : {}),
        }
      },
      async reindex() {
        await index.rebuild()
      },
    }

    /**
     * The declared surface, recorded.
     *
     * Every tool's description and schema is what the model has to read on
     * every request. The benchmark measures that cost for the shapes it
     * compares, but it cannot measure it for OPI's own surface unless OPI
     * records it the same way — so it does, here, to the same file format.
     *
     * This is how the ADR-0018 result is checked against the surface that
     * actually ships, rather than against a fixture's.
     */
    const declaredSurface: { name: string; description: string; input: unknown }[] = []

    /**
     * The call log, if the benchmark asked for one.
     *
     * It is `undefined` in normal use, and then the tools are not wrapped at
     * all — being measurable costs a product plugin nothing.
     */
    const callLog = openCallLog()

    /**
     * The audit trail's stop function.
     *
     * It is `undefined` until the audit is started, and it is `undefined`
     * for good when the audit is off — which is the shipped configuration.
     */
    let stopAudit: (() => Promise<void>) | undefined

    /**
     * Which wording the tool descriptions use.
     *
     * `revised` ships. `baseline` is the **control** for the wording ablation:
     * the same schema, the same backend, the same board, the same tasks and the
     * same model, with the pre-October-2026 wording. It exists so the
     * description change can be measured rather than assumed.
     */
    const variant = variantFor((ctx.options as { descriptionVariant?: unknown } | undefined)?.descriptionVariant)
    /**
     * Which guidance the skill carries.
     *
     * `direct` ships; `baseline` is the control for the guidance ablation.
     * It is a **separate** lever from the descriptions, and they are
     * measured separately so that a change to one is not credited to the
     * other.
     */
    const guidanceVariant = guidanceVariantFor(
      (ctx.options as { guidanceVariant?: unknown } | undefined)?.guidanceVariant,
    )
    /**
     * The skill's **description**, which decides whether the guide is loaded
     * at all.
     *
     * A skill is loaded on demand and its description is the only thing the
     * model reads first. The original fired on "a concept, a symbol, a task
     * or a decision", and the benchmark's questions contain none of those
     * words — so the guide was never delivered and the guidance ablation
     * measured nothing.
     */
    const triggerVariant = triggerVariantFor(
      (ctx.options as { triggerVariant?: unknown } | undefined)?.triggerVariant,
    )
    /**
     * The task tool's shape.
     *
     * `action` ships: one tool with an `action` argument. `split` is the arm
     * the benchmark measures against it — one tool per action, over the same
     * store and the same guard.
     */
    const taskShape = taskShapeFor(
      (ctx.options as { taskShape?: unknown } | undefined)?.taskShape,
    )
    /**
     * The schema's **size**.
     *
     * `full` ships. `minimal` is the arm that tests ADR-009's premise — that a
     * smaller surface costs less — with the structure, the arguments, the
     * enums and the behaviour all held constant, so the only thing that varies
     * is the prose.
     */
    const schemaSize = schemaSizeFor(
      (ctx.options as { schemaSize?: unknown } | undefined)?.schemaSize,
    )

    await ctx.tool.transform(async (editor) => {
      editor.namespace({ name: "pi", description: "OpenCode Project Intelligence" })

      // The `add` method is wrapped rather than each call site, so a tool
      // that is added later is recorded too, and the record cannot drift
      // from what is actually registered.
      // The editor's own type is not exported, so the definition is described
      // by what the wrapper needs. The real signature takes a context as
      // well; it is passed through untouched, because the wrapper only needs
      // the input.
      type ToolDefinition = Parameters<typeof editor.add>[0]
      type ToolExecute = NonNullable<ToolDefinition["execute"]>

      const add = editor.add.bind(editor)
      editor.add = (definition: ToolDefinition) => {
        const name = `pi.${definition.name}`
        // The transform runs once per location, so the same tool is added more
        // than once. The record is a **set**: the surface is what is
        // registered, not how many times it was registered.
        const existing = declaredSurface.find((tool) => tool.name === name)
        if (existing) {
          existing.description = definition.description
          existing.input = definition.input ?? {}
        } else {
          declaredSurface.push({
            name,
            description: definition.description,
            input: definition.input ?? {},
          })
        }

        /**
         * The call is wrapped so it can be counted.
         *
         * The benchmark counts calls from **inside** the plugin, because the
         * event stream — the thing under test — carries no record of a call
         * whose Code Mode wrapper failed. OPI's own surface has to be
         * countable the same way, or the three surfaces are not measured the
         * same way and the comparison is not a comparison.
         *
         * The count is written only when the benchmark asks for it. A
         * product plugin does not log every call to disk by default.
         */
        const execute = definition.execute
        if (execute && callLog) {
          return add({
            ...definition,
            execute: (async (input: Parameters<ToolExecute>[0], context: Parameters<ToolExecute>[1]) => {
              const at = Date.now()
              const inputKeys =
                input && typeof input === "object" && !Array.isArray(input)
                  ? Object.keys(input as Record<string, unknown>)
                  : []
              const action = String(
                (input as Record<string, unknown> | undefined)?.action ?? definition.name,
              )
              try {
                const result = await execute(input, context)
                await callLog.append({
                  tool: name,
                  action,
                  ok: true,
                  at,
                  durationMs: Date.now() - at,
                  inputKeys,
                })
                return result
              } catch (error) {
                await callLog.append({
                  tool: name,
                  action,
                  ok: false,
                  at,
                  durationMs: Date.now() - at,
                  inputKeys,
                  error: (error as Error).message,
                })
                throw error
              }
            }) as ToolExecute,
          } as never)
        }
        return add(definition as never)
      }

      // The description comes from the variants module, so the control arm
      // and the shipping arm cannot drift apart.
      const TOOL_CONTEXT = "context" as const
      editor.add({
        name: "context",
        description: descriptionFor(variant, TOOL_CONTEXT, schemaSize),
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "The question, in words." },
            budget_tokens: {
              type: "number",
              description: `Token budget for the pack. Default ${BUDGETS.default}, between ${BUDGETS.min} and ${BUDGETS.max}.`,
            },
            max_candidates: { type: "number", description: "Maximum candidates to return." },
          },
          required: ["query"],
          additionalProperties: false,
        },
        options: { namespace: "pi" },
        execute: async (input) => {
          const args = (input ?? {}) as Record<string, unknown>
          await ensureIndex()
          const result = assembleContext(index, String(args.query ?? ""), {
            ...(typeof args.budget_tokens === "number" ? { budgetTokens: args.budget_tokens } : {}),
            ...(typeof args.max_candidates === "number" ? { maxCandidates: args.max_candidates } : {}),
          })
          return {
            content: JSON.stringify({
              schema_version: "1",
              status: result.partial ? "partial" : "ok",
              data: result,
              sources: contextSources(result),
              warnings: result.warnings,
              truncated: result.truncated,
            }),
          }
        },
      })

      // The description comes from the variants module, so the control arm
      // and the shipping arm cannot drift apart.
      const TOOL_GRAPH = "graph" as const
      editor.add({
        name: "graph",
        description: descriptionFor(variant, TOOL_GRAPH, schemaSize),
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: [...GRAPH_ACTIONS], description: "The query to run." },
            query: { type: "string", description: "The symbol or path the query is about." },
            path: { type: "string", description: "Scope the query to one file." },
            max_hops: { type: "number", description: "How far to walk. Default 2, maximum 3." },
            max_symbols: { type: "number", description: "Maximum symbols to return. Default 50." },
            max_files: { type: "number", description: "Maximum files to return. Default 30." },
          },
          required: ["action", "query"],
          additionalProperties: false,
        },
        options: { namespace: "pi" },
        execute: async (input) => {
          const args = (input ?? {}) as Record<string, unknown>
          const action = String(args.action ?? "symbol_search") as Parameters<typeof queryGraph>[1]["action"]
          if (!GRAPH_ACTIONS.includes(action)) {
            return { content: JSON.stringify({ error: `Unknown action ${action}.` }) }
          }
          await ensureIndex()
          const result = queryGraph(index, {
            action,
            query: String(args.query ?? ""),
            ...(typeof args.path === "string" ? { path: args.path } : {}),
            ...(typeof args.max_hops === "number" ? { maxHops: args.max_hops } : {}),
            ...(typeof args.max_symbols === "number" ? { maxSymbols: args.max_symbols } : {}),
            ...(typeof args.max_files === "number" ? { maxFiles: args.max_files } : {}),
          })
          return {
            content: JSON.stringify({
              schema_version: "1",
              status: "partial",
              data: result,
              sources: graphSources(result),
              warnings: result.warnings,
              truncated: result.truncated,
            }),
          }
        },
      })

      // The task tool, in whichever shape this instance is configured for.
      //
      // The two shapes share one implementation — the same store, the same
      // guard, the same audit history — and differ only in how they present
      // it. That is what makes the surface comparison a comparison of
      // interfaces rather than of backends.
      registerTaskTools({
        editor,
        ctx,
        tasks,
        registry,
        shape: taskShape,
        descriptionVariant: variant,
        schemaSize,
        makeReply: (identity) => (data, warnings = [], status = "ok") => ({
          content: JSON.stringify({
            schema_version: "1",
            status,
            project_id: identity.id,
            worktree_id: identity.worktree.id,
            data,
            warnings,
            sources: [],
            truncated: false,
          }),
        }),
      })

      // The description comes from the variants module, so the control arm
      // and the shipping arm cannot drift apart.
      const TOOL_MEMORY = "memory" as const
      editor.add({
        name: "memory",
        description: descriptionFor(variant, TOOL_MEMORY, schemaSize),
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: MEMORY_ACTIONS,
              description: "The operation to run.",
            },
            query: { type: "string", description: "What to search for. For search." },
            title: { type: "string", description: "The memory's title. For propose." },
            body: { type: "string", description: "The memory's body. For propose." },
            kind: {
              type: "string",
              enum: ["human_decision", "verified_fact", "task_handoff", "discovery", "risk"],
              description: "What the memory is about. For propose.",
            },
            source: {
              type: "string",
              description:
                "The file the memory is about, relative to the project root. A memory with a source goes stale when that file changes.",
            },
            evidence: {
              type: "string",
              description: "The id of the thing that proves the memory. For propose.",
            },
            task: { type: "string", description: "The task's key. For handoff and resume." },
            completed: {
              type: "array",
              items: { type: "string" },
              description: "What was finished. For handoff.",
            },
            blockers: {
              type: "array",
              items: { type: "string" },
              description: "What is in the way. For handoff.",
            },
            next_actions: {
              type: "array",
              items: { type: "string" },
              description: "What to do next. For handoff.",
            },
            limit: { type: "number", description: "Maximum memories to return. Default 10." },
            include_superseded: {
              type: "boolean",
              description: "Include the memories that were replaced. Default false.",
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { namespace: "pi" },
        execute: async (input) => {
          const args = (input ?? {}) as Record<string, unknown>
          const action = String(args.action ?? "search")
          if (!MEMORY_ACTIONS.includes(action as (typeof MEMORY_ACTIONS)[number])) {
            return { content: JSON.stringify({ error: `Unknown action ${action}.` }) }
          }

          const identity = await resolveProject(ctx.location.directory, registry)
          if (!identity) {
            return {
              content: JSON.stringify({
                schema_version: "1",
                status: "error",
                data: undefined,
                warnings: ["The project could not be resolved."],
                sources: [],
                truncated: false,
              }),
            }
          }
          const projectId = identity.id
          const root = ctx.location.directory

          const reply = (data: unknown, warnings: string[] = [], status = "ok") => ({
            content: JSON.stringify({
              schema_version: "1",
              status,
              project_id: projectId,
              worktree_id: identity.worktree.id,
              data,
              warnings,
              sources: [],
              truncated: false,
            }),
          })

          switch (action) {
            case "search": {
              const all = withStaleness(memories.list(projectId), root)
              const result = searchMemories(all, String(args.query ?? ""), {
                limit: typeof args.limit === "number" ? args.limit : undefined,
                includeSuperseded: args.include_superseded === true,
                worktreeId: identity.worktree.id,
              })
              return reply(result, result.truncated ? [result.truncation_reason ?? ""] : [])
            }
            case "list": {
              const all = withStaleness(memories.list(projectId), root)
              const views = all.map((memory) => toMemoryView(memory, { includeBody: false }))
              return reply({ memories: views, count: views.length })
            }
            case "propose": {
              const title = String(args.title ?? "").trim()
              if (!title) return reply(undefined, ["A memory needs a title."], "error")
              const source = args.source ? String(args.source) : undefined
              const result = memories.propose({
                projectId,
                kind: (String(args.kind ?? "discovery") as Memory["kind"]),
                title,
                body: String(args.body ?? ""),
                worktreeId: identity.worktree.id,
                provenance: {
                  origin: "agent",
                  ...(source ? { source } : {}),
                  ...(args.evidence ? { evidenceRef: String(args.evidence) } : {}),
                },
              })
              if (!result.ok || !result.value) {
                return reply(undefined, [result.error ?? "The memory could not be proposed."], "error")
              }
              return reply(
                { memory: toMemoryView(result.value) },
                [
                  "The memory is a proposal. It is a lead, not a constraint, until someone confirms it.",
                ],
              )
            }
            case "handoff": {
              const task = args.task
                ? tasks.getByKey(projectId, String(args.task)) ?? tasks.get(String(args.task))
                : undefined
              const handoff = boundHandoff({
                ...emptyHandoff(),
                ...(task ? { taskId: task.id, taskKey: task.publicKey, status: task.state } : {}),
                completed: (args.completed as string[] | undefined) ?? [],
                blockers: (args.blockers as string[] | undefined) ?? [],
                nextActions: (args.next_actions as string[] | undefined) ?? [],
                worktree: { root, head: headOf(root) },
                createdAt: Date.now(),
              })
              const result = memories.recordHandoff(projectId, handoff, {
                worktreeId: identity.worktree.id,
              })
              if (!result.ok) {
                return reply(undefined, [result.error ?? "The handoff could not be recorded."], "error")
              }
              return reply({ handoff: summariseHandoff(handoff) })
            }
            case "resume": {
              const task = args.task
                ? tasks.getByKey(projectId, String(args.task)) ?? tasks.get(String(args.task))
                : undefined
              const handoff = task
                ? memories.latestHandoff(task.id)
                : memories.latestHandoffForProject(projectId)
              if (!handoff) {
                return reply(undefined, ["There is no handoff for that task."], "partial")
              }
              const referenced = handoff.decisions
                .map((decision) => memories.get(decision.memoryId))
                .filter((memory): memory is Memory => memory !== undefined)
              return reply({
                handoff: summariseHandoff(handoff, withStaleness(referenced, root)),
                raw: handoff,
              })
            }
            default:
              return reply(undefined, [`Unknown action ${action}.`], "error")
          }
        },
      })

      // The description comes from the variants module, so the control arm
      // and the shipping arm cannot drift apart.
      const TOOL_VERIFY = "verify" as const
      editor.add({
        name: "verify",
        description: descriptionFor(variant, TOOL_VERIFY, schemaSize),
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: VERIFY_ACTIONS,
              description: "The operation to run.",
            },
            gate_id: {
              type: "string",
              description: "The gate's id. The only thing `run` accepts.",
            },
            task: {
              type: "string",
              description: "The task's key. For run and evaluate_task.",
            },
            kind: {
              type: "string",
              enum: ["typecheck", "lint", "test", "integration_test", "build", "format", "security_scan", "custom"],
              description: "What the gate checks. For propose_gates.",
            },
            scope: {
              type: "array",
              items: { type: "string" },
              description:
                "The paths the gate covers, relative to the project root. A change here makes a run stale.",
            },
            required_for: {
              type: "array",
              items: { type: "string" },
              description:
                "The task types this gate is required for. Empty means the gate is available but not required.",
            },
            timeout_ms: { type: "number", description: "A hard time bound for the run." },
            risk: {
              type: "string",
              enum: ["safe", "side_effecting", "destructive"],
              description: "How much damage the gate could do.",
            },
            waiver: {
              type: "object",
              description: "A waiver. Needs an actor, a reason and a scope.",
              properties: {
                actor: { type: "string", description: "Who is accepting the risk." },
                reason: { type: "string", description: "Why." },
                scope: { type: "string", description: "What the waiver covers." },
              },
              required: ["actor", "reason", "scope"],
              additionalProperties: false,
            },
            limit: { type: "number", description: "Maximum runs to return. Default 10." },
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { namespace: "pi" },
        execute: async (input) => {
          const args = (input ?? {}) as Record<string, unknown>
          const action = String(args.action ?? "list_gates")
          if (!VERIFY_ACTIONS.includes(action as (typeof VERIFY_ACTIONS)[number])) {
            return { content: JSON.stringify({ error: `Unknown action ${action}.` }) }
          }

          const identity = await resolveProject(ctx.location.directory, registry)
          if (!identity) {
            return {
              content: JSON.stringify({
                schema_version: "1",
                status: "error",
                data: undefined,
                warnings: ["The project could not be resolved."],
                sources: [],
                truncated: false,
              }),
            }
          }
          const projectId = identity.id
          const root = ctx.location.directory

          const serviceOptions = {
            gates: () => verification.list(projectId),
            runs: (gateId: string) => verification.runs(gateId),
            recordRun: (run: GateRun) => {
              verification.recordRun(run)
            },
            root: () => root,
            head: () => headOf(root),
            executionAllowed: () => flags.isEnabled("verification.execution"),
            gate: (id: string) => verification.get(projectId, id),
          }

          const reply = (data: unknown, warnings: string[] = [], status = "ok") => ({
            content: JSON.stringify({
              schema_version: "1",
              status,
              project_id: projectId,
              worktree_id: identity.worktree.id,
              data,
              warnings,
              sources: [],
              truncated: false,
            }),
          })

          switch (action) {
            case "list_gates": {
              const registered = verification.list(projectId).map(toGateView)
              const detected = detectGates(root).map((gate) => ({
                id: gate.id,
                kind: gate.kind,
                description: gate.description,
                executable: gate.executable,
                args: gate.args,
                reason: gate.reason,
                runnable: gate.runnable,
              }))
              return reply({
                gates: registered,
                detected,
                execution_enabled: flags.isEnabled("verification.execution"),
              })
            }
            case "propose_gates": {
              const kind = String(args.kind ?? "custom") as Gate["kind"]
              const detected = detectGates(root).filter((gate) => gate.kind === kind)
              const id = detected[0]?.id ?? `${kind}-gate`
              const existing = verification.get(projectId, id)
              if (existing) {
                // The gate already exists. Proposing it again is a no-op, and
                // saying so is better than silently returning a gate whose
                // settings differ from what the caller asked for.
                return reply(
                  { gate: toGateView(existing), already_exists: true },
                  [
                    `The gate ${id} already exists. Its settings were not changed.`,
                    "Its scope and the task types it is required for are set when it is created.",
                  ],
                )
              }
              const result = verification.propose({
                projectId,
                id,
                executable: detected[0]?.executable ?? "/bin/true",
                args: detected[0]?.args ?? [],
                kind,
                description: detected[0]?.description ?? "A proposed check.",
                scope: (args.scope as string[] | undefined) ?? ["."],
                requiredForTypes: (args.required_for as string[] | undefined) ?? [],
                ...(typeof args.timeout_ms === "number" ? { timeoutMs: args.timeout_ms } : {}),
                risk: (args.risk as Gate["risk"] | undefined) ?? "safe",
                actor: "agent",
              })
              if (!result.ok || !result.value) {
                return reply(undefined, [result.error ?? "The gate could not be proposed."], "error")
              }
              return reply(
                { gate: toGateView(result.value) },
                [
                  "The gate is proposed. It does not run until someone approves it.",
                ],
              )
            }
            case "configure_gate": {
              const gateId = String(args.gate_id ?? "")
              if (!gateId) {
                return reply(undefined, ["`configure_gate` needs a gate id."], "error")
              }
              if (!verification.get(projectId, gateId)) {
                return reply(undefined, [`There is no gate named ${gateId}.`], "error")
              }
              const result = verification.redefine(projectId, gateId, {
                ...(args.scope !== undefined ? { scope: args.scope as string[] } : {}),
                ...(args.required_for !== undefined
                  ? { requiredForTypes: args.required_for as string[] }
                  : {}),
                ...(typeof args.timeout_ms === "number" ? { timeoutMs: args.timeout_ms } : {}),
                ...(args.risk !== undefined ? { risk: args.risk as Gate["risk"] } : {}),
                ...(args.description !== undefined ? { description: String(args.description) } : {}),
              })
              if (!result.ok || !result.value) {
                return reply(undefined, [result.error ?? "The gate could not be changed."], "error")
              }
              return reply(
                { gate: toGateView(result.value) },
                [
                  "The gate's configuration changed, so its earlier runs are now stale.",
                ],
              )
            }
            case "run": {
              const gateId = String(args.gate_id ?? "")
              if (!gateId) {
                return reply(undefined, ["`run` needs a gate id."], "error")
              }
              const task = args.task
                ? tasks.getByKey(projectId, String(args.task)) ?? tasks.get(String(args.task))
                : undefined
              const result = await runVerification(serviceOptions, {
                gateId,
                ...(task ? { taskId: task.id } : {}),
              })
              if (!result.ok) {
                return reply(undefined, [result.message], "error")
              }
              return reply({ run: toRunView(result.value) })
            }
            case "results": {
              const gateId = String(args.gate_id ?? "")
              if (!gateId) {
                return reply(undefined, ["`results` needs a gate id."], "error")
              }
              const gate = verification.get(projectId, gateId)
              if (!gate) {
                return reply(undefined, [`There is no gate named ${gateId}.`], "error")
              }
              const limit = typeof args.limit === "number" ? args.limit : 10
              const runs = verification.runs(gateId, limit)
              return reply({
                gate: toGateView(gate),
                runs: runs.map((run) => ({
                  ...toRunView(run),
                  stale: checkStaleness(run, gate, root, headOf(root)).stale,
                })),
              })
            }
            case "waive": {
              const waiverInput = args.waiver as
                | { actor?: string; reason?: string; scope?: string }
                | undefined
              if (!waiverInput) {
                return reply(undefined, ["`waive` needs an actor, a reason and a scope."], "error")
              }
              const task = args.task
                ? tasks.getByKey(projectId, String(args.task)) ?? tasks.get(String(args.task))
                : undefined
              if (!task) {
                return reply(undefined, ["`waive` needs a task."], "error")
              }
              const result = tasks.setVerification(task.id, "waived", {
                actor: "agent",
                waiver: {
                  actor: String(waiverInput.actor ?? ""),
                  reason: String(waiverInput.reason ?? ""),
                  scope: String(waiverInput.scope ?? ""),
                  at: Date.now(),
                },
              })
              if (!result.ok || !result.value) {
                return reply(undefined, [result.error ?? "The waiver could not be recorded."], "error")
              }
              return reply(
                { task: toView(result.value) },
                ["The waiver is recorded with who accepted it, why, and what it covers."],
              )
            }
            case "evaluate_task": {
              const task = args.task
                ? tasks.getByKey(projectId, String(args.task)) ?? tasks.get(String(args.task))
                : undefined
              if (!task) {
                return reply(undefined, ["`evaluate_task` needs a task."], "error")
              }
              const allRuns = verification.runsForTask(task.id, 100)
              const summary = evaluateVerification(serviceOptions, task, allRuns)
              return reply({
                task: toView(task),
                verification: summary.state,
                reason: summary.reason,
                gates: summary.gates,
                missing: summary.missing,
              })
            }
            default:
              return reply(undefined, [`Unknown action ${action}.`], "error")
          }
        },
      })

      // The description comes from the variants module, so the control arm
      // and the shipping arm cannot drift apart.
      const TOOL_STATUS = "status" as const
      editor.add({
        name: "status",
        description: descriptionFor(variant, TOOL_STATUS, schemaSize),
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ACTIONS,
              description: "What to report. Defaults to summary.",
            },
          },
          additionalProperties: false,
        },
        options: { namespace: "pi" },
        execute: async (input) => {
          const action = ((input as { action?: string })?.action ?? "summary") as StatusAction
          const result = await status(
            {
              action: ACTIONS.includes(action) ? action : "summary",
              directory: ctx.location.directory,
            },
            {
              registry,
              metrics,
              flags,
              queue,
              index: indexProvider,
              registryPath: registryPath(dataDir),
              version: PLUGIN_VERSION,
            },
          )
          return { content: JSON.stringify(result) }
        },
      })

      // The declared surface, written out. It is written **here**, at the end
      // of the transform, because that is where the tools are known to be
      // registered — the callback is what registers them.
      //
      // The benchmark reads this to compare OPI's real surface against the
      // shapes it measured. The file format is the benchmark's, so the two
      // are directly comparable.
      await writeFile(
        resolve(dataDir, "surface.json"),
        `${JSON.stringify({ shape: "pi", tools: declaredSurface }, null, 2)}\n`,
        "utf8",
      ).catch(() => {
        // A surface that cannot be recorded is not a reason to fail the load.
      })

      /**
       * The audit trail, if it is wanted.
       *
       * This is the **only** place the plugin touches the event stream,
       * and it is off unless `OPI_AUDIT_LOG` names a file. A product
       * plugin never subscribes: the stream is server-wide, and reading
       * another project's payloads is the risk T-01 names.
       *
       * When it is on, it filters on the event's location **before** the
       * payload is read, and drops the user-content event kinds by name.
       */
      stopAudit = startAudit(ctx, ctx.location.directory) ?? stopAudit
    })

    // The commands are the product's front door. Without them, the only way
    // to reach any of this is to ask an agent to call a tool and read the
    // JSON.
    //
    // A command **reports** the rules; it never makes them. It gathers what
    // the store knows and hands it to the agent with the reasoning
    // included. See ADR-0025.
    await registerCommands(ctx, {
      // The project is resolved when the command runs, not at setup: the
      // registry is what assigns the id, and a command may run in a
      // different location than the plugin was loaded in.
      projectId: async () => {
        const identity = await resolveProject(ctx.location.directory, registry)
        return identity?.id
      },
      tasks: async (projectId) => tasks.list(projectId),
      edges: async (projectId) => tasks.edges(projectId),
      gates: async (projectId) =>
        verification.list(projectId).map((gate) => ({
          id: gate.id,
          kind: gate.kind,
          state: gate.state,
          description: gate.description,
          requiredForTypes: gate.requiredForTypes,
        })),
      root: () => ctx.location.directory,
      head: () => headOf(ctx.location.directory),
      handoff: async (projectId, taskKey) => {
        if (!taskKey) return memories.latestHandoffForProject(projectId)
        const task = tasks.getByKey(projectId, taskKey) ?? tasks.get(taskKey)
        return task ? memories.latestHandoff(task.id) : undefined
      },
    })

    // The skill is the agent's guide. It is small and loaded on demand, so
    // it costs nothing in a project that never uses OPI.
    await registerSkill(ctx, { guidance: guidanceVariant, trigger: triggerVariant })

    // The dashboard reads through this. It is a view over the same stores
    // the tools use, so the browser and the agent cannot disagree.
    await registerRpc(ctx, {
      registry: registry as never,
      tasks,
      verification,
      memories,
      root: () => ctx.location.directory,
      head: () => headOf(ctx.location.directory),
      index: () => {
        const stats = index.stats()
        return {
          available: stats.files > 0,
          state: stats.files === 0 ? "absent" : stats.failures.length > 0 ? "stale" : "fresh",
          filesIndexed: stats.files,
          symbolsIndexed: stats.symbols,
          epoch: stats.epoch,
          languages: stats.languages,
        }
      },
    })

    // Prepare the index in the background so the first tool call is not
    // blocked, and start watching for changes.
    void ensureIndex()
    watcher.start()

    return () => {
      clearInterval(reconcile)
      watcher.close()
      tasks.close()
      verification.close()
      memories.close()
      registry.close()
      queue.close()
      index.close()
    }
  },
})

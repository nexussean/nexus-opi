#!/usr/bin/env bun
/**
 * The tool-surface benchmark (ADR-0018).
 *
 * Runs fixture shapes and a separate SQLite pair (opi / none-opi). Reports:
 *
 *   - inner tool calls, and how many failed
 *   - tokens (input / output / reasoning / cache read)
 *   - declared schema bytes (not observed prompt tokens)
 *
 * The shapes are:
 *
 *   separate — one tool per action, each with its own description and schema
 *   actions  — one tool with an `action` argument covering every action
 *   none     — legacy JSON fixture control
 *   opi      — product tools with a seeded SQLite board
 *   none-opi — same SQLite seed and locator, no product tools
 *
 * The control is the point. Without it, "0 calls" is uninterpretable: it may
 * mean the model did not need the tool, or that it never found it.
 *
 * ## Why a private server per shape
 *
 * A plugin is set up **once per server**, and its tools are registered into
 * the server's catalog. So the surface cannot change between runs against one
 * server: the `actions` run would still find the `separate` shape's six
 * tools in the catalog, and the control would find all six.
 *
 * Each shape therefore gets its **own** `opencode run --standalone` server,
 * with the plugin configured in the run's own project directory. That also
 * sidesteps the shared service not loading project-config plugins at all
 * (the compat doc, §12.3).
 *
 * ## Why the counter lives in the plugin
 *
 * The calls are counted by the plugin itself, writing to its own log. The
 * first measurement inferred them from the event stream, which is the thing
 * under test — and which carries no record of a call whose Code Mode wrapper
 * failed. A run in which the model tried the tool and failed recorded zero
 * calls. Measuring the thing through the same channel it is testing is how a
 * benchmark ends up measuring the harness.
 *
 * Usage:
 *   bun run harness/run.ts [--model deepseek/deepseek-flash] [--repeats 3]
 *                           [--shapes opi,none-opi] [--tasks list-all]
 *                           [--keep]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { hasCompleteUsage, extractAnswer, gradeRead, gradeWrite, snapshot, readPrompt, READ_IDS, OUTCOME_VERSION, unknown, type Snapshot, type Verdict } from "./outcomes.ts"
import { gradeContent, CONTENT_GRADER_VERSION, graderFingerprint } from "./content-grader.ts"
import { digest, fingerprintPrompt, fingerprintSurface, runtimeIdentity, sourceFingerprint } from "./fingerprints.ts"
import { seededRandom } from "./schedule.ts"
import { compareCostPerSuccess, costPerSuccessInterval } from "./uncertainty.ts"
import { boardJson, boardSnapshot } from "./board.ts"
import { authoritativeCost } from "./billing.ts"
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { realpath } from "node:fs/promises"
import { join, resolve } from "node:path"

const HERE = import.meta.dirname
const PACKAGE = resolve(HERE, "..")
const TASKS = resolve(PACKAGE, "../../fixtures/bench/tasks")
/** The product's own plugin — the surface that actually ships. */
const OPI_PLUGIN = resolve(PACKAGE, "../adapter-opencode")

function arg(flag: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback
}

/**
 * The surfaces the benchmark measures.
 *
 * The first three are fixtures: they exist to make the question answerable.
 * The fourth is **the product's own surface** — the six tools OPI actually
 * ships — measured against the same board, with the same prompts, by the same
 * harness. A measurement of a fixture is a measurement of a fixture; only the
 * fourth answers the question the exercise was raised to answer.
 */
/**
 * The surfaces the benchmark measures.
 *
 * `opi-baseline` is the **control** for the wording ablation: the product's
 * own surface with the pre-October-2026 descriptions. Same schema, same
 * backend, same board, same tasks, same model — only the prose differs. It
 * exists so the description change can be measured rather than assumed, and
 * it is a shape rather than a flag so the two arms are interleaved and
 * randomised the same way.
 */
/**
 * What each arm varies.
 *
 * Every arm differs from the shipping one in **exactly one** lever. An arm
 * that varies two measures both; an arm that varies none is a duplicate that
 * looks like a control. Two arms were mis-wired while this was being built,
 * and a mis-wired arm produces a clean, plausible, meaningless number — so the
 * table is explicit and the test reads it.
 */
export const ARM_LEVERS: Record<
  string,
  { wording: "revised" | "baseline"; guidance: "direct" | "baseline"; structure: "action" | "split"; size: "full" | "minimal" }
> = {
  // The shipping surface.
  opi: { wording: "revised", guidance: "direct", structure: "action", size: "full" },
  // The size arm: the same surface, with the prose shortened.
  "opi-minimal": { wording: "revised", guidance: "direct", structure: "action", size: "minimal" },
  // The wording arms: the pre-October-2026 descriptions.
  "opi-baseline": { wording: "baseline", guidance: "direct", structure: "action", size: "full" },
  "opi-minimal-wording": { wording: "baseline", guidance: "direct", structure: "action", size: "minimal" },
  // The guidance arms: the pre-change guidance body.
  "opi-baseline-guidance": { wording: "revised", guidance: "baseline", structure: "action", size: "full" },
  "opi-minimal-guidance": { wording: "revised", guidance: "baseline", structure: "action", size: "minimal" },
  // The structure arms: one tool per action.
  "opi-split": { wording: "revised", guidance: "direct", structure: "split", size: "full" },
  "opi-minimal-split": { wording: "revised", guidance: "direct", structure: "split", size: "minimal" },
}

const SHAPES = [
  "separate",
  "actions",
  "none",
  "opi",
  "none-opi",
  "opi-baseline",
  "opi-baseline-guidance",
  "opi-baseline-trigger",
  "opi-split",
  "opi-minimal",
  "opi-minimal-wording",
  "opi-minimal-guidance",
  "opi-minimal-split",
] as const
export type Shape = (typeof SHAPES)[number]

/**
 * The model the benchmark runs against.
 *
 * The default is `ollama-cloud/minimax-m3.1-flash`: it is fast, it makes tool
 * calls reliably, and it is on the same provider as the local fallback, so
 * the two are easy to compare.
 *
 * The **local** fallback is `ollama/ornith-1.5:9b`. It has no balance and no
 * rate limit, so the measurement can be reproduced offline and for free. It
 * is slower, and it is a 9B model, so its absolute numbers are not
 * comparable with a frontier model's — the *relative* comparison between
 * surfaces still is, because every shape is measured with the same model.
 *
 * The default used to be `deepseek/deepseek-flash`, whose provider balance
 * ran out halfway through a 120-run matrix. A benchmark that can die of
 * exhaustion is a benchmark that is not finished.
 */
/**
 * The models the benchmark runs against.
 *
 * More than one, because the models **disagree**, and that disagreement is
 * information rather than noise:
 *
 * - `ollama-cloud/deepseek-v4.1-flash` reached the board tool in 23 of 30 runs.
 * - `ollama-cloud/minimax-m3.1-flash` reached it in 10 of 30, and the runs it
 *   missed spent their time reading files and reverse-engineering the store.
 * - `ollama/ornith-1.5:9b` is the **local** fallback: no balance, no rate
 *   limit, reproducible offline.
 *
 * A surface's cost is not a property of the surface alone. It is a property of
 * the surface *and* the model that has to find it, so a measurement of one
 * model is a measurement of one model.
 *
 * `--model` takes a comma-separated list.
 */
const MODELS = (arg("--models") ?? arg("--model", "ollama-cloud/minimax-m3.1-flash")!)
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean)
const REPEATS = Number(arg("--repeats", "1"))
const ONLY_SHAPES = arg("--shapes")?.split(",").filter((shape): shape is Shape => SHAPES.includes(shape as Shape))
const ONLY_TASKS = arg("--tasks")?.split(",").map((id) => id.trim()).filter(Boolean)
const KEEP = process.argv.includes("--keep")

/**
 * The namespace the benchmark's tools live under.
 *
 * It has to be **unique to this benchmark**: the product's own plugin uses
 * `pi`, and a shared namespace would put two plugins' tools in one catalog
 * where the model cannot tell them apart.
 */
const BENCH_NAMESPACE = arg("--namespace", "benchtasks")!

/**
 * The OpenCode the benchmark runs against.
 *
 * It has to be the **same build that serves the plugin**, or the benchmark
 * measures a surface nobody uses. On this machine there are two: the CLI on
 * `PATH` (2.0.28) and the desktop app's own copy (2.1.0), and the plugin is
 * loaded into the latter.
 *
 * `OPENCODE_BIN` overrides it. The desktop app's copy is found by the
 * version it carries, under the app's support directory.
 */
function findOpencode(): string {
  const override = arg("--opencode") ?? process.env.OPENCODE_BIN
  if (override) return override
  const appSupport = join(
    process.env.HOME ?? "",
    "Library",
    "Application Support",
    "ai.opencode.desktop",
    "cli",
  )
  try {
    // Newest version first. `readdirSync` order is not a version order, and
    // the desktop app replaces its CLI directory when it updates: the
    // 2026-10-21 matrix lost 251 of 360 runs to a 2.1.0 directory that was
    // deleted mid-run.
    const candidates = readdirSync(appSupport, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(appSupport, entry.name, "opencode-cli"))
      .filter((candidate) => existsSync(candidate))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    if (candidates[0]) return candidates[0]
  } catch {
    // The desktop app is not installed. Fall through to the PATH.
  }
  return "opencode"
}


/**
 * The local model, if the run is against one.
 *
 * A local model has no balance and no rate limit, which makes a benchmark
 * reproducible and free. It is slower, and it is a smaller model, so its
 * absolute numbers are not comparable with a frontier model's. The
 * *relative* comparison between surfaces still is, because every shape is
 * measured with the same model.
 *
 * The local models think by default and think slowly, so their reasoning
 * has to be turned off — see `localModelConfig`.
 */
/** The local model, if this run is against one. */
function localModelOf(model: string): string | undefined {
  return model.startsWith("ollama/") ? model.slice("ollama/".length) : undefined
}

/**
 * The config a local model needs.
 *
 * Only the reasoning toggle: the local models support it, and without it a
 * run takes minutes rather than seconds.
 */
function localModelConfig(model: string): Record<string, unknown> {
  return {
    provider: {
      ollama: {
        models: {
          [model]: { reasoning: { supported: true, toggle: false } },
        },
      },
    },
  }
}

export interface Task {
  id: string
  name: string
  kind: string
  prompt: string
}

async function loadTasks(): Promise<Task[]> {
  const { readdir } = await import("node:fs/promises")
  const files = (await readdir(TASKS)).filter((file) => file.endsWith(".md")).sort()
  const tasks: Task[] = []
  for (const file of files) {
    const raw = await readFile(join(TASKS, file), "utf8")
    const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(raw)
    if (!match) throw new Error(`Malformed task file: ${file}`)
    const meta: Record<string, string> = {}
    for (const line of match[1].split("\n")) {
      const kv = /^([a-z]+):\s*(.*)$/.exec(line)
      if (kv) meta[kv[1]] = kv[2]
    }
    tasks.push({
      id: meta.id ?? file.replace(/\.md$/, ""),
      name: meta.name ?? file,
      kind: meta.kind ?? "unknown",
      prompt: match[2].trim(),
    })
  }
  return tasks
}

interface RecordedCall {
  tool: string
  action: string
  ok: boolean
  at: number
  durationMs: number
  error?: string
}

export interface RunMetrics {
  /** The model this run was measured against. */
  model: string
  shape: Shape
  task: Task
  calls: RecordedCall[]
  totalCalls: number
  failedCalls: number
  /**
   * The calls the model made that were **not** this surface's own tools.
   *
   * The discovery cost. It is invisible in the surface's own call log,
   * because the surface never saw those calls.
   */
  discoveryCalls: number
  discoveryTools: Record<string, number>
  tokens: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    /**
     * The cost the trace itself carried.
     *
     * This is a **lower bound**: the final answer's usage is not in the
     * trace. `billing.cost` is the authoritative figure.
     */
    cost: number
    steps: number
  }
  /**
   * The answer's **format**, reported beside the grade.
   *
   * `grade` is the old JSON-contract grade, kept so that the historical
   * comparison is still possible. `format` is what the answer looked like,
   * and `formatCompliant` is whether it met the contract.
   */
  format?: {
    grade: string
    format: string
    formatCompliant: boolean
    reasons: string[]
  }
  /**
   * The authoritative billing.
   *
   * The three things are kept apart on purpose: **execution** completed,
   * **answer** correct, and **billing** complete. A run that answered
   * correctly but whose cost was not fully recovered is a different thing
   * from one that did not answer, and the two must not be added together.
   */
  billing: {
    /** The authoritative cost. */
    cost: number
    /** Whether the cost is the whole cost. */
    complete: boolean
    /** Where the cost came from. */
    source: "store" | "trace" | "none"
    /** Why the cost is not complete, when it is not. */
    reason?: string
  }
  schemaBytes: number
  toolCount: number
  /** The fingerprint of the rendered surface for this run. */
  surfaceFingerprint: string
  durationMs: number
  error?: string
  /**
   * The verdict on the answer.
   *
   * `ungradable` is kept apart from `failed` on purpose: a run that never
   * produced an answer is a run that did not happen, and calling it a task
   * failure would make a broken harness look like a bad surface.
   */
  verdict: Verdict
  usageComplete?: boolean
  evidence?: { before: Snapshot; after?: Snapshot; answer: string; extractionReason?: string; promptHash: string }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * How many tools a shape is expected to register.
 *
 * It is **derived from the structure**, not from the arm's name. The check
 * used to test `shape === "opi-split"`, and so the `opi-minimal-split` arm —
 * which is also the split structure — was expected to register six tools
 * instead of fourteen. Every one of its runs was invalidated with "Unexpected
 * registered tool count", so the arm produced no data at all.
 */
export function expectedToolCount(shape: Shape): number {
  const levers = ARM_LEVERS[shape]
  // The split shape replaces one task tool with nine.
  if (levers?.structure === "split") return 6 + 8
  if (shape === "none" || shape === "none-opi") return 0
  if (shape === "actions") return 1
  if (shape === "separate") return 6
  return 6
}

/** The prompt a task is run with, including the answer contract. */
function taskPrompt(task: Task): string {
  return readPrompt(task.id, task.prompt)
}

/**
 * The plugin's own call log.
 *
 * The plugin is configured with a `benchDir`, and writes its calls and its
 * declared surface there. The harness reads the same place, so the calls it
 * counts are the calls the plugin saw.
 */
/**
 * The tokens a run used, and what it cost.
 *
 * They are in the run's `step_finish` events. Each event reports **that
 * step's** usage, not the run's: a two-step run has two events, and its cost
 * is the sum of both. Taking the last event's numbers — the obvious reading —
 * undercounts every run that took more than one step, which is most of the
 * interesting ones.
 */
async function readTokens(
  outputFile: string,
): Promise<{
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cost: number
  steps: number
}> {
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cost: 0, steps: 0 }
  try {
    const raw = await Bun.file(outputFile).text()
    for (const line of raw.split("\n")) {
      if (!line.trim() || !line.includes("step_finish")) continue
      try {
        const event = JSON.parse(line) as {
          part?: {
            tokens?: {
              input?: number
              output?: number
              reasoning?: number
              cache?: { read?: number }
            }
            cost?: number
          }
        }
        const usage = event.part?.tokens
        if (!usage) continue
        tokens.steps += 1
        tokens.input += usage.input ?? 0
        tokens.output += usage.output ?? 0
        tokens.reasoning += usage.reasoning ?? 0
        tokens.cacheRead += usage.cache?.read ?? 0
        tokens.cost += event.part?.cost ?? 0
      } catch {
        // A line that is not JSON is not a step.
      }
    }
  } catch {
    // No output file.
  }
  return tokens
}

/**
 * Non-surface calls, retained as discoveryCalls for compatibility with old reports.
 * Includes search, shell task execution, and verification. This is a heuristic:
 * a wrapper containing the namespace is excluded even if it also does other work.
 * It cannot isolate discovery or establish why a model chose a path.
 */
async function readDiscovery(outputFile: string, ownPrefix: string): Promise<{
  discoveryCalls: number
  discoveryTools: Record<string, number>
}> {
  const result = { discoveryCalls: 0, discoveryTools: {} as Record<string, number> }
  try {
    const raw = await Bun.file(outputFile).text()
    for (const line of raw.split("\n")) {
      if (!line.trim() || !line.includes("tool_use")) continue
      try {
        const event = JSON.parse(line) as {
          part?: { tool?: string; state?: { input?: { code?: string } } }
        }
        const part = event.part
        if (!part) continue

        // A tool call has a `tool`; a shell command is a `tool` too, but with
        // a command rather than a code body. Both count as discovery if they
        // are not the surface's own tool.
        const tool = part.tool ?? "unknown"
        if (tool === "execute") {
          // Code Mode's wrapper. The inner call is named in the code, so the
          // wrapper is only a discovery step if the code is not the surface's.
          const code = part.state?.input?.code ?? ""
          if (code.includes(ownPrefix)) continue
        } else if (tool.startsWith(ownPrefix)) {
          continue
        }
        result.discoveryCalls += 1
        result.discoveryTools[tool] = (result.discoveryTools[tool] ?? 0) + 1
      } catch {
        // A line that is not JSON is not a call.
      }
    }
  } catch {
    // No output file.
  }
  return result
}

async function readCalls(callLogFile: string): Promise<RecordedCall[]> {
  try {
    const raw = await readFile(callLogFile, "utf8")
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as RecordedCall)
  } catch {
    return []
  }
}

/**
 * The surface a plugin declared.
 *
 * The two plugins write their surfaces in the **same format** — the file
 * format is a choice, and making it the same is what makes the surfaces
 * directly comparable.
 */
async function readSurface(surfaceFile: string): Promise<{
  schemaBytes: number
  toolCount: number
  /** The fingerprint of the rendered schemas. */
  fingerprint: string
}> {
  try {
    const tools = JSON.parse(await readFile(surfaceFile, "utf8")) as {
      tools: { name: string; description: string; input: unknown }[]
    }
    return {
      toolCount: tools.tools.length,
      schemaBytes: tools.tools.reduce(
        (sum, tool) => sum + Buffer.byteLength(tool.description) + Buffer.byteLength(JSON.stringify(tool.input)),
        0,
      ),
      fingerprint: fingerprintSurface(tools),
    }
  } catch {
    return { toolCount: 0, schemaBytes: 0, fingerprint: digest([]) }
  }
}

/**
 * Seed OPI's task store with the benchmark's board.
 *
 * The `opi` shape runs the product's own plugin, so the board has to be the
 * **same** board the other shapes see. The seeding is done by the same
 * script a person would run, so there is one definition of the board rather
 * than two that can drift apart.
 */
export async function seedOpiBoard(dir: string, dataDir: string): Promise<void> {
  const result = Bun.spawn(
    ["bun", "run", resolve(PACKAGE, "../../scripts/seed-bench-board.ts"), "--data-dir", dataDir, "--root", dir],
    {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPI_DATA_DIR: dataDir },
    },
  )
  const code = await result.exited
  if (code !== 0) {
    const message = await new Response(result.stderr).text()
    throw new Error(`The board could not be seeded: ${message.slice(0, 300)}`)
  }
}

/** Both SQLite arms use exactly this setup; the control registers no plugin. */
export async function prepareOpiBoard(dir: string, dataDir: string): Promise<void> {
  await seedOpiBoard(dir, dataDir)
  await writeFile(join(dir, "README.md"),
    `# benchmark fixture\n\nThe authoritative task board is in ${join(dataDir, "registry.sqlite")}.\n`, "utf8")
}

/**
 * Run one task against one shape, on a **private server**.
 *
 * The server is started in the run's own directory with the plugin
 * configured there, so the surface is exactly the one this run is measuring.
 */
export /**
 * Set when the OpenCode binary can no longer be launched. Every later run
 * would fail the same way, so the matrix stops instead of recording hundreds
 * of zero-step runs that look like data.
 */
let launchFailure: string | undefined

function isLaunchFailure(error: string | undefined): boolean {
  return !!error && (error.includes("posix_spawn") || error.includes("OpenCode binary is missing"))
}

export async function measure(shape: Shape, task: Task, model: string): Promise<RunMetrics> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `opi-bench-${shape}-`)))
  /**
   * Where this shape's plugin writes its call log and its surface.
   *
   * The fixture plugin writes both into the bench directory. The product's
   * plugin writes its surface into its data directory and its call log
   * wherever `OPI_CALL_LOG` says.
   *
   * The `opi` shape's files live **outside** the project directory, and that
   * matters: the first attempt put them inside it, and the model found them.
   * It ran `ls -la`, then `find .bench .opi-data`, then `cat
   * .opi-data/surface.json` — three extra steps per run, spent working out
   * which tool answers the question, because the instrumentation was lying in
   * the project it was measuring.
   *
   * A real install keeps its data outside the project too, so this is not
   * only fairer to the measurement — it is what the product actually does.
   */
  const isOpi =
    shape === "opi" ||
    shape === "opi-baseline" ||
    shape === "opi-baseline-guidance" ||
    shape === "opi-baseline-trigger" ||
    shape === "opi-split" ||
    shape === "opi-minimal" ||
    shape === "opi-minimal-wording" ||
    shape === "opi-minimal-guidance" ||
    shape === "opi-minimal-split"
  const usesOpiStore = isOpi || shape === "none-opi"
  /** The description wording this arm uses. */
  // The wording. The `baseline` is the pre-October-2026 wording.
  // The wording. The `baseline` is the pre-October-2026 wording, which did
  // not carry the tool's own name or the words people use.
  const descriptionVariant = ARM_LEVERS[shape]?.wording ?? "revised"
  /**
   * The guidance this arm uses.
   *
   * The `direct` guidance says what to **do**; the `baseline` guidance only
   * says what the tools are for. They are separate levers, and they are
   * measured separately.
   */
  // The guidance body. The `baseline` guidance is the pre-change one, which
  // says what the tools are for and never says to prefer them.
  const guidanceVariant = ARM_LEVERS[shape]?.guidance ?? "direct"
  /**
   * The skill's description, which decides whether the guide is loaded at
   * all.
   *
   * The control fires on "a concept, a symbol, a task or a decision" — none
   * of which the benchmark's questions contain. The `cards` variant fires on
   * the words people use.
   */
  const triggerVariant = shape === "opi-baseline-trigger" ? "baseline" : "cards"
  /**
   * The task tool's shape.
   *
   * `opi-split` is the arm the surface-shape experiment says is worse: one
   * tool per action, over the **same** SQLite store, with the same guard and
   * the same audit history. Only the interface differs.
   */
  // The tool structure. The `split` shape is one tool per action.
  const taskShape = ARM_LEVERS[shape]?.structure ?? "action"
  /**
   * The schema's size.
   *
   * `opi-minimal` carries the same tools, arguments, enums and behaviour,
   * with only the prose shortened. It is the arm that tests ADR-009's
   * premise — that a smaller surface costs less — with everything else held
   * constant.
   */
  const schemaSize = ARM_LEVERS[shape]?.size ?? "full"
  const scratch = await realpath(await mkdtemp(join(tmpdir(), `opi-bench-scratch-${shape}-`)))
  const benchDir = join(scratch, ".bench")
  const dataDir = join(scratch, ".opi-data")
  const callLogFile = isOpi ? join(scratch, "calls.ndjson") : join(benchDir, "calls.ndjson")
  const surfaceFile = isOpi ? join(dataDir, "surface.json") : join(benchDir, "tools.json")
  const started = Date.now()
  let cleanupChild: (() => Promise<void>) | undefined
  try {
    await mkdir(dir, { recursive: true })
    await mkdir(benchDir, { recursive: true })

    /**
     * The `opi` shape runs the **product's own plugin**, not a fixture.
     *
     * Two things differ, and both are the point:
     *
     * 1. The plugin is OPI's, so the surface is the one that ships — six
     *    tools, 32 actions, whatever it measures.
     * 2. The board is OPI's **task store**, seeded with the same five cards,
     *    because a surface measured against a different board is not
     *    comparable to one measured against this board.
     *
     * The seed uses the same resolver the plugin uses. A hand-rolled key
     * produces a plugin that reports an empty board with no error at all.
     */
    if (usesOpiStore) {
      await prepareOpiBoard(dir, dataDir)
    }


    // The plugin is configured in **this** directory, and the private server
    // reads it. The shared service does not load project-config plugins at
    // all (the compat doc, §12.3).
    await writeFile(
      join(dir, "opencode.jsonc"),
      `${JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          /**
           * The `skill` tool is **enabled**.
           *
           * A skill is loaded on demand, and the `skill` tool is how. Without
           * it, OPI's guidance is never delivered — the guide exists in the
           * plugin and the model has no way to reach it.
           *
           * This is why the guidance ablation measured nothing: the harness
           * had the skill registered and the skill **tool** switched off, so
           * no arm could ever load it. Both arms were equally blind, which is
           * what a null result looks like when the treatment never arrives.
           */
          agent: { build: { tools: { skill: true } } },
          plugins: shape === "none-opi" ? [] : [
            isOpi
              ? {
                  package: OPI_PLUGIN,
                  options: {
                    descriptionVariant,
                    guidanceVariant,
                    triggerVariant,
                    taskShape,
                    schemaSize,
                  },
                }
              : {
                  package: PACKAGE,
                  options: {
                    taskShape: shape,
                    benchDir,
                    namespace: BENCH_NAMESPACE,
                  },
                },
          ],
          /**
           * The local models need their **reasoning turned off**.
           *
           * `ornith-1.5:9b` thinks by default, and it thinks slowly: a
           * 141-token response took 81 seconds, and one run took 644. With
           * the toggle off the same call takes 11 seconds.
           *
           * The switch is the model's own reasoning config. The provider's
           * `options.think` does not work — it made the model call the tool
           * five times instead of once.
           */
          ...(localModelOf(model) ? localModelConfig(localModelOf(model)!) : {}),
        },
        null,
        2,
      )}\n`,
      "utf8",
    )
    if (!usesOpiStore) await writeFile(join(dir, "README.md"), "# benchmark fixture\n", "utf8")

    // SQLite comparison: identical seed and locator, no JSON fallback in either arm.
    // The existing fixture comparison remains a separate, legacy experiment.
    if (!usesOpiStore) {
      // The board comes from the **shared** definition, so the fixture arms
      // and the SQLite arms see the same cards in the same states with the
      // same priorities. They did not: the fixture had a `todo` column and
      // different priorities, and a surface could "win" on a board it found
      // easier.
      await writeFile(join(dir, "board.json"), `${JSON.stringify(boardJson(), null, 2)}\n`, "utf8")
    }

    const before: Snapshot = usesOpiStore
      ? snapshot(join(dataDir, "registry.sqlite"))
      : boardSnapshot()
    const prompt = taskPrompt(task)
    const promptHash = new Bun.CryptoHasher("sha256").update(prompt).digest("hex")
    await writeFile(join(scratch, "before.json"), JSON.stringify(before, null, 2))

    // The private server. It is started in this directory, so it loads this
    // directory's plugin configuration and nothing else.
    // The child's output goes to a **file**, not a pipe. A piped stream that
    // is never read fills its buffer and blocks the process — which looks
    // exactly like a run that did nothing.
    const outputFile = join(scratch, "run-output.txt")
    // The output goes to a **file**, through a file descriptor. A piped
    // stream that is never read fills its buffer and blocks the process —
    // which looks exactly like a run that did nothing.
    // Desktop updates can remove a versioned binary while a matrix is running.
    // Re-resolve each run; --opencode / OPENCODE_BIN still pins an explicit path.
    const opencode = findOpencode()
    const fileHandle = await open(outputFile, "w")
    cleanupChild = async () => { await fileHandle.close().catch(() => {}) }
    const child = Bun.spawn(
      [opencode, "run", "--standalone", "--model", model, "--format", "json", prompt],
      {
        cwd: dir,
        stdout: fileHandle.fd,
        stderr: fileHandle.fd,
        env: {
          ...process.env,
          /**
           * `PWD` has to be set explicitly.
           *
           * `Bun.spawn`'s `cwd` sets the working directory but leaves `PWD`
           * pointing at the parent, and OpenCode resolves the **project**
           * configuration from `PWD`. Without this the run finds no plugin
           * configuration, loads nothing, and the model answers from the
           * filesystem — which looks exactly like a run that did nothing.
           */
          PWD: dir,
          OPI_BENCH_NAMESPACE: BENCH_NAMESPACE,
          /**
           * The `opi` shape runs the product's plugin, which keeps its task
           * store and its index in the data directory. It gets its own, so
           * a run cannot see another run's board.
           */
          ...(usesOpiStore
            ? {
                OPI_DATA_DIR: dataDir,
                /**
                 * The call log. The product's plugin counts its own calls,
                 * the same way the fixture does, so the three surfaces are
                 * measured the same way.
                 */
                OPI_CALL_LOG: callLogFile,
              }
            : {}),
          /**
           * A **clean** configuration directory.
           *
           * A standalone server loads the user's global plugins as well as
           * the project's, and the model prefers whichever tool suits it. With
           * the product's own plugins in the catalog, the model answered the
           * benchmark's questions with the *product's* tools, and the
           * benchmark measured nothing.
           *
           * Pointing `XDG_CONFIG_HOME` at an empty directory means only the
           * run's own project configuration is loaded — which is what a
           * benchmark needs: one surface, measured.
           */
          XDG_CONFIG_HOME: join(dir, ".bench-config"),
        },
      },
    )

    cleanupChild = async () => {
      if (!child.killed) child.kill()
      await child.exited.catch(() => {})
      await fileHandle.close().catch(() => {})
    }

    // The plugin writes its calls as they happen, so the log is read after
    // the run rather than after the server exits.
    // A trace, so a failed run is visible rather than silent.
    const trace = (message: string): void => {
      if (process.env.OPI_BENCH_TRACE) process.stderr.write(`      [trace] ${message}\n`)
    }
    trace(`spawned in ${dir}`)

    const deadline = Date.now() + 180_000
    let exitCode: number | undefined
    let exitedNormally = false
    let calls: RecordedCall[] = []
    while (Date.now() < deadline) {
      calls = await readCalls(callLogFile)
      // `child.exited` **rejects** when the process is killed, so it is
      // caught. A rejection here would end the run silently.
      const exited = await Promise.race([
        child.exited.then(
          (code) => { exitCode = code; return true },
          () => true,
        ),
        sleep(500).then(() => false),
      ])
      if (exited) { exitedNormally = true; break }
    }

    /**
     * The trace is read **after** the child has exited, but the child's last
     * event is not written when it exits.
     *
     * The CLI emits the model's final `step_finish` — the one that carries
     * the closing answer's **usage and cost** — after the model has
     * answered, and it can lose the race with the process exit. Every trace
     * read immediately on exit was therefore missing its final priced step:
     * 36 of 36 runs came back with incomplete billing, and
     * `costPerSuccessfulTask` was withheld for every cell because of it.
     *
     * The fix is to wait for the trace to stop growing before reading it.
     * The answer itself was always there — `extractAnswer` found it — but
     * without the closing `step_finish` there was no price for it.
     */
    await cleanupChild()
    cleanupChild = undefined
    // Give the plugin a moment to flush its last call.
    await sleep(500)
    calls = await readCalls(callLogFile)

    // Wait for the trace to settle: the file stops growing when the CLI has
    // flushed everything it has.
    const settleDeadline = Date.now() + 5_000
    let lastSize = -1
    while (Date.now() < settleDeadline) {
      const size = (await Bun.file(outputFile).exists()) ? (await Bun.file(outputFile).arrayBuffer()).byteLength : 0
      if (size === lastSize && size > 0) break
      lastSize = size
      await sleep(250)
    }
    const output = await Bun.file(outputFile).text().catch(() => "")
    trace(`read ${calls.length} calls; output: ${output.slice(-300)}`)

    const surface =
      shape === "none-opi"
        ? { toolCount: 0, schemaBytes: 0, fingerprint: digest([]) }
        : await readSurface(surfaceFile)
    const tokens = await readTokens(outputFile)

    /**
     * Whether the run is **valid**.
     *
     * A run that never launched, timed out, or produced nothing is not a
     * cheap answer — it is no answer. It is kept in the raw data and in
     * `runHealth`, and excluded from the completed-run statistics, so that
     * a broken harness cannot look like an efficient surface.
     */
    const childExitError = !exitedNormally
      ? "Run timed out after 180 seconds"
      : exitCode !== 0
        ? `OpenCode exited with code ${exitCode ?? "unknown"}`
        : tokens.steps === 0
          ? "No completed model steps recorded"
          : shape !== "none-opi" && !existsSync(surfaceFile)
            ? "Plugin surface was not recorded"
            : surface.toolCount !== expectedToolCount(shape)
              ? "Unexpected registered tool count"
              : undefined

    /**
     * The verdict on the answer.
     *
     * The **final answer** is graded, not the tool output and not the
     * intermediate reasoning: the tool output is the surface's account of
     * itself, and the reasoning is the model's account of its own thinking.
     * Neither is what the user would see.
     */
    const extracted = extractAnswer(output)
    let after: Snapshot | undefined
    let verdict: Verdict
    /**
     * The **format** of the answer, reported beside the grade.
     *
     * It is not part of the grade. A model that answers correctly in prose
     * has answered correctly, and a metric that calls that a failure is
     * measuring the wrong thing.
     */
    let format:
      | {
          grade: string
          format: string
          formatCompliant: boolean
          reasons: string[]
        }
      | undefined
    if (childExitError) verdict = unknown(childExitError)
    else {
      try {
        if (usesOpiStore) after = snapshot(join(dataDir, "registry.sqlite"))
        if (READ_IDS.includes(task.id)) {
          /**
           * The content grade is the grade.
           *
           * The old grader required a bare JSON object and reported every
           * other shape as ungradable. Across the retained reports, 48 of
           * 75 ungradable read answers failed on that requirement alone:
           * the content was right and the format was not. So the content
           * grader decides, and the old grade is kept beside it as the
           * **format** metric — the thing the old grader was really
           * measuring.
           */
          const content = gradeContent({
            task: task.id,
            answer: extracted.text,
            before,
            prompt: task.prompt,
          })
          const contract = extracted.reason
            ? unknown(extracted.reason)
            : gradeRead(task.id, extracted.text, before)
          verdict = {
            grade: content.grade,
            reasons: content.reasons.length ? content.reasons : contract.reasons,
          }
          format = {
            grade: contract.grade,
            format: content.format,
            formatCompliant: content.formatCompliant,
            reasons: contract.reasons,
          }
          if (after && JSON.stringify(before) !== JSON.stringify(after)) {
            verdict = { grade: "failed", reasons: ["read task mutated authoritative state"] }
          }
        } else {
          verdict = after ? gradeWrite(task.id, before, after) : unknown("legacy fixture writes lack an authoritative SQLite store")
          if (extracted.reason === "runtime emitted an error event") verdict = unknown(extracted.reason)
        }
      } catch (error) { verdict = unknown(`cannot inspect final store: ${(error as Error).message}`) }
    }
    const evidence = { before, after, answer: extracted.text, extractionReason: extracted.reason, promptHash }
    await writeFile(join(scratch, "outcome.json"), JSON.stringify({ verdict, evidence }, null, 2))
    /**
     * The authoritative cost.
     *
     * The CLI's own output does not price the final answer, so the trace's
     * sum is a lower bound. The runtime's session store has the whole cost,
     * and it is consulted here.
     *
     * A run whose cost could not be fully recovered is reported as such, and
     * the cost-per-success claim is withheld for the cell that contains it.
     */
    /**
     * The authoritative cost, **including for a run that did not complete**.
     *
     * A timed-out run spent real money, and that spend is in the runtime's
     * session store if the run got far enough to be billed. Recording it
     * as $0 would make a failing arm look cheap — which is exactly the
     * failure mode the end-to-end metric exists to catch.
     *
     * The store is consulted whenever the run reported a session id, and
     * the result is marked incomplete if the run did not finish, because a
     * run that was cut off may have been billed for work the trace never
     * showed.
     */
    const billing = authoritativeCost({ sessionId: extracted.sessionId, output })
    if (childExitError && billing.source === "store") {
      // The spend was recovered, but the run did not complete, so the
      // figure may be a lower bound: the run was cut off mid-flight.
      billing.complete = false
      billing.reason = `the run did not complete (${childExitError}); the recovered spend may be a lower bound`
    } else if (childExitError && billing.source !== "store") {
      // Nothing was recovered, so the spend is **unknown**, not zero.
      billing.reason = `the run did not complete (${childExitError}) and no session id was reported, so its spend could not be recovered`
    }
    const usageComplete = billing.complete
    // The discovery steps are measured against the surface's own namespace.
    // The `none` shape has no namespace, so every call is a discovery step —
    // which is exactly right: with no tool, the model is entirely discovery.
    const ownPrefix = shape === "none" || shape === "none-opi" ? "__no_surface__." : isOpi ? "pi." : `${BENCH_NAMESPACE}.`
    const discovery = await readDiscovery(outputFile, ownPrefix)
    const durationMs = Date.now() - started


    const failedCalls = calls.filter((call) => !call.ok).length
    return {
      model,
      shape,
      task,
      calls,
      totalCalls: calls.length,
      failedCalls,
      discoveryCalls: discovery.discoveryCalls,
      discoveryTools: discovery.discoveryTools,
      tokens,
      schemaBytes: surface.schemaBytes,
      toolCount: surface.toolCount,
      /** The fingerprint of the rendered surface. */
      surfaceFingerprint: surface.fingerprint,
      durationMs,
      error: childExitError,
      verdict, usageComplete, evidence, billing, format,
    }
  } catch (error) {
    if (process.env.OPI_BENCH_TRACE) {
      process.stderr.write(`      [trace] FAILED: ${(error as Error).message}\n`)
    }
    return {
      model,
      shape,
      task,
      calls: [],
      totalCalls: 0,
      failedCalls: 0,
      discoveryCalls: 0,
      discoveryTools: {},
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cost: 0, steps: 0 },
      schemaBytes: 0,
      toolCount: 0,
      surfaceFingerprint: digest([]),
      durationMs: Date.now() - started,
      error: (error as Error).message,
      usageComplete: false,
      billing: { cost: 0, complete: false, source: "none", reason: (error as Error).message },
      format: undefined,
      verdict: { grade: "ungradable", reasons: [`the run did not complete: ${(error as Error).message}`] },
    }
  } finally {
    await cleanupChild?.()
    if (KEEP) process.stderr.write(`    kept: ${dir} (artifacts: ${scratch})\n`)
    else await rm(dir, { recursive: true, force: true })
    if (!KEEP) await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

/** What one shape cost, across its runs. */
export interface ShapeSummary {
  runs: number
  completedRuns: number
  invalidRuns: number
  /**
   * The success metrics.
   *
   * The cost figures are only meaningful next to these. A surface that
   * gives up cheaply looks cheap, and a surface that answers correctly
   * slowly looks expensive.
   */
  success: {
    /** Runs whose answer was correct. */
    passed: number
    /** Runs whose answer was wrong. */
    failed: number
    /** Runs with no answer to grade. */
    ungradable: number
    /** The runs that were attempted. The denominator of the end-to-end rate. */
    attempted: number
    /** The runs that executed. The denominator of the content accuracy. */
    validRuns: number
    /** The runs that did not execute. */
    invalidRuns: number
    /**
     * **Content accuracy**: correct answers over the runs that executed.
     *
     * A run that timed out has no answer to be right or wrong about, so it
     * is not in this denominator.
     */
    contentAccuracy: number | null
    /**
     * **End-to-end success**: correct completions over every run attempted.
     *
     * The execution failures are in the denominator, because the user asked
     * for an answer and did not get one.
     */
    successRate: number | null
    /** Conditional accuracy among runs with a graded answer. */
    gradedSuccessRate: number | null
    /**
     * **Execution failure rate**: the runs that did not execute, over every
     * run attempted.
     */
    executionFailureRate: number | null
    /**
     * The spend of **every attempt**, divided by the number of successes.
     *
     * Failed attempts are included on purpose. A surface that abandons a
     * task after one step has spent nothing and produced nothing, and a
     * per-success cost that ignored the attempt would report that as
     * efficient.
     */
    costPerSuccessfulTask: number | null
    /**
     * The bootstrap interval for the cost per successful task.
     *
     * The point estimate is not enough. The ratio is computed over a
     * handful of runs whose cost varies by an order of magnitude, and a
     * difference between two arms can easily be the spread within one arm.
     * The interval is what says whether a difference is real.
     */
    costPerSuccessfulTaskInterval: {
      estimate: number | null
      low: number | null
      high: number | null
      samples: number
    }
    /**
     * The spend of every attempt, in total.
     *
     * The authoritative figure: the runtime's session store, which prices
     * the final answer that the CLI's trace does not.
     */
    totalSpend: number
    /** The spend the CLI's own trace carried. A lower bound. */
    traceSpend: number
    /** How many runs' billing was not fully recovered. */
    incompleteUsageRuns: number
    /**
     * The cost per successful answer, over the **measured** spend.
     *
     * A lower bound when the billing is incomplete.
     */
    measuredCostPerSuccessfulTask: number | null
  }
  toolCount: number
  schemaBytes: number
  totalCalls: number
  totalFailedCalls: number
  runsWithCalls: number
  runsWithMalformedCalls: number
  callsPerRun: { min: number; median: number; max: number }
  stepsPerRun: { min: number; median: number; max: number }
  discoveryPerRun: { min: number; median: number; max: number; total: number }
  costPerRun: { min: number; median: number; max: number; total: number }
  tokensPerRun: Record<string, { min: number; median: number; max: number }>
  medianDurationMs: number
}

/**
 * Outcome accounting includes invalid runs, even when the entire cell failed.
 *
 * ## The three things, kept apart
 *
 * - **Execution** — did the run complete? A run that did not is *invalid*,
 *   and is reported as such rather than counted as a failure.
 * - **Answer** — was the answer correct? The grader's business.
 * - **Billing** — is the recorded spend the whole cost?
 *
 * A run that answered correctly but whose cost was not fully recovered is a
 * different thing from one that did not answer, and the two are never added
 * together.
 *
 * ## The cost-per-success denominator
 *
 * The numerator is the spend of **every attempt** — the successful ones, the
 * failed ones, and the ones that timed out. Including the failures is what
 * stops a surface that abandons a task after one step from looking cheap.
 *
 * The denominator is the number of **successful** answers. A run that was
 * never graded contributes to the numerator and not to the denominator.
 *
 * `costPerSuccessfulTask` is **withheld** unless every run's billing is
 * complete, because a partial spend is a lower bound and a lower bound
 * presented as the cost is a wrong number. `measuredCostPerSuccessfulTask`
 * carries the lower bound, and is labelled as one.
 */
export function summariseOutcomes(runs: RunMetrics[]): ShapeSummary["success"] {
  // The four metrics, kept apart. Each answers a different question, and
  // they are not interchangeable.
  //
  // - **Content accuracy** — of the runs that *executed*, how many were
  //   correct? A run that timed out has no answer to be right or wrong
  //   about, so it is not in this denominator.
  // - **End-to-end success** — of the runs that were *attempted*, how many
  //   produced a correct answer? The execution failures are in this
  //   denominator, because the user asked for an answer and did not get one.
  // - **Execution failure rate** — of the runs that were attempted, how many
  //   failed to execute? This is what keeps an unreliable arm from looking
  //   successful on the first metric.
  // - **Cost per successful task** — the spend of *every* attempt over the
  //   number of correct completions. A run that failed after spending is
  //   still money spent.
  //
  // Excluding execution failures from every denominator would make a
  // surface that answers well when it answers at all look better than one
  // that answers reliably. The metrics are separate for that reason.
  const attempted = runs.length
  const valid = runs.filter(run => !run.error)
  const invalid = attempted - valid.length
  const passed = valid.filter(run => run.verdict.grade === "passed").length
  const failed = valid.filter(run => run.verdict.grade === "failed").length
  const ungradable = valid.length - passed - failed
  // The billing completeness, and the spend, come from the **authoritative**
  // record: the runtime's session store, which prices the final answer that
  // the CLI's own trace does not.
  const incompleteUsageRuns = runs.filter(run => run.billing?.complete !== true).length
  const totalSpend = runs.reduce((sum, run) => sum + (run.billing?.cost ?? run.tokens.cost), 0)
  // The spend the trace itself carried, for comparison.
  const traceSpend = runs.reduce((sum, run) => sum + run.tokens.cost, 0)
  const interval = costPerSuccessInterval(
    runs.map(run => ({
      passed: !run.error && run.verdict.grade === "passed",
      cost: run.billing?.cost ?? run.tokens.cost,
      billingComplete: run.billing?.complete === true,
    })),
  )
  return {
    passed, failed, ungradable,
    /** The runs that were attempted. The denominator of the end-to-end rate. */
    attempted,
    /** The runs that executed. The denominator of the content accuracy. */
    validRuns: valid.length,
    /** The runs that did not execute. */
    invalidRuns: invalid,
    /**
     * **Content accuracy**: correct answers over the runs that executed.
     *
     * A run that timed out has no answer to be right or wrong about.
     */
    contentAccuracy: valid.length ? passed / valid.length : null,
    /**
     * **End-to-end success**: correct completions over every run attempted.
     *
     * The execution failures are in the denominator, because the user asked
     * for an answer and did not get one. This is the rate that does not let
     * a surface answer well only when it answers at all.
     */
    successRate: attempted ? passed / attempted : null,
    /** The rate among the runs that produced a graded answer. */
    gradedSuccessRate: passed + failed ? passed / (passed + failed) : null,
    /**
     * **Execution failure rate**: the runs that did not execute, over every
     * run attempted.
     */
    executionFailureRate: attempted ? invalid / attempted : null,
    costPerSuccessfulTaskInterval: interval,
    totalSpend,
    /** The spend the CLI's own trace carried. A lower bound. */
    traceSpend,
    incompleteUsageRuns,
    measuredCostPerSuccessfulTask: passed ? totalSpend / passed : null,
    costPerSuccessfulTask: passed && !incompleteUsageRuns ? totalSpend / passed : null,
  }
}

export function summarise(runs: RunMetrics[]): Record<string, ShapeSummary> {
  const byShape = new Map<Shape, RunMetrics[]>()
  for (const run of runs) {
    const list = byShape.get(run.shape) ?? []
    list.push(run)
    byShape.set(run.shape, list)
  }
  const summary: Record<string, ShapeSummary> = {}
  for (const [shape, attempted] of byShape) {
    const list = attempted.filter((run) => !run.error)
    if (!list.length) continue // Invalid runs remain in raw data and runHealth, not cost statistics.
    const total = (key: (run: RunMetrics) => number) => list.reduce((sum, run) => sum + key(run), 0)
    const callCounts = list.map((run) => run.totalCalls).sort((a, b) => a - b)
    /**
     * The success metrics.
     *
     * The cost figures below are only meaningful next to these. A surface
     * that gives up cheaply looks cheap, and a surface that answers
     * correctly slowly looks expensive.
     */
    summary[shape] = {
      runs: attempted.length,
      success: summariseOutcomes(attempted),
      completedRuns: list.length,
      invalidRuns: attempted.length - list.length,
      totalCalls: total((run) => run.totalCalls),
      totalFailedCalls: total((run) => run.failedCalls),
      runsWithMalformedCalls: list.filter((run) => run.failedCalls > 0).length,
      /**
       * How many runs made at least one call. A shape where this is 0 was
       * never reached, which is different from a shape the model chose not
       * to use.
       */
      runsWithCalls: list.filter((run) => run.totalCalls > 0).length,
      /**
       * The spread of calls per run. A shape that is sometimes 0 and
       * sometimes 5 is noisy; the median alone would hide that.
       */
      callsPerRun: {
        min: callCounts[0] ?? 0,
        median: callCounts[Math.floor(callCounts.length / 2)] ?? 0,
        max: callCounts[callCounts.length - 1] ?? 0,
      },
      /**
       * The discovery cost.
       *
       * The calls the model made that were not this surface's own tools:
       * reaching for the wrong tool, running a shell command to look for the
       * board, searching the tool catalog. This is what a surface that the
       * model cannot read at a glance costs, and it is **not** visible in the
       * surface's own call log.
       */
      discoveryPerRun: {
        min: Math.min(...list.map((run) => run.discoveryCalls)),
        median: [...list.map((run) => run.discoveryCalls)].sort((a, b) => a - b)[
          Math.floor(list.length / 2)
        ] ?? 0,
        max: Math.max(...list.map((run) => run.discoveryCalls)),
        total: list.reduce((sum, run) => sum + run.discoveryCalls, 0),
      },
      /**
       * The token cost, per run. The **input** tokens are the ones the
       * surface's schema drives: every request carries the tool
       * definitions, so a smaller surface means fewer input tokens on
       * every turn.
       */
      tokensPerRun: {
        input: {
          min: Math.min(...list.map((run) => run.tokens.input)),
          median: [...list.map((run) => run.tokens.input)].sort((a, b) => a - b)[
            Math.floor(list.length / 2)
          ] ?? 0,
          max: Math.max(...list.map((run) => run.tokens.input)),
        },
        output: {
          min: Math.min(...list.map((run) => run.tokens.output)),
          median: [...list.map((run) => run.tokens.output)].sort((a, b) => a - b)[
            Math.floor(list.length / 2)
          ] ?? 0,
          max: Math.max(...list.map((run) => run.tokens.output)),
        },
        cacheRead: {
          min: Math.min(...list.map((run) => run.tokens.cacheRead)),
          median: [...list.map((run) => run.tokens.cacheRead)].sort((a, b) => a - b)[
            Math.floor(list.length / 2)
          ] ?? 0,
          max: Math.max(...list.map((run) => run.tokens.cacheRead)),
        },
      },
      /**
       * The **cost** of the run, and how many model steps it took.
       *
       * The cost is the number that decides: schema overhead is a
       * round-trip cost, but it is paid on every request, and the run's
       * total is what a user actually pays.
       */
      costPerRun: {
        min: Math.min(...list.map((run) => run.tokens.cost)),
        median: [...list.map((run) => run.tokens.cost)].sort((a, b) => a - b)[
          Math.floor(list.length / 2)
        ] ?? 0,
        max: Math.max(...list.map((run) => run.tokens.cost)),
        total: list.reduce((sum, run) => sum + run.tokens.cost, 0),
      },
      stepsPerRun: {
        min: Math.min(...list.map((run) => run.tokens.steps)),
        median: [...list.map((run) => run.tokens.steps)].sort((a, b) => a - b)[
          Math.floor(list.length / 2)
        ] ?? 0,
        max: Math.max(...list.map((run) => run.tokens.steps)),
      },
      schemaBytes: list[0]?.schemaBytes ?? 0,
      toolCount: list[0]?.toolCount ?? 0,
      medianDurationMs:
        [...list].sort((a, b) => a.durationMs - b.durationMs)[Math.floor(list.length / 2)]?.durationMs ?? 0,
    }
  }
  return summary
}

/**
 * The schedule.
 *
 * ## Why it is randomised
 *
 * The runs used to be scheduled in **arm blocks**: every run of one arm,
 * then every run of the next. That makes the arm and the position in the
 * run correlate, and the position in the run correlates with the
 * provider's cache state, its rate limit, and its own load. A difference
 * between two arms could then be a difference in *when* they ran, and the
 * reports had no way to tell.
 *
 * The schedule is now a **seeded randomisation** of the whole matrix, with
 * the seed persisted in the report. The same seed gives the same schedule,
 * so a run can be repeated exactly; and different arms are interleaved, so
 * no arm sits entirely inside one provider state.
 *
 * The seed is a **block** seed: the matrix is cut into blocks, and each
 * block is randomised. That keeps the arms balanced **within** every
 * block, so a provider hiccup that hits one block hits every arm in it.
 */
export function buildSchedule(options: {
  models: string[]
  shapes: string[]
  tasks: { id: string }[]
  repeats: number
  seed: number
  block: number
}): { model: string; shape: string; task: string; repeat: number }[] {
  const random = seededRandom(options.seed)
  const cells: { model: string; shape: string; task: string }[] = []
  for (const model of options.models) {
    for (const shape of options.shapes) {
      for (const task of options.tasks) cells.push({ model, shape, task: task.id })
    }
  }
  const blocks = Math.ceil(options.repeats / options.block)
  const work: { model: string; shape: string; task: string; repeat: number }[] = []
  for (let block = 0; block < blocks; block++) {
    const blockRuns: { model: string; shape: string; task: string; repeat: number }[] = []
    const firstRepeat = block * options.block
    const lastRepeat = Math.min((block + 1) * options.block, options.repeats)
    // The block's runs: every cell, once per repeat in the block.
    //
    // The repeats within a block are **interleaved**, not run in sequence:
    // the first repeat of every cell, then the second repeat of every
    // cell. A block therefore holds one run per cell per repeat, and the
    // arms stay balanced across the whole block.
    for (let offset = 0; offset < lastRepeat - firstRepeat; offset++) {
      for (const cell of cells) blockRuns.push({ ...cell, repeat: firstRepeat + offset })
    }
    for (let index = blockRuns.length - 1; index > 0; index--) {
      const swap = Math.floor(random() * (index + 1))
      const held = blockRuns[index]!
      blockRuns[index] = blockRuns[swap]!
      blockRuns[swap] = held
    }
    work.push(...blockRuns)
  }
  return work
}

if (import.meta.main) {
if (!Number.isInteger(REPEATS) || REPEATS < 1) throw new Error("--repeats must be a positive integer")
const requestedShapes = arg("--shapes")?.split(",")
if (requestedShapes?.some(shape => !SHAPES.includes(shape as Shape))) throw new Error("Unknown benchmark shape")
const tasks = (await loadTasks()).filter((task) => !ONLY_TASKS || ONLY_TASKS.includes(task.id))
if (!tasks.length || !MODELS.length) throw new Error("No tasks or models selected")
const shapes = ONLY_SHAPES?.length ? ONLY_SHAPES : SHAPES
const runs: RunMetrics[] = []

/**
 * How many runs go at once.
 *
 * The runs are fully isolated: each has its own project directory, its own
 * scratch directory, its own `XDG_CONFIG_HOME` and its own `OPI_DATA_DIR`.
 * Nothing is shared, so they can run concurrently.
 *
 * The bound is not about the server — it is about the **provider's** rate
 * limit. Too many at once and the calls start failing, and a failed call
 * looks like a malformed call, and the measurement is then wrong rather than
 * slow.
 */
const CONCURRENCY = Number(arg("--concurrency", "4"))
if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1) throw new Error("--concurrency must be a positive integer")

/** The seed, from the command line, or a fixed one. */
const SEED = Number(arg("--seed") ?? "20261021")
/** How many cells one block holds. */
const BLOCK = Number(arg("--block") ?? "2")

/** The schedule, as it is run. */
const work: { model: string; shape: Shape; task: Task; repeat: number }[] = []
{
  const scheduled = buildSchedule({
    models: [...MODELS],
    shapes: [...shapes],
    tasks,
    repeats: REPEATS,
    seed: SEED,
    block: BLOCK,
  })
  for (const entry of scheduled) {
    const task = tasks.find(candidate => candidate.id === entry.task)
    if (!task) continue
    work.push({ model: entry.model, shape: entry.shape as Shape, task, repeat: entry.repeat })
  }
}

let finished = 0
let next = 0
const workers = Array.from({ length: Math.min(CONCURRENCY, work.length) }, async () => {
  while (true) {
    if (launchFailure) return
    const index = next++
    if (index >= work.length) return
    const item = work[index]!
    const run = await measure(item.shape, item.task, item.model)
    if (isLaunchFailure(run.error)) {
      launchFailure ??= run.error
      process.stderr.write(`  ABORTING: ${run.error}\n`)
      continue // Not recorded: a run that never launched measured nothing.
    }
    runs.push(run)
    finished += 1
    process.stderr.write(
      `  [${finished}/${work.length}] ${item.model} ${item.shape} / ${item.task.id} ... ` +
        `${run.totalCalls} calls, ${run.failedCalls} failed, ${run.toolCount} tools\n`,
    )
  }
})
await Promise.all(workers)

/**
 * The report.
 *
 * The summary is **per model**, because the models disagree and the
 * disagreement is the finding. A single pooled summary would average away the
 * thing worth knowing: that one model reached the board tool in 23 runs out
 * of 30 and another in 10.
 */
const byModel: Record<string, ReturnType<typeof summarise>> = {}
for (const model of MODELS) {
  byModel[model] = summarise(runs.filter((run) => run.model === model))
}

const report = {
  models: MODELS,
  opencode: findOpencode(),
  /** Set when the matrix stopped early because OpenCode could not launch. */
  aborted: launchFailure,
  plannedRuns: work.length,
  attemptedRuns: runs.length,
  repeats: REPEATS,
  /**
   * The `none` shape is the **control**: the plugin registers no tools, so
   * the model has to answer from the filesystem. It is the baseline the
   * other two are read against — without it, "0 calls" is uninterpretable.
   */
  reportVersion: 5,
  oracleVersion: OUTCOME_VERSION,
  /**
   * The content grader's version and fingerprint.
   *
   * Two reports may only be compared when their grader fingerprints
   * match. The fingerprint covers the version, the frozen rules, and the
   * per-task expectations.
   */
  contentGrader: {
    version: CONTENT_GRADER_VERSION,
    fingerprint: graderFingerprint(),
  },
  /**
   * The fingerprints.
   *
   * A report without them cannot be tied to the code that produced it, and
   * a number without a fingerprint is a number nobody can reproduce.
   */
  fingerprints: {
    /** The harness's own source. */
    source: await sourceFingerprint(),
    /** The rendered surface, per shape, from the plugin's own record. */
    surfaces: Object.fromEntries(
      shapes.map(shape => {
        const cell = runs.filter(run => run.shape === shape && run.surfaceFingerprint)
        const distinct = new Set(cell.map(run => run.surfaceFingerprint))
        return [
          shape,
          {
            fingerprint: distinct.size === 1 ? [...distinct][0] : [...distinct],
            distinctRenderings: distinct.size,
          },
        ]
      }),
    ),
    /** The prompt, per task. */
    prompts: Object.fromEntries(tasks.map(task => [task.id, fingerprintPrompt(taskPrompt(task))])),
    /** The runtime that was used. */
    runtime: await runtimeIdentity(findOpencode()),
  },
  /**
   * The schedule.
   *
   * The seed makes the schedule reproducible; the block size makes the
   * arms balanced within each block.
   */
  schedule: {
    seed: SEED,
    block: BLOCK,
    randomised: true,
    /** The schedule, in order. */
    order: work.map(entry => ({
      model: entry.model,
      shape: entry.shape,
      task: entry.task.id,
      repeat: entry.repeat,
    })),
  },
  controls: { fixture: "none", sqlite: "none-opi" },
  comparisons: { sqlite: ["opi", "none-opi"], legacyFixture: ["actions", "separate", "none"] },
  outcomeValidation: "Structured read answers are compared with the pre-run snapshot. Supported SQLite writes require state and audit evidence; unsupported tasks are ungradable.",
  outcomes: MODELS.flatMap(model => shapes.flatMap(shape => tasks.map(task => {
    const cell = runs.filter(run => run.model === model && run.shape === shape && run.task.id === task.id)
    // The summary carries its own `attempted`, `validRuns` and `invalidRuns`.
    return { model, shape, task: task.id, ...summariseOutcomes(cell) }
  }))),
  /**
   * The arm-to-arm comparisons, with the uncertainty.
   *
   * Each comparison is between the two arms' **bootstrap intervals** for
   * the cost per successful task, and the verdict is the pre-registered
   * rule: overlapping intervals mean the difference is **not resolved**.
   *
   * The comparisons are declared, not discovered. The availability pair
   * (`opi` against `none-opi`) is a **different experiment** from the
   * interface pair, and they are reported separately.
   */
  armComparisons: {
    /** Product availability: the product against a matched control. */
    availability: MODELS.map(model => {
      const product = summariseOutcomes(runs.filter(run => run.model === model && run.shape === "opi"))
      const control = summariseOutcomes(runs.filter(run => run.model === model && run.shape === "none-opi"))
      return {
        model,
        product: product.costPerSuccessfulTaskInterval,
        control: control.costPerSuccessfulTaskInterval,
        correctness: {
          product: { passed: product.passed, failed: product.failed, ungradable: product.ungradable },
          control: { passed: control.passed, failed: control.failed, ungradable: control.ungradable },
        },
        ...compareCostPerSuccess(product.costPerSuccessfulTaskInterval, control.costPerSuccessfulTaskInterval),
      }
    }),
    /** The size arm: the minimal schema against the shipping one. */
    size: MODELS.map(model => {
      const minimal = summariseOutcomes(runs.filter(run => run.model === model && run.shape === "opi-minimal"))
      const full = summariseOutcomes(runs.filter(run => run.model === model && run.shape === "opi"))
      return {
        model,
        minimal: minimal.costPerSuccessfulTaskInterval,
        full: full.costPerSuccessfulTaskInterval,
        correctness: {
          minimal: { passed: minimal.passed, failed: minimal.failed, ungradable: minimal.ungradable },
          full: { passed: full.passed, failed: full.failed, ungradable: full.ungradable },
        },
        ...compareCostPerSuccess(minimal.costPerSuccessfulTaskInterval, full.costPerSuccessfulTaskInterval),
      }
    }),
    /** The wording arm, on whichever surface the run used. */
    wording: MODELS.map(model => {
      const baseline = summariseOutcomes(runs.filter(run => run.model === model && run.shape === "opi-baseline"))
      const revised = summariseOutcomes(runs.filter(run => run.model === model && run.shape === "opi"))
      return {
        model,
        baseline: baseline.costPerSuccessfulTaskInterval,
        revised: revised.costPerSuccessfulTaskInterval,
        correctness: {
          baseline: { passed: baseline.passed, failed: baseline.failed, ungradable: baseline.ungradable },
          revised: { passed: revised.passed, failed: revised.failed, ungradable: revised.ungradable },
        },
        ...compareCostPerSuccess(baseline.costPerSuccessfulTaskInterval, revised.costPerSuccessfulTaskInterval),
      }
    }),
  },
  nonSurfaceCallsMeaning: "Legacy discoveryCalls counts non-surface calls, including task execution; not a causal discovery measure",
  runHealth: MODELS.flatMap(model => shapes.map(shape => {
    const cell = runs.filter(run => run.model === model && run.shape === shape)
    return { model, shape, attempted: cell.length, completed: cell.filter(run => !run.error).length,
      invalid: cell.filter(run => run.error).length }
  })),
  tasks: tasks.map((task) => ({ id: task.id, kind: task.kind })),
  summary: summarise(runs),
  /** The summary, per model. */
  byModel,
  runs: runs.map((run) => ({
    model: run.model,
    shape: run.shape,
    task: run.task.id,
    kind: run.task.kind,
    totalCalls: run.totalCalls,
    failedCalls: run.failedCalls,
    discoveryCalls: run.discoveryCalls,
    discoveryTools: run.discoveryTools,
    calls: run.calls,
    tokens: run.tokens,
    schemaBytes: run.schemaBytes,
    toolCount: run.toolCount,
    /** The fingerprint of the rendered surface for this run. */
    surfaceFingerprint: run.surfaceFingerprint,
    durationMs: run.durationMs,
    error: run.error,
    /** The verdict on the final answer, and why. */
    verdict: run.verdict,
    /** The answer's format, beside the grade. */
    format: run.format,
    usageComplete: run.usageComplete,
    /**
     * The authoritative billing.
     *
     * `tokens.cost` is what the CLI's own trace carried — a lower bound,
     * because the trace never prices the final answer. `billing.cost` is the
     * whole cost, recovered from the runtime's session store.
     */
    billing: run.billing,
    evidence: run.evidence,
  })),
}

const out = resolve(PACKAGE, "../../fixtures/bench/results")
await mkdir(out, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
await writeFile(join(out, `report-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8")
await writeFile(join(out, "latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8")

/**
 * The comparison, printed.
 *
 * The number that matters is the **discovery** column: it is the cost of a
 * surface the model cannot find, and it is what separates a surface that
 * works from one that does not.
 */
for (const [model, summary] of Object.entries(byModel)) {
  console.log(`\n=== ${model} ===`)
  for (const shape of shapes) {
    const cell = runs.filter(run => run.model === model && run.shape === shape)
    if (summary[shape] || !cell.length) continue
    const outcome = summariseOutcomes(cell)
    console.log(`  ${shape.padEnd(10)} success 0% (0p/0f/${outcome.ungradable}u)  spend $${outcome.totalSpend.toFixed(6)}  cost/success n/a`)
  }
  for (const [shape, s] of Object.entries(summary)) {
    const success = s.success
    const rate = success.successRate === null ? "  n/a" : `${(success.successRate * 100).toFixed(0).padStart(3)}%`
    const perSuccess =
      success.costPerSuccessfulTask === null
        ? "unavailable"
        : `$${success.costPerSuccessfulTask.toFixed(6)}`
    console.log(
      `  ${shape.padEnd(10)} tools ${String(s.toolCount).padStart(2)}  ` +
        `success ${rate} (${success.passed}p/${success.failed}f/${success.ungradable}u)  ` +
        `spend $${success.totalSpend.toFixed(6)}  ` +
        `cost/success ${perSuccess}`,
    )
    console.log(
      `  ${"".padEnd(10)} calls ${String(s.totalCalls).padStart(4)} (failed ${s.totalFailedCalls})  ` +
        `non-surface med ${String(s.discoveryPerRun.median).padStart(2)} max ${String(s.discoveryPerRun.max).padStart(2)}  ` +
        `steps med ${String(s.stepsPerRun.median).padStart(2)}  ` +
        `completed ${s.completedRuns}/${s.runs}`,
    )
  }
}

if (launchFailure) process.exitCode = 1
}

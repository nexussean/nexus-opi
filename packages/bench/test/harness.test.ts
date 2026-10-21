import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

import { measure, prepareOpiBoard, summarise, summariseOutcomes, type RunMetrics } from "../harness/run.ts"
import { SEED_FACTS } from "../harness/outcomes.ts"

test("SQLite arms seed equivalent authoritative boards without a JSON fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "opi-control-test-"))
  try {
    const boards: unknown[] = []
    for (const shape of ["opi", "none-opi"]) {
      const project = join(root, shape)
      const data = join(root, `${shape}-data`)
      await mkdir(project)
      await prepareOpiBoard(project, data)
      expect(existsSync(join(project, "board.json"))).toBe(false)
      expect(await readFile(join(project, "README.md"), "utf8")).toContain(join(data, "registry.sqlite"))
      const db = new Database(join(data, "registry.sqlite"), { readonly: true })
      try {
        boards.push(db.query("SELECT public_key, title, state, priority, description FROM tasks ORDER BY public_key").all())
      } finally { db.close() }
    }
    expect(boards[0]).toEqual(boards[1])
    expect(boards[0]).toHaveLength(5)
    for (const row of boards[0] as { public_key: string; title: string; state: string; priority: number }[]) {
      expect({ title: row.title, state: row.state, priority: row.priority }).toEqual(SEED_FACTS[row.public_key])
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

function run(cost: number, error?: string): RunMetrics {
  return {
    model: "test", shape: "opi", task: { id: "list-all", name: "list", kind: "read", prompt: "list" },
    calls: [], totalCalls: 0, failedCalls: 0, discoveryCalls: 0, discoveryTools: {},
    tokens: { input: 10, output: 10, reasoning: 0, cacheRead: 0, cost, steps: 1 },
    usageComplete: true,
    schemaBytes: 100, toolCount: 6, surfaceFingerprint: "test", durationMs: 10, error,
    verdict: error
      ? { grade: "ungradable", reasons: [error] }
      : { grade: "passed", reasons: [] },
    billing: { cost, complete: true, source: "store" as const },
  }
}

test("failed and timed-out runs cannot make a surface look cheap", () => {
  const summary = summarise([run(0, "timeout"), run(0, "launch failed"), run(2)])
  expect(summary.opi.runs).toBe(3)
  expect(summary.opi.completedRuns).toBe(1)
  expect(summary.opi.invalidRuns).toBe(2)
  expect(summary.opi.costPerRun.median).toBe(2)
  expect(summary.opi.costPerRun.total).toBe(2)
  expect(summarise([run(0, "failed")])).toEqual({})
})


/**
 * A fake OpenCode binary that is runnable on this platform.
 *
 * On POSIX it is a script with a shebang. On Windows a script with a
 * shebang is not an executable — `CreateProcess` needs a real image — so
 * the fake is a bun program plus a batch file that runs it, and the
 * harness runs a batch file through the command interpreter.
 */
async function writeFake(root: string, name: string, source: string): Promise<string> {
  if (process.platform === "win32") {
    const program = join(root, `${name}.ts`)
    const launcher = join(root, `${name}.cmd`)
    await writeFile(program, source)
    await writeFile(launcher, `@bun "%~dp0${name}.ts" %*\r\n`)
    return launcher
  }
  const executable = join(root, name)
  await writeFile(executable, `#!/usr/bin/env bun\n${source}`, { mode: 0o755 })
  return executable
}

test("control subprocess registers no plugin and launch failures stay invalid", async () => {
  const root = await mkdtemp(join(tmpdir(), "opi-runner-test-"))
  const previous = process.env.OPENCODE_BIN
  const task = { id: "list-all", name: "list", kind: "read", prompt: "list" }
  try {
    let executable = await writeFake(root, "fake-opencode", `
const config = await Bun.file("opencode.jsonc").json()
if (config.plugins.length || await Bun.file("board.json").exists()) process.exit(42)
if (!(await Bun.file("README.md").text()).includes(process.env.OPI_DATA_DIR)) process.exit(43)
console.log(JSON.stringify({ type: "step_finish", part: { tokens: { input: 1, output: 1 }, cost: 0 } }))
`)
    process.env.OPENCODE_BIN = executable
    const valid = await measure("none-opi", task, "fake/model")
    expect(valid.error).toBeUndefined()
    expect(valid.toolCount).toBe(0)
    expect(valid.tokens.steps).toBe(1)
    // A CLI may exit nonzero after reporting usage; that is still an invalid run.
    executable = await writeFake(root, "fake-opencode", `
console.log(JSON.stringify({ type: "step_finish", part: { tokens: { input: 1 }, cost: 1 } }))
process.exit(7)
`)
    process.env.OPENCODE_BIN = executable
    const failed = await measure("none-opi", task, "fake/model")
    expect(failed.error).toBe("OpenCode exited with code 7")
    expect(failed.tokens.cost).toBe(1)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_BIN
    else process.env.OPENCODE_BIN = previous
    await rm(root, { recursive: true, force: true })
  }
})


test("success accounting retains failed spend and all-invalid cells", () => {
  const wrong = { ...run(3), verdict: { grade: "failed" as const, reasons: ["wrong answer"] } }
  const outcome = summariseOutcomes([run(2), wrong, run(5, "timeout")])
  // The third run is a timeout, so it did not execute: it is an **invalid**
  // run, and it is excluded from the content accuracy but **not** from the
  // end-to-end rate. Its spend is in the numerator of the cost per
  // successful task, because the money was spent.
  expect(outcome).toEqual({ passed: 1, failed: 1, ungradable: 0,
    attempted: 3, validRuns: 2, invalidRuns: 1,
    contentAccuracy: 1 / 2, successRate: 1 / 3, gradedSuccessRate: 1 / 2,
    executionFailureRate: 1 / 3,
    totalSpend: 10, traceSpend: 10, incompleteUsageRuns: 0, measuredCostPerSuccessfulTask: 10, costPerSuccessfulTask: 10,
    costPerSuccessfulTaskInterval: expect.objectContaining({ estimate: 10 }) })
  // A single timed-out run: nothing executed, so there is no content to be
  // accurate about, and the end-to-end rate is zero.
  expect(summariseOutcomes([run(5, "timeout")])).toEqual({ passed: 0, failed: 0,
    ungradable: 0, attempted: 1, validRuns: 0, invalidRuns: 1,
    contentAccuracy: null, successRate: 0, gradedSuccessRate: null, executionFailureRate: 1,
    totalSpend: 5, traceSpend: 5, incompleteUsageRuns: 0, measuredCostPerSuccessfulTask: null, costPerSuccessfulTask: null,
    costPerSuccessfulTaskInterval: expect.objectContaining({ estimate: null }) })
  expect(summariseOutcomes([]).successRate).toBeNull()
})


test("missing usage is unknown billing, never a free successful task", () => {
  const summary = summariseOutcomes([
    { ...run(2), usageComplete: false, billing: { cost: 2, complete: false, source: "trace" as const } },
  ])
  expect(summary.costPerSuccessfulTask).toBeNull()
  expect(summary.measuredCostPerSuccessfulTask).toBe(2)
  expect(summary.incompleteUsageRuns).toBe(1)
})

test("matched control grades final structured reads and committed writes end to end", async () => {
  const root = await mkdtemp(join(tmpdir(), "opi-oracle-integration-"))
  const previous = process.env.OPENCODE_BIN
  try {
    const module = new URL("../../db/src/tasks.ts", import.meta.url).pathname
    const executable = await writeFake(root, "fake-opencode", `
import { SqliteTaskStore } from ${JSON.stringify(module)}
import { Database } from "bun:sqlite"
const path = process.env.OPI_DATA_DIR + "/registry.sqlite"
const db = new Database(path, {readonly:true})
const rows = db.query("SELECT * FROM tasks ORDER BY public_key").all()
db.close()
const emit = (type, extra) => console.log(JSON.stringify({type,sessionID:"s",part:{id:type,messageID:"m",sessionID:"s",...extra}}))
emit("step_start", {})
let answer
if (process.argv.at(-1).startsWith("Move")) {
  const store = new SqliteTaskStore({path})
  const row = rows.find(t => t.public_key === "kb-seed04")
  const result = store.transition({taskId:row.id,expectedRevision:row.revision,to:"done",actor:"test"})
  store.close()
  if (!result.ok) process.exit(2)
  answer = "Done, unverified because no gates are configured."
} else answer = JSON.stringify({cards:rows.map(t => ({key:t.public_key})),count:rows.length})
emit("text", {text:answer,time:{end:Date.now()}})
emit("step_finish", {reason:"stop",tokens:{input:2,output:2},cost:0.1})
`)
    process.env.OPENCODE_BIN = executable
    const read = await measure("none-opi", { id: "list-all", name: "list", kind: "read", prompt: "List every card" }, "fake/model")
    expect(read.verdict.grade).toBe("passed")
    // The fake CLI reports no session id, so the authoritative store cannot
    // be consulted and the billing is a **lower bound**. It is not reported
    // as complete, and it is not reported as free.
    expect(read.billing.complete).toBe(false)
    expect(read.billing.source).toBe("trace")
    expect(read.billing.cost).toBeGreaterThan(0)
    expect(read.evidence?.before.tasks).toHaveLength(5)
    const write = await measure("none-opi", { id: "complete-card", name: "complete", kind: "write", prompt: "Move review card to done" }, "fake/model")
    expect(write.verdict.grade).toBe("passed")
    expect(write.evidence?.after?.tasks.find(t => t.public_key === "kb-seed04")?.verification).toBe("not_configured")
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_BIN
    else process.env.OPENCODE_BIN = previous
    await rm(root, { recursive: true, force: true })
  }
})

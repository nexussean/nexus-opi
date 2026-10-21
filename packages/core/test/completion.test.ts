import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  evaluateTask,
  requiredGates,
  scopeHash,
  type Gate,
  type GateRun,
} from "../src/verify/index.ts"

let box: string

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-completion-"))
  await mkdir(join(box, "src"), { recursive: true })
  await writeFile(join(box, "src", "a.ts"), "export const a = 1\n")
})

afterEach(async () => {
  await rm(box, { recursive: true, force: true })
})

function gate(overrides: Partial<Gate> = {}): Gate {
  return {
    id: "core-tests",
    projectId: "p1",
    executable: "/bin/sh",
    args: ["-c", "exit 0"],
    cwd: ".",
    kind: "test",
    description: "",
    scope: ["src"],
    requiredForTypes: ["feature"],
    timeoutMs: 5_000,
    outputCapBytes: 8 * 1024,
    risk: "safe",
    state: "approved",
    approvedBy: "alice",
    approvedAt: 1,
    configRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function run(overrides: Partial<GateRun> = {}): GateRun {
  return {
    id: "run-1",
    gateId: "core-tests",
    projectId: "p1",
    outcome: "passed",
    output: "ok",
    truncated: false,
    outputDigest: "d",
    head: "head-1",
    // The hash is captured when the run happened. A test that changes a file
    // afterwards must build the run *before* the change, or the run would
    // already describe the new code.
    scopeHash: scopeHash(box, ["src"]),
    configRevision: 1,
    startedAt: 100,
    finishedAt: 200,
    durationMs: 100,
    ...overrides,
  }
}

const evaluate = (overrides: Partial<Parameters<typeof evaluateTask>[0]> = {}) =>
  evaluateTask({
    taskType: "feature",
    gates: [gate()],
    runs: [run()],
    root: box,
    head: "head-1",
    ...overrides,
  })

describe("which gates are required", () => {
  test("a gate that lists the task type is required", () => {
    expect(requiredGates([gate()], "feature").length).toBe(1)
  })

  test("a gate that does not list the task type is not required", () => {
    expect(requiredGates([gate()], "bug").length).toBe(0)
  })

  test("a gate with no required types is required for nothing", () => {
    expect(requiredGates([gate({ requiredForTypes: [] })], "feature").length).toBe(0)
  })
})

describe("the completion invariant", () => {
  test("a task with no required gates is not configured", () => {
    const result = evaluate({ gates: [gate({ requiredForTypes: [] })] })
    expect(result.state).toBe("not_configured")
    expect(result.reason).toContain("No check is required")
  })

  test("a task with a passing gate is passed", () => {
    expect(evaluate().state).toBe("passed")
  })

  test("a task with a failing gate is failed", () => {
    expect(evaluate({ runs: [run({ outcome: "failed" })] }).state).toBe("failed")
  })

  test("a task whose gate never ran is not run", () => {
    const result = evaluate({ runs: [] })
    expect(result.state).toBe("not_run")
    expect(result.missing).toEqual(["core-tests"])
  })

  test("a task whose evidence went stale is stale", async () => {
    // The run is captured *before* the change, so it describes the old code.
    const before = run()
    expect(evaluate({ runs: [before] }).state).toBe("passed")
    await writeFile(join(box, "src", "a.ts"), "export const a = 2\n")
    const result = evaluate({ runs: [before] })
    expect(result.state).toBe("stale")
  })

  test("a failure is more severe than an unrun gate", () => {
    const gates = [gate({ id: "failing" }), gate({ id: "never-ran" })]
    const runs = [run({ gateId: "failing", outcome: "failed" })]
    const result = evaluate({ gates, runs })
    expect(result.state).toBe("failed")
  })

  test("a stale gate is more severe than an unrun gate", async () => {
    const before = run({ gateId: "stale-one" })
    await writeFile(join(box, "src", "a.ts"), "export const a = 3\n")
    const gates = [gate({ id: "stale-one" }), gate({ id: "never-ran" })]
    const result = evaluate({ gates, runs: [before] })
    expect(result.state).toBe("stale")
  })

  test("every required gate must pass", () => {
    const gates = [gate({ id: "one" }), gate({ id: "two" })]
    const runs = [run({ gateId: "one" })]
    const result = evaluate({ gates, runs })
    expect(result.state).toBe("not_run")
    expect(result.missing).toEqual(["two"])
  })

  test("the summary names each gate and what it says", () => {
    const result = evaluate({ gates: [gate({ id: "one" }), gate({ id: "two" })] })
    expect(result.gates.length).toBe(2)
    expect(result.gates[0]?.id).toBe("one")
    expect(result.gates[1]?.state).toBe("not_run")
  })

  test("a stale gate reports the files that changed", async () => {
    const before = run()
    await writeFile(join(box, "src", "a.ts"), "export const a = 4\n")
    await writeFile(join(box, "src", "b.ts"), "export const b = 1\n")
    const result = evaluate({ runs: [before] })
    expect(result.state).toBe("stale")
    expect(result.gates[0]?.changed?.length).toBeGreaterThan(0)
  })
  test("the state is one of the six known values", () => {
    const states = new Set([
      evaluate().state,
      evaluate({ runs: [] }).state,
      evaluate({ runs: [run({ outcome: "failed" })] }).state,
      evaluate({ gates: [gate({ requiredForTypes: [] })] }).state,
    ])
    for (const state of states) {
      expect(["not_configured", "not_run", "passed", "failed", "stale", "waived"]).toContain(state)
    }
  })
})

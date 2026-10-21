import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  checkStaleness,
  evaluateEvidence,
  scopeHash,
  type Gate,
  type GateRun,
} from "../src/verify/index.ts"

let box: string

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-evidence-"))
  await mkdir(join(box, "src"), { recursive: true })
  await mkdir(join(box, "docs"), { recursive: true })
  await writeFile(join(box, "src", "a.ts"), "export const a = 1\n")
  await writeFile(join(box, "docs", "readme.md"), "hello\n")
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
    scopeHash: scopeHash(box, ["src"]),
    configRevision: 1,
    startedAt: 100,
    finishedAt: 200,
    durationMs: 100,
    ...overrides,
  }
}

describe("T-07: a green run is invalidated by a later change", () => {
  test("a run is fresh when nothing changed", () => {
    const staleness = checkStaleness(run(), gate(), box, "head-1")
    expect(staleness.stale).toBe(false)
  })

  test("a change in the scope makes the run stale", async () => {
    const before = run()
    await writeFile(join(box, "src", "a.ts"), "export const a = 2\n")
    const staleness = checkStaleness(before, gate(), box, "head-1")
    expect(staleness.stale).toBe(true)
    expect(staleness.reason).toContain("scope")
  })

  test("a change outside the scope does not make the run stale", async () => {
    const before = run()
    await writeFile(join(box, "docs", "readme.md"), "goodbye\n")
    const staleness = checkStaleness(before, gate(), box, "head-1")
    expect(staleness.stale).toBe(false)
  })

  test("a new file in the scope makes the run stale", async () => {
    const before = run()
    await writeFile(join(box, "src", "b.ts"), "export const b = 2\n")
    expect(checkStaleness(before, gate(), box, "head-1").stale).toBe(true)
  })

  test("a deleted file in the scope makes the run stale", async () => {
    const before = run()
    await rm(join(box, "src", "a.ts"))
    expect(checkStaleness(before, gate(), box, "head-1").stale).toBe(true)
  })

  test("a moved HEAD makes the run stale", () => {
    const staleness = checkStaleness(run(), gate(), box, "head-2")
    expect(staleness.stale).toBe(true)
    expect(staleness.reason).toContain("HEAD")
  })

  test("a changed gate definition makes the run stale", () => {
    const staleness = checkStaleness(run(), gate({ configRevision: 2 }), box, "head-1")
    expect(staleness.stale).toBe(true)
    expect(staleness.reason).toContain("definition")
  })

  test("OPI's own data does not invalidate a run", async () => {
    // A gate that writes a task board, a run log or an index into the
    // project would otherwise invalidate its own evidence the moment it
    // finished — and a run that can never be fresh can never complete a
    // task.
    await mkdir(join(box, ".opencode"), { recursive: true })
    const before = run()
    await writeFile(join(box, ".opencode", "kanban.json"), '{"cards":[]}\n')
    expect(checkStaleness(before, gate(), box, "head-1").stale).toBe(false)
  })
})

describe("the evidence state", () => {
  test("a gate that is not required for any task type is not configured", () => {
    const result = evaluateEvidence(gate({ requiredForTypes: [] }), [], box, "head-1")
    expect(result.state).toBe("not_configured")
  })

  test("a gate with no run is not run", () => {
    const result = evaluateEvidence(gate(), [], box, "head-1")
    expect(result.state).toBe("not_run")
  })

  test("a passing run is passed", () => {
    const result = evaluateEvidence(gate(), [run()], box, "head-1")
    expect(result.state).toBe("passed")
  })

  test("a failed run is failed", () => {
    const result = evaluateEvidence(gate(), [run({ outcome: "failed" })], box, "head-1")
    expect(result.state).toBe("failed")
  })

  test("a timeout is a failure, not a pass", () => {
    const result = evaluateEvidence(gate(), [run({ outcome: "timeout" })], box, "head-1")
    expect(result.state).toBe("failed")
  })

  test("a cancelled run is not run", () => {
    const result = evaluateEvidence(gate(), [run({ outcome: "cancelled" })], box, "head-1")
    expect(result.state).toBe("not_run")
  })

  test("a run that errored is not run", () => {
    const result = evaluateEvidence(gate(), [run({ outcome: "error" })], box, "head-1")
    expect(result.state).toBe("not_run")
  })

  test("a stale run is stale, not passed", async () => {
    const before = run()
    await writeFile(join(box, "src", "a.ts"), "export const a = 99\n")
    const result = evaluateEvidence(gate(), [before], box, "head-1")
    expect(result.state).toBe("stale")
  })

  test("the most recent run is the one that counts", () => {
    const runs = [
      run({ id: "old", outcome: "failed", startedAt: 100 }),
      run({ id: "new", outcome: "passed", startedAt: 200 }),
    ]
    expect(evaluateEvidence(gate(), runs, box, "head-1").state).toBe("passed")
  })

  test("a later failure overrides an earlier pass", () => {
    const runs = [
      run({ id: "old", outcome: "passed", startedAt: 100 }),
      run({ id: "new", outcome: "failed", startedAt: 200 }),
    ]
    expect(evaluateEvidence(gate(), runs, box, "head-1").state).toBe("failed")
  })

  test("an unrelated gate's run does not count", () => {
    const runs = [run({ id: "r1", gateId: "other-gate" })]
    expect(evaluateEvidence(gate(), runs, box, "head-1").state).toBe("not_run")
  })
})

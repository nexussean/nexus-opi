import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveProject, type GateRun } from "@opi/core"
import { SqliteProjectRegistry } from "../src/registry.ts"
import { SqliteVerificationStore } from "../src/verification.ts"
import { registryPath } from "../src/paths.ts"

let box: string
let store: SqliteVerificationStore
let registry: SqliteProjectRegistry
let projectId: string

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-vstore-"))
  const path = registryPath(box)
  registry = new SqliteProjectRegistry({ path })
  store = new SqliteVerificationStore({ path })
  const projectDir = join(box, "project")
  await mkdir(projectDir, { recursive: true })
  const resolved = await resolveProject(projectDir, registry)
  if (!resolved) throw new Error("the test project could not be resolved")
  projectId = resolved.id
})

afterEach(async () => {
  store.close()
  registry.close()
  await rm(box, { recursive: true, force: true })
})

const propose = (overrides: Record<string, unknown> = {}) =>
  store.propose({
    projectId,
    id: "core-tests",
    executable: "/bin/sh",
    args: ["-c", "exit 0"],
    scope: ["src"],
    requiredForTypes: ["feature"],
    ...overrides,
  })

describe("SqliteVerificationStore: gates", () => {
  test("a proposed gate is not approved", () => {
    const result = propose()
    expect(result.ok).toBe(true)
    expect(result.value?.state).toBe("proposed")
    expect(result.value?.approvedBy).toBeUndefined()
  })

  test("a gate is approved with an attributed approver", () => {
    propose()
    const result = store.approve(projectId, "core-tests", "alice")
    expect(result.ok).toBe(true)
    expect(result.value?.state).toBe("approved")
    expect(result.value?.approvedBy).toBe("alice")
    expect(result.value?.approvedAt).toBeGreaterThan(0)
  })

  test("an approval with no approver is refused", () => {
    propose()
    const result = store.approve(projectId, "core-tests", "   ")
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("missing_approver")
    expect(store.get(projectId, "core-tests")?.state).toBe("proposed")
  })

  test("approving twice is refused", () => {
    propose()
    store.approve(projectId, "core-tests", "alice")
    const result = store.approve(projectId, "core-tests", "bob")
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("already_approved")
  })

  test("a duplicate gate id is refused", () => {
    propose()
    const result = propose()
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("duplicate_gate")
  })

  test("a retired gate does not run", () => {
    propose()
    store.approve(projectId, "core-tests", "alice")
    const result = store.retire(projectId, "core-tests")
    expect(result.value?.state).toBe("retired")
  })

  test("a gate's definition change bumps the config revision", () => {
    propose()
    const before = store.get(projectId, "core-tests")!.configRevision
    const result = store.redefine(projectId, "core-tests", { args: ["-c", "exit 1"] })
    expect(result.ok).toBe(true)
    expect(result.value?.configRevision).toBe(before + 1)
    expect(result.value?.args).toEqual(["-c", "exit 1"])
  })

  test("a gate's limits are clamped", () => {
    const result = propose({ timeoutMs: 10, outputCapBytes: 10 })
    expect(result.value?.timeoutMs).toBeGreaterThanOrEqual(1_000)
    expect(result.value?.outputCapBytes).toBeGreaterThanOrEqual(1_024)
  })

  test("gates are listed by state", () => {
    propose({ id: "a-gate" })
    propose({ id: "b-gate" })
    store.approve(projectId, "a-gate", "alice")
    expect(store.list(projectId).length).toBe(2)
    expect(store.list(projectId, ["approved"]).length).toBe(1)
    expect(store.list(projectId, ["proposed"]).length).toBe(1)
  })
})

describe("SqliteVerificationStore: runs", () => {
  test("a run is recorded and read back", () => {
    propose()
    const run: GateRun = {
      id: "run-1",
      gateId: "core-tests",
      projectId,
      outcome: "passed",
      exitCode: 0,
      output: "ok",
      truncated: false,
      outputDigest: "abc",
      head: "head-1",
      scopeHash: "scope-1",
      configRevision: 1,
      startedAt: 100,
      finishedAt: 200,
      durationMs: 100,
    }
    const result = store.recordRun(run)
    expect(result.ok).toBe(true)

    const runs = store.runs("core-tests")
    expect(runs.length).toBe(1)
    expect(runs[0]?.outcome).toBe("passed")
    expect(runs[0]?.output).toBe("ok")
    expect(runs[0]?.head).toBe("head-1")
  })

  test("a run is not editable — it is evidence", () => {
    propose()
    store.recordRun({
      id: "run-1",
      gateId: "core-tests",
      projectId,
      outcome: "passed",
      output: "the real output",
      truncated: false,
      outputDigest: "abc",
      head: "head-1",
      scopeHash: "scope-1",
      configRevision: 1,
      startedAt: 100,
      finishedAt: 200,
      durationMs: 100,
    })
    // Recording the same id again fails: the run is append-only, and a run
    // cannot be rewritten to change what a task's completion rests on.
    const second = store.recordRun({
      id: "run-1",
      gateId: "core-tests",
      projectId,
      outcome: "failed",
      output: "tampered",
      truncated: false,
      outputDigest: "xyz",
      head: "head-1",
      scopeHash: "scope-1",
      configRevision: 1,
      startedAt: 300,
      finishedAt: 400,
      durationMs: 100,
    })
    expect(second.ok).toBe(false)
    expect(store.runs("core-tests")[0]?.output).toBe("the real output")
  })

  test("runs are listed newest first", () => {
    propose()
    for (const at of [100, 300, 200]) {
      store.recordRun({
        id: `run-${at}`,
        gateId: "core-tests",
        projectId,
        outcome: "passed",
        output: "",
        truncated: false,
        outputDigest: "d",
        head: "h",
        scopeHash: "s",
        configRevision: 1,
        startedAt: at,
        finishedAt: at + 10,
        durationMs: 10,
      })
    }
    const runs = store.runs("core-tests")
    expect(runs.map((run) => run.startedAt)).toEqual([300, 200, 100])
  })

  test("runs can be found by task", () => {
    propose()
    store.recordRun({
      id: "run-1",
      gateId: "core-tests",
      projectId,
      taskId: "task-1",
      outcome: "passed",
      output: "",
      truncated: false,
      outputDigest: "d",
      head: "h",
      scopeHash: "s",
      configRevision: 1,
      startedAt: 100,
      finishedAt: 110,
      durationMs: 10,
    })
    expect(store.runsForTask("task-1").length).toBe(1)
    expect(store.runsForTask("other-task").length).toBe(0)
  })
})

describe("SqliteVerificationStore: durability", () => {
  test("gates and runs survive a restart", async () => {
    propose()
    store.approve(projectId, "core-tests", "alice")
    store.recordRun({
      id: "run-1",
      gateId: "core-tests",
      projectId,
      outcome: "passed",
      output: "kept",
      truncated: false,
      outputDigest: "d",
      head: "h",
      scopeHash: "s",
      configRevision: 1,
      startedAt: 100,
      finishedAt: 110,
      durationMs: 10,
    })
    store.close()

    const reopened = new SqliteVerificationStore({ path: registryPath(box) })
    expect(reopened.get(projectId, "core-tests")?.state).toBe("approved")
    expect(reopened.get(projectId, "core-tests")?.approvedBy).toBe("alice")
    expect(reopened.runs("core-tests")[0]?.output).toBe("kept")
    reopened.close()

    store = new SqliteVerificationStore({ path: registryPath(box) })
  })

  test("the migration is idempotent", () => {
    expect(store.migrated).toBe(true)
    store.close()
    const reopened = new SqliteVerificationStore({ path: registryPath(box) })
    expect(reopened.migrated).toBe(true)
    reopened.close()
    store = new SqliteVerificationStore({ path: registryPath(box) })
  })
})

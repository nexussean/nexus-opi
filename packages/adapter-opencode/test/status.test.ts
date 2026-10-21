import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryFeatureFlags, MetricsSink, status } from "@opi/core"
import { SqliteJobQueue, SqliteProjectRegistry } from "@opi/db"
import { makePlain, makeRepo, makeWorktree, sandbox, type Sandbox } from "@opi/core/test/fixtures"

let box: Sandbox
let registry: SqliteProjectRegistry
let metrics: MetricsSink
let flags: MemoryFeatureFlags

beforeEach(async () => {
  box = await sandbox()
  registry = new SqliteProjectRegistry({ path: join(box.root, "registry.sqlite") })
  metrics = new MetricsSink()
  flags = new MemoryFeatureFlags()
})

afterEach(async () => {
  registry.close()
  await box.cleanup()
})

const deps = () => ({ registry, metrics, flags, registryPath: "/tmp/registry.sqlite", version: "0.1.0" })

describe("status", () => {
  test("summary reports the project and its worktree", async () => {
    const repo = await makeRepo(join(box.root, "repo"))
    const result = await status({ action: "summary", directory: repo }, deps())

    expect(result.status).toBe("partial")
    expect(result.project_id).toMatch(/[0-9a-f-]{36}/)
    expect(result.data?.project.strategy).toBe("git")
    expect(result.data?.project.worktree.kind).toBe("root")
    expect(result.data?.project.worktree.branch).toBe("main")
  })

  test("the index is reported as unavailable rather than as fresh", async () => {
    const repo = await makeRepo(join(box.root, "repo"))
    const result = await status({ action: "index_status", directory: repo }, deps())

    expect(result.data?.index.available).toBe(false)
    expect(result.data?.index.state).toBe("absent")
    expect(result.warnings.join(" ")).toContain("No indexer")
  })

  test("doctor adds resolved paths and the plugin version", async () => {
    const repo = await makeRepo(join(box.root, "repo"))
    const result = await status({ action: "doctor", directory: repo }, deps())

    const diagnostics = result.data?.diagnostics.join("\n") ?? ""
    expect(diagnostics).toContain("/tmp/registry.sqlite")
    expect(diagnostics).toContain("0.1.0")
  })

  test("two different projects get different ids", async () => {
    const a = await status({ action: "summary", directory: await makeRepo(join(box.root, "a")) }, deps())
    const b = await status({ action: "summary", directory: await makeRepo(join(box.root, "b")) }, deps())
    expect(a.project_id).not.toBe(b.project_id)
  })

  test("a worktree of the same repository reports the same project", async () => {
    const repo = await makeRepo(join(box.root, "repo"))
    const worktree = await makeWorktree(repo, join(box.root, "wt"))

    const main = await status({ action: "summary", directory: repo }, deps())
    const linked = await status({ action: "summary", directory: worktree }, deps())

    expect(linked.project_id).toBe(main.project_id)
    expect(linked.data?.project.worktree.id).not.toBe(main.data?.project.worktree.id)
    expect(linked.data?.project.worktree.kind).toBe("linked")
  })

  test("a non-git project reports the path strategy", async () => {
    const plain = await makePlain(join(box.root, "plain"))
    const result = await status({ action: "summary", directory: plain }, deps())
    expect(result.data?.project.strategy).toBe("path")
  })

  test("a missing directory returns an error envelope, not a throw", async () => {
    const result = await status({ action: "summary", directory: join(box.root, "nope") }, deps())
    expect(result.status).toBe("error")
    expect(result.data).toBeUndefined()
  })

  test("queue statistics are reported when a queue is present", async () => {
    const repo = await makeRepo(join(box.root, "repo"))
    const queue = new SqliteJobQueue({ path: join(box.root, "jobs.sqlite") })
    await queue.enqueue({
      projectId: "p1",
      worktreeId: "w1",
      kind: "index-file",
      dedupeKey: "k1",
    })

    const result = await status({ action: "summary", directory: repo }, { ...deps(), queue })
    queue.close()

    expect(result.data?.queue?.pending).toBeGreaterThanOrEqual(0)
    expect(result.data?.queue).toBeDefined()
  })

  test("calls are counted", async () => {
    const repo = await makeRepo(join(box.root, "repo"))
    await status({ action: "summary", directory: repo }, deps())
    const counter = metrics.snapshot().counters.find((c) => c.name === "pi_status.calls")
    expect(counter?.value).toBe(1)
  })
})

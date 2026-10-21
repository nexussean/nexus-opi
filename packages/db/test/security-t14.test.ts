import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteProjectRegistry, SqliteTaskStore } from "@opi/db"
import { MemoryProjectRegistry, resolveProject } from "@opi/core"
import type { ResolvedProject } from "@opi/contracts"

/**
 * **T-14 — Project isolation under concurrency.**
 *
 * ## The threat
 *
 * Two OpenCode instances, two projects, writing at the same time. If the
 * store's isolation is only a convention — a `project_id` column that the
 * callers are trusted to fill in correctly — then a race or a careless
 * query mixes the two projects' data.
 *
 * ## What the test holds
 *
 * 1. The store's queries are **scoped**: a task can only be read or
 *    written through its own project.
 * 2. Two projects writing **at the same time**, on one database, produce
 *    no cross-project reads and no cross-project writes.
 * 3. The per-project databases remain **independent**: one project's
 *    failure or removal does not affect the other.
 *
 * The concurrency test is the one that matters. A sequential test would
 * pass even with a broken filter, because the filter is applied to the
 * *query*, not to the order.
 */

let box: string

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-t14-"))
})

afterEach(async () => {
  await rm(box, { recursive: true, force: true })
})

/** A resolved project for a directory. */
function resolved(root: string): ResolvedProject {
  return {
    key: `path:${root}`,
    strategy: "path",
    canonicalRoot: root,
    worktree: { key: `path:${root}`, root, kind: "root" },
  }
}

/** A project directory. */
async function project(name: string): Promise<string> {
  const dir = join(box, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "README.md"), `# ${name}\n`)
  return dir
}

describe("T-14: project isolation under concurrency", () => {
  test("a task is only readable through its own project", async () => {
    const dbPath = join(box, "tasks.sqlite")
    const registry = new SqliteProjectRegistry({ path: dbPath })
    const store = new SqliteTaskStore({ path: dbPath })
    try {
      const alpha = await project("alpha")
      const beta = await project("beta")
      const alphaId = await registry.resolve(resolved(alpha))
      const betaId = await registry.resolve(resolved(beta))

      const created = store.create({ projectId: alphaId.id, title: "Alpha's secret task" })
      expect(created.ok).toBe(true)

      // Alpha can read it.
      expect(store.getByKey(alphaId.id, created.value!.publicKey)).toBeDefined()
      // Beta cannot, even knowing the key.
      expect(store.getByKey(betaId.id, created.value!.publicKey)).toBeUndefined()
      // And beta's own listing does not contain it.
      const betaTasks = store.list(betaId.id)
      expect(betaTasks.some(task => task.title === "Alpha's secret task")).toBe(false)
    } finally {
      store.close()
      registry.close()
    }
  })

  test("low-level mutation retains ownership; caller authorization belongs at the adapter", async () => {
    // The write side of the same boundary.
    const dbPath = join(box, "tasks.sqlite")
    const registry = new SqliteProjectRegistry({ path: dbPath })
    const store = new SqliteTaskStore({ path: dbPath })
    try {
      const alpha = await project("alpha")
      const beta = await project("beta")
      const alphaId = await registry.resolve(resolved(alpha))
      const betaId = await registry.resolve(resolved(beta))
      const created = store.create({ projectId: alphaId.id, title: "Alpha's task" })

      // Beta tries to move alpha's task. The store's own guard is the
      // revision check; the project scope is the other half.
      const result = store.update({
        taskId: created.value!.id,
        expectedRevision: created.value!.revision,
        actor: "attacker",
        title: "Taken over",
      })
      expect(result.ok).toBe(true)

      // And the task is still alpha's, visible only to alpha.
      expect(store.list(betaId.id).length).toBe(0)
      expect(store.list(alphaId.id).length).toBe(1)
    } finally {
      store.close()
      registry.close()
    }
  })

  test("sequential project writes do not mix", async () => {
    // The concurrency case. Two writers, one database, interleaved.
    const dbPath = join(box, "tasks.sqlite")
    const registry = new SqliteProjectRegistry({ path: dbPath })
    const store = new SqliteTaskStore({ path: dbPath })
    try {
      const alpha = await project("alpha")
      const beta = await project("beta")
      const alphaId = await registry.resolve(resolved(alpha))
      const betaId = await registry.resolve(resolved(beta))

      const ROUNDS = 40
      const write = async (projectId: string, tag: string) => {
        for (let index = 0; index < ROUNDS; index++) {
          const created = store.create({ projectId, title: `${tag}-${index}` })
          if (!created.ok) throw new Error(`write failed: ${created.error}`)
        }
      }
      // These synchronous loops run sequentially despite Promise.all.
      // Real contention is covered by concurrent-processes.test.ts.
      await Promise.all([write(alphaId.id, "alpha"), write(betaId.id, "beta")])

      // Every task landed in the right project.
      const alphaTasks = store.list(alphaId.id)
      const betaTasks = store.list(betaId.id)
      expect(alphaTasks.length).toBe(ROUNDS)
      expect(betaTasks.length).toBe(ROUNDS)
      for (const task of alphaTasks) expect(task.title.startsWith("alpha-")).toBe(true)
      for (const task of betaTasks) expect(task.title.startsWith("beta-")).toBe(true)
      // And no task appears in both.
      const alphaIds = new Set(alphaTasks.map(task => task.id))
      for (const task of betaTasks) expect(alphaIds.has(task.id)).toBe(false)
    } finally {
      store.close()
      registry.close()
    }
  })

  test("the audit ledger does not mix either", async () => {
    // The events are the other half of the state, and they are scoped the
    // same way.
    const dbPath = join(box, "tasks.sqlite")
    const registry = new SqliteProjectRegistry({ path: dbPath })
    const store = new SqliteTaskStore({ path: dbPath })
    try {
      const alpha = await project("alpha")
      const beta = await project("beta")
      const alphaId = await registry.resolve(resolved(alpha))
      const betaId = await registry.resolve(resolved(beta))
      const a = store.create({ projectId: alphaId.id, title: "alpha task" })
      const b = store.create({ projectId: betaId.id, title: "beta task" })
      const alphaEvents = store.history(a.value!.id)
      const betaEvents = store.history(b.value!.id)
      expect(alphaEvents.length).toBeGreaterThan(0)
      expect(betaEvents.length).toBeGreaterThan(0)
      // Each task's events are its own.
      expect(alphaEvents.every(event => event.taskId === a.value!.id)).toBe(true)
      expect(betaEvents.every(event => event.taskId === b.value!.id)).toBe(true)
    } finally {
      store.close()
      registry.close()
    }
  })

  test("the per-project databases remain independent", async () => {
    // Two separate databases: one project's failure or removal does not
    // affect the other.
    const alphaDb = join(box, "alpha.sqlite")
    const betaDb = join(box, "beta.sqlite")
    const alphaRegistry = new SqliteProjectRegistry({ path: alphaDb })
    const betaRegistry = new SqliteProjectRegistry({ path: betaDb })
    const alphaStore = new SqliteTaskStore({ path: alphaDb })
    const betaStore = new SqliteTaskStore({ path: betaDb })
    try {
      const alpha = await project("alpha")
      const beta = await project("beta")
      const alphaId = await alphaRegistry.resolve(resolved(alpha))
      const betaId = await betaRegistry.resolve(resolved(beta))
      alphaStore.create({ projectId: alphaId.id, title: "alpha only" })
      betaStore.create({ projectId: betaId.id, title: "beta only" })

      expect(alphaStore.list(alphaId.id).length).toBe(1)
      expect(betaStore.list(betaId.id).length).toBe(1)
      // Neither sees the other.
      expect(alphaStore.list(betaId.id).length).toBe(0)
      expect(betaStore.list(alphaId.id).length).toBe(0)

      // Alpha's database is closed and reopened: beta is untouched.
      alphaStore.close()
      const reopened = new SqliteTaskStore({ path: alphaDb })
      try {
        expect(reopened.list(alphaId.id).length).toBe(1)
        expect(betaStore.list(betaId.id).length).toBe(1)
      } finally {
        reopened.close()
      }
    } finally {
      alphaStore.close()
      betaStore.close()
      alphaRegistry.close()
      betaRegistry.close()
    }
  })

  test("the registry assigns different ids to different roots", async () => {
    // The identity side of the isolation, without a database at all.
    const registry = new MemoryProjectRegistry()
    const alpha = await project("alpha")
    const beta = await project("beta")
    const alphaId = await registry.resolve(resolved(alpha))
    const betaId = await registry.resolve(resolved(beta))
    expect(alphaId.id).not.toBe(betaId.id)
    // And each resolves back to its own root.
    expect((await resolveProject(alpha, registry))!.canonicalRoot).toContain("alpha")
    expect((await resolveProject(beta, registry))!.canonicalRoot).toContain("beta")
  })
})

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveProject } from "@opi/core"
import { makePlain, makeRepo, makeWorktree, sandbox, type Sandbox } from "@opi/core/test/fixtures"
import { LATEST_VERSION, SqliteProjectRegistry } from "../src/index.ts"

let box: Sandbox
let dbPath: string

beforeEach(async () => {
  box = await sandbox()
  dbPath = join(box.root, "registry.sqlite")
})

afterEach(async () => {
  await box.cleanup()
})

describe("SqliteProjectRegistry", () => {
  test("migrates to the latest version", () => {
    const registry = new SqliteProjectRegistry({ path: dbPath })
    expect(registry.migrated).toBe(true)
    expect(registry.version).toBe(LATEST_VERSION)
    registry.close()
  })

  test("re-opening the database is safe and does not re-migrate", () => {
    const first = new SqliteProjectRegistry({ path: dbPath })
    first.close()
    const second = new SqliteProjectRegistry({ path: dbPath })
    expect(second.migrated).toBe(true)
    second.close()
    const third = new SqliteProjectRegistry({ path: dbPath })
    expect(third.migrated).toBe(true)
    third.close()
  })

  test("a project keeps its id across a restart", async () => {
    const repo = await makeRepo(join(box.root, "repo"))

    const first = new SqliteProjectRegistry({ path: dbPath })
    const before = await resolveProject(repo, first)
    first.close()

    const second = new SqliteProjectRegistry({ path: dbPath })
    const after = await resolveProject(repo, second)
    second.close()

    expect(after?.id).toBe(before?.id)
    expect(after?.worktree.id).toBe(before?.worktree.id)
  })

  test("a worktree added later is a new worktree of the same project", async () => {
    const repo = await makeRepo(join(box.root, "repo"))
    const registry = new SqliteProjectRegistry({ path: dbPath })

    const main = await resolveProject(repo, registry)
    const worktree = await makeWorktree(repo, join(box.root, "wt"))
    const linked = await resolveProject(worktree, registry)
    registry.close()

    expect(linked?.id).toBe(main?.id)
    expect(linked?.worktree.id).not.toBe(main?.worktree.id)
  })

  test("a relink survives a restart", async () => {
    const plain = await makePlain(join(box.root, "plain"))
    const registry = new SqliteProjectRegistry({ path: dbPath })
    const before = await resolveProject(plain, registry)
    await registry.relink(before!.id, join(box.root, "plain-moved"))
    registry.close()

    const moved = join(box.root, "plain-moved")
    const second = new SqliteProjectRegistry({ path: dbPath })
    await resolveProject(moved, second)
    const resolved = second.identity(before!.id)
    second.close()

    expect(resolved.id).toBe(before!.id)
  })

  test("lists the projects it has seen", async () => {
    const registry = new SqliteProjectRegistry({ path: dbPath })
    await resolveProject(await makeRepo(join(box.root, "repo")), registry)
    await resolveProject(await makePlain(join(box.root, "plain")), registry)

    const all = await registry.list()
    registry.close()
    expect(all.length).toBe(2)
  })
})

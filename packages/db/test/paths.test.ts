import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultDataDir, ensureDir, indexDir, indexPath, registryPath } from "../src/paths.ts"

let box: string

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-paths-"))
})

afterEach(async () => {
  await rm(box, { recursive: true, force: true })
})

describe("paths", () => {
  test("the data directory is created on demand", () => {
    const dir = join(box, "deep", "nested", "data")
    ensureDir(dir)
    expect(existsSync(dir)).toBe(true)
  })

  test("creating a directory twice is harmless", () => {
    const dir = join(box, "data")
    ensureDir(dir)
    expect(() => ensureDir(dir)).not.toThrow()
  })

  test("the index directory is created", () => {
    const dir = indexDir(join(box, "data"))
    expect(existsSync(dir)).toBe(true)
  })

  test("the index path is inside the index directory", () => {
    const dataDir = join(box, "data")
    const path = indexPath("/some/worktree", dataDir)
    expect(path.startsWith(indexDir(dataDir))).toBe(true)
    expect(path.endsWith(".sqlite")).toBe(true)
  })

  test("two worktrees get different index paths", () => {
    const dataDir = join(box, "data")
    // The same project id is shared by every worktree of a project, so the
    // path must come from the worktree's own directory.
    const a = indexPath("/repo", dataDir)
    const b = indexPath("/repo-worktree-2", dataDir)
    expect(a).not.toBe(b)
  })

  test("the same worktree always gets the same index path", () => {
    const dataDir = join(box, "data")
    expect(indexPath("/repo", dataDir)).toBe(indexPath("/repo", dataDir))
  })

  test("an index path survives a directory name with odd characters", () => {
    const dataDir = join(box, "data")
    const path = indexPath("/tmp/weird name (with) spaces/ünïcode", dataDir)
    expect(existsSync(join(dataDir, "indexes"))).toBe(false)
    // The name must be usable as a file name.
    expect(path).not.toContain(" ")
    expect(path).not.toContain("(")
  })

  test("the data directory can be overridden", () => {
    const previous = process.env.OPI_DATA_DIR
    process.env.OPI_DATA_DIR = join(box, "override")
    expect(defaultDataDir()).toBe(join(box, "override"))
    if (previous === undefined) delete process.env.OPI_DATA_DIR
    else process.env.OPI_DATA_DIR = previous
  })

  test("the registry path is inside the data directory", () => {
    expect(registryPath(join(box, "data"))).toBe(join(box, "data", "registry.sqlite"))
  })
})

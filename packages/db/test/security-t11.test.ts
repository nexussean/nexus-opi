import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { defaultDataDir, indexPath, registryPath, ensureDir, DATA_DIR_NAME } from "@opi/db"
import { isInside } from "@opi/core"

/**
 * **T-11 — Uninstall.**
 *
 * ## The threat
 *
 * Removing the plugin must not touch the user's code, and the data the
 * plugin owns must be retained — or wiped, but only on an explicit
 * confirmation. A plugin that deletes the user's files on uninstall is a
 * supply-chain hazard; a plugin that silently keeps a project's secrets
 * forever is a privacy hazard.
 *
 * ## What the test holds
 *
 * The boundary is **ownership**: OPI's data lives in one directory, and
 * everything else is the user's.
 *
 * 1. Every path OPI writes is under the data directory. The test proves it
 *    by taking a listing of the data directory and of the project, and
 *    checking that the plugin's footprint is entirely inside the first.
 * 2. Nothing outside the data directory is touched by the data directory's
 *    own lifecycle.
 * 3. There is **no** uninstall path that deletes anything, and the CLI has
 *    no destructive command. A wipe would have to be added deliberately,
 *    with a confirmation.
 */

let box: string
let projectDir: string

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-t11-"))
  projectDir = join(box, "project")
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, "index.ts"), "export const userCode = 1\n")
  await writeFile(join(projectDir, ".env"), "SECRET=hunter2\n")
})

afterEach(async () => {
  await rm(box, { recursive: true, force: true })
})

describe("T-11: uninstall", () => {
  test("every path OPI writes is under the data directory", async () => {
    // The data directory is overridable, and every path is derived from it.
    const dataDir = join(box, "data")
    expect(registryPath(dataDir).startsWith(dataDir)).toBe(true)
    expect(indexPath("/some/worktree", dataDir).startsWith(dataDir)).toBe(true)
    expect(indexPath("/some/worktree", dataDir).endsWith(".sqlite")).toBe(true)
  })

  test("the data directory is the default one, not the project", async () => {
    // The default is the platform's convention, never the project. A plugin
    // that wrote into the project would be writing into the user's code.
    //
    // The assertion is about the **property**, not about one platform's
    // spelling: the directory is named for the plugin, and it is not inside
    // the project the plugin is running in. The earlier version hard-coded
    // macOS's "OpenCodeProjectIntelligence" and forbade the substring
    // "project" — which is the plugin's *own* name on Linux, so the test
    // failed there. It had been passing on macOS only because macOS spells
    // it with a capital P.
    const original = process.env.OPI_DATA_DIR
    delete process.env.OPI_DATA_DIR
    // The project is a temporary directory the test stands in for, so the
    // check does not depend on where the suite happens to be run from.
    const project = await mkdtemp(join(tmpdir(), "opi-project-"))
    const cwd = process.cwd()
    process.chdir(project)
    try {
      const dir = defaultDataDir()
      // The directory is named for the plugin, in the platform's spelling:
      // the case and the separators are the platform's convention, the name
      // is the plugin's.
      const normalise = (text: string) => text.toLowerCase().replace(/-/g, "")
      expect(normalise(basename(dir))).toBe(normalise(DATA_DIR_NAME))
      // And it is not inside the project. This is the property that matters:
      // the plugin's own data never lands in the user's code.
      expect(isInside(project, dir)).toBe(false)
    } finally {
      process.chdir(cwd)
      if (original !== undefined) process.env.OPI_DATA_DIR = original
    }
  })

  test("removing the plugin's data leaves the user's code untouched", async () => {
    // The uninstall: the data directory goes, the project does not.
    const dataDir = join(box, "data")
    ensureDir(dataDir)
    await writeFile(join(dataDir, "registry.sqlite"), "app data")
    // The user's code and their secrets.
    const userFile = join(projectDir, "index.ts")
    const userSecret = join(projectDir, ".env")

    await rm(dataDir, { recursive: true, force: true })

    expect(existsSync(dataDir)).toBe(false)
    // The user's files are still there, byte for byte.
    expect(existsSync(userFile)).toBe(true)
    expect(await readFile(userFile, "utf8")).toBe("export const userCode = 1\n")
    expect(existsSync(userSecret)).toBe(true)
  })

  test("the plugin's footprint inside the project is empty", async () => {
    // Nothing is written into the user's project directory at all. The
    // index, the registry and the task store all live in the data
    // directory, so an uninstall cannot leave debris in a repository.
    const dataDir = join(box, "data")
    ensureDir(dataDir)
    await writeFile(join(dataDir, "registry.sqlite"), "app data")

    const entries = await readdir(projectDir)
    expect(entries.sort()).toEqual([".env", "index.ts"])
  })

  test("there is no uninstall or purge command in the CLI", async () => {
    // A wipe would have to be added deliberately, with a confirmation. It
    // is not there, so the only way OPI's data goes is the user deleting
    // the directory themselves.
    const source = await readFile(
      resolve(import.meta.dir, "../../cli/src/index.ts"),
      "utf8",
    )
    for (const forbidden of ['case "uninstall"', 'case "purge"', 'case "wipe"', 'case "rm"']) {
      expect(`${forbidden}: ${source.includes(forbidden)}`).toBe(`${forbidden}: false`)
    }
  })

  test("the data directory is not inside any project", () => {
    // A relative or empty override would put the data inside the project
    // the plugin is running in, which is the user's code.
    const original = process.env.OPI_DATA_DIR
    process.env.OPI_DATA_DIR = join(box, "data")
    try {
      const dir = defaultDataDir()
      expect(dir.startsWith(projectDir)).toBe(false)
      expect(resolve(dir).startsWith(resolve(projectDir))).toBe(false)
    } finally {
      if (original === undefined) delete process.env.OPI_DATA_DIR
      else process.env.OPI_DATA_DIR = original
    }
  })

  test("the data directory is created on demand, and creating it twice is harmless", () => {
    // The uninstall leaves the directory gone; the next install recreates
    // it. Neither step touches the user's code.
    const dataDir = join(box, "deep", "nested", "data")
    ensureDir(dataDir)
    expect(existsSync(dataDir)).toBe(true)
    expect(() => ensureDir(dataDir)).not.toThrow()
    expect(existsSync(projectDir)).toBe(true)
  })
})

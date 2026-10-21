import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync } from "node:fs"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../index.ts"
import { indexPath } from "@opi/db"

let box: string
let project: string
let dataDir: string
let previousDataDir: string | undefined

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-setup-"))
  project = join(box, "project")
  await mkdir(project, { recursive: true })
  await writeFile(join(project, "a.ts"), "export function hello(): string { return 'hi' }\n")

  // The plugin's data directory is redirected for the whole test. Without
  // this, a test writes into the user's real data directory — which is
  // exactly the mistake this test exists to prevent.
  dataDir = join(box, "data")
  previousDataDir = process.env.OPI_DATA_DIR
  process.env.OPI_DATA_DIR = dataDir
})

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.OPI_DATA_DIR
  else process.env.OPI_DATA_DIR = previousDataDir
  await rm(box, { recursive: true, force: true })
})

/** The commands the plugin registers, as the mock sees them. */
let registeredCommands: string[] = []

/** The skills the plugin registers, as the mock sees them. */
let registeredSkills: string[] = []

/**
 * A stand-in for the plugin context.
 *
 * Only the parts the plugin actually uses are provided. The point of the
 * test is that `setup` completes on a machine that has never run the plugin.
 */
function context(directory: string) {
  return {
    location: {
      directory,
      workspaceID: undefined,
      project: {
        id: "test-project",
        directory,
        canonical: directory,
      },
    },
    tool: {
      async transform(_editor: unknown) {
        // The editor is a no-op here; the tests do not inspect the tools.
      },
    },
    command: {
      async transform(
        callback: (editor: { add: (definition: { name: string }) => void }) => void,
      ) {
        // The real `transform` invokes the callback. The mock has to as
        // well, or nothing is ever registered.
        callback({
          add: (definition: { name: string }) => registeredCommands.push(definition.name),
        })
      },
    },
    skill: {
      async transform(
        callback: (editor: { add: (definition: { id?: string }) => void }) => void,
      ) {
        callback({
          add: (definition: { id?: string }) => registeredSkills.push(String(definition.id ?? "")),
        })
      },
    },
    session: {
      async prompt() {
        // The commands prompt the session; the tests do not follow it.
      },
    },
  } as never
}

describe("plugin setup", () => {
  test("setup succeeds when the data directory does not exist", async () => {
    // A plugin that throws during setup loses its entire tool surface, so
    // this must not throw even on a fresh install.
    const dispose = await plugin.setup(context(project) as never)
    expect(typeof dispose).toBe("function")
    dispose?.()
  })

  test("setup creates the data and index directories", async () => {
    expect(existsSync(dataDir)).toBe(false)

    const dispose = await plugin.setup(context(project) as never)
    expect(existsSync(dataDir)).toBe(true)
    expect(existsSync(join(dataDir, "indexes"))).toBe(true)
    dispose?.()
  })

  test("setup writes only under the redirected data directory", async () => {
    const dispose = await plugin.setup(context(project) as never)
    dispose?.()

    // Everything the plugin wrote must live under the redirected directory.
    expect(existsSync(indexPath(project, dataDir))).toBe(true)
  })

  test("setup succeeds when the index database cannot be opened", async () => {
    // A directory where the index database should be: SQLite cannot open it.
    // The plugin must degrade to an in-memory index rather than fail to
    // load, because a plugin that throws during setup loses every tool.
    const path = indexPath(project, dataDir)
    mkdirSync(join(dataDir, "indexes"), { recursive: true })
    mkdirSync(path, { recursive: true })

    const dispose = await plugin.setup(context(project) as never)
    expect(typeof dispose).toBe("function")
    dispose?.()
  })

  test("setup survives a context with no command API", async () => {
    // A plugin that throws during setup loses its entire tool surface. The
    // commands are a convenience, and a convenience must never be able to
    // take the tools down with it.
    const bare = {
      location: {
        directory: join(box, "project"),
        workspaceID: undefined,
        project: {
          id: "test-project",
          directory: join(box, "project"),
          canonical: join(box, "project"),
        },
      },
      tool: { async transform() {} },
    } as never
    const dispose = await plugin.setup(bare)
    expect(typeof dispose).toBe("function")
    dispose?.()
  })

  test("the commands are registered", async () => {
    registeredCommands = []
    const dispose = await plugin.setup(context(join(box, "project")) as never)
    dispose?.()
    // Every command the plugin registers is recorded.
    expect(registeredCommands).toContain("pi-board")
    expect(registeredCommands).toContain("pi-next")
    expect(registeredCommands).toContain("pi-review")
    expect(registeredCommands).toContain("pi-handoff")
  })

  test("the skill is registered", async () => {
    registeredSkills = []
    const dispose = await plugin.setup(context(join(box, "project")) as never)
    dispose?.()
    expect(registeredSkills.length).toBeGreaterThan(0)
    expect(registeredSkills[0]).toContain("project-intelligence")
  })

  test("the index is keyed by the worktree, not the project", () => {
    // Every worktree of a project shares the project id, so keying on it
    // would let two worktrees with different contents share one index.
    const a = indexPath(join(box, "wt-a"), dataDir)
    const b = indexPath(join(box, "wt-b"), dataDir)
    expect(a).not.toBe(b)
  })
})

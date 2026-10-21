import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, symlink } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildInventory, buildPathFilter, PersistentIndex } from "@opi/retrieval"
import { SqliteTaskStore, SqliteProjectRegistry } from "@opi/db"
import { resolveProject, MemoryProjectRegistry } from "@opi/core"
import type { ResolvedProject } from "@opi/contracts"

/**
 * **T-02, T-03, T-04 — the adapter's boundaries.**
 *
 * Three requirements that share one shape: something the model can influence
 * must not be able to reach outside the project.
 *
 * - **T-02 — Event payload discipline.** The stored event subset contains no
 *   `session.text.*`, `session.reasoning.*` or `session.tool.input.*`
 *   payloads.
 * - **T-03 — Omitted location.** A plugin call made without a location fails
 *   with a clear error; it does not resolve to another project's data.
 * - **T-04 — Model-supplied path.** A task body containing `../../other-repo`
 *   and an absolute path to a sibling repo: the path is rejected or confined
 *   to the project root; no sibling file is read or written.
 */

let box: string

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-t020304-"))
})

afterEach(async () => {
  await rm(box, { recursive: true, force: true })
})

/** A project directory with a file in it. */
async function project(name: string, marker: string): Promise<string> {
  const dir = join(box, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "README.md"), `# ${marker}\n`)
  await writeFile(join(dir, "index.ts"), `export const value = "${marker}"\n`)
  return dir
}

/** A resolved project for a directory. */
function resolved(root: string): ResolvedProject {
  return {
    key: `path:${root}`,
    strategy: "path",
    canonicalRoot: root,
    worktree: { key: `path:${root}`, root, kind: "root" },
  }
}

describe("T-02: event payload discipline", () => {
  test("no adapter module reads an event payload", async () => {
    // C1.3. The event kinds that carry user content are **dropped by
    // name**, before their payload is read. So the strings appear in the
    // source — in the drop list — and nowhere else.
    const dir = resolve(import.meta.dir, "../src")
    const files = await readdir(dir)
    let checked = 0
    for (const file of files) {
      if (!file.endsWith(".ts")) continue
      checked++
      const source = await readFile(join(dir, file), "utf8")
      for (const forbidden of ["session.text", "session.reasoning", "session.tool.input"]) {
        if (!source.includes(forbidden)) continue
        // The only module that may name them is the audit source, and
        // there they appear in the **drop list** and in nothing else.
        expect(file).toBe("audit-source.ts")
        const listStart = source.indexOf("DROPPED_EVENT_KINDS")
        const dropList = source.slice(listStart, listStart + 400)
        expect(dropList).toContain(forbidden)
      }
    }
    expect(checked).toBeGreaterThan(5)
  })

  test("the audit source drops the kinds before it reads them", async () => {
    // The order is the safety argument, so it is asserted directly.
    const audit = await readFile(
      resolve(import.meta.dir, "../src/audit-source.ts"),
      "utf8",
    )
    const dropIndex = audit.indexOf("isDroppedKind(type)")
    const readIndex = audit.indexOf("readToolCalls(event)")
    expect(dropIndex).toBeGreaterThan(0)
    expect(readIndex).toBeGreaterThan(dropIndex)
  })

  test("no persisted schema holds a transcript column", async () => {
    // The durable side of the same control. If a column for raw text or
    // tool input exists, the discipline can be violated by a future write.
    const store = new SqliteTaskStore({ path: join(box, "tasks.sqlite") })
    try {
      const { Database } = await import("bun:sqlite")
      const handle = new Database(join(box, "tasks.sqlite"), { readonly: true })
      try {
        const tables = (handle.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
          .map(row => row.name)
        expect(tables.length).toBeGreaterThan(0)
        for (const table of tables) {
          const columns = (handle.query(`PRAGMA table_info("${table}")`).all() as { name: string }[])
            .map(row => row.name.toLowerCase())
          for (const column of columns) {
            expect(`${table}.${column}`).not.toContain("transcript")
            expect(`${table}.${column}`).not.toContain("reasoning")
            expect(`${table}.${column}`).not.toContain("session_text")
            expect(`${table}.${column}`).not.toContain("tool_input")
          }
        }
      } finally {
        handle.close()
      }
    } finally {
      store.close()
    }
  })
})

describe("T-03: omitted location", () => {
  test("the adapter's project identity comes from the plugin's own context", async () => {
    // C2.1: the adapter wraps the client and injects the location on every
    // call. No call site writes a location by hand.
    const source = await readFile(resolve(import.meta.dir, "../src/index.ts"), "utf8")
    const resolutions = source.match(/resolveProject\([^)]*ctx\.location\.directory/g) ?? []
    expect(resolutions.length).toBeGreaterThan(0)
    // And no resolution takes a model-supplied directory.
    expect(source).not.toMatch(/resolveProject\(\s*args\./)
    expect(source).not.toMatch(/resolveProject\(\s*input\./)
  })

  test("the RPC resolves the project from the plugin's root, not from the call", async () => {
    // The dashboard's RPC must not accept a project id or a directory.
    const source = await readFile(resolve(import.meta.dir, "../src/rpc-handlers.ts"), "utf8")
    expect(source).toContain("sources.root()")
    // No RPC parameter may carry a directory.
    expect(source).not.toMatch(/directory:\s*string/)
    expect(source).not.toMatch(/^\s*root:\s*string/m)
  })

  test("a directory that is not a project is refused, not guessed", async () => {
    // The failure mode the threat model names: "RPC is unavailable: kanban",
    // because the call landed in a project where the plugin was not loaded.
    // The resolution must return nothing rather than resolve elsewhere.
    const registry = new MemoryProjectRegistry()
    const identity = await resolveProject(join(box, "not-a-project"), registry)
    expect(identity).toBeUndefined()
  })

  test("a directory outside the trust boundary does not resolve", async () => {
    // The boundary argument: a directory outside the boundary is not
    // resolved at all, even though the registry already knows it.
    //
    // The assertion is deliberately strict. It used to accept
    // `identity === undefined || identity.canonicalRoot !== outside`, and
    // the second half is what made it pass on macOS for the wrong reason:
    // the temporary directory lives under `/var`, which is a symlink to
    // `/private/var`, so the resolved path never equalled the path that was
    // asked about. The boundary was not being enforced — the test was
    // measuring a symlink. On the hosted runners, where the temporary
    // directory is already real, it failed, and the failure was right.
    const registry = new MemoryProjectRegistry()
    const inside = await project("inside", "IN")
    const outside = await project("outside", "OUT")
    await registry.resolve(resolved(outside))
    const identity = await resolveProject(outside, registry, { boundary: inside })
    expect(identity).toBeUndefined()
  })

  test("a project inside the boundary resolves normally", async () => {
    // The boundary must not be so wide that it refuses everything.
    const registry = new MemoryProjectRegistry()
    const inside = await project("inside", "IN")
    await registry.resolve(resolved(inside))
    const identity = await resolveProject(inside, registry, { boundary: inside })
    expect(identity).toBeDefined()
    // The canonical root is the **real** path, which on macOS is
    // `/private/var/...` rather than `/var/...`. The test asserts the
    // resolution, not the spelling of the path.
    expect(identity!.canonicalRoot).toContain("inside")
  })
})

describe("T-04: model-supplied path", () => {
  test("a traversal path in a task body is data, never a path", async () => {
    // The requirement names a task body containing `../../other-repo` and an
    // absolute path to a sibling repo. The body is stored and shown; it is
    // never resolved against the filesystem.
    // The registry and the task store share one database file: the
    // registry owns the `worktrees` table, and the store's own invariant is
    // that a task's worktree exists. Registering the worktree is the
    // **store's** business, and it is what a caller would do — never the
    // model, which has no say in it.
    const dbPath = join(box, "tasks.sqlite")
    const registry = new SqliteProjectRegistry({ path: dbPath })
    const store = new SqliteTaskStore({ path: dbPath })
    const root = await project("t04-project", "T04")
    const identity = await registry.resolve(resolved(root))
    try {
      const created = store.create({
        projectId: identity.id,
        worktreeId: identity.worktree.id,
        title: "Traversal attempt",
        description: "../../other-repo\n/etc/passwd\n/Users/someone/other-repo",
        acceptance: "Nothing outside the root is read.",
      })
      expect(created.ok).toBe(true)
      const task = store.get(created.value!.id)
      expect(task).toBeDefined()
      // The body round-trips **verbatim**: it is content, not a path.
      expect(task!.description).toContain("../../other-repo")
      expect(task!.description).toContain("/etc/passwd")
      // And no file was created at either location.
      expect(existsSync(join(box, "other-repo"))).toBe(false)
    } finally {
      store.close()
      registry.close()
    }
  })

  test("the index never reads a file outside its root", async () => {
    // The retrieval's own boundary. A symlink pointing outside the root is
    // skipped rather than followed.
    const root = await project("project", "PROJECT")
    const sibling = await project("sibling", "SIBLING")
    await writeFile(join(sibling, "secret.ts"), "export const secret = 1\n")
    // A symlink from inside the project to the sibling.
    await symlink(join(sibling, "secret.ts"), join(root, "link.ts"))
    // And a symlink to a directory outside the root.
    await symlink(sibling, join(root, "linkdir"))

    const inventory = await buildInventory({ root })
    const paths = inventory.entries.map(entry => entry.path)
    expect(paths).not.toContain("link.ts")
    expect(paths).not.toContain("linkdir/secret.ts")
    for (const path of paths) {
      expect(path.startsWith("..")).toBe(false)
      expect(path.startsWith("/")).toBe(false)
    }
  })

  test("the path filter rejects a path outside the root", async () => {
    const root = await project("project", "PROJECT")
    const filter = await buildPathFilter({ root })
    // The filter takes a path **relative to the root**.
    expect(filter("index.ts")).toBe(true)
    // A traversal is rejected: the path leaves the root.
    expect(filter("../other-repo/secret.ts")).toBe(false)
    expect(filter("../../etc/passwd")).toBe(false)
  })

  test("the path filter refuses an absolute path rather than following it", async () => {
    // The filter is a relative-path filter, and an absolute path is a
    // programming error, not a path to index. It throws rather than
    // quietly resolving.
    const root = await project("project", "PROJECT")
    const filter = await buildPathFilter({ root })
    expect(() => filter(join(root, "index.ts"))).toThrow()
  })

  test("the graph's path argument is a lookup key, not a filesystem path", async () => {
    // The `pi.graph` tool takes a `path` argument from the model. It is
    // used as a **key** into the index, in a parameterised query. A
    // traversal string matches nothing; it never reaches the filesystem.
    const source = await readFile(resolve(import.meta.dir, "../src/index.ts"), "utf8")
    expect(source).toContain("path: args.path")
    const persistent = await readFile(
      resolve(import.meta.dir, "../../retrieval/src/persistent.ts"),
      "utf8",
    )
    // The queries are parameterised, and the path is never concatenated.
    expect(persistent).toContain("WHERE path = ?")
    expect(persistent).not.toMatch(/WHERE path = \$\{/)
    expect(persistent).not.toMatch(/SELECT[\s\S]{0,80}FROM[\s\S]{0,80}\$\{[^}]*path/i)
  })

  test("the index refuses to serve a root it was not built for", async () => {
    // The root check: an index built for one tree must not be used for
    // another, because the rows would be wrong in a way nothing downstream
    // could see.
    const alpha = await project("alpha", "A")
    const beta = await project("beta", "B")
    const index = new PersistentIndex({ root: alpha, path: join(box, "index.sqlite") })
    index.close()
    // Opening it for a different root is refused.
    expect(() => new PersistentIndex({ root: beta, path: join(box, "index.sqlite") })).toThrow()
  })
})

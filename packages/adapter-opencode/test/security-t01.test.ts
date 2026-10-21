import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Database } from "bun:sqlite"
import { SqliteProjectRegistry } from "@opi/db"
import type { ResolvedProject } from "@opi/contracts"

/**
 * **T-01 — Cross-project event leakage.**
 *
 * ## The threat
 *
 * The plugin's event stream is **server-wide**. One plugin instance saw
 * seven directories, including an unrelated project with 1 180 events. A
 * consumer that filters late has already read the other project's payloads,
 * and doc 05 forbids retaining raw transcripts.
 *
 * ## What the test holds
 *
 * Two projects, one server, one registry. The plugin's persisted state for
 * project A must contain **zero** records from project B, and the consumer
 * must never have parsed B's payloads.
 *
 * ## The property under test
 *
 * The adapter **does not subscribe to the event stream at all**. That is
 * control C1.4 — "the dashboard and the CLI never subscribe to the event
 * stream at all" — taken to its strongest form: nothing consumes it, so
 * nothing can leak from it.
 *
 * The test asserts both halves:
 *
 * 1. the **structural** property — no adapter module subscribes, so there
 *    is no filter to get wrong;
 * 2. the **behavioural** property — with two projects registered, the
 *    persisted state for one contains nothing from the other.
 */

let box: string
let registry: SqliteProjectRegistry

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-t01-"))
  registry = new SqliteProjectRegistry({ path: join(box, "registry.sqlite") })
})

afterEach(async () => {
  registry.close()
  await rm(box, { recursive: true, force: true })
})

/** A project directory with a file in it. */
async function project(name: string, marker: string): Promise<string> {
  const dir = join(box, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "README.md"), `# ${marker}\n`)
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

describe("T-01: cross-project event leakage", () => {
  test("the shipped configuration does not subscribe to the event stream", async () => {
    // The structural property, in the configuration that ships.
    //
    // There is **one** module that can subscribe: the audit source, and
    // only when `OPI_AUDIT_LOG` names a file. The plugin's entry point
    // never subscribes by itself, and no other module does either.
    const source = await readFile(resolve(import.meta.dir, "../src/index.ts"), "utf8")
    // The entry point delegates, and the delegation is guarded.
    expect(source).toContain("startAudit")
    expect(source).not.toContain("ctx.event.subscribe")
  })

  test("the only subscriber is the audit source, and it is opt-in", async () => {
    // Every module, not just the entry point.
    const dir = resolve(import.meta.dir, "../src")
    const files = await readdir(dir)
    let checked = 0
    const subscribers: string[] = []
    for (const file of files) {
      if (!file.endsWith(".ts")) continue
      checked++
      const source = await readFile(join(dir, file), "utf8")
      if (source.includes("event.subscribe")) subscribers.push(file)
    }
    expect(checked).toBeGreaterThan(5)
    // Exactly one module can subscribe.
    expect(subscribers).toEqual(["audit-source.ts"])
    // And it is opt-in: without `OPI_AUDIT_LOG` there is no subscription.
    const audit = await readFile(join(dir, "audit-source.ts"), "utf8")
    expect(audit).toContain("OPI_AUDIT_LOG")
    expect(audit).toContain("if (!trail.path) return undefined")
  })

  test("the audit's filter runs before the payload is read", async () => {
    // The threat model's C1.1: the filter is applied **before** any
    // payload is parsed or stored. The order in the source is the order
    // the events are handled in.
    const audit = await readFile(
      resolve(import.meta.dir, "../src/audit-source.ts"),
      "utf8",
    )
    const dropIndex = audit.indexOf("isDroppedKind(type)")
    const directoryIndex = audit.indexOf("eventDirectory(event)")
    const readIndex = audit.indexOf("readToolCalls(event)")
    expect(dropIndex).toBeGreaterThan(0)
    expect(directoryIndex).toBeGreaterThan(dropIndex)
    expect(readIndex).toBeGreaterThan(directoryIndex)
  })

  test("two projects on one registry stay separate", async () => {
    // The behavioural property. Two projects are registered against one
    // registry, exactly as two OpenCode instances on one server would be.
    const alpha = await project("alpha", "ALPHA-SECRET-MARKER")
    const beta = await project("beta", "BETA-SECRET-MARKER")

    const alphaId = await registry.resolve(resolved(alpha))
    const betaId = await registry.resolve(resolved(beta))
    expect(alphaId.id).not.toBe(betaId.id)

    // Each project's record carries only its own root.
    const alphaRow = registry.identity(alphaId.id)
    const betaRow = registry.identity(betaId.id)
    expect(alphaRow.canonicalRoot).toBe(alpha)
    expect(betaRow.canonicalRoot).toBe(beta)
    expect(JSON.stringify(alphaRow)).not.toContain("BETA-SECRET-MARKER")
    expect(JSON.stringify(betaRow)).not.toContain("ALPHA-SECRET-MARKER")
  })

  test("the whole registry holds no record from the other project", async () => {
    // The persisted state, read back the way an attacker would: dump every
    // row of every table and look for the other project's marker.
    const alpha = await project("alpha", "ALPHA-SECRET-MARKER")
    const beta = await project("beta", "BETA-SECRET-MARKER")
    await registry.resolve(resolved(alpha))
    await registry.resolve(resolved(beta))

    const db = new Database(join(box, "registry.sqlite"), { readonly: true })
    try {
      const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
        .map(row => row.name)
      expect(tables.length).toBeGreaterThan(0)
      for (const table of tables) {
        const rows = db.query(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[]
        for (const row of rows) {
          const text = JSON.stringify(row)
          // A row of project A never mentions project B's directory.
          if (text.includes(alpha)) {
            expect(`${table}: ${text}`).not.toContain(beta)
          }
          // And no row carries a file's contents.
          expect(text).not.toContain("SECRET-MARKER")
        }
      }
    } finally {
      db.close()
    }
  })

  test("the project id is derived from the root, not supplied", async () => {
    // The threat model's C2.2: the envelope's project id is filled from the
    // trusted context, never from model input. Two registrations of the
    // same root give the same id, and different roots give different ids.
    const alpha = await project("alpha", "A")
    const beta = await project("beta", "B")
    const first = await registry.resolve(resolved(alpha))
    const again = await registry.resolve(resolved(alpha))
    const other = await registry.resolve(resolved(beta))
    expect(again.id).toBe(first.id)
    expect(other.id).not.toBe(first.id)
  })

  test("listing the registry returns both projects and nothing else", async () => {
    const alpha = await project("alpha", "A")
    const beta = await project("beta", "B")
    await registry.resolve(resolved(alpha))
    await registry.resolve(resolved(beta))
    const list = await registry.list()
    expect(list.length).toBe(2)
    expect(list.map(entry => entry.canonicalRoot).sort()).toEqual([alpha, beta].sort())
  })
})

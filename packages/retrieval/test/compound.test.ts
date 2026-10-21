import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PersistentIndex } from "../src/persistent.ts"
import { assembleContext } from "../src/context.ts"

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opi-compound-"))
  await mkdir(join(root, "src"), { recursive: true })
  await writeFile(
    join(root, "src", "contracts.ts"),
    "export const SCHEMA_VERSION = '1'\nexport function resolveThing(): number { return 1 }\n",
  )
  await writeFile(
    join(root, "src", "other.ts"),
    "export function unrelated(): number { return 2 }\nexport const VERSION = '2'\n",
  )
  return root
}

describe("the compound name match", () => {
  test("a question's words find a symbol whose name is built from them", async () => {
    const root = await project()
    const index = new PersistentIndex({ root })
    await index.rebuild()

    // The question names no symbol. "schema version" is the symbol's name.
    const result = assembleContext(index, "where is the schema version constant set")
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.candidates[0]?.path).toBe("src/contracts.ts")
    expect(result.candidates[0]?.reason).toContain("SCHEMA_VERSION")

    index.close()
    await rm(root, { recursive: true, force: true })
  })

  test("a shape word is dropped so the name can still match", async () => {
    const root = await project()
    const index = new PersistentIndex({ root })
    await index.rebuild()

    // "constant" describes the kind of thing; it is not part of the name.
    const result = assembleContext(index, "where is the schema version constant set")
    const reasons = result.candidates.map((candidate) => candidate.reason).join(" ")
    expect(reasons).toContain("schema version")

    index.close()
    await rm(root, { recursive: true, force: true })
  })

  test("an exact match still outranks a compound match", async () => {
    const root = await project()
    const index = new PersistentIndex({ root })
    await index.rebuild()

    const result = assembleContext(index, "where is resolveThing defined")
    expect(result.candidates[0]?.reason).toBe("defines resolveThing")

    index.close()
    await rm(root, { recursive: true, force: true })
  })

  test("an index written before the compound signal is repaired", async () => {
    const root = await project()
    const path = join(root, "index.sqlite")

    const first = new PersistentIndex({ root, path })
    await first.rebuild()
    first.close()

    // Simulate an index written by an older version: the concept rows carry
    // no `per_symbol_all`. The column is added on open, and the refresh
    // backfills the rows.
    const raw = new Database(path)
    raw.exec("ALTER TABLE index_concepts DROP COLUMN per_symbol_all")
    raw.close()

    const second = new PersistentIndex({ root, path })
    await second.refresh()
    const result = assembleContext(second, "where is the schema version constant set")
    expect(result.candidates[0]?.path).toBe("src/contracts.ts")

    second.close()
    await rm(root, { recursive: true, force: true })
  })
})

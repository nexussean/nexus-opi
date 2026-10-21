import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PersistentIndex } from "../src/persistent.ts"
import { assembleContext } from "../src/context.ts"

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opi-idx-"))
  await mkdir(join(root, "src"), { recursive: true })
  await writeFile(
    join(root, "src", "a.ts"),
    "export function alpha(): number { return 1 }\nexport function beta(): number { return 2 }\n",
  )
  await writeFile(join(root, "src", "b.ts"), "export function gamma(): number { return 3 }\n")
  return root
}

describe("PersistentIndex: targeted reindex", () => {
  test("reindexes only the paths it is given", async () => {
    const root = await project()
    const index = new PersistentIndex({ root })
    await index.rebuild()
    const before = index.stats()

    await writeFile(join(root, "src", "a.ts"), "export function delta(): number { return 9 }\n")
    const after = await index.reindexPaths(["src/a.ts"])

    expect(after.files).toBe(before.files)
    // The new symbol is present and the old one is gone.
    expect(index.filesDefining("delta").length).toBe(1)
    expect(index.filesDefining("alpha").length).toBe(0)
    // The untouched file keeps its symbols.
    expect(index.filesDefining("gamma").length).toBe(1)
    index.close()
    await rm(root, { recursive: true, force: true })
  })

  test("a deleted file leaves the index", async () => {
    const root = await project()
    const index = new PersistentIndex({ root })
    await index.rebuild()
    expect(index.stats().files).toBe(2)

    await rm(join(root, "src", "b.ts"))
    const after = await index.reindexPaths(["src/b.ts"])

    expect(after.files).toBe(1)
    expect(index.filesDefining("gamma").length).toBe(0)
    index.close()
    await rm(root, { recursive: true, force: true })
  })

  test("an unchanged file costs nothing", async () => {
    const root = await project()
    const index = new PersistentIndex({ root })
    await index.rebuild()
    const epoch = index.epoch

    // Re-indexing an unchanged file must not start a new epoch.
    await index.reindexPaths(["src/a.ts"])
    expect(index.epoch).toBe(epoch)
    index.close()
    await rm(root, { recursive: true, force: true })
  })

  test("an unknown path is ignored", async () => {
    const root = await project()
    const index = new PersistentIndex({ root })
    await index.rebuild()

    await index.reindexPaths(["does/not/exist.ts", "", "../escape.ts"])
    expect(index.stats().files).toBe(2)
    index.close()
    await rm(root, { recursive: true, force: true })
  })

  test("a secret path is never read", async () => {
    const root = await project()
    const index = new PersistentIndex({ root })
    await index.rebuild()

    await writeFile(join(root, ".env"), "SECRET_TOKEN=abc123\n")
    await index.reindexPaths([".env"])

    // The secret is not indexed and not searchable.
    expect(index.files().some((file) => file.path.includes(".env"))).toBe(false)
    index.close()
    await rm(root, { recursive: true, force: true })
  })

  test("a path outside the project is refused", async () => {
    const root = await project()
    const index = new PersistentIndex({ root })
    await index.rebuild()

    await index.reindexPaths(["../../etc/passwd"])
    expect(index.stats().files).toBe(2)
    index.close()
    await rm(root, { recursive: true, force: true })
  })
})

describe("PersistentIndex: persistence", () => {
  test("a persisted index survives a restart", async () => {
    const root = await project()
    const path = join(root, "index.sqlite")

    const first = new PersistentIndex({ root, path })
    await first.rebuild()
    const files = first.stats().files
    first.close()

    // A new process opens the same database and finds the index already there.
    const second = new PersistentIndex({ root, path })
    expect(second.stats().files).toBe(files)
    expect(second.filesDefining("alpha").length).toBe(1)
    second.close()
    await rm(root, { recursive: true, force: true })
  })

  test("a persisted index is updated, not duplicated", async () => {
    const root = await project()
    const path = join(root, "index.sqlite")

    const first = new PersistentIndex({ root, path })
    await first.rebuild()
    first.close()

    await writeFile(join(root, "src", "a.ts"), "export function epsilon(): number { return 5 }\n")

    const second = new PersistentIndex({ root, path })
    // A refresh finds the change without a full rebuild.
    await second.refresh()
    expect(second.stats().files).toBe(2)
    expect(second.filesDefining("epsilon").length).toBe(1)
    expect(second.filesDefining("alpha").length).toBe(0)
    second.close()
    await rm(root, { recursive: true, force: true })
  })

  test("a persisted index answers a question that names no symbol", async () => {
    const root = await project()
    const path = join(root, "index.sqlite")

    const first = new PersistentIndex({ root, path })
    await first.rebuild()
    first.close()

    // A fresh open, as after a restart. The concept layer used to live only
    // in memory, so a persisted index had **no concepts at all** and every
    // natural-language question came back empty while an in-memory index
    // answered it. The file count was identical; only the answers differed.
    const second = new PersistentIndex({ root, path })
    const result = assembleContext(second, "alpha beta storage")

    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.partial).toBe(false)
    second.close()
    await rm(root, { recursive: true, force: true })
  })

  test("an index written before concepts existed is repaired", async () => {
    const root = await project()
    const path = join(root, "index.sqlite")

    const first = new PersistentIndex({ root, path })
    await first.rebuild()
    first.close()

    // Simulate an index written by an older version: the files are indexed
    // but the concept rows are gone.
    const raw = new Database(path)
    raw.exec("DELETE FROM index_concepts")
    raw.close()

    const second = new PersistentIndex({ root, path })
    // The refresh backfills the missing concepts.
    await second.refresh()
    const result = assembleContext(second, "alpha beta storage")
    expect(result.candidates.length).toBeGreaterThan(0)
    second.close()
    await rm(root, { recursive: true, force: true })
  })

  test("an index opens when its directory does not exist", async () => {
    const root = await project()
    // The path is inside a directory that has never been created. SQLite
    // creates the file but not the directory, so this used to fail with
    // "unable to open database file" — at plugin setup, which is the worst
    // possible moment.
    const path = join(root, "no", "such", "directory", "index.sqlite")

    const index = new PersistentIndex({ root, path })
    await index.rebuild()
    expect(index.stats().files).toBe(2)
    index.close()
    await rm(root, { recursive: true, force: true })
  })

  test("an index that cannot be opened fails loudly", async () => {
    const root = await project()
    // A directory where the database file should be: SQLite cannot open it.
    const blocked = join(root, "blocked")
    await mkdir(blocked, { recursive: true })

    // The failure is real, and the caller is expected to handle it. A plugin
    // must not let this reach its setup, because a plugin that throws during
    // setup loses its whole tool surface.
    expect(() => new PersistentIndex({ root, path: blocked })).toThrow()

    // The fallback — an in-memory index — still works.
    const fallback = new PersistentIndex({ root })
    await fallback.rebuild()
    expect(fallback.stats().files).toBe(2)
    fallback.close()
    await rm(root, { recursive: true, force: true })
  })

  test("an index refuses a different project", async () => {    const root = await project()
    const other = await project()
    const path = join(root, "index.sqlite")

    const first = new PersistentIndex({ root, path })
    await first.rebuild()
    first.close()

    // Opening another project's tree against this database must fail: the
    // stored rows belong to a different tree, and nothing downstream could
    // tell that from the results.
    expect(() => new PersistentIndex({ root: other, path })).toThrow(/was built for/)
    await rm(root, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  })
})

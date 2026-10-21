import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PersistentIndex } from "../src/persistent.ts"
import { buildInventory, hashContent, isSecretPath } from "../src/inventory.ts"

let box: string

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-index-"))
})

afterEach(async () => {
  await rm(box, { recursive: true, force: true })
})

async function write(relative: string, content: string): Promise<void> {
  const full = join(box, relative)
  await mkdir(join(full, ".."), { recursive: true })
  await writeFile(full, content)
}

describe("inventory", () => {
  test("indexes source files and skips the rest", async () => {
    await write("src/main.ts", "export const a = 1\n")
    await write("src/main.go", "package main\n")
    await write("README.md", "# hello\n")
    await write("node_modules/pkg/index.js", "module.exports = 1\n")

    const inventory = await buildInventory({ root: box })
    const paths = inventory.entries.map((entry) => entry.path)

    expect(paths).toContain("src/main.ts")
    expect(paths).toContain("src/main.go")
    expect(paths).not.toContain("README.md")
    expect(paths).not.toContain("node_modules/pkg/index.js")
  })

  test("honours the project's .gitignore", async () => {
    await write(".gitignore", "generated/\n*.gen.ts\n")
    await write("src/keep.ts", "export const a = 1\n")
    await write("generated/skip.ts", "export const b = 2\n")
    await write("src/thing.gen.ts", "export const c = 3\n")

    const inventory = await buildInventory({ root: box })
    const paths = inventory.entries.map((entry) => entry.path)

    expect(paths).toContain("src/keep.ts")
    expect(paths).not.toContain("generated/skip.ts")
    expect(paths).not.toContain("src/thing.gen.ts")
  })

  test("never indexes a secret path", async () => {
    await write(".env", "SECRET=1\n")
    await write("keys/private.pem", "-----BEGIN-----\n")
    await write("config/credentials.json", "{}\n")
    await write("src/safe.ts", "export const a = 1\n")

    const inventory = await buildInventory({ root: box })
    const paths = inventory.entries.map((entry) => entry.path)

    expect(paths).not.toContain(".env")
    expect(paths).not.toContain("keys/private.pem")
    expect(paths).not.toContain("config/credentials.json")
    expect(paths).toContain("src/safe.ts")
  })

  test("a secret path is recognised before it is ever read", () => {
    expect(isSecretPath(".env")).toBe(true)
    expect(isSecretPath("keys/id_rsa")).toBe(true)
    expect(isSecretPath("src/index.ts")).toBe(false)
  })

  test("a symlink that leaves the root is skipped", async () => {
    const outside = await mkdtemp(join(tmpdir(), "opi-outside-"))
    await writeFile(join(outside, "secret.ts"), "export const secret = 1\n")
    await write("src/inside.ts", "export const a = 1\n")
    await symlink(join(outside, "secret.ts"), join(box, "src", "escape.ts"))

    const inventory = await buildInventory({ root: box })
    const paths = inventory.entries.map((entry) => entry.path)

    expect(paths).toContain("src/inside.ts")
    expect(paths).not.toContain("src/escape.ts")
    await rm(outside, { recursive: true, force: true })
  })

  test("a file over the size limit is skipped", async () => {
    await write("src/big.ts", `export const big = "${"x".repeat(5000)}"\n`)
    await write("src/small.ts", "export const small = 1\n")

    const inventory = await buildInventory({ root: box, maxFileBytes: 100 })
    const paths = inventory.entries.map((entry) => entry.path)

    expect(paths).toContain("src/small.ts")
    expect(paths).not.toContain("src/big.ts")
  })

  test("the hash changes when the content does", async () => {
    expect(await hashContent("a")).not.toBe(await hashContent("b"))
    expect(await hashContent("a")).toBe(await hashContent("a"))
  })
})

describe("PersistentIndex", () => {
  test("builds an epoch with files and symbols", async () => {
    await write("src/main.ts", "export function alpha() { return 1 }\n")
    const index = new PersistentIndex({ root: box })
    const stats = await index.rebuild()

    expect(stats.epoch).toBe(1)
    expect(stats.files).toBe(1)
    expect(stats.symbols).toBeGreaterThan(0)
    expect(stats.languages).toContain("typescript")
    index.close()
  })

  test("indexes Go as a first-class language", async () => {
    await write("main.go", "package main\n\nfunc main() {}\n")
    const index = new PersistentIndex({ root: box })
    const stats = await index.rebuild()

    expect(stats.languages).toContain("go")
    const symbols = index.symbolsIn("main.go")
    expect(symbols.map((symbol) => symbol.name)).toContain("main")
    index.close()
  })

  test("a Go method gets a qualified name from its receiver", async () => {
    await write("server.go", `package main

type Server struct{}

func (s *Server) Start() error { return nil }
`)
    const index = new PersistentIndex({ root: box })
    await index.rebuild()

    const symbols = index.symbolsIn("server.go")
    const method = symbols.find((symbol) => symbol.name === "Start")
    expect(method?.qualifiedName).toBe("Server.Start")
    index.close()
  })

  test("a refresh re-indexes only what changed", async () => {
    await write("src/one.ts", "export const one = 1\n")
    await write("src/two.ts", "export const two = 2\n")
    const index = new PersistentIndex({ root: box })
    await index.rebuild()

    const before = index.hashOf("src/one.ts")
    await write("src/one.ts", "export const one = 999\n")
    await index.refresh()

    expect(index.hashOf("src/one.ts")).not.toBe(before)
    expect(index.hashOf("src/two.ts")).toBe(index.hashOf("src/two.ts"))
    index.close()
  })

  test("a refresh with no changes keeps the epoch", async () => {
    await write("src/one.ts", "export const one = 1\n")
    const index = new PersistentIndex({ root: box })
    await index.rebuild()
    const epoch = index.epoch

    const stats = await index.refresh()
    expect(stats.epoch).toBe(epoch)
    index.close()
  })

  test("a deleted file is removed from the index", async () => {
    await write("src/one.ts", "export const one = 1\n")
    await write("src/two.ts", "export const two = 2\n")
    const index = new PersistentIndex({ root: box })
    await index.rebuild()
    expect(index.files()).toHaveLength(2)

    await rm(join(box, "src", "two.ts"))
    await index.refresh()

    expect(index.files().map((row) => row.path)).toEqual(["src/one.ts"])
    expect(index.symbolsIn("src/two.ts")).toEqual([])
    index.close()
  })

  test("a renamed file is indexed under its new name", async () => {
    await write("src/old.ts", "export const moved = 1\n")
    const index = new PersistentIndex({ root: box })
    await index.rebuild()

    await rename(join(box, "src", "old.ts"), join(box, "src", "new.ts"))
    await index.refresh()

    const paths = index.files().map((row) => row.path)
    expect(paths).toContain("src/new.ts")
    expect(paths).not.toContain("src/old.ts")
    index.close()
  })

  test("rapid edits settle on the last content", async () => {
    await write("src/rapid.ts", "export const v = 0\n")
    const index = new PersistentIndex({ root: box })
    await index.rebuild()

    for (let version = 1; version <= 5; version++) {
      await write("src/rapid.ts", `export const v = ${version}\n`)
      await index.refresh()
    }

    const source = index.hashOf("src/rapid.ts")
    expect(source).toBe(await hashContent("export const v = 5\n"))
    index.close()
  })

  test("an import edge is recorded as syntactic, never resolved", async () => {
    await write("src/a.ts", "export const a = 1\n")
    await write("src/b.ts", `import { a } from "./a"\n`)
    const index = new PersistentIndex({ root: box })
    await index.rebuild()

    const edges = index.importsIn("src/b.ts")
    expect(edges).toHaveLength(1)
    expect(edges[0]?.specifier).toBe("./a")
    expect(edges[0]?.confidence).toBe("syntactic")
    index.close()
  })

  test("the index survives a restart", async () => {
    await write("src/main.ts", "export function alpha() { return 1 }\n")
    const path = join(box, "index.sqlite")

    const first = new PersistentIndex({ root: box, path })
    await first.rebuild()
    const epoch = first.epoch
    first.close()

    const second = new PersistentIndex({ root: box, path })
    expect(second.epoch).toBe(epoch)
    expect(second.stats().files).toBe(1)
    expect(second.filesDefining("alpha")).toHaveLength(1)
    second.close()
  })

  test("a file with no adapter is reported, not silently dropped", async () => {
    await write("src/main.ts", "export const a = 1\n")
    const index = new PersistentIndex({ root: box, adapters: [] })
    const stats = await index.rebuild()

    expect(stats.files).toBe(0)
    expect(stats.failures.length).toBeGreaterThan(0)
    expect(stats.failures[0]?.reason).toContain("no adapter")
    index.close()
  })
})

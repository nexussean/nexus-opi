import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LexicalIndex, exactMatches } from "../src/lexical.ts"
import { PersistentIndex } from "../src/persistent.ts"

let box: string
let index: PersistentIndex
let lexical: LexicalIndex

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-lexical-"))
  await mkdir(join(box, "src"), { recursive: true })
  await writeFile(
    join(box, "src", "auth.ts"),
    `export class AuthService {
  login() { return true }
}
export function logout() { return false }
`,
  )
  await writeFile(
    join(box, "src", "handler.ts"),
    `import { AuthService } from "./auth"

export function handle() {
  return new AuthService()
}
`,
  )
  await writeFile(join(box, "src", "notes.md"), "not source\n")

  index = new PersistentIndex({ root: box })
  await index.rebuild()
  lexical = new LexicalIndex(index)
})

afterEach(async () => {
  index.close()
  await rm(box, { recursive: true, force: true })
})

describe("LexicalIndex", () => {
  test("finds a symbol by name", () => {
    const result = lexical.names("AuthService")
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0]?.path).toBe("src/auth.ts")
    expect(result.hits[0]?.confidence).toBe("resolved")
  })

  test("a hit cites the line the symbol is declared on", () => {
    const result = lexical.names("AuthService")
    const hit = result.hits.find((entry) => entry.symbol === "AuthService")
    expect(hit?.path).toBe("src/auth.ts")
    expect(hit?.startLine).toBe(0)
    expect(hit?.kind).toBe("class")
  })

  test("a name match is not reported as a body match", () => {
    const result = lexical.names("AuthService")
    for (const hit of result.hits) {
      expect(hit.matched).toBe("name")
    }
  })

  test("a body search finds mentions", () => {
    const result = lexical.search("login", { column: "body" })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0]?.matched).toBe("body")
    // A body mention is not a proven binding.
    expect(result.hits[0]?.confidence).toBe("syntactic")
  })

  test("a path search finds files by path", () => {
    const result = lexical.paths("handler")
    expect(result.hits.map((hit) => hit.path)).toContain("src/handler.ts")
  })

  test("an excluded file is not searchable", async () => {
    // A file the inventory skipped must not be findable.
    await writeFile(join(box, "src", "secret.ts"), "export const secretThing = 1\n")
    await writeFile(join(box, ".gitignore"), "src/secret.ts\n")
    await index.rebuild()

    const result = lexical.names("secretThing")
    expect(result.hits).toEqual([])
  })

  test("a non-source file is not indexed at all", () => {
    const result = lexical.names("source")
    expect(result.hits.map((hit) => hit.path)).not.toContain("src/notes.md")
  })

  test("the result names the epoch it was drawn from", () => {
    const result = lexical.names("AuthService")
    expect(result.epoch).toBe(index.epoch)
  })

  test("a rebuild during a query is reported", async () => {
    const stale = new LexicalIndex(index)
    await index.rebuild()
    const result = stale.names("AuthService")
    expect(result.warnings.join(" ")).toContain("rebuilt")
  })

  test("an empty term returns nothing", () => {
    expect(lexical.names("   ").hits).toEqual([])
  })

  test("a malformed term returns nothing rather than throwing", () => {
    expect(() => lexical.names('"unbalanced')).not.toThrow()
    expect(lexical.names('"unbalanced').hits).toEqual([])
  })

  test("exact matches are found and are resolved", () => {
    const matches = exactMatches(index, "AuthService")
    expect(matches).toHaveLength(1)
    expect(matches[0]?.path).toBe("src/auth.ts")
    expect(matches[0]?.confidence).toBe("resolved")
  })

  test("a path filter restricts the results", () => {
    const result = lexical.names("AuthService", { paths: ["src/nothing.ts"] })
    expect(result.hits).toEqual([])
  })
})

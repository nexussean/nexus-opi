import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodeIndex } from "../src/indexer.ts"
import { parse } from "../src/grammar.ts"
import { extractImports, resolveRelative } from "../src/imports.ts"
import { estimateTokens, interpretQuery, retrieve } from "../src/retrieve.ts"
import { extractSymbols, extractVariables } from "../src/symbols.ts"

let box: string

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-retrieval-"))
})

afterEach(async () => {
  await rm(box, { recursive: true, force: true })
})

async function write(relative: string, content: string): Promise<string> {
  const full = join(box, relative)
  await mkdir(join(full, ".."), { recursive: true })
  await writeFile(full, content)
  return full
}

describe("symbols", () => {
  test("extracts functions, classes and methods", () => {
    const source = `
export function alpha(x: string) { return x }
class Beta {
  gamma() { return 1 }
}
export interface Delta { a: number }
type Epsilon = string | number
enum Zeta { A }
`
    const { tree } = parse(source, "typescript")
    const symbols = extractSymbols(tree, source)
    const names = symbols.map((symbol) => symbol.name)

    expect(names).toContain("alpha")
    expect(names).toContain("Beta")
    expect(names).toContain("gamma")
    expect(names).toContain("Delta")
    expect(names).toContain("Epsilon")
    expect(names).toContain("Zeta")
  })

  test("a method gets a qualified name", () => {
    const source = `class Beta { gamma() { return 1 } }`
    const { tree } = parse(source, "typescript")
    const symbols = extractSymbols(tree, source)
    const gamma = symbols.find((symbol) => symbol.name === "gamma")
    expect(gamma?.qualifiedName).toBe("Beta.gamma")
  })

  test("records the source span", () => {
    const source = `function alpha() {\n  return 1\n}\n`
    const { tree } = parse(source, "typescript")
    const alpha = extractSymbols(tree, source).find((symbol) => symbol.name === "alpha")
    expect(alpha?.startLine).toBe(0)
    expect(alpha?.endLine).toBe(2)
  })

  test("extracts variables", () => {
    const source = `const answer = 42\nlet other = "x"`
    const { tree } = parse(source, "typescript")
    const names = extractVariables(tree, source).map((symbol) => symbol.name)
    expect(names).toContain("answer")
    expect(names).toContain("other")
  })
})

describe("imports", () => {
  test("extracts import, export and require specifiers", () => {
    const source = `
import { a } from "./a"
export { b } from "./b"
const c = require("./c")
const p = import("./d")
`
    const { tree } = parse(source, "typescript")
    const specifiers = extractImports(tree, source).map((edge) => edge.specifier)
    expect(specifiers).toContain("./a")
    expect(specifiers).toContain("./b")
    expect(specifiers).toContain("./c")
    expect(specifiers).toContain("./d")
  })

  test("resolves a relative specifier to a real file", () => {
    const files = new Set(["src/a.ts", "src/b/index.tsx"])
    expect(resolveRelative("./a", "src/main.ts", files)).toBe("src/a.ts")
    expect(resolveRelative("./b", "src/main.ts", files)).toBe("src/b/index.tsx")
    expect(resolveRelative("./missing", "src/main.ts", files)).toBeUndefined()
  })

  test("a package specifier is not resolved to a local file", () => {
    expect(resolveRelative("some-package", "src/main.ts", new Set(["src/a.ts"]))).toBeUndefined()
  })
})

describe("CodeIndex", () => {
  test("indexes files and symbols", async () => {
    await write("src/main.ts", `export function alpha() { return 1 }`)
    await write("src/other.ts", `import { alpha } from "./main"\nexport function beta() { return alpha() }`)

    const index = new CodeIndex(box)
    await index.build()

    expect(index.fileCount).toBe(2)
    expect(index.symbols.has("alpha")).toBe(true)
    expect(index.symbols.has("beta")).toBe(true)
    index.close()
  })

  test("resolves import edges between files", async () => {
    await write("src/main.ts", `export function alpha() { return 1 }`)
    await write("src/other.ts", `import { alpha } from "./main"`)

    const index = new CodeIndex(box)
    await index.build()

    expect(index.importersOf("src/main.ts")).toContain("src/other.ts")
    expect(index.importsOf("src/other.ts")).toContain("src/main.ts")
    index.close()
  })

  test("skips node_modules and build output", async () => {
    await write("src/main.ts", `export function alpha() { return 1 }`)
    await write("node_modules/thing/index.ts", `export function vendored() { return 1 }`)
    await write("dist/bundle.ts", `export function bundled() { return 1 }`)

    const index = new CodeIndex(box)
    await index.build()

    expect(index.fileCount).toBe(1)
    expect(index.symbols.has("vendored")).toBe(false)
    expect(index.symbols.has("bundled")).toBe(false)
    index.close()
  })

  test("the full-text search returns rows", async () => {
    await write("src/main.ts", `export function uniqueSymbolName() { return 1 }`)

    const index = new CodeIndex(box)
    await index.build()

    // A silently empty search is the failure mode that hides: a query that
    // throws returns nothing and looks like "no match".
    const rows = index.search("uniqueSymbol", "names", 10)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]?.path).toBe("src/main.ts")
    index.close()
  })

  test("a search for a term that is not there returns nothing", async () => {
    await write("src/main.ts", `export function alpha() { return 1 }`)
    const index = new CodeIndex(box)
    await index.build()
    expect(index.search("zzzznotthere", "names", 10)).toEqual([])
    index.close()
  })
})

describe("interpretQuery", () => {
  test("finds a camel-case identifier", () => {
    expect(interpretQuery("where is BoardStore defined").symbol).toBe("BoardStore")
  })

  test("finds a snake_case identifier", () => {
    expect(interpretQuery("where is board_store defined").symbol).toBe("board_store")
  })

  test("prefers a backticked name", () => {
    expect(interpretQuery("where is `resolveProject` defined").symbol).toBe("resolveProject")
  })

  test("drops question words", () => {
    const interpreted = interpretQuery("where does the board file get written")
    expect(interpreted.terms).not.toContain("where")
    expect(interpreted.terms).not.toContain("the")
    expect(interpreted.terms).toContain("board")
  })

  test("drops adverbs that qualify the question", () => {
    // "actually" and "really" describe the question, not the thing asked
    // about. Left in, they became domain terms in the concept layer, and
    // "where are the background jobs actually run" matched eight files on
    // "actually"/"run" instead of the one that runs the jobs.
    //
    // The held-out retrieval set caught this: the score fell from 0.920 to
    // 0.880 when "actually" was treated as a domain.
    const interpreted = interpretQuery("where are the background jobs actually run")
    expect(interpreted.terms).not.toContain("actually")
    expect(interpreted.terms).not.toContain("really")
    expect(interpreted.terms).toContain("background")
    expect(interpreted.terms).toContain("jobs")
  })
})

describe("retrieve", () => {
  test("an exact symbol ranks its definition first", async () => {
    await write("src/main.ts", `export function resolveProject() { return 1 }`)
    await write("src/other.ts", `import { resolveProject } from "./main"`)

    const index = new CodeIndex(box)
    await index.build()
    const result = retrieve(index, "where is resolveProject defined")

    expect(result.hits[0]?.path).toBe("src/main.ts")
    expect(result.hits[0]?.reason).toContain("defines resolveProject")
    index.close()
  })

  test("a definition outranks a file that merely mentions the name", async () => {
    await write("src/def.ts", `export function alpha() { return 1 }`)
    await write("src/noisy.ts", `// alpha alpha alpha alpha\n// alpha alpha alpha alpha`)

    const index = new CodeIndex(box)
    await index.build()
    const result = retrieve(index, "where is alpha defined")

    expect(result.hits[0]?.path).toBe("src/def.ts")
    index.close()
  })

  test("a file that imports the definition is reachable", async () => {
    await write("src/def.ts", `export function alpha() { return 1 }`)
    await write("src/user.ts", `import { alpha } from "./def"`)

    const index = new CodeIndex(box)
    await index.build()
    const result = retrieve(index, "what uses alpha")

    expect(result.hits.map((hit) => hit.path)).toContain("src/user.ts")
    index.close()
  })

  test("nothing is reported as resolved without a proven binding", async () => {
    await write("src/main.ts", `export function alpha() { return 1 }`)
    const index = new CodeIndex(box)
    await index.build()
    const result = retrieve(index, "where is alpha defined")

    for (const hit of result.hits) {
      expect(hit.confidence).toBe("syntactic")
    }
    index.close()
  })

  test("the pack carries a citation, not a whole file", async () => {
    const body = Array.from({ length: 200 }, (_, i) => `  const line${i} = ${i}`).join("\n")
    await write("src/main.ts", `export function alpha() {\n${body}\n}`)

    const index = new CodeIndex(box)
    await index.build()
    const result = retrieve(index, "where is alpha defined")

    expect(result.hits[0]?.snippet?.length).toBeLessThan(300)
    expect(result.tokens).toBeLessThan(200)
    index.close()
  })

  test("a question about nothing in the repository returns nothing", async () => {
    await write("src/main.ts", `export function alpha() { return 1 }`)
    const index = new CodeIndex(box)
    await index.build()
    const result = retrieve(index, "zzzznotarealthing")
    expect(result.hits.every((hit) => hit.score >= 0.05)).toBe(true)
    index.close()
  })
})

describe("estimateTokens", () => {
  test("is a conservative byte-to-token bound", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("abcd")).toBe(1)
    expect(estimateTokens("a".repeat(400))).toBe(100)
  })
})

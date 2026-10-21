import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GRAPH_ACTIONS, queryGraph } from "../src/graph.ts"
import { PersistentIndex } from "../src/persistent.ts"

let box: string
let index: PersistentIndex

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-graph-"))
  await mkdir(join(box, "src"), { recursive: true })
  await mkdir(join(box, "src", "__tests__"), { recursive: true })

  await writeFile(
    join(box, "src", "service.ts"),
    `export class AuthService {
  login() { return true }
}
export function helper() { return 1 }
`,
  )
  await writeFile(
    join(box, "src", "handler.ts"),
    `import { AuthService } from "./service"

export function handle() {
  const service = new AuthService()
  return service.login()
}
`,
  )
  await writeFile(
    join(box, "src", "__tests__", "service.test.ts"),
    `import { AuthService } from "../service"

test("login", () => {})
`,
  )

  index = new PersistentIndex({ root: box })
  await index.rebuild()
})

afterEach(async () => {
  index.close()
  await rm(box, { recursive: true, force: true })
})

describe("queryGraph", () => {
  test("symbol_search finds a definition and cites it", () => {
    const result = queryGraph(index, { action: "symbol_search", query: "AuthService" })

    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]?.path).toBe("src/service.ts")
    expect(result.nodes[0]?.confidence).toBe("resolved")
    expect(result.completeness).toBe("complete")
  })

  test("symbol_search for an unknown name returns nothing and says so", () => {
    const result = queryGraph(index, { action: "symbol_search", query: "NoSuchThing" })
    expect(result.nodes).toEqual([])
    expect(result.warnings.join(" ")).toContain("No symbol named")
  })

  test("importers reports the importer of the target", () => {
    const result = queryGraph(index, { action: "importers", query: "AuthService" })
    // The node is the definition; the reason names the importer.
    const reasons = result.nodes.map((node) => node.reason).join(" ")
    expect(reasons).toContain("src/handler.ts")
  })

  test("importers is never reported as complete", () => {
    const result = queryGraph(index, { action: "importers", query: "AuthService" })
    expect(result.completeness).toBe("partial")
    expect(result.completenessNote).toContain("not proof that it calls")
  })

  test("an import that names a declared symbol is resolved", () => {
    const result = queryGraph(index, { action: "importers", query: "AuthService" })
    const resolved = result.nodes.filter((node) => node.confidence === "resolved")
    expect(resolved.length).toBeGreaterThan(0)
    expect(resolved[0]?.path).toBe("src/service.ts")
    expect(resolved[0]?.reason).toContain("the name matches this definition")
  })

  test("callers is a superset, and says so", () => {
    const result = queryGraph(index, { action: "callers", query: "AuthService" })
    expect(result.completeness).toBe("partial")
    expect(result.completenessNote).toContain("superset")
    expect(result.nodes.every((node) => node.confidence === "syntactic")).toBe(true)
  })

  test("callers finds the places that mention a name, even when nothing is defined", async () => {
    // A type-only import is a mention, not a definition. The superset must
    // still find it.
    await writeFile(
      join(box, "src", "user.ts"),
      `import type { AuthService } from "./service"

export function use() {
  const value: AuthService | null = null
  return value
}
`,
    )
    await index.refresh()

    const result = queryGraph(index, { action: "callers", query: "AuthService" })
    expect(result.nodes.length).toBeGreaterThan(0)
    expect(result.nodes.some((node) => node.path === "src/user.ts")).toBe(true)
    expect(result.completeness).toBe("partial")
  })

  test("every node cites a file and a line", () => {
    const result = queryGraph(index, { action: "impact", query: "AuthService" })
    for (const node of result.nodes) {
      expect(node.path).toBeTruthy()
      expect(node.startLine).toBeGreaterThanOrEqual(0)
      expect(node.reason).toBeTruthy()
    }
  })

  test("neighbours stay within the hop limit", () => {
    const result = queryGraph(index, { action: "neighbors", query: "AuthService", maxHops: 1 })
    expect(result.limits.maxHops).toBe(1)
  })

  test("the hop limit is capped at three", () => {
    const result = queryGraph(index, { action: "neighbors", query: "AuthService", maxHops: 99 })
    expect(result.limits.maxHops).toBe(3)
  })

  test("a bounded result says it was truncated", () => {
    const result = queryGraph(index, { action: "impact", query: "AuthService", maxSymbols: 0 })
    expect(result.truncated).toBe(true)
    expect(result.warnings.join(" ")).toContain("Truncated")
  })

  test("related tests are candidates, labelled as such", () => {
    const result = queryGraph(index, { action: "related_tests", query: "AuthService" })
    expect(result.nodes.some((node) => node.path.includes("service.test.ts"))).toBe(true)
    expect(result.completeness).toBe("partial")
  })

  test("an unknown action warns rather than throwing", () => {
    const result = queryGraph(index, { action: "nonsense" as never, query: "x" })
    expect(result.nodes).toEqual([])
    expect(result.warnings.join(" ")).toContain("Unknown action")
  })

  test("every action the plan names is implemented", () => {
    expect(GRAPH_ACTIONS).toEqual([
      "symbol_search",
      "neighbors",
      "references",
      "callers",
      "importers",
      "impact",
      "related_tests",
    ])
  })
})

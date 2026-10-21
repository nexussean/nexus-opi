import { describe, expect, test } from "bun:test"
import { conceptFile, scoreConcept, splitTerms } from "../src/concept.ts"
import { containsSimilar, similar, tokenize, vocabulary } from "../src/tokens.ts"

describe("tokenize", () => {
  test("splits camel case into words", () => {
    expect(tokenize("BoardStore")).toEqual(["board", "store"])
  })

  test("splits snake case and kebab case", () => {
    expect(tokenize("board_store")).toEqual(["board", "store"])
    expect(tokenize("board-store")).toEqual(["board", "store"])
  })

  test("lower-cases and drops punctuation", () => {
    expect(tokenize("Hello, World!")).toEqual(["hello", "world"])
  })

  test("builds a distinct vocabulary", () => {
    expect([...vocabulary("alpha beta alpha gamma")].sort()).toEqual(["alpha", "beta", "gamma"])
  })
})

describe("similar", () => {
  test("matches inflected forms", () => {
    expect(similar("write", "writes")).toBe(true)
    expect(similar("write", "writing")).toBe(true)
    expect(similar("write", "written")).toBe(true)
    expect(similar("resolve", "resolved")).toBe(true)
    expect(similar("register", "registration")).toBe(true)
    expect(similar("index", "indexes")).toBe(true)
  })

  test("does not match a short prefix", () => {
    expect(similar("ab", "abcdef")).toBe(false)
  })

  test("does not match unrelated words", () => {
    expect(similar("board", "store")).toBe(false)
    expect(similar("resolve", "result")).toBe(false)
    expect(similar("worker", "worktree")).toBe(false)
  })

  test("finds a similar token in a set", () => {
    expect(containsSimilar(["board", "store"], "stor")).toBe(true)
    expect(containsSimilar(["board", "store"], "index")).toBe(false)
  })
})

describe("conceptFile", () => {
  test("only things that can act carry an action", () => {
    const file = conceptFile(
      [
        { name: "ResolvedProject", kind: "interface" },
        { name: "resolveProject", kind: "function" },
      ],
      "src/project/resolve.ts",
      "const identity = 1",
    )
    // The interface is in the file's vocabulary, but only the function can act.
    expect(file.symbolTokens.has("resolved")).toBe(true)
    expect(file.perSymbol).toHaveLength(1)
    expect([...file.perSymbol[0]!]).toContain("resolve")
  })
})

describe("scoreConcept", () => {
  const file = conceptFile(
    [
      { name: "resolveProjectPath", kind: "function" },
      { name: "ResolvedProject", kind: "interface" },
    ],
    "src/project/resolve.ts",
    "export function resolveProjectPath() { return 1 }",
  )

  test("a symbol carrying both terms is the strongest match", () => {
    const evidence = scoreConcept(file, ["project", "resolved"], ["project", "resolved"])
    expect(evidence?.score).toBeGreaterThan(1)
    expect(evidence?.actionIn).toBe("symbol")
    expect(evidence?.domainIn).toBe("symbol")
  })

  test("a type alone does not answer an action", () => {
    const typesOnly = conceptFile(
      [{ name: "ResolvedProject", kind: "interface" }],
      "src/contracts/index.ts",
      "export interface ResolvedProject {}",
    )
    const evidence = scoreConcept(typesOnly, ["resolved"], ["project"])
    // The action can only be found in the body, so it scores lower.
    expect(evidence?.actionIn).toBe("body")
  })

  test("a file with neither term does not match", () => {
    const unrelated = conceptFile([], "src/other.ts", "export const x = 1")
    expect(scoreConcept(unrelated, ["project"], ["board"])).toBeUndefined()
  })

  test("the same term is not paired with itself", () => {
    const evidence = scoreConcept(file, ["project"], ["project"])
    expect(evidence).toBeUndefined()
  })
})

describe("splitTerms", () => {
  test("every term is a candidate for both roles", () => {
    const split = splitTerms(["board", "written"])
    expect(split.actions).toContain("written")
    expect(split.domains).toContain("board")
  })
})

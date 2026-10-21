import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BUDGETS, assembleContext } from "../src/context.ts"
import { PersistentIndex } from "../src/persistent.ts"

let box: string
let index: PersistentIndex

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-context-"))
  await mkdir(join(box, "src"), { recursive: true })
  await writeFile(
    join(box, "src", "auth.ts"),
    `export class AuthService {
  login() { return true }
}
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
  index = new PersistentIndex({ root: box })
  await index.rebuild()
})

afterEach(async () => {
  index.close()
  await rm(box, { recursive: true, force: true })
})

describe("assembleContext", () => {
  test("an exact symbol is found and cited", () => {
    const result = assembleContext(index, "where is AuthService defined")
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.candidates[0]?.path).toBe("src/auth.ts")
    expect(result.candidates[0]?.confidence).toBe("resolved")
  })

  test("every candidate says why it was selected", () => {
    const result = assembleContext(index, "where is AuthService defined")
    for (const candidate of result.candidates) {
      expect(candidate.reason).toBeTruthy()
      expect(candidate.signals.length).toBeGreaterThan(0)
    }
  })

  test("one candidate per file", () => {
    const result = assembleContext(index, "where is AuthService defined")
    const paths = result.candidates.map((candidate) => candidate.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  test("the pack respects the budget", () => {
    const result = assembleContext(index, "AuthService", { budgetTokens: BUDGETS.min })
    expect(result.tokens).toBeLessThanOrEqual(BUDGETS.min)
  })

  test("the budget is clamped to the plan's range", () => {
    const tooSmall = assembleContext(index, "AuthService", { budgetTokens: 1 })
    expect(tooSmall.budgetTokens).toBe(BUDGETS.min)

    const tooBig = assembleContext(index, "AuthService", { budgetTokens: 999999 })
    expect(tooBig.budgetTokens).toBe(BUDGETS.max)
  })

  test("a truncated pack says so", () => {
    const result = assembleContext(index, "AuthService", { budgetTokens: BUDGETS.min, maxCandidates: 0 })
    expect(result.truncated).toBe(true)
    expect(result.warnings.join(" ")).toContain("cut at the")
  })

  test("a question the index cannot answer is partial, with a recommendation", () => {
    const result = assembleContext(index, "zzzznothinghere")
    expect(result.partial).toBe(true)
    expect(result.recommendation).toBeTruthy()
    expect(result.recommendation).toContain("not evidence")
  })

  test("the default budget is the plan's 1500", () => {
    expect(BUDGETS.default).toBe(1500)
    expect(assembleContext(index, "AuthService").budgetTokens).toBe(1500)
  })

  test("the file that answers the question ranks first", () => {
    const result = assembleContext(index, "where is the auth service defined")
    expect(result.candidates[0]?.path).toBe("src/auth.ts")
  })

  test("a test file does not outrank the implementation", async () => {
    await mkdir(join(box, "test"), { recursive: true })
    await writeFile(
      join(box, "test", "auth.test.ts"),
      `import { AuthService } from "../src/auth"

test("login", () => { new AuthService() })
`,
    )
    await index.rebuild()

    const result = assembleContext(index, "where is the auth service defined")
    const first = result.candidates[0]
    expect(first?.path).toBe("src/auth.ts")
    expect(first?.path).not.toContain("test")
  })

  test("a candidate carries a snippet", () => {
    const result = assembleContext(index, "where is AuthService defined")
    expect(result.candidates[0]?.snippet.length).toBeGreaterThan(0)
  })
})

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PersistentIndex } from "../src/persistent.ts"
import { resolveImports, resolvedDefinitions } from "../src/resolve.ts"

let box: string
let index: PersistentIndex

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-resolve-"))
  await mkdir(join(box, "src"), { recursive: true })

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
  return new AuthService()
}
`,
  )
  await writeFile(
    join(box, "src", "external.ts"),
    `import { thing } from "some-package"

export function use() { return thing }
`,
  )
  await writeFile(
    join(box, "src", "mismatched.ts"),
    `import { NotThere } from "./service"

export function use() { return NotThere }
`,
  )

  index = new PersistentIndex({ root: box })
  await index.rebuild()
})

afterEach(async () => {
  index.close()
  await rm(box, { recursive: true, force: true })
})

describe("resolveImports", () => {
  test("an import that names a declared symbol is resolved", () => {
    const result = resolveImports(index, "src/handler.ts")
    const binding = result.imports.find((edge) => edge.name === "AuthService")

    expect(binding?.confidence).toBe("resolved")
    expect(binding?.definition?.path).toBe("src/service.ts")
    expect(binding?.definition?.qualifiedName).toBe("AuthService")
  })

  test("an import of a package outside the project is unresolved", () => {
    const result = resolveImports(index, "src/external.ts")
    expect(result.imports[0]?.confidence).toBe("unresolved")
    expect(result.unresolved).toBe(1)
  })

  test("an import that names something the target does not declare stays syntactic", () => {
    const result = resolveImports(index, "src/mismatched.ts")
    const binding = result.imports[0]

    expect(binding?.confidence).toBe("syntactic")
    expect(binding?.definition).toBeUndefined()
  })

  test("unresolved imports are counted and reported", () => {
    const result = resolveImports(index, "src/external.ts")
    expect(result.warnings.join(" ")).toContain("could not be tied to a definition")
  })

  test("resolvedDefinitions gives the definitions a file imports", () => {
    const definitions = resolvedDefinitions(index, "src/handler.ts")
    expect(definitions).toHaveLength(1)
    expect(definitions[0]?.symbol.name).toBe("AuthService")
    expect(definitions[0]?.confidence).toBe("resolved")
    expect(definitions[0]?.via).toBe("src/handler.ts")
  })
})

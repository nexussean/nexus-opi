import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  constraintLines,
  isConstraint,
  isExpired,
  isStale,
  isUsable,
  search,
  withStaleness,
  type Memory,
} from "../src/memory/index.ts"

let box: string

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-memory-"))
  await mkdir(join(box, "src"), { recursive: true })
  await writeFile(join(box, "src", "a.ts"), "export const a = 1\n")
})

afterEach(async () => {
  await rm(box, { recursive: true, force: true })
})

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: overrides.id ?? "m1",
    projectId: "p1",
    kind: overrides.kind ?? "discovery",
    title: overrides.title ?? "A memory",
    body: overrides.body ?? "The body of the memory.",
    trust: overrides.trust ?? "proposed",
    provenance: overrides.provenance ?? { origin: "agent" },
    createdAt: overrides.createdAt ?? 1,
    stale: overrides.stale ?? false,
    ...overrides,
  }
}

describe("trust states", () => {
  test("only a confirmed memory or a verified fact is a constraint", () => {
    expect(isConstraint("human_confirmed")).toBe(true)
    expect(isConstraint("gate_verified")).toBe(true)
    expect(isConstraint("agent_reported")).toBe(false)
    expect(isConstraint("proposed")).toBe(false)
    expect(isConstraint("superseded")).toBe(false)
  })

  test("the trust states are distinct", () => {
    // The point of named states over a confidence number: a proposal is not
    // a decision, and a superseded memory is not either.
    expect(isConstraint("proposed")).not.toBe(isConstraint("human_confirmed"))
  })
})

describe("staleness", () => {
  test("a source-linked memory goes stale when its source changes", async () => {
    const content = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(box, "src", "a.ts"), "utf8"),
    )
    const hash = new Bun.CryptoHasher("sha256").update(content).digest("hex").slice(0, 16)
    const m = memory({
      trust: "gate_verified",
      provenance: { origin: "gate", source: "src/a.ts", sourceHash: hash },
    })
    expect(isStale(m, box)).toBe(false)

    await writeFile(join(box, "src", "a.ts"), "export const a = 2\n")
    expect(isStale(m, box)).toBe(true)
  })

  test("a memory with no source is never stale", () => {
    expect(isStale(memory({ provenance: { origin: "human" } }), box)).toBe(false)
  })

  test("a source that has been deleted is not stale", async () => {
    const m = memory({
      provenance: { origin: "gate", source: "src/gone.ts", sourceHash: "abc" },
    })
    expect(isStale(m, box)).toBe(false)
  })

  test("a stale memory is not usable as a fact", () => {
    const m = memory({ stale: true })
    expect(isUsable(m)).toBe(false)
  })

  test("an expired memory is not usable", () => {
    const m = memory({ expiresAt: Date.now() - 1 })
    expect(isExpired(m)).toBe(true)
    expect(isUsable(m)).toBe(false)
  })

  test("the staleness is recomputed, not stored", async () => {
    const content = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(box, "src", "a.ts"), "utf8"),
    )
    const hash = new Bun.CryptoHasher("sha256").update(content).digest("hex").slice(0, 16)
    const m = memory({
      stale: false,
      provenance: { origin: "gate", source: "src/a.ts", sourceHash: hash },
    })
    await writeFile(join(box, "src", "a.ts"), "export const a = 3\n")
    const [recomputed] = withStaleness([m], box)
    expect(recomputed?.stale).toBe(true)
  })
})

describe("search", () => {
  test("a proposal and a decision are returned separately", () => {
    // Both mention "sqlite", so both match. What differs is what they are:
    // one is a constraint and one is a lead.
    const memories = [
      memory({ id: "d1", trust: "human_confirmed", title: "Use SQLite for tasks" }),
      memory({ id: "p1", trust: "proposed", title: "SQLite may be slow here" }),
    ]
    const result = search(memories, "sqlite")
    expect(result.constraints.map((m) => m.id)).toEqual(["d1"])
    expect(result.leads.map((m) => m.id)).toEqual(["p1"])
  })

  test("a proposal is never in the constraints", () => {
    const memories = [memory({ id: "p1", trust: "proposed", title: "SQLite seems slow" })]
    const result = search(memories, "sqlite")
    expect(result.constraints).toHaveLength(0)
    expect(result.leads).toHaveLength(1)
  })

  test("a superseded memory is not returned by default", () => {
    const memories = [memory({ id: "s1", trust: "superseded", title: "Use JSON files" })]
    const result = search(memories, "json")
    expect(result.constraints).toHaveLength(0)
    expect(result.leads).toHaveLength(0)
    expect(result.superseded).toBeUndefined()
  })

  test("a superseded memory can be asked for", () => {
    const memories = [memory({ id: "s1", trust: "superseded", title: "Use JSON files" })]
    const result = search(memories, "json", { includeSuperseded: true })
    expect(result.superseded?.length).toBe(1)
  })

  test("the result is bounded and says so", () => {
    const memories = Array.from({ length: 10 }, (_, i) =>
      memory({ id: `m${i}`, trust: "human_confirmed", title: `Decision ${i}` }),
    )
    const result = search(memories, "decision", { limit: 3 })
    expect(result.returned).toBe(3)
    expect(result.truncated).toBe(true)
    expect(result.truncation_reason).toContain("3")
  })

  test("the constraints come first when the limit is spent", () => {
    const memories = [
      memory({ id: "p1", trust: "proposed", title: "Decision proposal" }),
      memory({ id: "d1", trust: "human_confirmed", title: "Decision real" }),
    ]
    const result = search(memories, "decision", { limit: 1 })
    expect(result.constraints.map((m) => m.id)).toEqual(["d1"])
  })

  test("a stale memory is returned with its staleness stated", () => {
    const memories = [memory({ id: "d1", trust: "human_confirmed", stale: true, title: "Old decision" })]
    const result = search(memories, "old")
    expect(result.constraints[0]?.stale).toBe(true)
  })

  test("the body is truncated by default", () => {
    const long = "x".repeat(2000)
    const memories = [memory({ id: "d1", trust: "human_confirmed", body: long })]
    const short = search(memories, "x")
    expect(short.constraints[0]?.body.length).toBeLessThan(700)
    const full = search(memories, "x", { fullBody: true })
    expect(full.constraints[0]?.body.length).toBe(2000)
  })

  test("a memory scoped to another worktree is not returned", () => {
    const memories = [
      memory({ id: "other", trust: "human_confirmed", worktreeId: "wt-2", title: "Elsewhere" }),
      memory({ id: "here", trust: "human_confirmed", worktreeId: "wt-1", title: "Here" }),
    ]
    const result = search(memories, "elsewhere here", { worktreeId: "wt-1" })
    expect(result.constraints.map((m) => m.id)).toEqual(["here"])
  })
})

describe("the constraint lines", () => {
  test("only constraints are included", () => {
    const memories = [
      memory({ id: "d1", trust: "human_confirmed", title: "A decision" }),
      memory({ id: "p1", trust: "proposed", title: "A proposal" }),
    ]
    const lines = constraintLines(memories)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("A decision")
  })

  test("the list is bounded", () => {
    const memories = Array.from({ length: 20 }, (_, i) =>
      memory({ id: `d${i}`, trust: "human_confirmed", title: `Decision ${i}` }),
    )
    expect(constraintLines(memories, { limit: 5 })).toHaveLength(5)
  })

  test("a stale constraint says so", () => {
    const memories = [memory({ id: "d1", trust: "human_confirmed", stale: true, title: "Old" })]
    expect(constraintLines(memories)[0]).toContain("stale")
  })
})

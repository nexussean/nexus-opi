import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveProject, type Handoff } from "@opi/core"
import { SqliteProjectRegistry } from "../src/registry.ts"
import { SqliteMemoryStore } from "../src/memory.ts"
import { registryPath } from "../src/paths.ts"

let box: string
let store: SqliteMemoryStore
let registry: SqliteProjectRegistry
let projectId: string

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-mstore-"))
  const path = registryPath(box)
  registry = new SqliteProjectRegistry({ path })
  store = new SqliteMemoryStore({ path })
  const projectDir = join(box, "project")
  await mkdir(projectDir, { recursive: true })
  const resolved = await resolveProject(projectDir, registry)
  if (!resolved) throw new Error("the test project could not be resolved")
  projectId = resolved.id
})

afterEach(async () => {
  store.close()
  registry.close()
  await rm(box, { recursive: true, force: true })
})

const propose = (overrides: Record<string, unknown> = {}) =>
  store.propose({
    projectId,
    kind: "discovery",
    title: "A discovery",
    body: "Something the agent noticed.",
    provenance: { origin: "agent" },
    ...overrides,
  })

describe("SqliteMemoryStore: propose", () => {
  test("a proposal is untrusted", () => {
    const result = propose()
    expect(result.ok).toBe(true)
    expect(result.value?.trust).toBe("proposed")
  })

  test("a memory with no title is refused", () => {
    const result = propose({ title: "   " })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("invalid_title")
  })

  test("a verified fact with no source hash is refused", () => {
    // A fact needs a fact's evidence. Without the hash, it is a claim.
    const result = propose({ kind: "verified_fact" })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("missing_source_hash")
  })

  test("the provenance is stored", () => {
    const result = propose({
      provenance: { origin: "agent", source: "src/a.ts", evidenceRef: "run-1" },
    })
    expect(result.value?.provenance.source).toBe("src/a.ts")
    expect(result.value?.provenance.evidenceRef).toBe("run-1")
  })
})

describe("SqliteMemoryStore: confirm", () => {
  test("a human confirmation makes a constraint", () => {
    const proposed = propose()
    const result = store.confirm(projectId, proposed.value!.id, "alice")
    expect(result.ok).toBe(true)
    expect(result.value?.trust).toBe("human_confirmed")
    expect(result.value?.kind).toBe("human_decision")
  })

  test("a confirmation with no actor is refused", () => {
    const proposed = propose()
    const result = store.confirm(projectId, proposed.value!.id, "  ")
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("missing_actor")
    // The memory is still a proposal.
    expect(store.get(proposed.value!.id)?.trust).toBe("proposed")
  })

  test("a superseded memory cannot be confirmed", () => {
    const proposed = propose()
    store.supersede(projectId, proposed.value!.id, {
      title: "Replacement",
      body: "The new truth.",
      actor: "alice",
    })
    const result = store.confirm(projectId, proposed.value!.id, "alice")
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("superseded")
  })
})

describe("SqliteMemoryStore: verify", () => {
  test("a gate verification makes a constraint", () => {
    const proposed = propose()
    const result = store.verify(projectId, proposed.value!.id, {
      source: "src/a.ts",
      sourceHash: "abc123",
      evidenceRef: "run-1",
    })
    expect(result.ok).toBe(true)
    expect(result.value?.trust).toBe("gate_verified")
    expect(result.value?.kind).toBe("verified_fact")
    expect(result.value?.provenance.sourceHash).toBe("abc123")
  })

  test("a verification with no source is refused", () => {
    const proposed = propose()
    const result = store.verify(projectId, proposed.value!.id, {
      source: "",
      sourceHash: "",
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("missing_source")
  })
})

describe("SqliteMemoryStore: supersede", () => {
  test("the old memory becomes superseded and the new one is a decision", () => {
    const proposed = propose({ title: "The old truth" })
    const result = store.supersede(projectId, proposed.value!.id, {
      title: "The new truth",
      body: "We changed our minds.",
      actor: "alice",
    })
    expect(result.ok).toBe(true)
    expect(result.value?.trust).toBe("human_confirmed")
    expect(result.value?.supersedesId).toBe(proposed.value!.id)
    expect(store.get(proposed.value!.id)?.trust).toBe("superseded")
  })

  test("a supersession with no actor is refused", () => {
    const proposed = propose()
    const result = store.supersede(projectId, proposed.value!.id, {
      title: "x",
      body: "y",
      actor: "",
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("missing_actor")
  })

  test("the superseded memory is retained, not deleted", () => {
    const proposed = propose()
    store.supersede(projectId, proposed.value!.id, {
      title: "x",
      body: "y",
      actor: "alice",
    })
    // The history of a decision is the point.
    expect(store.get(proposed.value!.id)).toBeDefined()
  })
})

describe("SqliteMemoryStore: delete", () => {
  test("deleting a memory leaves a tombstone", () => {
    const proposed = propose({ title: "To be removed" })
    const result = store.delete(projectId, proposed.value!.id, {
      reason: "no longer true",
      actor: "alice",
    })
    expect(result.ok).toBe(true)
    expect(store.get(proposed.value!.id)).toBeUndefined()

    const tombstones = store.tombstones(projectId)
    expect(tombstones.length).toBe(1)
    expect(tombstones[0]?.title).toBe("To be removed")
    expect(tombstones[0]?.reason).toBe("no longer true")
    expect(tombstones[0]?.actor).toBe("alice")
  })

  test("a deletion with no actor is refused", () => {
    const proposed = propose()
    const result = store.delete(projectId, proposed.value!.id, { reason: "x", actor: "" })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("missing_actor")
  })
})

describe("SqliteMemoryStore: handoffs", () => {
  const handoff = (overrides: Partial<Handoff> = {}): Handoff => ({
    completed: ["Did the thing"],
    evidence: [{ kind: "test_run", id: "run-1", outcome: "passed" }],
    decisions: [{ memoryId: "m1", trust: "human_confirmed" }],
    blockers: ["Nothing"],
    nextActions: ["The next thing"],
    worktree: { head: "abc" },
    createdAt: Date.now(),
    ...overrides,
  })

  test("a handoff is recorded and read back", () => {
    const result = store.recordHandoff(projectId, handoff({ taskId: "task-1" }))
    expect(result.ok).toBe(true)
    const found = store.latestHandoff("task-1")
    expect(found?.completed).toEqual(["Did the thing"])
    expect(found?.evidence[0]?.outcome).toBe("passed")
  })

  test("the latest handoff is the newest one", () => {
    store.recordHandoff(projectId, handoff({ taskId: "task-1", completed: ["First"] }))
    store.recordHandoff(projectId, handoff({ taskId: "task-1", completed: ["Second"] }))
    expect(store.latestHandoff("task-1")?.completed).toEqual(["Second"])
  })

  test("a project with no handoff has none", () => {
    expect(store.latestHandoffForProject(projectId)).toBeUndefined()
  })
})

describe("SqliteMemoryStore: sessions", () => {
  test("a session is linked to a project", () => {
    const result = store.linkSession("session-1", projectId, { currentTaskId: "task-1" })
    expect(result.ok).toBe(true)
    const session = store.session("session-1")
    expect(session?.projectId).toBe(projectId)
    expect(session?.currentTaskId).toBe("task-1")
  })

  test("linking the same session again updates it", () => {
    store.linkSession("session-1", projectId, { currentTaskId: "task-1" })
    store.linkSession("session-1", projectId, { currentTaskId: "task-2" })
    expect(store.session("session-1")?.currentTaskId).toBe("task-2")
  })

  test("a project's sessions are listed", () => {
    store.linkSession("session-1", projectId)
    store.linkSession("session-2", projectId)
    expect(store.sessions(projectId).length).toBe(2)
  })
})

describe("SqliteMemoryStore: durability", () => {
  test("memories survive a restart", () => {
    const proposed = propose({ title: "Durable" })
    store.confirm(projectId, proposed.value!.id, "alice")
    store.close()

    const reopened = new SqliteMemoryStore({ path: registryPath(box) })
    const found = reopened.get(proposed.value!.id)
    expect(found?.title).toBe("Durable")
    expect(found?.trust).toBe("human_confirmed")
    reopened.close()

    store = new SqliteMemoryStore({ path: registryPath(box) })
  })

  test("the migration is idempotent", () => {
    expect(store.migrated).toBe(true)
    store.close()
    const reopened = new SqliteMemoryStore({ path: registryPath(box) })
    expect(reopened.migrated).toBe(true)
    reopened.close()
    store = new SqliteMemoryStore({ path: registryPath(box) })
  })
})

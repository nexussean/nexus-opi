import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveProject } from "@opi/core"
import { SqliteTaskStore } from "../src/tasks.ts"
import { SqliteProjectRegistry } from "../src/registry.ts"
import { registryPath } from "../src/paths.ts"

let box: string
let store: SqliteTaskStore
let registry: SqliteProjectRegistry
let projectId: string

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-tasks-"))
  const path = registryPath(box)
  registry = new SqliteProjectRegistry({ path })
  store = new SqliteTaskStore({ path })
  // A project must exist before a task can reference it. The directory has
  // to exist for the resolver to find it.
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

const create = (title: string, extra: Record<string, unknown> = {}) =>
  store.create({ projectId, title, ...extra })

describe("SqliteTaskStore: create", () => {
  test("a task is created in backlog with a derived key", () => {
    const result = create("Fix the board store")
    expect(result.ok).toBe(true)
    expect(result.value?.publicKey).toBe("fix-the-board-store")
    expect(result.value?.state).toBe("backlog")
    expect(result.value?.revision).toBe(1)
    expect(result.value?.verification).toBe("not_configured")
  })

  test("an explicit key is kept", () => {
    const result = create("Anything", { publicKey: "PI-0012" })
    expect(result.value?.publicKey).toBe("PI-0012")
  })

  test("a colliding key is made unique", () => {
    create("Same title")
    const second = create("Same title")
    expect(second.ok).toBe(true)
    expect(second.value?.publicKey).toBe("same-title-2")
  })

  test("a task without a title is refused", () => {
    const result = create("   ")
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("invalid_title")
  })

  test("the creation is recorded in the history", () => {
    const created = create("Recorded")
    const history = store.history(created.value!.id)
    expect(history.length).toBe(1)
    expect(history[0]?.operation).toBe("created")
    expect(history[0]?.sequence).toBe(1)
  })
})

describe("SqliteTaskStore: update", () => {
  test("an update bumps the revision", () => {
    const created = create("Updatable")
    const result = store.update({
      taskId: created.value!.id,
      expectedRevision: 1,
      title: "Updated title",
    })
    expect(result.ok).toBe(true)
    expect(result.value?.title).toBe("Updated title")
    expect(result.value?.revision).toBe(2)
  })

  test("a stale revision is a conflict, and nothing is written", () => {
    const created = create("Conflicted")
    store.update({ taskId: created.value!.id, expectedRevision: 1, title: "First" })

    const stale = store.update({
      taskId: created.value!.id,
      expectedRevision: 1,
      title: "Second",
    })
    expect(stale.ok).toBe(false)
    expect(stale.reason).toBe("revision_conflict")

    // The first write stands. The stale one changed nothing.
    expect(store.get(created.value!.id)?.title).toBe("First")
    expect(store.get(created.value!.id)?.revision).toBe(2)
  })

  test("an update is recorded in the history", () => {
    const created = create("Audited")
    store.update({ taskId: created.value!.id, expectedRevision: 1, title: "New" })
    const history = store.history(created.value!.id)
    expect(history.length).toBe(2)
    expect(history[1]?.operation).toBe("updated")
    expect(history[1]?.changes.title).toBe("New")
  })

  test("an update to an unknown task is refused", () => {
    const result = store.update({ taskId: "nope", expectedRevision: 1, title: "x" })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("not_found")
  })
})

describe("SqliteTaskStore: transitions", () => {
  test("a legal transition is applied", () => {
    const created = create("Movable")
    const result = store.transition({
      taskId: created.value!.id,
      to: "ready",
      expectedRevision: 1,
    })
    expect(result.ok).toBe(true)
    expect(result.value?.state).toBe("ready")
    expect(result.value?.revision).toBe(2)
  })

  test("an illegal transition is refused", () => {
    const created = create("Not movable")
    // backlog -> done is not a legal workflow step.
    const result = store.transition({
      taskId: created.value!.id,
      to: "done",
      expectedRevision: 1,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("illegal_transition")
    expect(store.get(created.value!.id)?.state).toBe("backlog")
  })

  test("done is allowed when no gates are configured", () => {
    // The ADR-0022 exception: a project with no gate policy has nothing to
    // fail, so `done` is reachable. The task is still not *verified*.
    const created = create("No gates")
    store.transition({ taskId: created.value!.id, to: "ready", expectedRevision: 1 })
    store.transition({ taskId: created.value!.id, to: "in_progress", expectedRevision: 2 })
    store.transition({ taskId: created.value!.id, to: "review", expectedRevision: 3 })
    const result = store.transition({
      taskId: created.value!.id,
      to: "done",
      expectedRevision: 4,
    })
    expect(result.ok).toBe(true)
    expect(result.value?.state).toBe("done")
    expect(result.value?.verification).toBe("not_configured")
  })

  test("done is refused when the checks have not run", () => {
    const created = create("Gates pending")
    store.transition({ taskId: created.value!.id, to: "ready", expectedRevision: 1 })
    store.transition({ taskId: created.value!.id, to: "in_progress", expectedRevision: 2 })
    store.transition({ taskId: created.value!.id, to: "review", expectedRevision: 3 })
    store.setVerification(created.value!.id, "not_run")

    const result = store.transition({
      taskId: created.value!.id,
      to: "done",
      expectedRevision: 5,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("unverified")
    expect(store.get(created.value!.id)?.state).toBe("review")
  })

  test("done is refused when the checks failed", () => {
    const created = create("Gates failing")
    store.transition({ taskId: created.value!.id, to: "ready", expectedRevision: 1 })
    store.transition({ taskId: created.value!.id, to: "in_progress", expectedRevision: 2 })
    store.transition({ taskId: created.value!.id, to: "review", expectedRevision: 3 })
    store.setVerification(created.value!.id, "failed")

    const result = store.transition({
      taskId: created.value!.id,
      to: "done",
      expectedRevision: 5,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("unverified")
  })

  test("done is refused when the evidence is stale", () => {
    const created = create("Gates stale")
    store.transition({ taskId: created.value!.id, to: "ready", expectedRevision: 1 })
    store.transition({ taskId: created.value!.id, to: "in_progress", expectedRevision: 2 })
    store.transition({ taskId: created.value!.id, to: "review", expectedRevision: 3 })
    store.setVerification(created.value!.id, "stale")

    const result = store.transition({
      taskId: created.value!.id,
      to: "done",
      expectedRevision: 5,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("stale_evidence")
  })

  test("done is allowed when the checks passed", () => {
    const created = create("Gates passed")
    store.transition({ taskId: created.value!.id, to: "ready", expectedRevision: 1 })
    store.transition({ taskId: created.value!.id, to: "in_progress", expectedRevision: 2 })
    store.transition({ taskId: created.value!.id, to: "review", expectedRevision: 3 })
    store.setVerification(created.value!.id, "passed")

    const result = store.transition({
      taskId: created.value!.id,
      to: "done",
      expectedRevision: 5,
    })
    expect(result.ok).toBe(true)
    expect(result.value?.verification).toBe("passed")
  })

  test("a waiver lets a task reach done, and is recorded", () => {
    const created = create("Waived")
    store.transition({ taskId: created.value!.id, to: "ready", expectedRevision: 1 })
    store.transition({ taskId: created.value!.id, to: "in_progress", expectedRevision: 2 })
    store.transition({ taskId: created.value!.id, to: "review", expectedRevision: 3 })
    store.setVerification(created.value!.id, "failed")

    const result = store.transition({
      taskId: created.value!.id,
      to: "done",
      expectedRevision: 5,
      waiver: { actor: "alice", reason: "Docs only", scope: "lint", at: Date.now() },
    })
    expect(result.ok).toBe(true)
    expect(result.value?.verification).toBe("waived")
    expect(result.value?.waiver?.actor).toBe("alice")
    expect(result.value?.waiver?.reason).toBe("Docs only")
  })

  test("an incomplete waiver is refused", () => {
    const created = create("Bad waiver")
    store.transition({ taskId: created.value!.id, to: "ready", expectedRevision: 1 })
    store.transition({ taskId: created.value!.id, to: "in_progress", expectedRevision: 2 })
    store.transition({ taskId: created.value!.id, to: "review", expectedRevision: 3 })

    const result = store.transition({
      taskId: created.value!.id,
      to: "done",
      expectedRevision: 4,
      waiver: { actor: "", reason: "no reason", scope: "lint", at: Date.now() },
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("waiver_required")
  })

  test("a stale revision is a conflict on a transition too", () => {
    const created = create("Transition conflict")
    const result = store.transition({
      taskId: created.value!.id,
      to: "ready",
      expectedRevision: 99,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("revision_conflict")
  })
})

describe("SqliteTaskStore: edges", () => {
  test("tasks can be linked", () => {
    const a = create("First")
    const b = create("Second")
    const result = store.link({
      projectId,
      from: a.value!.id,
      to: b.value!.id,
      relation: "blocks",
    })
    expect(result.ok).toBe(true)
    expect(store.edges(projectId).length).toBe(1)
  })

  test("a cycle is refused", () => {
    const a = create("A")
    const b = create("B")
    const c = create("C")
    store.link({ projectId, from: a.value!.id, to: b.value!.id, relation: "blocks" })
    store.link({ projectId, from: b.value!.id, to: c.value!.id, relation: "blocks" })

    // C blocks A would close the loop.
    const result = store.link({
      projectId,
      from: c.value!.id,
      to: a.value!.id,
      relation: "blocks",
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("cycle")
    expect(store.hasCycle(projectId)).toBe(false)
  })

  test("a task cannot depend on itself", () => {
    const a = create("Self")
    const result = store.link({
      projectId,
      from: a.value!.id,
      to: a.value!.id,
      relation: "blocks",
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("self_reference")
  })

  test("a duplicate link is refused", () => {
    const a = create("Dup A")
    const b = create("Dup B")
    store.link({ projectId, from: a.value!.id, to: b.value!.id, relation: "blocks" })
    const result = store.link({
      projectId,
      from: a.value!.id,
      to: b.value!.id,
      relation: "blocks",
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("duplicate_edge")
  })

  test("a link can be removed", () => {
    const a = create("Unlink A")
    const b = create("Unlink B")
    store.link({ projectId, from: a.value!.id, to: b.value!.id, relation: "blocks" })
    const result = store.unlink({
      projectId,
      from: a.value!.id,
      to: b.value!.id,
      relation: "blocks",
    })
    expect(result.ok).toBe(true)
    expect(store.edges(projectId).length).toBe(0)
  })
})

describe("SqliteTaskStore: durability", () => {
  test("a task can be deleted, with its links and history", () => {
    const a = create("Delete A")
    const b = create("Delete B")
    store.link({ projectId, from: a.value!.id, to: b.value!.id, relation: "blocks" })

    const result = store.delete(a.value!.id)
    expect(result.ok).toBe(true)
    expect(store.get(a.value!.id)).toBeUndefined()
    expect(store.history(a.value!.id)).toEqual([])
    // The edge went with it.
    expect(store.edges(projectId).length).toBe(0)
  })

  test("deleting an unknown task is refused", () => {
    const result = store.delete("nope")
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("not_found")
  })

  test("the evidence state is derived, not set by an ordinary update", () => {
    const created = create("Derived evidence")
    // An ordinary update cannot claim a task is verified.
    store.update({ taskId: created.value!.id, expectedRevision: 1, title: "Changed" })
    expect(store.get(created.value!.id)?.verification).toBe("not_configured")

    // Only the verification service can record the derived state.
    store.setVerification(created.value!.id, "passed")
    expect(store.get(created.value!.id)?.verification).toBe("passed")
  })

  test("recording the evidence is audited", () => {
    const created = create("Audited evidence")
    store.setVerification(created.value!.id, "passed", { actor: "verifier" })
    const history = store.history(created.value!.id)
    const last = history[history.length - 1]
    expect(last?.operation).toBe("evidence")
    expect(last?.actor).toBe("verifier")
  })

  test("recording the evidence bumps the revision", () => {
    const created = create("Revision bump")
    const before = store.get(created.value!.id)!.revision
    store.setVerification(created.value!.id, "passed")
    expect(store.get(created.value!.id)!.revision).toBe(before + 1)
  })

  test("recording the same evidence again changes nothing", () => {
    const created = create("No-op evidence")
    store.setVerification(created.value!.id, "passed")
    const revision = store.get(created.value!.id)!.revision
    const result = store.setVerification(created.value!.id, "passed")
    expect(result.ok).toBe(true)
    expect(store.get(created.value!.id)!.revision).toBe(revision)
  })

  test("a waiver is recorded with the evidence", () => {
    const created = create("Waived evidence")
    store.setVerification(created.value!.id, "waived", {
      actor: "alice",
      waiver: { actor: "alice", reason: "docs only", scope: "lint", at: 1 },
    })
    const task = store.get(created.value!.id)!
    expect(task.verification).toBe("waived")
    expect(task.waiver?.actor).toBe("alice")
    expect(task.waiver?.reason).toBe("docs only")
  })

  test("tasks survive a restart", async () => {
    const created = create("Durable")
    store.close()

    const reopened = new SqliteTaskStore({ path: registryPath(box) })
    const found = reopened.get(created.value!.id)
    expect(found?.title).toBe("Durable")
    expect(reopened.history(created.value!.id).length).toBe(1)
    reopened.close()

    // Reopen for the afterEach cleanup.
    store = new SqliteTaskStore({ path: registryPath(box) })
  })

  test("the migration is idempotent", () => {
    expect(store.migrated).toBe(true)
    store.close()
    const reopened = new SqliteTaskStore({ path: registryPath(box) })
    expect(reopened.migrated).toBe(true)
    reopened.close()
    store = new SqliteTaskStore({ path: registryPath(box) })
  })
})

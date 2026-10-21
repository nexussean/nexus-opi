import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { toHistory, toList, toView, type Task, type TaskEdge } from "@opi/core"

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? "t1",
    projectId: "p1",
    publicKey: overrides.publicKey ?? "task-1",
    title: "A task",
    description: "",
    acceptance: "",
    type: "feature",
    state: overrides.state ?? "backlog",
    priority: overrides.priority ?? 2,
    verification: overrides.verification ?? "not_configured",
    revision: overrides.revision ?? 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe("the task view", () => {
  test("the verification state is always reported", () => {
    const view = toView(task())
    expect(view.verification).toBe("not_configured")
    expect(view.verification_note).toContain("Unverified")
  })

  test("a done task with no checks says it is unverified", () => {
    // The board must not present an unverified task as finished-and-clean.
    const view = toView(task({ state: "done", verification: "not_configured" }))
    expect(view.state).toBe("done")
    expect(view.verified).toBe(false)
    expect(view.verification_note).toContain("Unverified")
  })

  test("a verified task is marked verified", () => {
    const view = toView(task({ state: "done", verification: "passed" }))
    expect(view.verified).toBe(true)
  })

  test("the blockers are named", () => {
    const edges: TaskEdge[] = [{ from: "t1", to: "t2", relation: "blocks" }]
    const tasks = [task({ id: "t1", publicKey: "a" }), task({ id: "t2", publicKey: "b" })]
    const view = toView(tasks[1]!, { edges, tasks })
    expect(view.blocked_by).toEqual(["a"])
  })

  test("parent and related links are not blockers", () => {
    const edges: TaskEdge[] = [{ from: "t1", to: "t2", relation: "parent" }]
    const tasks = [task({ id: "t1", publicKey: "a" }), task({ id: "t2", publicKey: "b" })]
    expect(toView(tasks[1]!, { edges, tasks }).blocked_by).toBeUndefined()
  })
})

describe("the task list", () => {
  test("the waiting list names what each task waits for", () => {
    const tasks = [
      task({ id: "a", publicKey: "a", state: "backlog" }),
      task({ id: "b", publicKey: "b", state: "backlog" }),
    ]
    const edges: TaskEdge[] = [{ from: "a", to: "b", relation: "blocks" }]
    const list = toList(tasks, edges)
    expect(list.waiting.length).toBe(1)
    expect(list.waiting[0]).toEqual({ key: "b", blocked_by: ["a"] })
  })

  test("the next task is the one to work on", () => {
    const tasks = [
      task({ id: "a", publicKey: "a", priority: 3, createdAt: 1 }),
      task({ id: "b", publicKey: "b", priority: 1, createdAt: 2 }),
    ]
    expect(toList(tasks, []).next?.key).toBe("a")
  })

  test("the list is bounded", () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      task({ id: `t${i}`, publicKey: `t${i}` }),
    )
    const list = toList(tasks, [], { limit: 3 })
    expect(list.count).toBe(3)
    expect(list.total).toBe(10)
  })

  test("the list can be filtered by state", () => {
    const tasks = [
      task({ id: "a", publicKey: "a", state: "backlog" }),
      task({ id: "b", publicKey: "b", state: "done" }),
    ]
    expect(toList(tasks, [], { states: ["done"] }).count).toBe(1)
  })
})

describe("the task history", () => {
  test("the events are in order", () => {
    const events = [
      {
        id: "e1",
        taskId: "t1",
        sequence: 1,
        actor: "system",
        operation: "created",
        changes: { title: "A task" },
        createdAt: 1,
      },
      {
        id: "e2",
        taskId: "t1",
        sequence: 2,
        actor: "agent",
        operation: "transitioned",
        changes: { from: "backlog", to: "ready" },
        evidenceRef: "run-1",
        createdAt: 2,
      },
    ]
    const history = toHistory(task(), events)
    expect(history.events.length).toBe(2)
    expect(history.events[0]?.sequence).toBe(1)
    expect(history.events[1]?.evidence_ref).toBe("run-1")
  })
})

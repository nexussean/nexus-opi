import { describe, expect, test } from "bun:test"
import {
  allowedTransitions,
  canComplete,
  checkTransition,
  findBlocked,
  findCycle,
  isLegalTransition,
  isReady,
  isVerified,
  nextTask,
  verificationNote,
  wouldCreateCycle,
  type Task,
  type TaskEdge,
} from "../src/task/index.ts"

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
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const edge = (from: string, to: string, relation: TaskEdge["relation"] = "blocks"): TaskEdge => ({
  from,
  to,
  relation,
})

describe("the state machine", () => {
  test("the legal transitions are the plan's", () => {
    expect(isLegalTransition("backlog", "ready")).toBe(true)
    expect(isLegalTransition("ready", "in_progress")).toBe(true)
    expect(isLegalTransition("in_progress", "review")).toBe(true)
    expect(isLegalTransition("review", "done")).toBe(true)
    expect(isLegalTransition("review", "in_progress")).toBe(true)
    expect(isLegalTransition("done", "in_progress")).toBe(true)
    expect(isLegalTransition("done", "archived")).toBe(true)
  })

  test("skipping steps is refused", () => {
    expect(isLegalTransition("backlog", "done")).toBe(false)
    expect(isLegalTransition("backlog", "review")).toBe(false)
    expect(isLegalTransition("ready", "done")).toBe(false)
  })

  test("an archived task is terminal", () => {
    expect(allowedTransitions("archived")).toEqual([])
    expect(isLegalTransition("archived", "ready")).toBe(false)
  })

  test("moving to the same state is a no-op, not an error", () => {
    expect(isLegalTransition("ready", "ready")).toBe(true)
  })
})

describe("the completion rule", () => {
  test("done is refused when the checks have not run", () => {
    const result = canComplete({ verification: "not_run" })
    expect(result.ok).toBe(false)
  })

  test("done is refused when the checks failed", () => {
    expect(canComplete({ verification: "failed" }).ok).toBe(false)
  })

  test("done is refused when the evidence is stale", () => {
    const result = canComplete({ verification: "stale" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("stale_evidence")
  })

  test("done is allowed when the checks passed", () => {
    expect(canComplete({ verification: "passed" }).ok).toBe(true)
  })

  test("done is allowed when no gates are configured", () => {
    // ADR-0022: a project with no gate policy has nothing to fail.
    expect(canComplete({ verification: "not_configured" }).ok).toBe(true)
  })

  test("not_configured is not the same as passed", () => {
    expect(isVerified({ verification: "not_configured" })).toBe(false)
    expect(isVerified({ verification: "passed" })).toBe(true)
    expect(isVerified({ verification: "waived" })).toBe(true)
  })

  test("the note says plainly that an unconfigured project is unverified", () => {
    const note = verificationNote({ verification: "not_configured" })
    expect(note).toContain("Unverified")
    expect(note).toContain("no check policy")
  })

  test("the note names the actor for a waiver", () => {
    const note = verificationNote({
      verification: "waived",
      waiver: { actor: "alice", reason: "docs only", scope: "lint", at: 1 },
    })
    expect(note).toContain("alice")
    expect(note).toContain("docs only")
  })
})

describe("checkTransition", () => {
  test("a legal transition with sufficient evidence is accepted", () => {
    const result = checkTransition(task({ state: "review" }), "done")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.state).toBe("done")
  })

  test("an illegal transition is refused with the allowed list", () => {
    const result = checkTransition(task({ state: "backlog" }), "done")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("illegal_transition")
      expect(result.required).toContain("ready")
    }
  })

  test("a waiver supplied with the transition satisfies the evidence rule", () => {
    const result = checkTransition(task({ state: "review", verification: "failed" }), "done", {
      waiver: { actor: "alice", reason: "docs only", scope: "lint", at: 1 },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.verification).toBe("waived")
  })

  test("an incomplete waiver is refused", () => {
    const result = checkTransition(task({ state: "review" }), "done", {
      waiver: { actor: "", reason: "x", scope: "lint", at: 1 },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("waiver_required")
  })
})

describe("the dependency graph", () => {
  test("a cycle is detected", () => {
    const edges = [edge("a", "b"), edge("b", "c")]
    expect(wouldCreateCycle(edges, "c", "a")).toBe(true)
    expect(wouldCreateCycle(edges, "a", "c")).toBe(false)
  })

  test("an existing edge is not a cycle", () => {
    const edges = [edge("a", "b")]
    expect(wouldCreateCycle(edges, "a", "b")).toBe(false)
  })

  test("a self-edge is a cycle", () => {
    expect(wouldCreateCycle([], "a", "a")).toBe(true)
  })

  test("a cycle in a whole graph is found", () => {
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "a")]
    const cycle = findCycle(edges)
    expect(cycle).toBeDefined()
    expect(cycle?.length).toBe(3)
  })

  test("an acyclic graph has no cycle", () => {
    expect(findCycle([edge("a", "b"), edge("b", "c")])).toBeUndefined()
  })

  test("parent and related edges do not affect readiness", () => {
    const tasks = [task({ id: "a", state: "backlog" }), task({ id: "b", state: "backlog" })]
    const edges = [edge("a", "b", "parent"), edge("a", "b", "related")]
    expect(isReady(tasks[0]!, tasks, edges)).toBe(true)
  })

  test("a blocks edge does affect readiness", () => {
    const tasks = [task({ id: "a", state: "backlog" }), task({ id: "b", state: "backlog" })]
    const edges = [edge("a", "b", "blocks")]
    expect(isReady(tasks[1]!, tasks, edges)).toBe(false)
    expect(isReady(tasks[0]!, tasks, edges)).toBe(true)
  })

  test("a finished predecessor makes the successor ready", () => {
    const tasks = [task({ id: "a", state: "done" }), task({ id: "b", state: "backlog" })]
    expect(isReady(tasks[1]!, tasks, [edge("a", "b", "blocks")])).toBe(true)
  })

  test("a missing predecessor means not ready", () => {
    const tasks = [task({ id: "b", state: "backlog" })]
    expect(isReady(tasks[0]!, tasks, [edge("missing", "b", "blocks")])).toBe(false)
  })

  test("the blocked list names the predecessors", () => {
    const tasks = [
      task({ id: "a", publicKey: "a", state: "backlog" }),
      task({ id: "b", publicKey: "b", state: "backlog" }),
    ]
    const blocked = findBlocked(tasks, [edge("a", "b", "blocks")])
    expect(blocked.length).toBe(1)
    expect(blocked[0]?.taskKey).toBe("b")
    expect(blocked[0]?.blockedBy).toEqual(["a"])
  })

  test("the next task is the highest priority ready one", () => {
    const tasks = [
      task({ id: "a", publicKey: "a", priority: 1, createdAt: 1 }),
      task({ id: "b", publicKey: "b", priority: 3, createdAt: 2 }),
      task({ id: "c", publicKey: "c", priority: 2, createdAt: 3 }),
    ]
    expect(nextTask(tasks, [])?.id).toBe("b")
  })

  test("a task blocked by a dependency is not next", () => {
    const tasks = [
      task({ id: "a", publicKey: "a", priority: 3, createdAt: 1 }),
      task({ id: "b", publicKey: "b", priority: 1, createdAt: 2 }),
    ]
    const edges = [edge("b", "a", "blocks")]
    expect(nextTask(tasks, edges)?.id).toBe("b")
  })

  test("a task already in progress is not next", () => {
    const tasks = [task({ id: "a", state: "in_progress" })]
    expect(nextTask(tasks, [])).toBeUndefined()
  })
})

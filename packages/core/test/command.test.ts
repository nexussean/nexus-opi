import { describe, expect, test } from "bun:test"
import {
  formatBlockers,
  formatBoard,
  formatHandoff,
  formatList,
  formatNext,
  formatReview,
  type CommandContext,
} from "../src/command/index.ts"
import type { Task, TaskEdge } from "../src/task/index.ts"

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? "t1",
    projectId: "p1",
    publicKey: overrides.publicKey ?? "task-1",
    title: overrides.title ?? "A task",
    description: "",
    acceptance: overrides.acceptance ?? "",
    type: overrides.type ?? "feature",
    state: overrides.state ?? "backlog",
    priority: overrides.priority ?? 2,
    verification: overrides.verification ?? "not_configured",
    revision: 1,
    createdAt: overrides.createdAt ?? 1,
    updatedAt: 1,
    ...overrides,
  }
}

const edge = (from: string, to: string): TaskEdge => ({ from, to, relation: "blocks" })

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    projectId: "p1",
    tasks: [],
    edges: [],
    gates: [],
    root: "/tmp/project",
    head: "abc123",
    ...overrides,
  }
}

describe("the board", () => {
  test("an empty board says so", () => {
    expect(formatBoard(context())).toContain("The board is empty")
  })

  test("the tasks are listed by state", () => {
    const board = formatBoard(
      context({
        tasks: [
          task({ id: "a", publicKey: "a", state: "in_progress", title: "Working" }),
          task({ id: "b", publicKey: "b", state: "backlog", title: "Waiting" }),
        ],
      }),
    )
    expect(board).toContain("in_progress:")
    expect(board).toContain("Working")
    expect(board).toContain("backlog:")
  })

  test("an unverified task is marked", () => {
    const board = formatBoard(
      context({ tasks: [task({ id: "a", publicKey: "a", state: "backlog" })] }),
    )
    expect(board).toContain("[unverified]")
  })

  test("a verified task is not marked", () => {
    const board = formatBoard(
      context({
        tasks: [task({ id: "a", publicKey: "a", state: "done", verification: "passed" })],
      }),
    )
    expect(board).not.toContain("[unverified]")
  })

  test("a waiting task says what it waits for", () => {
    const board = formatBoard(
      context({
        tasks: [
          task({ id: "a", publicKey: "a", state: "backlog" }),
          task({ id: "b", publicKey: "b", state: "backlog" }),
        ],
        edges: [edge("a", "b")],
      }),
    )
    expect(board).toContain("waiting for a")
  })

  test("the next task is named", () => {
    const board = formatBoard(
      context({ tasks: [task({ id: "a", publicKey: "a", state: "ready", title: "Do it" })] }),
    )
    expect(board).toContain("Next: a")
  })

  test("the gates are listed with their state", () => {
    const board = formatBoard(
      context({
        tasks: [task({ id: "a" })],
        gates: [{ id: "core-tests", kind: "test", state: "approved", description: "", requiredForTypes: [] }],
      }),
    )
    expect(board).toContain("core-tests")
    expect(board).toContain("approved")
  })

  test("an unapproved gate says it does not run", () => {
    const board = formatBoard(
      context({
        tasks: [task({ id: "a" })],
        gates: [{ id: "core-tests", kind: "test", state: "proposed", description: "", requiredForTypes: [] }],
      }),
    )
    expect(board).toContain("it does not run")
  })
})

describe("the next task", () => {
  test("it names the task and its state", () => {
    const next = formatNext(
      context({ tasks: [task({ id: "a", publicKey: "a", state: "ready", title: "Do it" })] }),
    )
    expect(next).toContain("Next task: a")
    expect(next).toContain("Do it")
    expect(next).toContain("State: ready")
  })

  test("it states the evidence", () => {
    const next = formatNext(
      context({ tasks: [task({ id: "a", publicKey: "a", state: "ready" })] }),
    )
    expect(next).toContain("Evidence:")
    expect(next).toContain("Unverified")
  })

  test("it states the acceptance criteria", () => {
    const next = formatNext(
      context({
        tasks: [
          task({ id: "a", publicKey: "a", state: "ready", acceptance: "The tests pass" }),
        ],
      }),
    )
    expect(next).toContain("Done means:")
    expect(next).toContain("The tests pass")
  })

  test("it lists the checks the task needs", () => {
    const next = formatNext(
      context({
        tasks: [task({ id: "a", publicKey: "a", state: "ready", type: "feature" })],
        gates: [
          {
            id: "core-tests",
            kind: "test",
            state: "approved",
            description: "",
            requiredForTypes: ["feature"],
          },
        ],
      }),
    )
    expect(next).toContain("Checks this task needs:")
    expect(next).toContain("core-tests")
  })

  test("when nothing is ready it says what is waiting", () => {
    // `a` blocks `b`, and `a` is unfinished — so `b` is not ready and
    // `a` itself is in progress, so there is no *next* task.
    const next = formatNext(
      context({
        tasks: [
          task({ id: "a", publicKey: "a", state: "in_progress" }),
          task({ id: "b", publicKey: "b", state: "backlog" }),
        ],
        edges: [edge("a", "b")],
      }),
    )
    expect(next).toContain("Nothing new to start")
    expect(next).toContain("a is in progress")
    expect(next).toContain("b — waiting for a")
  })

  test("a board in progress does not say nothing is ready", () => {
    // Saying "nothing is ready" when something is in progress is wrong: the
    // board is not stuck, it is busy.
    const board = formatBoard(
      context({ tasks: [task({ id: "a", publicKey: "a", state: "in_progress" })] }),
    )
    expect(board).toContain("a is in progress")
    expect(board).not.toContain("Every task is waiting for a dependency")
  })

  test("when there is nothing at all it says so plainly", () => {
    expect(formatNext(context())).toContain("nothing is waiting")
  })
})

describe("the blockers", () => {
  test("a waiting task is listed", () => {
    const blockers = formatBlockers(
      context({
        tasks: [
          task({ id: "a", publicKey: "a" }),
          task({ id: "b", publicKey: "b" }),
        ],
        edges: [edge("a", "b")],
      }),
    )
    expect(blockers).toContain("b — waiting for a")
  })

  test("nothing waiting says so", () => {
    expect(formatBlockers(context())).toContain("Nothing is waiting")
  })
})

describe("the review", () => {
  test("it reports the evidence and does not force done", () => {
    const review = formatReview(
      context({ tasks: [task({ id: "a", publicKey: "a", state: "review" })] }),
      "a",
    )
    expect(review).toContain("Evidence:")
    expect(review).toContain("only reach 'done' on evidence")
  })

  test("an unknown task says so", () => {
    expect(formatReview(context(), "nope")).toContain("no task named nope")
  })

  test("a done task says it can be reopened", () => {
    const review = formatReview(
      context({ tasks: [task({ id: "a", publicKey: "a", state: "done" })] }),
      "a",
    )
    expect(review).toContain("Reopen it")
  })

  test("it lists the required checks", () => {
    const review = formatReview(
      context({
        tasks: [task({ id: "a", publicKey: "a", state: "review", type: "bug" })],
        gates: [
          {
            id: "core-tests",
            kind: "test",
            state: "approved",
            description: "",
            requiredForTypes: ["bug"],
          },
        ],
      }),
      "a",
    )
    expect(review).toContain("Required checks:")
  })
})

describe("the handoff", () => {
  test("it reports what was done, blocked and next", () => {
    const text = formatHandoff(context(), {
      taskKey: "a",
      status: "review",
      completed: ["Wrote the parser"],
      evidence: [{ kind: "test_run", id: "run-1", outcome: "passed" }],
      blockers: ["Windows is untested"],
      nextActions: ["Test on Windows"],
    })
    expect(text).toContain("Task: a (review)")
    expect(text).toContain("Wrote the parser")
    expect(text).toContain("run-1: passed")
    expect(text).toContain("Windows is untested")
    expect(text).toContain("Test on Windows")
  })

  test("it records the worktree head", () => {
    const text = formatHandoff(context(), {
      completed: [],
      evidence: [],
      blockers: [],
      nextActions: [],
    })
    expect(text).toContain("abc123")
  })
})

describe("the list", () => {
  test("the tasks are listed with their states", () => {
    const list = formatList(
      context({
        tasks: [
          task({ id: "a", publicKey: "a", state: "in_progress", title: "Working" }),
          task({ id: "b", publicKey: "b", state: "backlog", title: "Later" }),
        ],
      }),
    )
    expect(list).toContain("a")
    expect(list).toContain("in_progress")
    expect(list).toContain("Working")
  })

  test("it says when the list was cut", () => {
    const tasks = Array.from({ length: 40 }, (_, i) =>
      task({ id: `t${i}`, publicKey: `t${i}` }),
    )
    const list = formatList(context({ tasks }), 5)
    expect(list).toContain("Only the first 5 of 40")
  })

  test("an empty board says so", () => {
    expect(formatList(context())).toContain("no tasks")
  })
})

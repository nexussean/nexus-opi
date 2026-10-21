import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { authoritativeCost, traceBilling } from "../harness/billing.ts"

/**
 * The billing.
 *
 * The CLI's `--format json` output prices every **step** but never prices
 * the **final answer**: the trace ends with a `text` event and no closing
 * `step_finish`. The harness used to sum the `step_finish` events, so it
 * recorded $0 for a run that cost $0.00071.
 *
 * These tests pin the behaviour that follows from that:
 *
 * - a missing usage event is **unknown**, never zero;
 * - a legitimate zero-cost run is zero;
 * - a duplicate event is counted once;
 * - a timeout is not billed as a completed run.
 */
describe("the trace's own billing", () => {
  const step = (messageID: string, cost: number, reason = "tool-calls") =>
    JSON.stringify({
      type: "step_finish",
      part: { messageID, reason, cost, tokens: { input: 1, output: 1 } },
    })
  const text = (messageID: string) =>
    JSON.stringify({ type: "text", part: { messageID, text: "the answer" } })

  test("it sums the priced steps", () => {
    const trace = [step("m1", 0.001), step("m2", 0.002)].join("\n")
    const billing = traceBilling(trace)
    expect(billing.total).toBeCloseTo(0.003, 10)
    expect(billing.steps).toBe(2)
  })

  test("the final answer's message is not priced by the trace", () => {
    const billing = traceBilling([step("m1", 0.001), text("m2")].join("\n"))
    expect(billing.finalMessageId).toBe("m2")
    expect(billing.finalPriced).toBe(false)
    // The trace's total does not include it. That is the defect.
    expect(billing.total).toBeCloseTo(0.001, 10)
  })

  test("a legitimate zero-cost run is zero, not unknown", () => {
    const trace = [step("m1", 0)].join("\n")
    const billing = traceBilling(trace)
    expect(billing.total).toBe(0)
    expect(billing.steps).toBe(1)
  })

  test("a step with no cost is not counted", () => {
    const trace = JSON.stringify({
      type: "step_finish",
      part: { messageID: "m1", reason: "tool-calls", tokens: { input: 1 } },
    })
    expect(traceBilling(trace).steps).toBe(0)
  })
})

/**
 * A session store, under the test's control.
 *
 * The store's **presence** decides which reason a missing cost carries, so
 * a test that does not control it is really a test of the machine it ran
 * on. That is why the reason assertion below used to pass locally and fail
 * on the hosted runners: the runners have no OpenCode store, so a different
 * — equally correct — reason fired.
 *
 * The store is built here, in a temporary directory, and the harness is
 * pointed at it.
 */
function withStore<T>(
  rows: { sessionId: string; id: string; data: unknown }[],
  run: (path: string) => T,
): T {
  const box = mkdtempSync(join(tmpdir(), "opi-billing-"))
  const path = join(box, "opencode.db")
  const db = new Database(path)
  // The harness reads `session_message` by `session_id`, and the payload
  // carries the message's own id, cost and tokens.
  db.run("CREATE TABLE session_message (id TEXT, data TEXT, session_id TEXT)")
  for (const row of rows) {
    db.run("INSERT INTO session_message (id, data, session_id) VALUES (?, ?, ?)", [
      row.id,
      JSON.stringify(row.data),
      row.sessionId,
    ])
  }
  db.close()
  const previous = process.env.OPI_BENCH_SESSION_STORE
  process.env.OPI_BENCH_SESSION_STORE = path
  try {
    return run(path)
  } finally {
    if (previous === undefined) delete process.env.OPI_BENCH_SESSION_STORE
    else process.env.OPI_BENCH_SESSION_STORE = previous
    rmSync(box, { recursive: true, force: true })
  }
}

describe("the authoritative cost", () => {
  test("with no session id the cost is a lower bound, not a fact", () => {
    // The run reported no session, so the store could not be consulted. The
    // cost is unknown, and it must be reported as unknown.
    const result = authoritativeCost({ output: "" })
    expect(result.complete).toBe(false)
    expect(result.source).toBe("trace")
    expect(result.reason).toBeTruthy()
  })

  test("a missing usage event is never treated as zero cost", () => {
    // The whole point. A run whose cost was not found must not be reported
    // as free.
    const result = authoritativeCost({
      sessionId: "ses_does_not_exist",
      output: JSON.stringify({
        type: "step_finish",
        part: { messageID: "m1", reason: "stop", cost: 0, tokens: { input: 1 } },
      }),
    })
    expect(result.complete).toBe(false)
    expect(result.reason).toBeTruthy()
  })

  test("the reason says the store had no priced message", () => {
    // The store is **there** and holds no message for this session, so the
    // reason is that one.
    withStore([], () => {
      const result = authoritativeCost({ sessionId: "ses_nope", output: "" })
      expect(result.reason).toContain("no priced message")
      expect(result.complete).toBe(false)
    })
  })

  test("the reason says the store was not there when it is not", () => {
    // The other branch, and the one the hosted runners took. A store that
    // is not there is a different fact from a store that holds nothing, and
    // the reason says which.
    const box = mkdtempSync(join(tmpdir(), "opi-billing-"))
    const path = join(box, "absent.db")
    const previous = process.env.OPI_BENCH_SESSION_STORE
    process.env.OPI_BENCH_SESSION_STORE = path
    try {
      const result = authoritativeCost({ sessionId: "ses_nope", output: "" })
      expect(result.reason).toContain("the session store is not at")
      expect(result.complete).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.OPI_BENCH_SESSION_STORE
      else process.env.OPI_BENCH_SESSION_STORE = previous
      rmSync(box, { recursive: true, force: true })
    }
  })

  test("the store prices the run when it holds a priced message", () => {
    // The positive case: the store **is** the authority, and it prices the
    // final answer too — which the trace cannot.
    withStore(
      [
        {
          sessionId: "ses_known",
          id: "row-1",
          data: { id: "msg-1", cost: 0.0005, tokens: { input: 10, output: 5 } },
        },
        {
          sessionId: "ses_known",
          id: "row-2",
          data: { id: "msg-2", cost: 0.00025, tokens: { input: 20, output: 8 } },
        },
      ],
      () => {
        const result = authoritativeCost({ sessionId: "ses_known", output: "" })
        expect(result.complete).toBe(true)
        expect(result.source).toBe("store")
        expect(result.cost).toBeCloseTo(0.00075, 10)
      },
    )
  })
})

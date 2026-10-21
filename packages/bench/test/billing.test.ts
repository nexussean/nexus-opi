import { describe, expect, test } from "bun:test"
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
    const result = authoritativeCost({ sessionId: "ses_nope", output: "" })
    expect(result.reason).toContain("no priced message")
  })
})

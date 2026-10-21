import { describe, expect, test } from "bun:test"
import { summariseOutcomes } from "../harness/run.ts"

/**
 * The four metrics, kept apart.
 *
 * ## Why they must be separate
 *
 * The first version of the regrade excluded invalid runs from **every**
 * denominator. That is right for the **content accuracy** — a run that timed
 * out has no answer to be right or wrong about — and wrong for everything
 * else. Excluding timeouts from the end-to-end denominator would let a
 * surface that answers well *when it answers at all* look better than one
 * that answers reliably, and a user cannot tell the difference between the
 * two.
 *
 * So:
 *
 * | Metric | Denominator |
 * |---|---|
 * | **Content accuracy** | the runs that **executed** |
 * | **End-to-end success** | every run **attempted** |
 * | **Execution failure rate** | every run **attempted** |
 * | **Cost per successful task** | the spend of every attempt, over the correct completions |
 */

/** A run metric, for the summary. */
function run(options: {
  grade: "passed" | "failed" | "ungradable"
  cost: number
  error?: string
}): any {
  return {
    model: "m",
    shape: "s",
    task: { id: "t", name: "t", kind: "read", prompt: "p" },
    calls: [],
    totalCalls: 0,
    failedCalls: 0,
    discoveryCalls: 0,
    discoveryTools: {},
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cost: options.cost, steps: 1 },
    usageComplete: true,
    schemaBytes: 1,
    toolCount: 1,
    surfaceFingerprint: "f",
    durationMs: 1,
    error: options.error,
    verdict: { grade: options.grade, reasons: [] },
    billing: { cost: options.cost, complete: true, source: "store" as const },
  }
}

describe("the metrics, kept apart", () => {
  test("content accuracy is over the runs that executed", () => {
    // 2 of 3 executed runs are correct; the fourth never executed.
    const summary = summariseOutcomes([
      run({ grade: "passed", cost: 0.001 }),
      run({ grade: "passed", cost: 0.001 }),
      run({ grade: "failed", cost: 0.001 }),
      run({ grade: "passed", cost: 0.001, error: "Run timed out after 180 seconds" }),
    ])
    expect(summary.validRuns).toBe(3)
    expect(summary.invalidRuns).toBe(1)
    expect(summary.contentAccuracy).toBeCloseTo(2 / 3, 10)
  })

  test("end-to-end success is over every run attempted", () => {
    // The same four runs: the timeout is in this denominator, because the
    // user asked for an answer and did not get one.
    const summary = summariseOutcomes([
      run({ grade: "passed", cost: 0.001 }),
      run({ grade: "passed", cost: 0.001 }),
      run({ grade: "failed", cost: 0.001 }),
      run({ grade: "passed", cost: 0.001, error: "Run timed out after 180 seconds" }),
    ])
    expect(summary.attempted).toBe(4)
    expect(summary.successRate).toBeCloseTo(2 / 4, 10)
  })

  test("the execution failure rate is over every run attempted", () => {
    const summary = summariseOutcomes([
      run({ grade: "passed", cost: 0.001 }),
      run({ grade: "passed", cost: 0.001 }),
      run({ grade: "failed", cost: 0.001 }),
      run({ grade: "passed", cost: 0.001, error: "Run timed out after 180 seconds" }),
    ])
    expect(summary.executionFailureRate).toBeCloseTo(1 / 4, 10)
  })

  test("the two rates differ, and the difference is the execution failures", () => {
    // The property the separation exists for: an arm that answers well
    // when it answers at all has a **higher** content accuracy than its
    // end-to-end success.
    const summary = summariseOutcomes([
      run({ grade: "passed", cost: 0.001 }),
      run({ grade: "passed", cost: 0.001 }),
      run({ grade: "passed", cost: 0.001 }),
      run({ grade: "passed", cost: 0.001, error: "Run timed out after 180 seconds" }),
    ])
    expect(summary.contentAccuracy).toBe(1)
    expect(summary.successRate).toBeCloseTo(3 / 4, 10)
    expect(summary.contentAccuracy!).toBeGreaterThan(summary.successRate!)
  })

  test("the cost per successful task counts the failed attempt's spend", () => {
    // The money was spent, so it is in the numerator; and the invalid
    // run's spend too, if it is known.
    const summary = summariseOutcomes([
      run({ grade: "passed", cost: 0.002 }),
      run({ grade: "failed", cost: 0.004 }),
      run({ grade: "passed", cost: 0.002, error: "Run timed out after 180 seconds" }),
    ])
    // 0.008 of spend, over 1 correct completion.
    expect(summary.totalSpend).toBeCloseTo(0.008, 10)
    expect(summary.costPerSuccessfulTask).toBeCloseTo(0.008, 10)
  })

  test("a run that did not execute has no content to be accurate about", () => {
    const summary = summariseOutcomes([
      run({ grade: "passed", cost: 0.001, error: "Run timed out after 180 seconds" }),
    ])
    // The content accuracy is **null**, not 0 and not 1: there was no
    // answer to grade.
    expect(summary.contentAccuracy).toBeNull()
    expect(summary.successRate).toBe(0)
    expect(summary.executionFailureRate).toBe(1)
  })

  test("the content accuracy is null when nothing executed", () => {
    const summary = summariseOutcomes([
      run({ grade: "passed", cost: 0.001, error: "a" }),
      run({ grade: "passed", cost: 0.001, error: "b" }),
    ])
    expect(summary.contentAccuracy).toBeNull()
    expect(summary.successRate).toBe(0)
    expect(summary.executionFailureRate).toBe(1)
  })
})

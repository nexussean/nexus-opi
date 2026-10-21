import { describe, expect, test } from "bun:test"
import { compareCostPerSuccess, costPerSuccessInterval } from "../harness/uncertainty.ts"
import { seededRandom } from "../harness/schedule.ts"

/**
 * The uncertainty.
 *
 * The pre-registration says the bar for "not resolved" is a bootstrap
 * interval, and the comparison is between **intervals**, not between point
 * estimates. These tests pin the behaviour that makes that meaningful.
 */

describe("the seeded generator", () => {
  test("it is deterministic", () => {
    const a = seededRandom(42)
    const b = seededRandom(42)
    for (let index = 0; index < 100; index++) expect(a()).toBe(b())
  })

  test("it produces numbers in the unit interval", () => {
    const random = seededRandom(7)
    for (let index = 0; index < 1000; index++) {
      const value = random()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  test("different seeds give different sequences", () => {
    const a = seededRandom(1)
    const b = seededRandom(2)
    expect(a()).not.toBe(b())
  })
})

describe("the cost per successful task", () => {
  test("it divides the total spend by the successes", () => {
    const interval = costPerSuccessInterval([
      { passed: true, cost: 0.002, billingComplete: true },
      { passed: false, cost: 0.004, billingComplete: true },
      { passed: true, cost: 0.002, billingComplete: true },
    ])
    // The failed run's spend counts in the numerator.
    expect(interval.estimate).toBeCloseTo(0.004, 10)
  })

  test("it has no estimate when nothing succeeded", () => {
    const interval = costPerSuccessInterval([
      { passed: false, cost: 0.002, billingComplete: true },
      { passed: false, cost: 0.004, billingComplete: true },
    ])
    expect(interval.estimate).toBeNull()
    expect(interval.low).toBeNull()
  })

  test("it is reproducible", () => {
    const runs = [
      { passed: true, cost: 0.002, billingComplete: true },
      { passed: true, cost: 0.003, billingComplete: true },
      { passed: false, cost: 0.004, billingComplete: true },
    ]
    const a = costPerSuccessInterval(runs, { seed: 5 })
    const b = costPerSuccessInterval(runs, { seed: 5 })
    expect(a.low).toBe(b.low)
    expect(a.high).toBe(b.high)
  })

  test("the interval contains the point estimate", () => {
    const runs = Array.from({ length: 12 }, (_, index) => ({
      passed: index % 3 !== 0,
      cost: 0.001 * (1 + (index % 5)),
      billingComplete: true,
    }))
    const interval = costPerSuccessInterval(runs, { seed: 3 })
    expect(interval.low!).toBeLessThanOrEqual(interval.estimate!)
    expect(interval.estimate!).toBeLessThanOrEqual(interval.high!)
  })

  test("a wide spread of costs gives a wide interval", () => {
    const tight = costPerSuccessInterval(
      Array.from({ length: 12 }, () => ({ passed: true, cost: 0.002, billingComplete: true })),
      { seed: 3 },
    )
    const wide = costPerSuccessInterval(
      Array.from({ length: 12 }, (_, index) => ({
        passed: true,
        cost: index % 2 === 0 ? 0.0001 : 0.01,
        billingComplete: true,
      })),
      { seed: 3 },
    )
    expect(wide.high! - wide.low!).toBeGreaterThan(tight.high! - tight.low!)
  })

  test("a resample with no successes has no ratio, and is not a zero", () => {
    // Every run fails, so no resample can produce a ratio. The count of
    // usable resamples must be zero, and the estimate must be null — not 0.
    const interval = costPerSuccessInterval(
      Array.from({ length: 8 }, () => ({ passed: false, cost: 0.002, billingComplete: true })),
      { seed: 3, resamples: 100 },
    )
    expect(interval.estimate).toBeNull()
    expect(interval.samples).toBe(0)
  })
})

describe("the comparison", () => {
  test("overlapping intervals are not resolved", () => {
    const comparison = compareCostPerSuccess(
      { estimate: 0.002, low: 0.001, high: 0.004, samples: 100 },
      { estimate: 0.0025, low: 0.0015, high: 0.005, samples: 100 },
    )
    expect(comparison.overlaps).toBe(true)
    expect(comparison.verdict).toBe("not-resolved")
  })

  test("separate intervals give a verdict", () => {
    const comparison = compareCostPerSuccess(
      { estimate: 0.001, low: 0.0008, high: 0.0012, samples: 100 },
      { estimate: 0.005, low: 0.004, high: 0.006, samples: 100 },
    )
    expect(comparison.overlaps).toBe(false)
    expect(comparison.verdict).toBe("a-lower")
  })

  test("a missing interval is not resolved", () => {
    const comparison = compareCostPerSuccess(
      { estimate: null, low: null, high: null, samples: 0 },
      { estimate: 0.005, low: 0.004, high: 0.006, samples: 100 },
    )
    expect(comparison.verdict).toBe("not-resolved")
  })
})

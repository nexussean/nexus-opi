/**
 * The uncertainty.
 *
 * ## Why
 *
 * The benchmark compares arms by a **ratio** — the cost per successful task —
 * and the ratio is computed over a handful of runs whose cost varies by an
 * order of magnitude. A 30% difference between two arms, computed over six
 * runs each, can easily be the spread within one arm.
 *
 * So the comparison is a comparison of **intervals**, not of point estimates.
 * Each arm's cost per successful task is resampled with a **bootstrap**, and
 * the two arms' intervals are compared. Overlapping intervals mean the
 * difference is not resolved, and the honest answer is "not resolved".
 *
 * ## The method
 *
 * The bootstrap resamples the arm's **runs**, with replacement, and recomputes
 * the ratio each time:
 *
 * - the numerator is the resampled runs' total spend, **including** the runs
 *   that failed, because the spend happened;
 * - the denominator is the resampled runs' number of successes, and a
 *   resample with no successes yields **no** ratio rather than a division by
 *   zero.
 *
 * The interval is the 2.5th and 97.5th percentiles of the resampled ratios.
 * The resampling is **seeded**, so the interval is reproducible.
 *
 * ## What it does not do
 *
 * It does not correct for a systematic difference between the arms — a
 * provider that was slower during one arm's runs, or a machine that was busy.
 * That is what the randomised, blocked schedule is for. The bootstrap says
 * how much of a difference is noise *within* an arm, and nothing about noise
 * *between* the arms.
 */
import { seededRandom } from "./schedule.ts"

/** One run's contribution to a cell. */
export interface CellRun {
  /** Whether the run's answer was correct. */
  passed: boolean
  /** The run's authoritative cost. */
  cost: number
  /** Whether the run's cost was fully recovered. */
  billingComplete: boolean
}

/** A bootstrap interval. */
export interface Interval {
  /** The point estimate. */
  estimate: number | null
  /** The lower bound of the 95% interval. */
  low: number | null
  /** The upper bound of the 95% interval. */
  high: number | null
  /** How many resamples produced a ratio. */
  samples: number
}

/** The default number of resamples. */
export const DEFAULT_RESAMPLES = 10_000

/**
 * The cost per successful task, and its bootstrap interval.
 *
 * The point estimate is the total spend over the successful answers, with
 * **every** run's spend in the numerator.
 */
export function costPerSuccessInterval(
  runs: CellRun[],
  options: { resamples?: number; seed?: number } = {},
): Interval {
  const resamples = options.resamples ?? DEFAULT_RESAMPLES
  const seed = options.seed ?? 20261021
  if (!runs.length) {
    return { estimate: null, low: null, high: null, samples: 0 }
  }
  const successes = runs.filter(run => run.passed).length
  const spend = runs.reduce((sum, run) => sum + run.cost, 0)
  const estimate = successes ? spend / successes : null

  const random = seededRandom(seed)
  const ratios: number[] = []
  for (let iteration = 0; iteration < resamples; iteration++) {
    let sampleSpend = 0
    let sampleSuccesses = 0
    for (let index = 0; index < runs.length; index++) {
      const run = runs[Math.floor(random() * runs.length)]!
      sampleSpend += run.cost
      if (run.passed) sampleSuccesses++
    }
    // A resample with no successes has no ratio. It is **not** a zero, and
    // it is not dropped silently: the count of usable resamples is reported.
    if (!sampleSuccesses) continue
    ratios.push(sampleSpend / sampleSuccesses)
  }
  if (!ratios.length) {
    return { estimate, low: null, high: null, samples: 0 }
  }
  ratios.sort((a, b) => a - b)
  const low = ratios[Math.floor(ratios.length * 0.025)]!
  const high = ratios[Math.floor(ratios.length * 0.975)]!
  return { estimate, low, high, samples: ratios.length }
}

/** The comparison of two arms. */
export interface Comparison {
  /** The first arm. */
  a: Interval
  /** The second arm. */
  b: Interval
  /** Whether the two intervals overlap. */
  overlaps: boolean
  /** The verdict, in words. */
  verdict: "a-lower" | "b-lower" | "not-resolved"
}

/**
 * Compare two arms' cost per successful task.
 *
 * The verdict is deliberately cautious: two arms whose intervals overlap are
 * **not resolved**, even if their point estimates differ.
 */
export function compareCostPerSuccess(a: Interval, b: Interval): Comparison {
  if (a.low === null || a.high === null || b.low === null || b.high === null) {
    return { a, b, overlaps: true, verdict: "not-resolved" }
  }
  const overlaps = a.low <= b.high && b.low <= a.high
  if (overlaps) return { a, b, overlaps, verdict: "not-resolved" }
  return { a, b, overlaps, verdict: a.high < b.low ? "a-lower" : "b-lower" }
}

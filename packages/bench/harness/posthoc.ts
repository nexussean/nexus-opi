/**
 * The post-hoc analysis of the pre-registered run.
 *
 * ## What this is
 *
 * The **pre-registered** verdict is in
 * `docs/bench/preregistration-schema-size.md`, and the script that applies
 * it is `packages/bench/harness/decision.ts`. That verdict is **not
 * changed** by anything here.
 *
 * This is the **additional** analysis, run after the result was seen, and
 * it is labelled as such everywhere. It exists because the pre-registered
 * bar (non-overlapping bootstrap intervals) is a **conservative** bar, and a
 * reader is entitled to know what the data says beyond it.
 *
 * The statistics here are ones a reader would want and the pre-registered
 * rule did not name:
 *
 * - the **permutation test** on the difference in mean spend — a test of
 *   the same null hypothesis that does not depend on the shape of the cost
 *   distribution;
 * - the **P(spend of one arm < spend of the other)** under the bootstrap,
 *   which is the probability the pre-registered rule was approximating;
 * - the **mechanism**: the format-compliance difference, and the number of
 *   extra steps the prose answers cost.
 *
 * None of these changes the pre-registered verdict, and none of them was
 * chosen because of what it said.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { seededRandom } from "./schedule.ts"

const PACKAGE = resolve(import.meta.dir, "..")
const reportPath = process.argv[2] ?? resolve(PACKAGE, "../../fixtures/bench/results/latest.json")
const report = JSON.parse(readFileSync(reportPath, "utf8"))

/** One run. */
interface ReportRun {
  model: string
  shape: string
  task: string
  verdict: { grade: string }
  error?: string
  format?: { format: string; formatCompliant: boolean }
  billing?: { cost: number; complete: boolean }
  tokens: { cost: number }
  totalCalls: number
}

const runs: ReportRun[] = report.runs ?? []
const models = [...new Set(runs.map(run => run.model))].sort()

/** The runs of one arm. */
function arm(model: string, shape: string): ReportRun[] {
  return runs.filter(run => run.model === model && run.shape === shape)
}

/** The spend of a run. */
const spend = (run: ReportRun): number => run.billing?.cost ?? run.tokens.cost

/**
 * A two-sided permutation test on the difference in mean spend.
 *
 * The null hypothesis: the two arms' runs are exchangeable, so the
 * difference in means is a labelling artefact. The test enumerates the
 * labellings — or samples them — and asks how often a difference at least
 * as large as the observed one appears by chance.
 */
function permutationTest(
  a: number[],
  b: number[],
  options: { samples?: number; seed?: number } = {},
): { observed: number; p: number } {
  const samples = options.samples ?? 10_000
  const random = seededRandom(options.seed ?? 20261021)
  const pooled = [...a, ...b]
  const observed = mean(a) - mean(b)
  let atLeastAsExtreme = 0
  for (let iteration = 0; iteration < samples; iteration++) {
    // Shuffle the pooled values.
    const shuffled = [...pooled]
    for (let index = shuffled.length - 1; index > 0; index--) {
      const swap = Math.floor(random() * (index + 1))
      const held = shuffled[index]!
      shuffled[index] = shuffled[swap]!
      shuffled[swap] = held
    }
    const difference = mean(shuffled.slice(0, a.length)) - mean(shuffled.slice(a.length))
    if (Math.abs(difference) >= Math.abs(observed)) atLeastAsExtreme++
  }
  return { observed, p: (atLeastAsExtreme + 1) / (samples + 1) }
}

/** The mean. */
function mean(values: number[]): number {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * The bootstrap probability that one arm's mean spend is below the other's.
 *
 * This is the quantity the pre-registered interval-overlap rule was
 * approximating. It is reported **beside** the pre-registered verdict, and
 * it does not replace it.
 */
function probabilityLower(
  a: number[],
  b: number[],
  options: { samples?: number; seed?: number } = {},
): { pABelowB: number; pBBelowA: number } {
  const samples = options.samples ?? 10_000
  const random = seededRandom(options.seed ?? 20261021)
  const resample = (values: number[]): number => {
    let total = 0
    for (let index = 0; index < values.length; index++) {
      total += values[Math.floor(random() * values.length)]!
    }
    return total / values.length
  }
  let aBelowB = 0
  let bBelowA = 0
  for (let iteration = 0; iteration < samples; iteration++) {
    const meanA = resample(a)
    const meanB = resample(b)
    if (meanA < meanB) aBelowB++
    if (meanB < meanA) bBelowA++
  }
  return { pABelowB: aBelowB / samples, pBBelowA: bBelowA / samples }
}

console.log("The post-hoc analysis of the pre-registered run.\n")
console.log("This does NOT change the pre-registered verdict. It is reported because the")
console.log("pre-registered bar (non-overlapping intervals) is conservative, and a reader")
console.log("is entitled to know what the data says beyond it.\n")

for (const model of models) {
  const minimal = arm(model, "opi-minimal")
  const full = arm(model, "opi")
  if (!minimal.length || !full.length) continue
  const minimalSpend = minimal.map(spend)
  const fullSpend = full.map(spend)
  const test = permutationTest(minimalSpend, fullSpend)
  const probability = probabilityLower(minimalSpend, fullSpend)

  console.log(`  ${model.split("/").pop()}`)
  console.log(
    `    mean spend: minimal $${mean(minimalSpend).toFixed(6)}  full $${mean(fullSpend).toFixed(6)}` +
      `  (${((1 - mean(minimalSpend) / mean(fullSpend)) * 100).toFixed(1)}% ${mean(minimalSpend) < mean(fullSpend) ? "less" : "more"})`,
  )
  console.log(`    permutation test on the difference in mean spend: p = ${test.p.toFixed(4)}`)
  console.log(
    `    bootstrap P(minimal's mean spend < full's): ${probability.pABelowB.toFixed(4)}` +
      `   P(full's < minimal's): ${probability.pBBelowA.toFixed(4)}`,
  )
  // The mechanism.
  const minimalFormat = minimal.filter(run => run.format?.formatCompliant).length
  const fullFormat = full.filter(run => run.format?.formatCompliant).length
  const minimalSteps = minimal.map(run => run.totalCalls).reduce((a, b) => a + b, 0)
  const fullSteps = full.map(run => run.totalCalls).reduce((a, b) => a + b, 0)
  console.log(
    `    format compliance: minimal ${minimalFormat}/${minimal.length}  full ${fullFormat}/${full.length}` +
      `   |  tool calls: minimal ${minimalSteps}  full ${fullSteps}`,
  )
  console.log()
}

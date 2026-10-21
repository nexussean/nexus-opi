/**
 * The pre-registered decision.
 *
 * ## What this does
 *
 * It reads a run's report, computes the arm-to-arm comparisons **from the
 * report's own runs**, and applies the **pre-declared** decision rule from
 * `docs/bench/preregistration-schema-size.md`.
 *
 * The rule was written before the run and is not changed afterwards. The
 * script applies it mechanically: it does not decide whether the result is
 * "good enough", and it has no branch for "the answer is complicated".
 *
 * ## Why it computes the comparisons itself
 *
 * The comparisons are computed here rather than read from the report, so
 * that the decision rests on a **separate, auditable artifact** and not on
 * a field the harness wrote. It also means the script works on any report,
 * including one written by a harness that predates the comparison code.
 *
 * ## The rule
 *
 * Ship the minimal schema as the default if and only if, on **both** models:
 *
 * - (a) the content success rate of `opi-minimal` is not lower than `opi`'s;
 * - (b) the cost per successful task of `opi-minimal` is lower than `opi`'s.
 *
 * And the "lower" in (b) is the **pre-declared** bar: the two arms'
 * bootstrap 95% intervals must not overlap.
 *
 * If the models disagree, the result is **split**. If the intervals
 * overlap, the result is **not resolved**.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { compareCostPerSuccess, costPerSuccessInterval } from "./uncertainty.ts"

const PACKAGE = resolve(import.meta.dir, "..")
const reportPath = process.argv[2] ?? resolve(PACKAGE, "../../fixtures/bench/results/latest.json")
const report = JSON.parse(readFileSync(reportPath, "utf8"))

/** One run, as the report holds it. */
interface ReportRun {
  model: string
  shape: string
  task: string
  verdict: { grade: string; reasons: string[] }
  error?: string
  usageComplete?: boolean
  format?: { grade: string; format: string; formatCompliant: boolean }
  billing?: { cost: number; complete: boolean; source: string; reason?: string }
  tokens: { cost: number }
}

/** A cell's numbers. */
interface Cell {
  runs: number
  passed: number
  failed: number
  ungradable: number
  invalid: number
  validRuns: number
  invalidRuns: number
  formatCompliant: number
  totalSpend: number
  interval: ReturnType<typeof costPerSuccessInterval>
}

/** The runs of one (model, shape) cell. */
function cell(runs: ReportRun[], model: string, shape: string): Cell {
  const own = runs.filter(run => run.model === model && run.shape === shape)
  const passed = own.filter(run => !run.error && run.verdict.grade === "passed").length
  const failed = own.filter(run => !run.error && run.verdict.grade === "failed").length
  const ungradable = own.filter(run => !run.error && run.verdict.grade === "ungradable").length
  const invalid = own.filter(run => run.error).length
  const totalSpend = own.reduce((sum, run) => sum + (run.billing?.cost ?? run.tokens.cost), 0)
  return {
    runs: own.length,
    passed,
    failed,
    ungradable,
    invalid,
    validRuns: own.length - invalid,
    invalidRuns: invalid,
    formatCompliant: own.filter(run => run.format?.formatCompliant).length,
    totalSpend,
    interval: costPerSuccessInterval(
      own.map(run => ({
        passed: !run.error && run.verdict.grade === "passed",
        cost: run.billing?.cost ?? run.tokens.cost,
        billingComplete: run.billing?.complete === true,
      })),
    ),
  }
}

const runs: ReportRun[] = report.runs ?? []
const models = [...new Set(runs.map(run => run.model))].sort()

/** The rule's outcome. */
type Verdict =
  | "ship"
  | "do-not-ship"
  | "split"
  | "not-resolved"
  | "not-usable"

console.log(`The pre-registered decision, applied to ${reportPath}\n`)
console.log(`grader: ${report.contentGrader?.fingerprint ?? "unknown"}`)
console.log(`seed:   ${report.schedule?.seed ?? "unknown"} (block ${report.schedule?.block ?? "?"})`)
console.log(`source: ${report.fingerprints?.source ?? "unknown"}`)
console.log(`runs:   ${runs.length}\n`)

const results: {
  model: string
  correctnessOk: boolean
  costOk: boolean
  invalidShare: number
  detail: string
}[] = []

for (const model of models) {
  const minimal = cell(runs, model, "opi-minimal")
  const full = cell(runs, model, "opi")
  if (!minimal.runs || !full.runs) {
    results.push({
      model,
      correctnessOk: false,
      costOk: false,
      invalidShare: 1,
      detail: "one of the two arms was not in this run, so the comparison cannot be made",
    })
    continue
  }

  // (a) The correctness condition, on the **end-to-end** rate.
  //
  // The end-to-end rate, not the content accuracy: a shipping decision is
  // about whether the user gets an answer, and a run that never executed
  // is a run that did not give one. The content accuracy is reported
  // beside it, because the two together say more than either alone — an
  // arm with a high content accuracy and a low end-to-end rate answers
  // well only when it answers at all.
  const minimalRate = minimal.passed / Math.max(1, minimal.runs)
  const fullRate = full.passed / Math.max(1, full.runs)
  const minimalContent = minimal.validRuns ? minimal.passed / minimal.validRuns : null
  const fullContent = full.validRuns ? full.passed / full.validRuns : null
  const correctnessOk = minimalRate >= fullRate

  // (b) The cost condition, by the pre-declared interval bar.
  const comparison = compareCostPerSuccess(minimal.interval, full.interval)
  const costOk =
    comparison.verdict === "b-lower" &&
    minimal.interval.estimate !== null &&
    full.interval.estimate !== null &&
    minimal.interval.estimate < full.interval.estimate

  // The kill criterion: more than 10% invalid makes the cell unusable.
  const invalidShare = Math.max(minimal.invalid / minimal.runs, full.invalid / full.runs)
  const usable = invalidShare <= 0.1

  let detail: string
  if (!usable) {
    detail = `the cell is ${(invalidShare * 100).toFixed(0)}% invalid, which is over the pre-declared 10% limit`
  } else if (!correctnessOk) {
    detail = `(a) FAILS: the minimal schema's end-to-end success rate is lower (${(minimalRate * 100).toFixed(1)}% against ${(fullRate * 100).toFixed(1)}%)`
  } else if (!costOk) {
    const reason =
      comparison.verdict === "not-resolved"
        ? `the two intervals overlap ([${fmt(minimal.interval.low)}, ${fmt(minimal.interval.high)}] against [${fmt(full.interval.low)}, ${fmt(full.interval.high)}]), so the difference is not resolved`
        : "the minimal schema is not cheaper"
    detail = `(b) FAILS: ${reason}`
  } else {
    detail = `(a) and (b) both hold: the minimal schema is not less correct and is cheaper, with non-overlapping intervals`
  }

  results.push({ model, correctnessOk, costOk, invalidShare, detail })
}

/** A money figure for the console. */
function fmt(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(6)}`
}

for (const result of results) {
  const model = result.model.split("/").pop()!
  const minimal = cell(runs, result.model, "opi-minimal")
  const full = cell(runs, result.model, "opi")
  const minimalContent = minimal.validRuns ? minimal.passed / minimal.validRuns : null
  const fullContent = full.validRuns ? full.passed / full.validRuns : null
  console.log(`  ${model}`)
  console.log(
    `    minimal: ${minimal.passed}p/${minimal.failed}f/${minimal.ungradable}u of ${minimal.validRuns} executed` +
      `  end-to-end ${(minimal.passed / Math.max(1, minimal.runs) * 100).toFixed(1)}%  content-acc ${minimalContent === null ? "n/a" : (minimalContent * 100).toFixed(1) + "%"}  exec-fail ${(minimal.invalidRuns / Math.max(1, minimal.runs) * 100).toFixed(1)}%` +
      `  spend ${fmt(minimal.totalSpend)}  cost/success ${fmt(minimal.interval.estimate)} [${fmt(minimal.interval.low)}, ${fmt(minimal.interval.high)}]`,
  )
  console.log(
    `    full:    ${full.passed}p/${full.failed}f/${full.ungradable}u of ${full.validRuns} executed` +
      `  end-to-end ${(full.passed / Math.max(1, full.runs) * 100).toFixed(1)}%  content-acc ${fullContent === null ? "n/a" : (fullContent * 100).toFixed(1) + "%"}  exec-fail ${(full.invalidRuns / Math.max(1, full.runs) * 100).toFixed(1)}%` +
      `  spend ${fmt(full.totalSpend)}  cost/success ${fmt(full.interval.estimate)} [${fmt(full.interval.low)}, ${fmt(full.interval.high)}]`,
  )
  console.log(`    ${result.detail}`)
  console.log(`    correctness ok: ${result.correctnessOk}   cost ok: ${result.costOk}   invalid share: ${(result.invalidShare * 100).toFixed(1)}%`)
  console.log()
}

// The rule, applied.
let verdict: Verdict
if (!results.length) {
  verdict = "not-usable"
} else if (results.some(result => result.invalidShare > 0.1)) {
  verdict = "not-usable"
} else if (results.every(result => result.correctnessOk && result.costOk)) {
  verdict = "ship"
} else if (
  results.some(result => result.correctnessOk && result.costOk) &&
  results.some(result => !result.correctnessOk || !result.costOk)
) {
  verdict = "split"
} else if (results.every(result => result.correctnessOk) && results.some(result => !result.costOk)) {
  // Every model says the correctness condition holds and at least one does
  // not resolve the cost condition.
  verdict = "not-resolved"
} else {
  verdict = "do-not-ship"
}

const verdicts: Record<Verdict, string> = {
  ship: "SHIP the minimal schema as the default.",
  "do-not-ship": "DO NOT SHIP the minimal schema on this evidence.",
  split: "SPLIT — the models disagree, so the minimal schema does not ship on this evidence.",
  "not-resolved":
    "NOT RESOLVED — the cost difference is inside the spread. The minimal schema does not ship on this evidence.",
  "not-usable": "NOT USABLE — a cell breached the pre-declared kill criterion.",
}
console.log(verdicts[verdict])
console.log(`\n(The pre-registration: docs/bench/preregistration-schema-size.md)`)

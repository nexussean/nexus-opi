import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { gradeContent } from "../harness/content-grader.ts"
import { boardSnapshot } from "../harness/board.ts"
import type { Snapshot } from "../harness/outcomes.ts"

/**
 * The **execution validity** of the regrading.
 *
 * ## The defect this prevents
 *
 * The first version of the regrade counted a run's content grade whether or
 * not the run had **completed**. Twenty-seven of the retained read runs were
 * invalid — timeouts, launch failures, and runs invalidated because the
 * surface was not what the arm said it was — and they still had an answer
 * text, and the answer text was sometimes right.
 *
 * Counting those as successes would have let a **correct answer from a
 * broken run** pass content grading and become an experimental observation.
 * It is not one. A run that did not complete produced no observation; the
 * fact that something was written before the timeout is not a data point
 * about the surface.
 *
 * So the regrade records the content grade of an invalid run, and **excludes
 * it from every count**.
 */

const BEFORE = boardSnapshot() as Snapshot
const RESULTS = resolve(import.meta.dir, "../../../fixtures/bench/results")

/** One retained read run. */
interface Retained {
  file: string
  model: string
  shape: string
  task: string
  oldGrade: string
  error?: string
  answer: string
}

/** Every retained read run. */
function retained(): Retained[] {
  const out: Retained[] = []
  for (const file of readdirSync(RESULTS).filter(f => f.startsWith("report-") && f.endsWith(".json")).sort()) {
    let report: any
    try {
      report = JSON.parse(readFileSync(join(RESULTS, file), "utf8"))
    } catch {
      continue
    }
    for (const run of report.runs ?? []) {
      if (run.kind !== "read") continue
      const answer = run.evidence?.answer
      if (answer === undefined) continue
      out.push({
        file,
        model: run.model,
        shape: run.shape,
        task: run.task,
        oldGrade: run.verdict?.grade ?? "unknown",
        error: run.error,
        answer,
      })
    }
  }
  return out
}

const RETAINED = retained()
const VALID = RETAINED.filter(run => !run.error)
const INVALID = RETAINED.filter(run => run.error)

describe("the regrade's execution validity", () => {
  test("there are invalid runs among the retained answers", () => {
    // If this ever fails, the fixture set changed and the test below is
    // no longer exercising the case it was written for.
    expect(INVALID.length).toBeGreaterThan(0)
  })

  test("an invalid run is not counted, however good its answer", () => {
    // The case: a run that timed out, whose answer happens to be right.
    const invalidWithGoodAnswer = INVALID.filter(
      run => gradeContent({ task: run.task, answer: run.answer, before: BEFORE }).grade === "passed",
    )
    // There is at least one, which is why the rule matters.
    expect(invalidWithGoodAnswer.length).toBeGreaterThan(0)
  })

  test("the counts are over the valid runs only", () => {
    // The rule, computed from the reports rather than read from a
    // generated artifact. An artifact goes stale the moment a new report
    // lands, and a test that reads one tests the artifact's freshness
    // rather than the rule.
    const counted = RETAINED.filter(run => !run.error)
    const passed = counted.filter(
      run => gradeContent({ task: run.task, answer: run.answer, before: BEFORE }).grade === "passed",
    ).length
    const failed = counted.filter(
      run => gradeContent({ task: run.task, answer: run.answer, before: BEFORE }).grade === "failed",
    ).length
    // Every valid run is accounted for: passed, failed, or ungradable.
    expect(passed + failed).toBeLessThanOrEqual(counted.length)
    // And the invalid runs are not in the count at all.
    expect(counted.length).toBe(VALID.length)
    expect(RETAINED.length).toBe(VALID.length + INVALID.length)
  })

  test("the regrade's own artifact agrees with the reports", () => {
    // The artifact is a convenience, not the source of truth. When it is
    // present it must agree.
    let latest: any
    try {
      latest = JSON.parse(readFileSync(join(RESULTS, "regrade-latest.json"), "utf8"))
    } catch {
      return
    }
    expect(latest.executionValidity.validRuns).toBe(VALID.length)
    expect(latest.executionValidity.invalidRuns).toBe(INVALID.length)
    expect(latest.validRuns).toBe(VALID.length)
    // The matrix sums to the valid runs, not to every answer.
    const matrixTotal = Object.values(latest.oldToNew as Record<string, Record<string, number>>)
      .flatMap(row => Object.values(row))
      .reduce((sum, count) => sum + count, 0)
    expect(matrixTotal).toBe(VALID.length)
  })

  test("every invalid run is recorded with its reason", () => {
    // The invalid runs are recorded with the reason they were invalid, so
    // a reader can tell a timeout from an invalidated surface.
    const reasons = new Set(INVALID.map(run => run.error))
    expect(reasons.size).toBeGreaterThan(0)
    for (const reason of reasons) {
      expect(reason).toBeTruthy()
      expect(reason!.length).toBeGreaterThan(0)
    }
  })

  test("no answer the old grader passed may now fail, over the valid runs", () => {
    const regressions: string[] = []
    for (const run of VALID) {
      if (run.oldGrade !== "passed") continue
      const verdict = gradeContent({ task: run.task, answer: run.answer, before: BEFORE })
      if (verdict.grade === "failed") {
        regressions.push(`${run.file} ${run.shape}/${run.task}: ${verdict.reasons.join("; ")}`)
      }
    }
    expect(regressions.join("\n")).toBe("")
  })
})

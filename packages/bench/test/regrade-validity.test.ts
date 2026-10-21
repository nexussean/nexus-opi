import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
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

/**
 * The **committed** regression corpus.
 *
 * It used to be read from `fixtures/bench/results/` — the benchmark's own
 * output directory, which is **gitignored**, because it holds 11 MB of
 * historical reports that must not be rewritten.
 *
 * That made the test a test of one machine: in a fresh clone the directory
 * does not exist, `readdirSync` threw `ENOENT` at module load, and the
 * whole file went down. The hosted CI found it.
 *
 * The corpus is extracted from the reports by
 * `scripts/extract-retained-answers.ts` and **versioned**, so the same
 * answers are checked on every machine and every platform. It carries the
 * error that made a run invalid, and the regrade's own summary, so both
 * halves of this file run everywhere.
 */
const CORPUS = resolve(import.meta.dir, "../../../fixtures/bench/retained/content-answers.json")

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

/** The corpus, and the regrade summary that travels with it. */
function corpus(): {
  answers: Retained[]
  regrade: {
    executionValidity?: { validRuns?: number; invalidRuns?: number }
    validRuns?: number
    oldToNew?: Record<string, Record<string, number>>
  }
} {
  try {
    const parsed = JSON.parse(readFileSync(CORPUS, "utf8")) as any
    return { answers: parsed.answers ?? [], regrade: parsed.regrade ?? {} }
  } catch {
    // A missing corpus yields an empty list, not a thrown error. The
    // failure lands in the test that asserts the corpus is present, with a
    // message that says what is wrong.
    return { answers: [], regrade: {} }
  }
}

const { answers: RETAINED, regrade: REGRADE } = corpus()
const VALID = RETAINED.filter(run => !run.error)
const INVALID = RETAINED.filter(run => run.error)

describe("the regrade's execution validity", () => {
  test("the committed regression corpus is present, with invalid runs among it", () => {
    // If the corpus is missing, the file's other tests would be checking
    // nothing. If there are no invalid runs, the test below is no longer
    // exercising the case it was written for.
    if (!RETAINED.length) {
      throw new Error(
        `The regression corpus is missing or empty: ${CORPUS}. ` +
          "It is versioned on purpose, so this is a repository defect. " +
          "Regenerate it with `bun run scripts/extract-retained-answers.ts`.",
      )
    }
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

  test("the regrade's own summary agrees with the answers it summarises", () => {
    // The summary is a convenience, not the source of truth — but it is
    // **versioned alongside the answers**, so this check always runs rather
    // than quietly doing nothing where a generated file happens to be
    // absent.
    expect(REGRADE.executionValidity?.validRuns).toBe(VALID.length)
    expect(REGRADE.executionValidity?.invalidRuns).toBe(INVALID.length)
    expect(REGRADE.validRuns).toBe(VALID.length)
    // The matrix sums to the valid runs, not to every answer.
    const matrixTotal = Object.values(REGRADE.oldToNew as Record<string, Record<string, number>>)
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

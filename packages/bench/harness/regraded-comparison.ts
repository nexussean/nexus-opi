/**
 * The regraded comparison.
 *
 * ## What this does
 *
 * It takes the retained reports, regrades every retained **read** answer
 * with the content-aware grader, and recomputes the per-arm comparison.
 *
 * ## Why it matters
 *
 * The schema-size arm was measured with a grader that reported a **format**
 * failure as a content failure. 48 of the 75 ungradable answers were
 * format failures with correct content. If the arms differed in their
 * format compliance — and they did, because the whole point of the arm
 * was to change the descriptions the model reads — then the measured
 * difference was partly a difference in format compliance, and the
 * "38% cheaper with four more correct answers" was partly a statement
 * about JSON formatting rather than about the surface.
 *
 * This recomputes the comparison with the format removed from the grade,
 * so the question becomes: does the surface still matter once the answers
 * are read for their **content**?
 *
 * ## What it does not do
 *
 * It does not measure behaviour under a prompt without the JSON
 * requirement. The retained answers were produced under a prompt that
 * required one. Regrading them measures the grader's reading of those
 * answers, not a model's behaviour under a different prompt. That is a
 * separate experiment.
 */
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { gradeContent, CONTENT_GRADER_VERSION, graderFingerprint } from "./content-grader.ts"
import { boardSnapshot } from "./board.ts"
import type { Snapshot } from "./outcomes.ts"

const PACKAGE = resolve(import.meta.dir, "..")
const RESULTS = resolve(PACKAGE, "../../fixtures/bench/results")
const BEFORE = boardSnapshot() as Snapshot

/** One arm's numbers, under both graders. */
interface Arm {
  runs: number
  /** The runs that did not complete. */
  invalid: number
  /**
   * The runs that executed.
   *
   * The **content accuracy** is over these; the **end-to-end success** is
   * over every run attempted. The two are reported side by side, because a
   * surface that answers well only when it answers at all has a higher
   * content accuracy than its end-to-end success, and that difference is
   * the thing a reader has to see.
   */
  valid: number
  oldPassed: number
  oldUngradable: number
  newPassed: number
  newFailed: number
  newUngradable: number
  /** The answers that met the JSON contract. */
  formatCompliant: number
}

async function main() {
  const files = (await readdir(RESULTS)).filter(f => f.startsWith("report-") && f.endsWith(".json")).sort()
  const arms = new Map<string, Arm>()
  const perModel = new Map<string, Map<string, Arm>>()

  for (const file of files) {
    let report: any
    try {
      report = JSON.parse(await readFile(join(RESULTS, file), "utf8"))
    } catch {
      continue
    }
    for (const run of report.runs ?? []) {
      if (run.kind !== "read") continue
      const answer = run.evidence?.answer
      if (answer === undefined) continue
      const verdict = gradeContent({ task: run.task, answer, before: BEFORE })
      const oldGrade = run.verdict?.grade ?? "unknown"

      // The run's **execution validity**, kept independent of the grade.
      //
      // A run that did not complete — a timeout, a launch failure, an
      // invalidated surface — is not an experimental observation, whatever
      // its answer contains. It is counted as invalid and excluded from
      // every rate.
      const executionValid = !run.error

      const key = run.shape
      const arm = arms.get(key) ?? {
        runs: 0, invalid: 0, valid: 0, oldPassed: 0, oldUngradable: 0, newPassed: 0, newFailed: 0,
        newUngradable: 0, formatCompliant: 0,
      }
      const modelKey = run.model
      const byShape = perModel.get(modelKey) ?? new Map<string, Arm>()
      const modelArm = byShape.get(key) ?? { ...arm, runs: 0, invalid: 0, valid: 0 }

      for (const target of [arm, modelArm]) {
        target.runs++
        if (executionValid) target.valid++
        if (!executionValid) {
          target.invalid++
          continue
        }
        if (oldGrade === "passed") target.oldPassed++
        if (oldGrade === "ungradable") target.oldUngradable++
        if (verdict.grade === "passed") target.newPassed++
        if (verdict.grade === "failed") target.newFailed++
        if (verdict.grade === "ungradable") target.newUngradable++
        if (verdict.formatCompliant) target.formatCompliant++
      }
      arms.set(key, arm)
      byShape.set(key, modelArm)
      perModel.set(modelKey, byShape)
    }
  }

  const out = {
    analysisVersion: 1,
    graderVersion: CONTENT_GRADER_VERSION,
    graderFingerprint: graderFingerprint(),
    scope:
      "The retained READ answers, regraded with the content-aware grader, and the per-arm comparison recomputed. The write tasks are not regraded: they are graded against the authoritative store, and that is unchanged. The retained answers were produced under a prompt that required a JSON-only answer, so this measures the grader's reading of those answers and not behaviour under a prompt without the JSON requirement.",
    executionValidity:
      "A run that did not complete is not an experimental observation, whatever its answer contains. The invalid runs are counted separately and excluded from the CONTENT ACCURACY, in both the old and the new column. They are NOT excluded from the end-to-end success rate, which is over every run attempted: the user asked for an answer and did not get one. The content grade of an invalid run is still recorded in the regrade artifact.",
    sourceReports: files,
    arms: Object.fromEntries([...arms.entries()].sort()),
    byModel: Object.fromEntries(
      [...perModel.entries()].map(([model, byShape]) => [model, Object.fromEntries([...byShape.entries()].sort())]),
    ),
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  await writeFile(join(RESULTS, `regraded-comparison-${stamp}.json`), `${JSON.stringify(out, null, 2)}\n`, "utf8")
  await writeFile(join(RESULTS, "regraded-comparison-latest.json"), `${JSON.stringify(out, null, 2)}\n`, "utf8")

  console.log("The retained read answers, under both graders.")
  console.log("Invalid runs (did not complete) are excluded from the CONTENT ACCIDENCY, because a")
  console.log("run that did not complete has no answer to be right or wrong about. They are NOT")
  console.log("excluded from the END-TO-END rate, which is over every run attempted: the user asked")
  console.log("for an answer and did not get one.\n")
  console.log("arm                       runs  inv  valid   old:pass/ungrad   new:pass/fail/ungrad   format-ok   content-acc  end-to-end")
  for (const [shape, arm] of [...arms.entries()].sort()) {
    const contentAccuracy = arm.valid ? arm.newPassed / arm.valid : null
    const endToEnd = arm.runs ? arm.newPassed / arm.runs : null
    console.log(
      `${shape.padEnd(24)} ${String(arm.runs).padStart(5)} ${String(arm.invalid).padStart(4)} ${String(arm.valid).padStart(6)}   ` +
        `${String(arm.oldPassed).padStart(4)}/${String(arm.oldUngradable).padStart(6)}        ` +
        `${String(arm.newPassed).padStart(4)}/${String(arm.newFailed).padStart(4)}/${String(arm.newUngradable).padStart(6)}      ` +
        `${String(arm.formatCompliant).padStart(4)}` +
        `        ${contentAccuracy === null ? "  n/a" : (contentAccuracy * 100).toFixed(1).padStart(6) + "%"}` +
        `    ${endToEnd === null ? "  n/a" : (endToEnd * 100).toFixed(1).padStart(6) + "%"}`,
    )
  }
  console.log("\nper model:")
  for (const [model, byShape] of perModel) {
    console.log(`\n  ${model.split("/").pop()}`)
    for (const [shape, arm] of [...byShape.entries()].sort()) {
      console.log(
        `    ${shape.padEnd(22)} ${String(arm.runs).padStart(3)} runs  ` +
          `old ${String(arm.oldPassed).padStart(2)}p/${String(arm.oldUngradable).padStart(2)}u  ` +
          `new ${String(arm.newPassed).padStart(2)}p/${String(arm.newFailed).padStart(2)}f/${String(arm.newUngradable).padStart(2)}u  ` +
          `format ${String(arm.formatCompliant).padStart(2)}`,
      )
    }
  }
}

await main()

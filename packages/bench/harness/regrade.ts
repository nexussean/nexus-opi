/**
 * Regrade the retained answers.
 *
 * ## What this does
 *
 * It reads every retained report, grades every retained read answer with the
 * content-aware grader, and writes a **new** report that links to the
 * originals. The historical verdicts are not overwritten and not modified:
 * they stay exactly as they were, and the new report says what the new
 * grader says about the same answers.
 *
 * ## What it does not do
 *
 * It does **not** measure behaviour under a prompt without the JSON
 * requirement. The retained answers were produced under a prompt that said
 * "return only one JSON object". Regrading them measures the grader, not
 * the model: a model that wrote prose under a JSON-only prompt is evidence
 * about format compliance, and nothing more.
 *
 * A prompt change is a separate experiment, and it is run as one.
 */
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { gradeContent, CONTENT_GRADER_VERSION, graderFingerprint } from "./content-grader.ts"
import { boardSnapshot } from "./board.ts"
import type { Snapshot } from "./outcomes.ts"

/** The package root. */
const PACKAGE = resolve(import.meta.dir, "..")
/** Where the reports live. */
const RESULTS = resolve(PACKAGE, "../../fixtures/bench/results")

/** The board, as the harness's own snapshot. */
const BEFORE = boardSnapshot() as Snapshot

/** One retained run's record. */
interface RetainedRun {
  model: string
  shape: string
  task: string
  kind?: string
  /**
   * Whether the run itself failed.
   *
   * A run with an error did not complete, so it is not an experimental
   * observation — whatever its answer contains.
   */
  error?: string
  verdict?: { grade?: string; reasons?: string[] }
  evidence?: { answer?: string; promptHash?: string }
}

/** One retained report. */
interface RetainedReport {
  reportVersion?: number
  oracleVersion?: string
  runs?: RetainedRun[]
}

async function main() {
  const files = (await readdir(RESULTS)).filter(f => f.startsWith("report-") && f.endsWith(".json")).sort()
  const results: {
    source: string
    model: string
    shape: string
    task: string
    oldGrade: string
    newGrade: string
    format: string
    formatCompliant: boolean
    reasons: string[]
    /** Whether the run itself completed. Independent of the grade. */
    executionValid: boolean
    /** Why it did not, when it did not. */
    executionError?: string
  }[] = []

  for (const file of files) {
    let report: RetainedReport
    try {
      report = JSON.parse(await readFile(join(RESULTS, file), "utf8")) as RetainedReport
    } catch {
      continue
    }
    for (const run of report.runs ?? []) {
      // Only the read tasks have an answer to grade. The write tasks are
      // graded against the authoritative store, and that is unchanged.
      if (run.kind !== "read") continue
      const answer = run.evidence?.answer
      if (answer === undefined) continue
      const verdict = gradeContent({ task: run.task, answer, before: BEFORE })
      results.push({
        source: file,
        model: run.model,
        shape: run.shape,
        task: run.task,
        oldGrade: run.verdict?.grade ?? "unknown",
        newGrade: verdict.grade,
        format: verdict.format,
        formatCompliant: verdict.formatCompliant,
        reasons: verdict.reasons,
        /**
         * Whether the **run itself** was valid.
         *
         * This is independent of the grade, and it is the reason the two
         * are kept apart. A run that timed out, or that was invalidated
         * because the surface was not what the arm said it was, is not an
         * experimental observation — whatever its answer says. Its answer
         * can be read for what it contains, and the reading is reported, but
         * it does not become a success.
         */
        executionValid: !run.error,
        executionError: run.error,
      })
    }
  }

  // The comparison, by the old grade and the new one.
  //
  // **Over the valid runs only.** An invalid run is not an experimental
  // observation, whatever its answer says, so it is excluded from every
  // count here. Its grade is still recorded in `results`.
  const valid = results.filter(result => result.executionValid)
  const matrix: Record<string, Record<string, number>> = {}
  for (const result of valid) {
    matrix[result.oldGrade] ??= {}
    matrix[result.oldGrade]![result.newGrade] = (matrix[result.oldGrade]![result.newGrade] ?? 0) + 1
  }

  // The format, for the answers the old grader called ungradable.
  const formatCounts: Record<string, number> = {}
  for (const result of valid) {
    if (result.oldGrade !== "ungradable") continue
    formatCounts[result.format] = (formatCounts[result.format] ?? 0) + 1
  }

  // The per-cell summary.
  const cells: Record<string, { old: Record<string, number>; new: Record<string, number>; formats: Record<string, number> }> = {}
  for (const result of valid) {
    const key = `${result.model.split("/").pop()} / ${result.shape} / ${result.task}`
    cells[key] ??= { old: {}, new: {}, formats: {} }
    cells[key]!.old[result.oldGrade] = (cells[key]!.old[result.oldGrade] ?? 0) + 1
    cells[key]!.new[result.newGrade] = (cells[key]!.new[result.newGrade] ?? 0) + 1
    cells[key]!.formats[result.format] = (cells[key]!.formats[result.format] ?? 0) + 1
  }

  const out = {
    regradeVersion: 1,
    graderVersion: CONTENT_GRADER_VERSION,
    graderFingerprint: graderFingerprint(),
    /**
     * The limit, stated in the artifact itself.
     */
    scope:
      "Regrades retained READ answers with the content-aware grader. The retained answers were produced under a prompt that required a JSON-only answer, so this measures the grader's reading of those answers. It does NOT measure behaviour under a prompt without the JSON requirement, and it does not regrade the write tasks, which are graded against the authoritative store.",
    /**
     * The execution validity, kept independent of the grade.
     *
     * A run that did not complete — a timeout, a launch failure, an
     * invalidated surface — produced no valid experimental observation,
     * whatever its answer contains. Its answer is still read, and the
     * reading is reported, but it is **not** counted as a success and it is
     **not** counted in any rate. The counts below are over the valid runs
     * only.
     */
    executionValidity: {
      rule:
        "A run is a valid observation only if it completed without error. The content grade of an invalid run is recorded, and is never counted as a success, a failure, or a rate.",
      validRuns: results.filter(result => result.executionValid).length,
      invalidRuns: results.filter(result => !result.executionValid).length,
    },
    /**
     * The metrics, kept apart.
     *
     * Excluding the invalid runs from the content accuracy is right: a run
     * that timed out has no answer to be right or wrong about. Excluding
     * them from the **end-to-end** rate would be wrong: the user asked for
     * an answer and did not get one, and a surface that answers well only
     * when it answers at all must not look better than one that answers
     * reliably.
     */
    metrics: {
      contentAccuracy: `${valid.filter(result => result.newGrade === "passed").length}/${valid.length}`,
      endToEndSuccess: `${valid.filter(result => result.newGrade === "passed").length}/${results.length}`,
      executionFailureRate: `${results.length - valid.length}/${results.length}`,
    },
    historicalVerdictsUnchanged: true,
    sourceReports: files,
    gradedAnswers: results.length,
    /** The valid runs the counts are over. */
    validRuns: valid.length,
    oldToNew: matrix,
    ungradableOldByFormat: formatCounts,
    cells,
    results,
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  await mkdir(RESULTS, { recursive: true })
  const path = join(RESULTS, `regrade-${stamp}.json`)
  await writeFile(path, `${JSON.stringify(out, null, 2)}\n`, "utf8")
  await writeFile(join(RESULTS, "regrade-latest.json"), `${JSON.stringify(out, null, 2)}\n`, "utf8")

  console.log(`graded ${results.length} retained read answers (${valid.length} valid, ${results.length - valid.length} invalid)`)
  console.log(`grader: ${out.graderFingerprint}`)
  console.log("\nold grade -> new grade:")
  for (const [old, row] of Object.entries(matrix)) {
    console.log(`  ${old.padEnd(12)} -> ${Object.entries(row).map(([k, v]) => `${k}:${v}`).join("  ")}`)
  }
  console.log("\nthe old grader's ungradable answers, by format:")
  for (const [format, count] of Object.entries(formatCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${format.padEnd(18)} ${count}`)
  }
  console.log(`\nwritten: ${path}`)
}

await main()

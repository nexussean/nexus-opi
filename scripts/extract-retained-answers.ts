#!/usr/bin/env bun
/**
 * Extract the **retained answers** into a versioned regression corpus.
 *
 * ## Why this exists
 *
 * The grader's regression test was reading `fixtures/bench/results/` — the
 * benchmark's own output directory. That directory is **gitignored**: it
 * holds 11 MB of historical reports, and they must not be rewritten.
 *
 * The consequence was a test that only ran on the machine that produced the
 * reports. In a fresh clone the directory does not exist, and
 * `readdirSync` threw `ENOENT` **at module load**, which took down the
 * whole test file — including five answer-shape tests that are
 * self-contained and should have run everywhere.
 *
 * The hosted CI found it. That is the gate working.
 *
 * ## What it does
 *
 * Reads the reports, keeps the **read** answers together with the grade the
 * old grader gave them, and writes a compact corpus to
 * `fixtures/bench/retained/content-answers.json`.
 *
 * The corpus is the regression input. It is versioned, so the test runs
 * against the same answers on every machine and every platform. The reports
 * stay where they are, untracked and unmodified.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"

const REPO = resolve(import.meta.dir, "..")
const RESULTS = resolve(REPO, "fixtures/bench/results")
const OUT = resolve(REPO, "fixtures/bench/retained/content-answers.json")

/** One retained answer. */
interface Retained {
  file: string
  model: string
  shape: string
  task: string
  oldGrade: string
  error?: string
  answer: string
}

/** The regrade's own summary, kept alongside the answers it summarises. */
interface RegradeSummary {
  regradeVersion?: string
  graderVersion?: string
  executionValidity?: { validRuns?: number; invalidRuns?: number }
  validRuns?: number
  oldToNew?: Record<string, Record<string, number>>
  ungradableOldByFormat?: Record<string, number>
}

if (!existsSync(RESULTS)) {
  console.error(`The benchmark results are not here: ${RESULTS}`)
  console.error("Run the benchmark first, or fetch the reports. Nothing was written.")
  process.exit(1)
}

const retained: Retained[] = []
const files = readdirSync(RESULTS)
  .filter(file => file.startsWith("report-") && file.endsWith(".json"))
  .sort()

for (const file of files) {
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
    retained.push({
      file,
      model: run.model,
      shape: run.shape,
      task: run.task,
      oldGrade: run.verdict?.grade ?? "unknown",
      // The error is what makes a run **invalid**: it did not complete, so
      // it produced no observation, whatever its answer text says.
      error: run.error,
      answer,
    })
  }
}

if (!retained.length) {
  console.error("No read answers were found. Nothing was written.")
  process.exit(1)
}

// The regrade's own summary travels with the corpus it summarises, so the
// check that the two agree runs everywhere rather than only where a
// generated artifact happens to be lying around.
let regrade: RegradeSummary = {}
try {
  regrade = JSON.parse(readFileSync(join(RESULTS, "regrade-latest.json"), "utf8")) as RegradeSummary
} catch {
  // The summary is optional. The corpus is the source of truth.
}

const corpus = {
  note:
    "The grader's regression corpus: the answers the models actually produced, " +
    "with the grade the old grader gave them. It is versioned so that the " +
    "regression test runs against the same answers on every machine and every " +
    "platform. The benchmark's own reports are gitignored and are not modified. " +
    "Regenerate with `bun run scripts/extract-retained-answers.ts`.",
  source: "fixtures/bench/results/report-*.json",
  count: retained.length,
  regrade,
  answers: retained,
}

mkdirSync(resolve(REPO, "fixtures/bench/retained"), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(corpus, null, 2)}\n`, "utf8")

console.log(`${retained.length} retained answers from ${files.length} reports`)
console.log(`  written: ${OUT}`)

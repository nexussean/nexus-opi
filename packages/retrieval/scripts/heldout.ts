#!/usr/bin/env bun
/**
 * Run the held-out query set.
 *
 *   bun run scripts/heldout.ts
 *
 * These 25 questions were written **after** the retrieval layer was tuned, and
 * none of them were used to change it. They are the only honest estimate of
 * how the retriever does on questions it has never seen.
 */
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { applyKillCriterion, evaluate, type Query } from "../src/evaluate.ts"

const HERE = import.meta.dirname
const QUERIES = resolve(HERE, "../../../fixtures/retrieval/heldout-queries.json")

const REPOSITORIES: Record<string, string> = {
  opi: resolve(HERE, "../../.."),
  kanban: "/Users/nexussean/Documents/Coding/opencode-plugins/kanban",
}

const queries = JSON.parse(await readFile(QUERIES, "utf8")) as Query[]

console.log(`Running ${queries.length} held-out queries\n`)

const report = await evaluate(queries, { repositories: REPOSITORIES })

console.log(`  ${"system".padEnd(6)} ${"hit@5".padStart(8)} ${"prec@5".padStart(8)} ${"tokens(5)".padStart(10)} ${"tokens→ans".padStart(11)}`)
console.log(`  ${"opi".padEnd(6)} ${report.opi.hitAt5.toFixed(3).padStart(8)} ${report.opi.precisionAt5.toFixed(3).padStart(8)} ${String(report.opi.medianTokens).padStart(10)} ${String(report.opi.medianTokensToAnswer).padStart(11)}`)
console.log(`  ${"grep".padEnd(6)} ${report.grep.hitAt5.toFixed(3).padStart(8)} ${report.grep.precisionAt5.toFixed(3).padStart(8)} ${String(report.grep.medianTokens).padStart(10)} ${String(report.grep.medianTokensToAnswer).padStart(11)}`)

console.log("\nBy question kind")
for (const [kind, bucket] of Object.entries(report.perKind)) {
  console.log(`  ${kind.padEnd(10)} ${String(bucket.queries).padStart(3)} queries   opi ${bucket.opi}   grep ${bucket.grep}`)
}

const misses = report.results.filter((result) => !result.opi.hit)
if (misses.length) {
  console.log("\nMisses")
  for (const result of misses) {
    console.log(`  ${result.id}  ${result.query}`)
    console.log(`     want: ${result.expected.join(", ")}`)
    console.log(`     got:  ${result.opi.paths.join(", ") || "-"}`)
  }
}

const verdict = applyKillCriterion(report)
console.log("\nKill criterion")
for (const check of verdict.checks) {
  console.log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}  (${check.value})`)
}
console.log(`\n  ${verdict.passed ? "PASSES" : `FAILS: ${verdict.failures.join("; ")}`}\n`)

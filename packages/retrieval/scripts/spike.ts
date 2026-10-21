#!/usr/bin/env bun
/**
 * Run the retrieval spike.
 *
 *   bun run scripts/spike.ts
 *
 * Builds an index over each repository, runs the query set against OPI and
 * against the grep baseline, and applies the kill criterion.
 */
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { applyKillCriterion, evaluate, type Query } from "../src/evaluate.ts"

const HERE = import.meta.dirname
const QUERIES = resolve(HERE, "../../../fixtures/retrieval/queries.json")

const REPOSITORIES: Record<string, string> = {
  opi: resolve(HERE, "../../.."),
  kanban: "/Users/nexussean/Documents/Coding/opencode-plugins/kanban",
}

const queries = JSON.parse(await readFile(QUERIES, "utf8")) as Query[]

console.log(`Running ${queries.length} queries over ${Object.keys(REPOSITORIES).length} repositories\n`)

const floorArg = process.argv.indexOf("--floor")
const relativeFloor = floorArg === -1 ? undefined : Number(process.argv[floorArg + 1])
const report = await evaluate(queries, {
  repositories: REPOSITORIES,
  ...(relativeFloor === undefined ? {} : { relativeFloor }),
})

console.log("Repositories")
for (const [name, info] of Object.entries(report.repositories)) {
  console.log(`  ${name.padEnd(8)} ${String(info.files).padStart(4)} files  ${String(info.symbols).padStart(5)} symbols  ${info.buildMs}ms`)
}

console.log("\nResults")
console.log(`  ${"system".padEnd(6)} ${"hit@5".padStart(8)} ${"prec@5".padStart(8)} ${"tokens(5)".padStart(10)} ${"tokens→ans".padStart(11)}`)
console.log(`  ${"opi".padEnd(6)} ${report.opi.hitAt5.toFixed(3).padStart(8)} ${report.opi.precisionAt5.toFixed(3).padStart(8)} ${String(report.opi.medianTokens).padStart(10)} ${String(report.opi.medianTokensToAnswer).padStart(11)}`)
console.log(`  ${"grep".padEnd(6)} ${report.grep.hitAt5.toFixed(3).padStart(8)} ${report.grep.precisionAt5.toFixed(3).padStart(8)} ${String(report.grep.medianTokens).padStart(10)} ${String(report.grep.medianTokensToAnswer).padStart(11)}`)

console.log("\nBy question kind")
for (const [kind, bucket] of Object.entries(report.perKind)) {
  console.log(`  ${kind.padEnd(10)} ${String(bucket.queries).padStart(3)} queries   opi ${bucket.opi}   grep ${bucket.grep}`)
}

console.log("\nMisses")
for (const result of report.results) {
  if (result.opi.hit && result.grep.hit) continue
  console.log(`  ${result.id}  ${result.query}`)
  console.log(`     expected: ${result.expected.join(", ")}`)
  console.log(`     opi:      ${result.opi.hit ? "hit" : "MISS"} ${result.opi.paths.join(", ") || "-"}`)
  console.log(`     grep:     ${result.grep.hit ? "hit" : "MISS"} ${result.grep.paths.join(", ") || "-"}`)
}

const verdict = applyKillCriterion(report)
console.log("\nKill criterion")
for (const check of verdict.checks) {
  console.log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}  (${check.value})`)
}
console.log(`\n  ${verdict.passed ? "SPIKE PASSES" : `SPIKE FAILS: ${verdict.failures.join("; ")}`}\n`)

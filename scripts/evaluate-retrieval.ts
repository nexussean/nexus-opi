/**
 * The OPI-027 retrieval evaluation.
 *
 * The spike's numbers (hit@5 0.960) were measured on the **spike's** retriever.
 * This measures the **shipping path** — `assembleContext` over a
 * `PersistentIndex` — which is what `pi.context` actually calls.
 *
 * The held-out set is the one written after tuning, never used to change the
 * ranking. It is read, not written. The pass threshold is the plan's 90% and
 * it is **not moved** if the result lands below it.
 *
 * Run: bun run scripts/evaluate-retrieval.ts
 */
import { readFileSync, readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { assembleContext, type ContextCandidate } from "../packages/retrieval/src/context.ts"
import { PersistentIndex } from "../packages/retrieval/src/persistent.ts"
import { indexPath } from "../packages/db/src/index.ts"
import { defaultDataDir } from "../packages/db/src/paths.ts"

interface HeldOut {
  id: string
  repo: string
  kind: string
  query: string
  expect: string[]
}

// The repository root. The expected paths in the fixture are relative to it.
const ROOT = resolve(import.meta.dir, "..")
const REPOS: Record<string, string> = {
  opi: ROOT,
  kanban: resolve(ROOT, "../opencode-plugins/kanban"),
}

/** The words a query uses, the way the retriever reads them. */
function words(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((word) => word.length > 2)
}

/**
 * The grep baseline.
 *
 * A file matches when it contains any of the query's words. This is what
 * `grep -l` does, and it is given the same query interpretation the
 * retriever uses, so the comparison is about the *retriever* and not about
 * the baseline being handicapped.
 */
function grepBaseline(root: string, query: string, limit: number): string[] {
  const terms = words(query)
  if (terms.length === 0) return []
  const files: { path: string; hits: number }[] = []
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    if (path.includes("/node_modules/") || path.includes("/.git/")) continue
    if (!/\.[a-z]{2,4}$/.test(path)) continue
    let content: string
    try {
      content = readFileSync(path, "utf8")
    } catch {
      continue
    }
    const lower = content.toLowerCase()
    const hits = terms.filter((word) => lower.includes(word)).length
    if (hits > 0) files.push({ path: path.slice(root.length + 1), hits })
  }
  return files
    .sort((a, b) => b.hits - a.hits).slice(0, limit).map((file) => file.path)
}

function score(results: string[], expected: string[]): { hit: boolean; precision: number } {
  const hits = results.filter((path) => expected.includes(path)).length
  return { hit: hits > 0, precision: results.length > 0 ? hits / results.length : 0 }
}

interface Totals {
  hits: number
  precision: number
  packTokens: number
  answerTokens: number
  answerCount: number
  byKind: Map<string, { total: number; hit: number }>
  misses: { id: string; query: string; want: string[]; got: string[] }[]
}

function emptyTotals(): Totals {
  return {
    hits: 0,
    precision: 0,
    packTokens: 0,
    answerTokens: 0,
    answerCount: 0,
    byKind: new Map(),
    misses: [],
  }
}

async function main() {
  const heldOut = JSON.parse(
    await readFile(join(ROOT, "fixtures/retrieval/heldout-queries.json"), "utf8"),
  ) as HeldOut[]

  const indexes = new Map<string, PersistentIndex>()
  for (const [name, root] of Object.entries(REPOS)) {
    const index = new PersistentIndex({ root, path: indexPath(root, defaultDataDir()) })
    await index.refresh()
    indexes.set(name, index)
  }

  console.log(`Running ${heldOut.length} held-out queries through the shipping path\n`)
  console.log("  system    hit@5   prec@5  tokens(5)  tokens→ans")

  const opi = emptyTotals()
  const grep = emptyTotals()

  for (const item of heldOut) {
    const index = indexes.get(item.repo)
    const root = REPOS[item.repo]
    if (!index || !root) continue

    // --- OPI: the shipping path ---
    const result = assembleContext(index, item.query, { budgetTokens: 1500, maxCandidates: 5 })
    const paths = result.candidates.map((candidate: ContextCandidate) => candidate.path)
    const opiOutcome = score(paths, item.expect)
    if (opiOutcome.hit) opi.hits += 1
    opi.precision += opiOutcome.precision
    opi.packTokens += result.tokens
    const answerIndex = result.candidates.findIndex((candidate) => item.expect.includes(candidate.path))
    if (answerIndex >= 0) {
      opi.answerTokens += result.candidates
        .slice(0, answerIndex + 1)
        .reduce((sum, candidate) => sum + Math.ceil((candidate.snippet || candidate.path).length / 4), 0)
      opi.answerCount += 1
    }
    const opiKind = opi.byKind.get(item.kind) ?? { total: 0, hit: 0 }
    opiKind.total += 1
    if (opiOutcome.hit) opiKind.hit += 1
    opi.byKind.set(item.kind, opiKind)
    if (!opiOutcome.hit) {
      opi.misses.push({ id: item.id, query: item.query, want: item.expect, got: paths })
    }

    // --- grep: the baseline ---
    const grepPaths = grepBaseline(root, item.query, 5)
    const grepOutcome = score(grepPaths, item.expect)
    if (grepOutcome.hit) grep.hits += 1
    grep.precision += grepOutcome.precision
    const grepAnswer = grepPaths.findIndex((path) => item.expect.includes(path))
    if (grepAnswer >= 0) {
      // The cost of a grep answer is the file the agent must read, at its
      // own size — which is why grep is expensive even when it is right.
      let size = 0
      for (let i = 0; i <= grepAnswer; i++) {
        try {
          size += readFileSync(join(root, grepPaths[i]!), "utf8").length
        } catch {
          // A file that cannot be read costs nothing in the estimate.
        }
      }
      grep.answerTokens += Math.ceil(size / 4)
      grep.answerCount += 1
    }
    const grepKind = grep.byKind.get(item.kind) ?? { total: 0, hit: 0 }
    grepKind.total += 1
    if (grepOutcome.hit) grepKind.hit += 1
    grep.byKind.set(item.kind, grepKind)
  }

  const total = heldOut.length
  const row = (label: string, t: Totals) => {
    const hitRate = t.hits / total
    const precision = t.precision / total
    const pack = Math.round(t.packTokens / total)
    const answer = t.answerCount > 0 ? String(Math.round(t.answerTokens / t.answerCount)) : "-"
    console.log(
      `  ${label.padEnd(9)}${hitRate.toFixed(3).padStart(6)}  ${precision.toFixed(3).padStart(6)}  ${String(pack).padStart(8)}  ${answer.padStart(9)}`,
    )
    return hitRate
  }

  const opiRate = row("opi", opi)
  const grepRate = row("grep", grep)

  console.log("\nBy question kind")
  for (const kind of [...opi.byKind.keys()].sort()) {
    const o = opi.byKind.get(kind)!
    const g = grep.byKind.get(kind)!
    console.log(
      `  ${kind.padEnd(10)} ${String(o.total).padStart(2)} queries   opi ${o.hit}   grep ${g.hit}`,
    )
  }

  if (opi.misses.length > 0) {
    console.log("\nMisses")
    for (const miss of opi.misses) {
      console.log(`  ${miss.id}  ${miss.query}`)
      console.log(`     want: ${miss.want.join(", ")}`)
      console.log(`     got:  ${miss.got.join(", ") || "(nothing)"}`)
    }
  }

  const threshold = 0.9
  console.log("\nKill criterion")
  const passes =
    opiRate >= threshold && opiRate > grepRate
  console.log(
    `  ${opiRate >= threshold ? "PASS" : "FAIL"}  OPI hit@5 is at least ${threshold}  (${opiRate.toFixed(3)})`,
  )
  console.log(
    `  ${opiRate > grepRate ? "PASS" : "FAIL"}  OPI hit@5 is strictly greater than grep's  (${opiRate.toFixed(3)} vs ${grepRate.toFixed(3)})`,
  )

  for (const index of indexes.values()) index.close()

  // The exit code is the gate. A retrieval change that drops the held-out
  // score below the threshold must fail the run, not merely print a number.
  if (!passes) {
    console.error("\nThe held-out retrieval score is below the threshold. This is a regression.")
    process.exit(1)
  }
}

await main()

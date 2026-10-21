import { spawn } from "node:child_process"
import { CodeIndex } from "./indexer.ts"
import { estimateTokens, interpretQuery, retrieve } from "./retrieve.ts"

export interface Query {
  id: string
  /** Which repository the question is about. */
  repo: string
  query: string
  /** Files that answer the question, relative to the repository root. */
  expect: string[]
  kind: "symbol" | "usage" | "feature" | "concept" | "config"
}

export interface QueryResult {
  id: string
  repo: string
  kind: string
  query: string
  expected: string[]
  opi: { paths: string[]; hit: boolean; precision: number; tokens: number; tokensToAnswer: number | null }
  grep: { paths: string[]; hit: boolean; precision: number; tokens: number; tokensToAnswer: number | null }
}

export interface EvaluationReport {
  repositories: Record<string, { files: number; symbols: number; buildMs: number }>
  opi: { hitAt5: number; precisionAt5: number; medianTokens: number; medianTokensToAnswer: number; queries: number }
  grep: { hitAt5: number; precisionAt5: number; medianTokens: number; medianTokensToAnswer: number; queries: number }
  perKind: Record<string, { opi: number; grep: number; queries: number }>
  results: QueryResult[]
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? 0
}

/**
 * The baseline: what an agent does today.
 *
 * `grep -rn` over the repository, taking the distinct files it names, in the order grep
 * reports them, and the matching lines as the evidence.
 *
 * Two concessions to the baseline, both things a competent agent does anyway:
 *
 * - `node_modules` and build output are excluded. Grepping into `node_modules` returns
 *   noise, not answers, and no agent means to read it.
 * - The query is interpreted with the **same** helper the retriever uses, so the
 *   comparison isolates the retrieval mechanism from query understanding. If the
 *   baseline were worse at picking a search term, that would be a finding about
 *   query understanding, not about indexing.
 */
async function grepBaseline(
  repo: string,
  query: string,
  expected: string[],
): Promise<{ paths: string[]; tokens: number; tokensToAnswer: number | null }> {
  const interpreted = interpretQuery(query)
  const term = interpreted.symbol ?? interpreted.terms[0]
  if (!term) return { paths: [], tokens: 0, tokensToAnswer: null }

  const proc = Bun.spawn(
    [
      "grep",
      "-rn",
      "--include=*.ts",
      "--include=*.tsx",
      "--include=*.js",
      "--include=*.jsx",
      "--exclude-dir=node_modules",
      "--exclude-dir=dist",
      "--exclude-dir=build",
      "--exclude-dir=.git",
      "--exclude-dir=coverage",
      term,
      repo,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  if (code !== 0 && !out) return { paths: [], tokens: 0, tokensToAnswer: null }

  const expectedSet = new Set(expected)
  const paths: string[] = []
  const seen = new Set<string>()
  let tokens = 0
  let tokensToAnswer: number | null = null
  for (const line of out.split("\n")) {
    if (!line) continue
    const match = /^(.+?):\d+:(.*)$/.exec(line)
    if (!match) continue
    const file = match[1]!.replace(`${repo}/`, "")
    if (!seen.has(file)) {
      seen.add(file)
      paths.push(file)
    }
    // The evidence grep gives is the matching line.
    if (paths.length <= 5) {
      const cost = estimateTokens(match[2] ?? "")
      tokens += cost
      // The cost of reaching the answer: everything read up to and including
      // the first file that answers the question.
      if (tokensToAnswer === null && expectedSet.has(file)) tokensToAnswer = tokens
    }
  }
  return { paths: paths.slice(0, 5), tokens, tokensToAnswer }
}

/** The tokens of the evidence pack up to and including the first correct file. */
function tokensToAnswer(
  paths: string[],
  hits: { path: string; snippet?: string }[],
  expected: string[],
): number | null {
  const expectedSet = new Set(expected)
  let total = 0
  for (let index = 0; index < paths.length; index++) {
    const hit = hits[index]
    total += estimateTokens(hit?.snippet ?? paths[index] ?? "")
    if (expectedSet.has(paths[index]!)) return total
  }
  return null
}

function score(paths: string[], expected: string[]): { hit: boolean; precision: number } {
  if (paths.length === 0) return { hit: false, precision: 0 }
  const expectedSet = new Set(expected)
  const relevant = paths.filter((path) => expectedSet.has(path)).length
  return { hit: relevant > 0, precision: relevant / paths.length }
}

export interface EvaluateOptions {
  /** Map of repository name to its root directory. */
  repositories: Record<string, string>
  limit?: number
  /** The relative relevance floor to evaluate at. */
  relativeFloor?: number
}

/** Run the query set against the index and against the grep baseline. */
export async function evaluate(queries: Query[], options: EvaluateOptions): Promise<EvaluationReport> {
  const limit = options.limit ?? 5
  const indexes = new Map<string, CodeIndex>()
  const repositoryInfo: EvaluationReport["repositories"] = {}

  for (const [name, root] of Object.entries(options.repositories)) {
    const started = Date.now()
    const index = new CodeIndex(root)
    await index.build()
    indexes.set(name, index)
    repositoryInfo[name] = {
      files: index.fileCount,
      symbols: index.symbolCount,
      buildMs: Date.now() - started,
    }
  }

  const results: QueryResult[] = []

  for (const query of queries) {
    const index = indexes.get(query.repo)
    if (!index) throw new Error(`No index for repository ${query.repo}`)

    const opiResult = retrieve(index, query.query, {
      limit,
      ...(options.relativeFloor === undefined ? {} : { relativeFloor: options.relativeFloor }),
    })
    const opiPaths = opiResult.hits.map((hit) => hit.path)
    const opiScore = score(opiPaths, query.expect)

    const baseline = await grepBaseline(options.repositories[query.repo]!, query.query, query.expect)
    const grepScore = score(baseline.paths, query.expect)

    results.push({
      id: query.id,
      repo: query.repo,
      kind: query.kind,
      query: query.query,
      expected: query.expect,
      opi: {
        paths: opiPaths,
        hit: opiScore.hit,
        precision: opiScore.precision,
        tokens: opiResult.tokens,
        tokensToAnswer: tokensToAnswer(opiPaths, opiResult.hits, query.expect),
      },
      grep: {
        paths: baseline.paths,
        hit: grepScore.hit,
        precision: grepScore.precision,
        tokens: baseline.tokens,
        tokensToAnswer: baseline.tokensToAnswer,
      },
    })
  }

  const opiHits = results.filter((result) => result.opi.hit).length
  const grepHits = results.filter((result) => result.grep.hit).length

  const perKind: EvaluationReport["perKind"] = {}
  for (const result of results) {
    const bucket = (perKind[result.kind] ??= { opi: 0, grep: 0, queries: 0 })
    bucket.queries += 1
    if (result.opi.hit) bucket.opi += 1
    if (result.grep.hit) bucket.grep += 1
  }

  return {
    repositories: repositoryInfo,
    opi: {
      hitAt5: opiHits / results.length,
      precisionAt5: results.reduce((sum, result) => sum + result.opi.precision, 0) / results.length,
      medianTokens: median(results.map((result) => result.opi.tokens)),
      medianTokensToAnswer: median(
        results.map((result) => result.opi.tokensToAnswer ?? 0).filter((value) => value > 0),
      ),
      queries: results.length,
    },
    grep: {
      hitAt5: grepHits / results.length,
      precisionAt5: results.reduce((sum, result) => sum + result.grep.precision, 0) / results.length,
      medianTokens: median(results.map((result) => result.grep.tokens)),
      medianTokensToAnswer: median(
        results.map((result) => result.grep.tokensToAnswer ?? 0).filter((value) => value > 0),
      ),
      queries: results.length,
    },
    perKind,
    results,
  }
}

/** Apply the kill criterion from the spike's hypothesis document. */
export function applyKillCriterion(report: EvaluationReport): {
  passed: boolean
  failures: string[]
  checks: { name: string; value: string; ok: boolean }[]
} {
  const checks = [
    {
      name: "OPI hit@5 is strictly greater than grep's",
      value: `${report.opi.hitAt5.toFixed(3)} vs ${report.grep.hitAt5.toFixed(3)}`,
      ok: report.opi.hitAt5 > report.grep.hitAt5,
    },
    {
      name: "OPI hit@5 is at least 0.90",
      value: report.opi.hitAt5.toFixed(3),
      ok: report.opi.hitAt5 >= 0.9,
    },
    {
      name: "OPI's median tokens are at most a third of the baseline's",
      value: `${report.opi.medianTokens} vs ${report.grep.medianTokens}`,
      ok: report.opi.medianTokens <= report.grep.medianTokens / 3,
    },
  ]
  const failures = checks.filter((check) => !check.ok).map((check) => check.name)
  return { passed: failures.length === 0, failures, checks }
}

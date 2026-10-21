import type { Confidence } from "@opi/contracts"
import { scoreConcept } from "./concept.ts"
import type { CodeIndex } from "./indexer.ts"

export interface RetrievalHit {
  path: string
  score: number
  reason: string
  symbol?: string
  kind?: string
  startLine?: number
  endLine?: number
  /** The cited text. */
  snippet?: string
  /**
   * How sure we are. Nothing is `resolved` without a proven binding — the spike
   * only produces `syntactic` and `unresolved`.
   */
  confidence: Confidence
}

export interface RetrievalResult {
  hits: RetrievalHit[]
  /** The query terms the retriever recognised. */
  interpreted: { symbol?: string; path?: string; terms: string[] }
  /** True when nothing scored above the floor. */
  empty: boolean
  /** The estimated tokens of the evidence pack. */
  tokens: number
}

export interface RetrieveOptions {
  limit?: number
  /** Results below this score are dropped. */
  floor?: number
  /**
   * A hit must score at least this fraction of the best hit. `0` keeps
   * everything, `1` keeps only the top hit. The default drops the noise a
   * pack would otherwise carry.
   */
  relativeFloor?: number
}

/** A conservative byte-to-token bound. Not a tokenizer, and not billed tokens. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "where", "what", "which", "how",
  "does", "defined", "define", "uses", "use", "used", "file", "files", "implement",
  "implemented", "implementation", "handles", "handle", "handling", "function", "method",
  "class", "start", "starts", "begin", "begins", "get", "set", "are", "is", "it", "in", "of",
  "to", "on", "by", "there", "when", "does", "into", "from",
  // Question furniture that carries no domain meaning.
  //
  // "actually" and "really" are adverbs that qualify the question, not the
  // thing asked about. Left in, they became **domain** terms in the concept
  // layer, and "where are the background jobs actually run" matched eight
  // files on "actually"/"run" instead of the one that runs the jobs.
  "actually", "really", "exactly", "probably", "maybe", "simply", "just", "still",
  "also", "only", "even", "well", "though", "rather", "quite", "very", "much", "many",
])

/**
 * Words that describe the **shape** of the thing being asked for rather than
 * its name.
 *
 * "where is the error code list defined" is asking for the thing that holds
 * error codes. The word "list" is how the question describes the answer; the
 * name itself is "error code". Treating "list" as part of the name means the
 * match must be `ErrorCodeList`, which does not exist.
 *
 * "code" is **not** a shape word: `ErrorCode` is a name.
 *
 * These words are dropped when building a compound name, but kept for the
 * lexical and concept layers, where "list" is still a useful signal.
 */
const SHAPE_WORDS = new Set([
  "list", "lists", "set", "sets", "map", "maps", "table", "tables", "array", "arrays",
  "collection", "collections", "index", "indexes", "registry", "registries", "store",
  "stores", "record", "records", "entry", "entries", "config", "configs", "configuration",
  "constants", "constant", "enum", "enums", "values", "value",
])

/**
 * The words that describe the shape of an answer rather than its name.
 *
 * Exported because the shipping path needs the same rule. A question like
 * "where is the schema version constant set" names `SCHEMA_VERSION`; "constant"
 * is how the question describes the answer, and including it would stop the
 * name from matching.
 */
export { SHAPE_WORDS }

/** Pull likely symbol names out of a natural-language question. */
export function interpretQuery(query: string): { symbol?: string; path?: string; terms: string[] } {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term))

  // `BoardStore` or `board_store` — a camel or snake identifier.
  const identifier = /\b([A-Za-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*)\b/.exec(query)
  const snake = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/.exec(query)
  const backticked = /`([^`]+)`/.exec(query)

  let symbol: string | undefined
  if (backticked?.[1]) symbol = backticked[1].trim()
  else if (identifier?.[1]) symbol = identifier[1]
  else if (snake?.[1]) symbol = snake[1]

  const path = /\b((?:[\w.-]+\/)*[\w.-]+\.[a-z]{2,4})\b/.exec(query)?.[1]

  return { ...(symbol ? { symbol } : {}), ...(path ? { path } : {}), terms }
}

/**
 * The weights, in one place so they can be argued with.
 *
 * An exact symbol definition is worth more than everything else combined. A
 * mention in a body is worth a little, and is **capped per file** so that a file
 * which happens to say the word forty times cannot outrank the file that defines
 * the symbol.
 */
const WEIGHTS = {
  exactDefinition: 1.0,
  caseInsensitiveDefinition: 0.8,
  /** A compound name match: "data directory" inside `defaultDataDir`. */
  compoundDefinition: 0.85,
  nameMatch: 0.3,
  pathMatch: 0.25,
  bodyMatch: 0.08,
  /** The most any file can gain from body matches alone. */
  bodyCap: 0.16,
  /** A file that imports a matched file. */
  graphHop: 0.15,
  /** The most any file can gain from graph hops alone. */
  graphCap: 0.3,
  /**
   * A hit must score at least this fraction of the best hit to be included.
   *
   * With a definition scoring 1.0, this keeps candidate answers (a name
   * match at 0.3, a path match at 0.25) and drops context (a graph hop at
   * 0.15, a body mention at 0.08). The boundary is between "could be the
   * answer" and "is adjacent to the answer".
   */
  relativeFloor: 0.15,
  /** The weight of a concept match: an action and a domain in one file. */
  concept: 0.7,
}

/**
 * Compound name matching.
 *
 * A question's words joined without separators should be findable inside a
 * symbol's name joined the same way: "data directory" → `datadir` → found in
 * `defaultDataDir`.
 *
 * The join must be **contiguous** in the symbol name, or "error code" would
 * match `ErrorCode` only by luck. The symbol's own camel-case boundaries are
 * used, and the query's words must line up with them in order.
 */
export function compoundMatches(
  symbolName: string,
  words: string[],
): boolean {
  if (words.length < 2) return false
  // The symbol's parts, in order: `defaultDataDir` → [default, data, dir].
  const parts = symbolName
    .replace(/[^A-Za-z0-9]+/g, " ")
    .split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
    .flatMap((part) => part.split(" "))
    .filter(Boolean)
    .map((part) => part.toLowerCase())
  if (parts.length < words.length) return false

  for (let start = 0; start + words.length <= parts.length; start++) {
    let matched = true
    for (let offset = 0; offset < words.length; offset++) {
      const part = parts[start + offset]!
      const word = words[offset]!
      if (part === word) continue
      // Allow an inflection: `codes` matches `code`.
      if (part.length > word.length && part.startsWith(word)) continue
      if (word.length > part.length && word.startsWith(part)) continue
      matched = false
      break
    }
    if (matched) return true
  }
  return false
}

/**
 * Retrieve the code most likely to answer a question.
 *
 * The signals are deliberately simple and explainable: an exact symbol match dominates, then
 * lexical matches on names, then path matches, then one graph hop to a file that imports a
 * matched file. Every hit carries why it was returned.
 */
export function retrieve(index: CodeIndex, query: string, options: RetrieveOptions = {}): RetrievalResult {
  const limit = options.limit ?? 5
  const floor = options.floor ?? 0.05
  const interpreted = interpretQuery(query)

  interface Entry {
    score: number
    reasons: string[]
    symbol?: string
    kind?: string
    line?: number
    snippet?: string
  }
  const scores = new Map<string, Entry>()

  const bump = (path: string, score: number, reason: string, extra?: Partial<Entry>) => {
    const entry = scores.get(path) ?? { score: 0, reasons: [] }
    entry.score += score
    entry.reasons.push(reason)
    if (extra?.symbol) entry.symbol = extra.symbol
    if (extra?.kind) entry.kind = extra.kind
    if (extra?.line !== undefined) entry.line = extra.line
    if (extra?.snippet) entry.snippet = extra.snippet
    scores.set(path, entry)
  }

  // 1. An exact symbol name is the strongest signal there is.
  if (interpreted.symbol) {
    const exact = index.symbols.get(interpreted.symbol) ?? []
    for (const match of exact) {
      bump(
        match.file,
        WEIGHTS.exactDefinition,
        `defines ${match.symbol.qualifiedName}`,
        {
          symbol: match.symbol.qualifiedName,
          kind: match.symbol.kind,
          line: match.symbol.startLine,
          snippet: match.symbol.text.slice(0, 1200),
        },
      )
    }
    if (exact.length === 0) {
      const lower = interpreted.symbol.toLowerCase()
      for (const [name, entries] of index.symbols) {
        if (name.toLowerCase() !== lower) continue
        for (const entry of entries) {
          bump(
            entry.file,
            WEIGHTS.caseInsensitiveDefinition,
            `defines ${entry.symbol.qualifiedName}`,
            {
              symbol: entry.symbol.qualifiedName,
              kind: entry.symbol.kind,
              line: entry.symbol.startLine,
              snippet: entry.symbol.text.slice(0, 1200),
            },
          )
        }
      }
    }
  }

  // 1b. A compound name: the question's words inside one symbol's name.
  //
  // "where is the data directory chosen" must find `defaultDataDir`, and
  // "where is the error code list defined" must find `ERROR_CODES`. Neither is
  // a symbol the question names outright.
  if (interpreted.terms.length >= 2) {
    const seen = new Set<string>()
    // One compound match per file, across every run of words.
    //
    // A class with nineteen members all called `JobWorker.#something` would
    // otherwise contribute nineteen matches and swamp the file that actually
    // answers the question.
    const matchedFiles = new Set<string>()
    // Every contiguous run of two or more question words, longest first.
    //
    // "error code list" must find `ERROR_CODES`, and the words that match it
    // are "error code" — the run of two, not the run of three. So the runs are
    // tried, not just the whole phrase.
    for (let length = Math.min(3, interpreted.terms.length); length >= 2; length--) {
      for (let start = 0; start + length <= interpreted.terms.length; start++) {
        const raw = interpreted.terms.slice(start, start + length)
        // Drop the words that describe the shape of the answer rather than its
        // name, but only if something is left.
        const words = raw.filter((word) => !SHAPE_WORDS.has(word))
        if (words.length < 2) continue
        for (const entries of index.joinedSymbols.values()) {
          for (const entry of entries) {
            if (!compoundMatches(entry.symbol.qualifiedName, words)) continue
            if (matchedFiles.has(entry.file)) continue
            matchedFiles.add(entry.file)
            const key = `${entry.file}:${entry.symbol.qualifiedName}`
            if (seen.has(key)) continue
            seen.add(key)
            // A longer run of the question's words is stronger evidence.
            const weight = WEIGHTS.compoundDefinition * (1 + (length - 2) * 0.15)
            bump(
              entry.file,
              weight,
              `defines ${entry.symbol.qualifiedName} (matches "${words.join(" ")}")`,
              {
                symbol: entry.symbol.qualifiedName,
                kind: entry.symbol.kind,
                line: entry.symbol.startLine,
                snippet: entry.symbol.text.slice(0, 1200),
              },
            )
          }
        }
      }
    }
  }

  // 2. Lexical search, per column group.
  //
  // A term contributes its **best** score per file, not the sum of every row
  // it matched. Otherwise a file with sixteen symbols called `Board.*` scores
  // sixteen times a file that defines the one symbol you asked about.
  const searchTerms = [interpreted.symbol, ...interpreted.terms].filter(Boolean) as string[]

  for (const term of searchTerms.slice(0, 4)) {
    const nameBest = new Map<string, { qualified: string; snippet?: string }>()
    for (const row of index.search(term, "names", 60)) {
      if (!row.symbol) continue
      const existing = nameBest.get(row.path)
      if (existing) continue
      nameBest.set(row.path, {
        qualified: row.qualified || row.symbol,
        ...(row.snippet ? { snippet: row.snippet } : {}),
      })
    }
    for (const [path, match] of nameBest) {
      bump(path, WEIGHTS.nameMatch, `names ${match.qualified}`, {
        symbol: match.qualified,
        kind: "symbol",
        ...(match.snippet ? { snippet: match.snippet } : {}),
      })
    }

    // The path index has one row per symbol, so the same file comes back
    // many times. It scores once.
    const pathBest = new Set<string>()
    for (const row of index.search(term, "paths", 30)) {
      if (pathBest.has(row.path)) continue
      pathBest.add(row.path)
      bump(row.path, WEIGHTS.pathMatch, `path matches ${term}`)
    }

    const bodyBest = new Map<string, { snippet?: string }>()
    for (const row of index.search(term, "body", 30)) {
      if (bodyBest.has(row.path)) continue
      bodyBest.set(row.path, { ...(row.snippet ? { snippet: row.snippet } : {}) })
    }
    for (const [path, match] of bodyBest) {
      bump(path, WEIGHTS.bodyMatch, `mentions ${term}`, {
        ...(match.snippet ? { snippet: match.snippet } : {}),
      })
    }
  }

  // 3. The concept layer: a file that mentions both an action and a domain.
  //
  // This is what answers questions that name no symbol. The action and the
  // domain are both drawn from the question's own words; the pairing is
  // whichever one the file fits best.
  if (interpreted.terms.length > 0) {
    for (const file of index.files.values()) {
      const evidence = scoreConcept(file.concept, interpreted.terms, interpreted.terms)
      if (!evidence) continue
      bump(
        file.path,
        WEIGHTS.concept * evidence.score,
        `mentions ${evidence.domain} and ${evidence.action} (${evidence.domainIn}/${evidence.actionIn})`,
      )
    }
  }

  // 4. One graph hop: a file that imports a file we already matched.
  //
  // Only the strongest direct matches contribute, and the graph contribution
  // per file is capped, so an importer cannot outweigh the file it imports.
  const direct = [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 3)
    .map(([path]) => path)
  const graphGains = new Map<string, number>()
  for (const path of direct) {
    for (const importer of index.importersOf(path)) {
      const gain = (graphGains.get(importer) ?? 0) + WEIGHTS.graphHop
      if (gain > WEIGHTS.graphCap) continue
      graphGains.set(importer, gain)
      // The importer is a weaker match than the file itself, and is reported as
      // such. The edge is syntactic: nothing here proves a call.
      bump(importer, WEIGHTS.graphHop, `imports ${path}`)
    }
  }

  const hits: RetrievalHit[] = []
  for (const [path, entry] of scores) {
    if (entry.score < floor) continue
    const file = index.files.get(path)
    const symbol = entry.symbol
      ? [...(index.symbols.get(entry.symbol.split(".").pop()!) ?? [])].find((candidate) => candidate.file === path)
          ?.symbol
      : undefined
    hits.push({
      path,
      score: Number(entry.score.toFixed(4)),
      reason: entry.reasons.join("; "),
      ...(symbol ? { symbol: symbol.qualifiedName, kind: symbol.kind } : {}),
      ...(symbol ? { startLine: symbol.startLine, endLine: symbol.endLine } : {}),
      ...(symbol ? { snippet: cite(symbol.text) } : entry.snippet ? { snippet: entry.snippet } : {}),
      confidence: "syntactic",
    })
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))

  // A relative relevance floor. A hit that scores a fraction of the best one
  // is noise, and noise in an evidence pack costs context without adding
  // confidence. The absolute floor still applies.
  const best = hits[0]?.score ?? 0
  const relativeFloor = options.relativeFloor ?? WEIGHTS.relativeFloor
  const relevant = hits.filter((hit) => hit.score >= Math.max(floor, best * relativeFloor))
  const top = relevant.slice(0, limit)

  const tokens = top.reduce((sum, hit) => sum + estimateTokens(hit.snippet ?? hit.path), 0)
  return { hits: top, interpreted, empty: top.length === 0, tokens }
}

/**
 * A citation is a **signature**, not a body.
 *
 * The agent can read the file if it needs more. Handing it the whole definition
 * would make every answer expensive and would not make it more correct.
 */
export function cite(text: string): string {
  const lines = text.split("\n").slice(0, 3).join("\n").trim()
  return lines.length > 240 ? `${lines.slice(0, 237)}...` : lines
}

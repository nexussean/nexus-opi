import type { Confidence, SourceRef } from "@opi/contracts"
import { scoreConcept } from "./concept.ts"
import { LexicalIndex, exactMatches } from "./lexical.ts"
import type { PersistentIndex } from "./persistent.ts"
import { queryGraph } from "./graph.ts"
import { compoundMatches, interpretQuery, SHAPE_WORDS } from "./retrieve.ts"

/**
 * The context assembler.
 *
 * The plan's contract (doc 05):
 *
 * 1. Normalise the query; detect probable symbols, filenames and paths.
 * 2. Generate candidates from exact symbol match, FTS, path/name, and the graph.
 * 3. Restrict candidates by the active epoch and the exclusion policy.
 * 4. Rank with weighted signals.
 * 5. Apply diversity and dedupe.
 * 6. Return the smallest useful spans, with why each was selected.
 * 7. When relevance is insufficient, return `partial` plus a recommendation —
 *    never bury a relevant file because the graph missed an edge.
 *
 * The budget is a hard bound. A pack that would exceed it is cut and says so.
 */

export interface ContextCandidate {
  path: string
  symbol: string
  qualifiedName: string
  kind: string
  startLine: number
  endLine: number
  snippet: string
  score: number
  /** Why this was selected. */
  reason: string
  confidence: Confidence
  /** The signals that contributed. */
  signals: string[]
}

export interface ContextResult {
  candidates: ContextCandidate[]
  /** The estimated tokens of the pack. */
  tokens: number
  /** The budget that was in force. */
  budgetTokens: number
  /** True when the pack was cut short. */
  truncated: boolean
  /** True when nothing scored well enough. */
  partial: boolean
  /** What to do when the result is partial. */
  recommendation?: string
  warnings: string[]
}

export interface AssembleOptions {
  /** The token budget. The plan's default is 1 500; the ceiling is 6 000. */
  budgetTokens?: number
  /** How many candidates to return at most. */
  maxCandidates?: number
}

/** The plan's budgets. */
export const BUDGETS = {
  default: 1500,
  min: 300,
  max: 6000,
}

/**
 * The ranking weights.
 *
 * The plan's starting heuristic (doc 05): text relevance 0.35, symbol/path
 * exactness 0.25, graph proximity 0.20, task/memory relation 0.15,
 * freshness 0.05. There are no tasks or memories yet, so that 0.15 is
 * redistributed to the signals that exist and the total is kept at 1.
 */
const WEIGHTS = {
  /** An exact definition. Nothing outranks it. */
  exact: 1.0,
  /**
   * A compound name: the question's words inside one symbol's name.
   *
   * Stronger than a lexical match, because the symbol's *whole* name is
   * built from the question's words rather than merely containing one of
   * them. Weaker than an exact match, because the question did not name the
   * symbol outright.
   */
  compound: 0.85,
  /** A lexical match on a name. */
  text: 0.5,
  /** A path that matches. */
  path: 0.35,
  /** A file that mentions both an action and a domain. */
  concept: 0.3,
  /** A file linked to the target by an import. */
  graph: 0.2,
}

/** A conservative byte-to-token bound. Not a tokenizer, and not billed tokens. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Is this a test file? */
export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__)\//.test(path) || /\.(test|spec)\.[jt]sx?$/.test(path)
}

/** The words a question uses that name a symbol. */
function probableSymbol(query: string): string | undefined {
  const backticked = /`([^`]+)`/.exec(query)
  if (backticked?.[1]) return backticked[1].trim()
  const identifier = /\b([A-Za-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*)\b/.exec(query)
  if (identifier?.[1]) return identifier[1]
  const snake = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/.exec(query)
  if (snake?.[1]) return snake[1]
  return undefined
}

function probablePath(query: string): string | undefined {
  return /\b((?:[\w.-]+\/)*[\w.-]+\.[a-z]{2,4})\b/.exec(query)?.[1]
}

/**
 * Assemble an evidence pack for a question.
 */
export function assembleContext(
  index: PersistentIndex,
  query: string,
  options: AssembleOptions = {},
): ContextResult {
  const budget = Math.min(
    BUDGETS.max,
    Math.max(BUDGETS.min, options.budgetTokens ?? BUDGETS.default),
  )
  const maxCandidates = options.maxCandidates ?? 12
  const warnings: string[] = []

  const lexical = new LexicalIndex(index)
  const symbol = probableSymbol(query)
  const path = probablePath(query)

  /** path|symbol -> candidate */
  const candidates = new Map<string, ContextCandidate>()
  const signals = new Map<string, Set<string>>()

  const consider = (candidate: Omit<ContextCandidate, "score" | "signals">, signal: string, weight: number) => {
    const key = `${candidate.path}:${candidate.qualifiedName}`
    const existing = candidates.get(key)
    if (!existing) {
      candidates.set(key, {
        ...candidate,
        score: weight,
        signals: [signal],
      })
      return
    }
    existing.score += weight
    if (!existing.signals.includes(signal)) existing.signals.push(signal)
  }

  // 1. An exact symbol match. The strongest signal there is.
  if (symbol) {
    for (const hit of exactMatches(index, symbol)) {
      consider(
        {
          path: hit.path,
          symbol: hit.symbol,
          qualifiedName: hit.qualifiedName,
          kind: hit.kind,
          startLine: hit.startLine,
          endLine: hit.endLine,
          snippet: "",
          reason: `defines ${hit.qualifiedName}`,
          confidence: "resolved",
        },
        "exact",
        WEIGHTS.exact,
      )
    }
  }

  // 2. A compound name: the question's words inside one symbol's name.
  //
  // "where is the schema version constant set" must find `SCHEMA_VERSION`,
  // and "where is the data directory chosen" must find `defaultDataDir`.
  // Neither is a symbol the question names outright, and the concept layer
  // cannot find them either — the question's action word ("constant", "set")
  // appears nowhere in the code.
  //
  // This is the one signal the concept layer cannot replace, and it is the
  // same signal the spike's retriever had. Leaving it out made the shipping
  // path weaker than the spike it was built from.
  {
    const terms = interpretQuery(query).terms
    if (terms.length >= 2) {
      // One compound match per file: a class with nineteen members would
      // otherwise contribute nineteen matches and swamp the answer.
      const matchedFiles = new Set<string>()
      // Every contiguous run of two or more question words, longest first.
      //
      // "error code list" must find `ERROR_CODES`, and the words that match
      // it are "error code" — the run of two, not the run of three.
      for (let length = Math.min(3, terms.length); length >= 2; length--) {
        for (let start = 0; start + length <= terms.length; start++) {
          const raw = terms.slice(start, start + length)
          // Drop the words that describe the shape of the answer rather than
          // its name, but only if something is left.
          const words = raw.filter((word) => !SHAPE_WORDS.has(word))
          if (words.length < 2) continue
          for (const file of index.files()) {
            if (matchedFiles.has(file.path)) continue
            const symbols = index.symbolsIn(file.path)
            const match = symbols.find((candidate) => compoundMatches(candidate.qualifiedName, words))
            if (!match) continue
            matchedFiles.add(file.path)
            consider(
              {
                path: file.path,
                symbol: match.name,
                qualifiedName: match.qualifiedName,
                kind: match.kind,
                startLine: match.startLine,
                endLine: match.endLine,
                snippet: "",
                reason: `defines ${match.qualifiedName} (matches "${words.join(" ")}")`,
                confidence: "syntactic",
              },
              "compound",
              // A longer run of the question's words is stronger evidence.
              WEIGHTS.compound * (1 + (length - 2) * 0.15),
            )
          }
        }
      }
    }
  }

  // 3. A lexical match on names.
  if (symbol) {
    for (const hit of lexical.names(symbol).hits) {
      consider(
        {
          path: hit.path,
          symbol: hit.symbol,
          qualifiedName: hit.qualifiedName,
          kind: hit.kind,
          startLine: hit.startLine,
          endLine: hit.endLine,
          snippet: hit.snippet,
          reason: `names ${hit.qualifiedName}`,
          confidence: hit.confidence,
        },
        "text",
        WEIGHTS.text,
      )
    }
  }

  // 3. A path match.
  if (path) {
    for (const hit of lexical.paths(path).hits) {
      consider(
        {
          path: hit.path,
          symbol: hit.symbol,
          qualifiedName: hit.qualifiedName,
          kind: hit.kind,
          startLine: hit.startLine,
          endLine: hit.endLine,
          snippet: hit.snippet,
          reason: `path matches ${path}`,
          confidence: "syntactic",
        },
        "path",
        WEIGHTS.path,
      )
    }
  }

  // 4. A concept match: a file that mentions both an action and a domain.
  //
  // The terms come from the same interpretation the retriever uses, so
  // question furniture — "the", "where", "defined" — is filtered out. Without
  // that, every file in the project matches "the" and the ranking is noise.
  const terms = interpretQuery(query).terms
  if (terms.length > 0) {
    for (const file of index.files()) {
      const evidence = scoreConcept(file.concept, terms, terms)
      if (!evidence) continue
      const symbols = index.symbolsIn(file.path)
      // The symbol that best matches the question, not simply the first one.
      const best =
        symbols.find((symbol) => terms.some((term) => symbol.qualifiedName.toLowerCase().includes(term))) ??
        symbols.find((symbol) => symbol.name.toLowerCase().includes(evidence.domain)) ??
        symbols[0]
      // A file whose own name or path carries the terms is a better answer
      // than one that merely mentions them, and says so.
      const pathSignal = terms.some((term) => file.path.toLowerCase().includes(term))
      const symbolSignal = terms.some((term) => (best?.qualifiedName ?? "").toLowerCase().includes(term))
      consider(
        {
          path: file.path,
          symbol: best?.name ?? "",
          qualifiedName: best?.qualifiedName ?? file.path,
          kind: best?.kind ?? "file",
          startLine: best?.startLine ?? 0,
          endLine: best?.endLine ?? 0,
          snippet: "",
          reason: pathSignal
            ? `its path names ${evidence.domain}`
            : symbolSignal
              ? `defines ${best?.qualifiedName}`
              : `mentions ${evidence.domain} and ${evidence.action}`,
          confidence: "syntactic",
        },
        "concept",
        // The evidence's own strength carries the weight. A file whose
        // symbols name both the action and the domain is a far better answer
        // than one that mentions them in passing, and a flat weight threw
        // that away.
        WEIGHTS.concept * evidence.score * (pathSignal || symbolSignal ? 1.5 : 1),
      )
    }
  }

  // 5. A graph neighbour, when the question names a symbol.
  if (symbol) {
    const graph = queryGraph(index, { action: "neighbors", query: symbol, maxSymbols: 6 })
    for (const node of graph.nodes) {
      consider(
        {
          path: node.path,
          symbol: node.name,
          qualifiedName: node.qualifiedName,
          kind: node.kind,
          startLine: node.startLine,
          endLine: node.endLine,
          snippet: "",
          reason: node.reason,
          confidence: node.confidence,
        },
        "graph",
        WEIGHTS.graph,
      )
    }
  }

  // Rank, then dedupe: one long snippet per file.
  //
  // The tiebreak is not alphabetical. When two files score the same, the one
  // that is a **test** file loses to the one that is not, and among equals the
  // shorter path wins. A test file is evidence about the code, not the code
  // itself, and a reader asking "where is X" wants the implementation.
  const ranked = [...candidates.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const aTest = isTestPath(a.path)
    const bTest = isTestPath(b.path)
    if (aTest !== bTest) return aTest ? 1 : -1
    if (a.path.length !== b.path.length) return a.path.length - b.path.length
    return a.path.localeCompare(b.path)
  })
  const perFile = new Map<string, number>()
  const deduped: ContextCandidate[] = []
  for (const candidate of ranked) {
    const seen = perFile.get(candidate.path) ?? 0
    if (seen >= 1) continue
    perFile.set(candidate.path, seen + 1)
    deduped.push(candidate)
  }

  // Fill in a snippet for anything that has none, from the symbol's text.
  for (const candidate of deduped) {
    if (candidate.snippet) continue
    const source = index.symbolText(candidate.path)
    if (source) candidate.snippet = source
  }

  // The budget is a hard bound. The pack is cut, and it says so.
  const selected: ContextCandidate[] = []
  let tokens = 0
  let truncated = false
  for (const candidate of deduped) {
    if (selected.length >= maxCandidates) {
      truncated = true
      break
    }
    const cost = estimateTokens(candidate.snippet || candidate.path)
    if (tokens + cost > budget) {
      truncated = true
      break
    }
    selected.push(candidate)
    tokens += cost
  }

  // An empty pack has two very different causes, and the caller must be able
  // to tell them apart.
  //
  // - The **budget or the cap** cut everything: the candidates exist, they
  //   were simply not returned. Raising the budget would help.
  // - **Nothing scored**: the index has no answer. Raising the budget would
  //   not help, and the answer may not be in the index at all.
  const hadCandidates = deduped.length > 0
  const partial = selected.length === 0

  if (partial && hadCandidates) {
    warnings.push(
      `The pack was cut at the ${budget}-token budget. The candidates are in the index but were not returned.`,
    )
  } else if (partial) {
    warnings.push(
      "Nothing in the index scored well enough for this question. The answer may still be in the project: try the native grep or read tools, or ask about a symbol by name.",
    )
  } else if (truncated) {
    warnings.push(
      `The pack was cut at the ${budget}-token budget. The remaining candidates are in the index but were not returned.`,
    )
  }

  return {
    candidates: selected,
    tokens,
    budgetTokens: budget,
    truncated,
    partial,
    ...(partial
      ? {
          recommendation:
            "Use the native grep or read tools, or narrow the question to a symbol name. A missing candidate is not evidence that the file is irrelevant.",
        }
      : {}),
    warnings,
  }
}

/** The source references for a context result. */
export function contextSources(result: ContextResult): SourceRef[] {
  return result.candidates.map((candidate) => ({
    path: candidate.path,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    confidence: candidate.confidence,
  }))
}

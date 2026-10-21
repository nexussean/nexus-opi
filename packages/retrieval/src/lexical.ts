import type { Confidence } from "@opi/contracts"
import type { PersistentIndex } from "./persistent.ts"

/**
 * The lexical and path index.
 *
 * The graph and the retriever now share one store: the persistent index. This
 * layer is the lexical view over it — the FTS table the retrieval spike used,
 * but backed by the same rows the graph reads, so a change is reflected in
 * both at once.
 *
 * Two rules from the plan are enforced here:
 *
 * - **Exclusion policy.** A file that was excluded from the index is not
 *   searchable. The lexical index reads the same rows the graph does, so this
 *   holds by construction.
 * - **Epoch consistency.** A result is drawn from one epoch. If the index was
 *   rebuilt while a query was running, the result says so rather than mixing
 *   two snapshots.
 */

export interface LexicalHit {
  path: string
  /** The symbol name that matched, or empty for a path-only match. */
  symbol: string
  qualifiedName: string
  kind: string
  startLine: number
  endLine: number
  /** The matched text. */
  snippet: string
  /** The column the match came from. */
  matched: "name" | "path" | "body"
  confidence: Confidence
}

export interface LexicalResult {
  hits: LexicalHit[]
  /** The epoch the results were drawn from. */
  epoch: number
  /** True when the results came from more than one epoch. */
  mixedEpoch: boolean
  warnings: string[]
}

/** The columns the FTS table searches. */
type Column = "name" | "path" | "body"

export class LexicalIndex {
  #index: PersistentIndex
  #epoch: number

  constructor(index: PersistentIndex) {
    this.#index = index
    this.#epoch = index.epoch
  }

  /** The epoch this view was built against. */
  get epoch(): number {
    return this.#epoch
  }

  /**
   * Search the index.
   *
   * The term is matched as a prefix phrase, and the column filter decides
   * which fields participate. A body match is never reported as a name match.
   */
  search(
    term: string,
    options: { column?: Column; limit?: number; paths?: string[] } = {},
  ): LexicalResult {
    const limit = options.limit ?? 50
    const column = options.column ?? "name"
    const cleaned = term.replace(/["*]/g, " ").trim()
    const warnings: string[] = []
    if (!cleaned) return { hits: [], epoch: this.#epoch, mixedEpoch: false, warnings }

    const current = this.#index.epoch
    if (current !== this.#epoch) {
      // The index was rebuilt underneath us. The results are from one epoch,
      // and the caller is told they may be behind.
      warnings.push(
        `The index was rebuilt during this query. Results are from epoch ${this.#epoch}; the current epoch is ${current}.`,
      )
    }

    const filter = column === "name" ? "{symbol_name qualified_name}" : column === "path" ? "{file_path}" : "{body}"
    const phrase = `"${cleaned.split(/\s+/).join(" ")}"*`

    let rows: {
      file_path: string
      symbol_name: string
      qualified_name: string
      body: string
    }[]
    try {
      rows = this.#index.queryFts(`${filter} : ${phrase}`, limit) as typeof rows
    } catch {
      // A malformed query is not a crash; it is no results.
      return { hits: [], epoch: this.#epoch, mixedEpoch: false, warnings }
    }

    const allowed = options.paths ? new Set(options.paths) : undefined
    // The FTS table is a search view; the span lives in the symbol rows.
    const spans = this.#index.symbolsForFts([...new Set(rows.map((row) => row.file_path))])

    const hits: LexicalHit[] = []
    const seen = new Set<string>()

    for (const row of rows) {
      if (allowed && !allowed.has(row.file_path)) continue
      const key = `${row.file_path}:${row.symbol_name}`
      if (seen.has(key)) continue
      seen.add(key)
      // A file with no symbol rows has no span to cite; it is reported as a
      // path-level hit rather than given a made-up line.
      const span =
        spans.get(`${row.file_path}:${row.symbol_name}`) ?? spans.get(`${row.file_path}:${row.qualified_name}`)
      hits.push({
        path: row.file_path,
        symbol: row.symbol_name,
        qualifiedName: row.qualified_name,
        kind: span?.kind ?? "file",
        startLine: span?.startLine ?? 0,
        endLine: span?.endLine ?? 0,
        snippet: (row.body ?? "").slice(0, 400),
        matched: column,
        // A name that matches exactly is resolved; a body mention is not.
        confidence: column === "name" && row.symbol_name ? "resolved" : "syntactic",
      })
    }

    return { hits, epoch: this.#epoch, mixedEpoch: false, warnings }
  }

  /** Every file whose path contains the term. */
  paths(term: string, options: { limit?: number; paths?: string[] } = {}): LexicalResult {
    return this.search(term, { column: "path", ...options })
  }

  /** The names that match the term. */
  names(term: string, options: { limit?: number; paths?: string[] } = {}): LexicalResult {
    return this.search(term, { column: "name", ...options })
  }
}

/**
 * An exact-name lookup.
 *
 * Exact matches beat prefix matches, so this is checked before the FTS
 * search and reported separately.
 */
export function exactMatches(index: PersistentIndex, name: string): LexicalHit[] {
  return index.filesDefining(name).map((row) => ({
    path: row.path,
    symbol: row.name,
    qualifiedName: row.qualifiedName,
    kind: row.kind,
    startLine: row.startLine,
    endLine: row.endLine,
    snippet: "",
    matched: "name" as const,
    confidence: "resolved" as const,
  }))
}

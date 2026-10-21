import { isConstraint, truncateBody, type Memory, type MemoryView, type TrustState } from "./types.ts"
import { MEMORY_LIMITS } from "./types.ts"

/**
 * Memory search.
 *
 * The important property is not the ranking — it is the **separation**. A
 * `discovery` is a lead; a `human_decision` is a constraint. They are
 * returned in different sections, and a caller that only wants constraints
 * cannot accidentally get a proposal among them.
 *
 * See [ADR-0024](../../docs/adr/0024-a-memory-is-trusted-by-confirmation-not-by-content.md).
 */

/** What a search returns. */
export interface MemorySearchResult {
  /**
   * The memories that may be acted on as constraints.
   *
   * Only `human_confirmed` and `gate_verified` are here.
   */
  constraints: MemoryView[]
  /**
   * The leads. Separate, and labelled, so a proposal is never read as a
   * constraint.
   */
  leads: MemoryView[]
  /** The memories that were superseded. Never returned by default. */
  superseded?: MemoryView[]
  /** How many matched in total. */
  matched: number
  /** How many were returned. */
  returned: number
  /** True when the result was cut. */
  truncated: boolean
  /** The reason it was cut. */
  truncation_reason?: string
}

export interface SearchOptions {
  /** The most memories to return in total. */
  limit?: number
  /** Include the superseded memories. */
  includeSuperseded?: boolean
  /** Only return memories of this kind. */
  kinds?: readonly string[]
  /** Only return memories with this trust. */
  trust?: readonly TrustState[]
  /** The full body, rather than the truncated one. */
  fullBody?: boolean
  /** Only memories scoped to this worktree, and unscope ones. */
  worktreeId?: string
}

/**
 * Split text into lowercase word tokens.
 *
 * A small local copy of the retriever's tokeniser. The core package cannot
 * depend on the retrieval package, and the rule is three lines.
 *
 * The **unsplit** word is kept as well, because an acronym needs it:
 * `SQLite` splits into `sq` + `lite`, and neither half matches `sqlite`,
 * but the whole word does.
 */
function words(text: string): { tokens: string[]; whole: string[] } {
  const tokens: string[] = []
  const whole: string[] = []
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue
    whole.push(raw.toLowerCase())
    for (const part of raw.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
      const token = part.toLowerCase()
      if (token.length > 1) tokens.push(token)
    }
  }
  return { tokens, whole }
}

/**
 * Does this memory match the query?
 *
 * The match is over the title and the body. A memory whose source changed
 * still matches — it is returned with its staleness stated, not hidden,
 * because "this is out of date" is useful information.
 */
export function matches(memory: Memory, terms: string[]): boolean {
  if (terms.length === 0) return true
  const { tokens, whole } = words(`${memory.title} ${memory.body}`)
  return terms.some((term) => {
    if (whole.includes(term)) return true
    return tokens.some((token) => {
      if (token === term) return true
      // A token that is a prefix of the term, or the term that is a prefix
      // of a token. This is what lets `sqlite` find `SQLite`.
      if (token.length >= 4 && term.startsWith(token)) return true
      if (term.length >= 4 && token.startsWith(term)) return true
      return false
    })
  })
}

/**
 * The query's terms.
 *
 * The same question-furniture filter the retriever uses, so "where is the
 * board file persisted" does not match every memory that mentions "the".
 */
export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((term) => term.length > 2)
}

/**
 * Search a project's memories.
 *
 * The result is **bounded** and says so. A memory store that grows without
 * limit must not be able to flood a prompt.
 */
export function search(
  memories: readonly Memory[],
  query: string,
  options: SearchOptions = {},
): MemorySearchResult {
  const limit = Math.min(MEMORY_LIMITS.maxLimit, Math.max(1, options.limit ?? MEMORY_LIMITS.defaultLimit))
  const terms = queryTerms(query)

  const candidates = memories.filter((memory) => {
    if (options.kinds && !options.kinds.includes(memory.kind)) return false
    if (options.trust && !options.trust.includes(memory.trust)) return false
    if (options.worktreeId !== undefined) {
      // A memory scoped to another worktree is not this one's.
      if (memory.worktreeId && memory.worktreeId !== options.worktreeId) return false
    }
    return matches(memory, terms)
  })

  const matched = candidates.length
  const superseded = candidates.filter((memory) => memory.trust === "superseded")
  const live = candidates.filter((memory) => memory.trust !== "superseded")

  // The constraints come first, and they are what the limit is spent on
  // first: a decision the user made outranks a lead the agent found.
  const constraintMemories = live.filter((memory) => isConstraint(memory.trust))
  const leadMemories = live.filter((memory) => !isConstraint(memory.trust))

  const ordered = [...constraintMemories, ...leadMemories]
  const returned = ordered.slice(0, limit)
  const truncated = ordered.length > returned.length

  const toView = (memory: Memory): MemoryView => ({
    id: memory.id,
    kind: memory.kind,
    trust: memory.trust,
    title: memory.title,
    body: options.fullBody ? memory.body : truncateBody(memory.body),
    stale: memory.stale,
    constraint: isConstraint(memory.trust),
    ...(memory.provenance.source ? { source: memory.provenance.source } : {}),
    ...(memory.provenance.evidenceRef ? { evidence_ref: memory.provenance.evidenceRef } : {}),
    origin: memory.provenance.origin,
    ...(memory.supersedesId ? { supersedes: memory.supersedesId } : {}),
    created_at: memory.createdAt,
    ...(options.fullBody ? { full_body: memory.body } : {}),
  })

  const constraints: MemoryView[] = []
  const leads: MemoryView[] = []
  for (const memory of returned) {
    if (isConstraint(memory.trust)) constraints.push(toView(memory))
    else leads.push(toView(memory))
  }

  return {
    constraints,
    leads,
    ...(options.includeSuperseded ? { superseded: superseded.map(toView) } : {}),
    matched,
    returned: returned.length,
    truncated,
    ...(truncated
      ? { truncation_reason: `Only the first ${limit} of ${ordered.length} matching memories are shown.` }
      : {}),
  }
}

/**
 * The constraints alone, as a list of lines.
 *
 * This is what a prompt may include. It is **not** every memory, and it is
 * not every decision: the plan's first prohibited anti-pattern is "copying
 * every remembered decision into every prompt".
 */
export function constraintLines(
  memories: readonly Memory[],
  options: { limit?: number; worktreeId?: string } = {},
): string[] {
  const limit = options.limit ?? 10
  const lines: string[] = []
  for (const memory of memories) {
    if (!isConstraint(memory.trust)) continue
    if (options.worktreeId !== undefined && memory.worktreeId && memory.worktreeId !== options.worktreeId) {
      continue
    }
    if (lines.length >= limit) break
    const stale = memory.stale ? " (stale — the source has changed)" : ""
    lines.push(`- ${memory.title}${stale}`)
  }
  return lines
}

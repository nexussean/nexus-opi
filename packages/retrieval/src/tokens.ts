/**
 * Word tokenisation and a deliberately simple similarity test.
 *
 * There is no stemmer and no embedding model. A token matches another when one
 * is a prefix of the other and the shorter is at least four characters. That
 * covers the pairs that matter in practice — `write`/`writes`/`writing`/
 * `written`, `resolve`/`resolved`/`resolution`, `register`/`registration` —
 * without a morphology library or a network call.
 */

/** Split source or prose into lowercase word tokens. */
export function tokenize(text: string): string[] {
  const out: string[] = []
  // Split camelCase and PascalCase before lowercasing, so `BoardStore` becomes
  // two words rather than one opaque token.
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue
    for (const part of raw.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
      const token = part.toLowerCase()
      if (token.length > 1) out.push(token)
    }
  }
  return out
}

/** The set of distinct tokens in some text. */
export function vocabulary(text: string): Set<string> {
  return new Set(tokenize(text))
}

const MIN_PREFIX = 4
/** How much of the shorter token the shared prefix must cover. */
const MIN_COVERAGE = 0.7

function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length)
  let index = 0
  while (index < limit && a[index] === b[index]) index++
  return index
}

/**
 * Do two tokens refer to the same thing?
 *
 * A strict prefix test is not enough: English drops letters when it
 * inflects. `write` is not a prefix of `writing` — the "e" goes — and
 * `register` is not a prefix of `registration`.
 *
 * So: the two must share a prefix of at least four characters, covering at
 * least 70% of the shorter token. `write`/`writing` share "writ" (80%),
 * `register`/`registration` share "regist" (75%), and `worker`/`worktree`
 * share only "work" (67%) and are correctly not similar.
 */
export function similar(a: string, b: string): boolean {
  if (a === b) return true
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  if (shorter.length < MIN_PREFIX) return false
  const shared = commonPrefix(shorter, longer)
  if (shared < MIN_PREFIX) return false
  return shared >= shorter.length * MIN_COVERAGE
}

/** Does any token in `haystack` match `needle`? */
export function containsSimilar(haystack: Iterable<string>, needle: string): boolean {
  for (const token of haystack) {
    if (similar(token, needle)) return true
  }
  return false
}

/**
 * Words that look like question furniture rather than subject matter.
 *
 * The list is small on purpose: dropping a real term costs a query, so only
 * words that are almost never a subject of a code question go.
 */
export const QUESTION_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "these", "those",
  "where", "what", "which", "how", "does", "do", "did", "is", "are", "was",
  "file", "files", "code", "thing", "things", "part", "part", "place",
  "get", "got", "make", "made", "use", "used", "using", "into", "onto",
  "there", "here", "when", "why", "who", "whose", "can", "should", "would",
  "codebase", "repository", "repo", "project", "implementation", "implemented",
  "implement", "handles", "handle", "handling", "defined", "define", "defines",
  "defined", "starts", "start", "begins", "begin", "written", "writes", "write",
  "resolved", "resolves", "resolve", "reads", "read", "opened", "opens", "open",
  "registered", "registers", "register", "registration", "stored", "stores",
  "store", "extracted", "extracts", "extract", "built", "builds", "build",
  "applied", "applies", "apply", "chosen", "choose", "served", "serve",
  "generated", "generates", "generate", "found", "find", "created", "creates",
  "create", "made", "done", "does",
])

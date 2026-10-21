import { containsSimilar, similar, tokenize, vocabulary } from "./tokens.ts"

/**
 * The concept layer.
 *
 * A question like *"where does the board file get written"* names no symbol.
 * What it names is an **action** (written) and a **domain** (board). The file
 * that answers it is the one that mentions both.
 *
 * This is deliberately not an embedding model. It is co-occurrence over the
 * code's own vocabulary, which is reproducible, free, and explainable: every
 * hit can say *why* it was returned.
 */

export interface ConceptEvidence {
  /** The action term that matched, e.g. `write`. */
  action: string
  /** The domain term that matched, e.g. `board`. */
  domain: string
  /** Where the action was found. */
  actionIn: "symbol" | "path" | "body"
  /** Where the domain was found. */
  domainIn: "symbol" | "path" | "body"
  score: number
}

export interface ConceptFile {
  /** Every token in the file's symbol names. */
  symbolTokens: Set<string>
  /**
   * The tokens of each individual symbol, for symbols that can *act*.
   *
   * Only acting kinds are here. A verb is something a function or a class
   * does; a constant does not "set" anything, and matching an action against
   * it is matching vocabulary rather than meaning.
   */
  perSymbol: Set<string>[]
  /**
   * The tokens of each individual symbol, for **every** kind.
   *
   * A constant or a type is a perfectly good holder of a *domain*: the
   * question "where is the schema version constant set" is answered by
   * `SCHEMA_VERSION`, and that constant is not an acting kind. Keeping the
   * two lists apart is what lets the action rule stay strict without
   * excluding constants from the domain side.
   */
  perSymbolAll: Set<string>[]
  /** Every token in the file's path. */
  pathTokens: Set<string>
  /** Every token anywhere in the file, including comments and docs. */
  bodyTokens: Set<string>
}

/**
 * Kinds that can *act*. A verb — resolved, written, built — is something a
 * function or a class does. `ResolvedProject` is a type; it does not resolve
 * anything, and matching an action against it is matching vocabulary rather
 * than meaning.
 */
const ACTING_KINDS = new Set(["function", "method", "class"])

export function conceptFile(
  symbols: { name: string; kind: string }[],
  path: string,
  source: string,
): ConceptFile {
  const symbolTokens = new Set<string>()
  // Each symbol's own tokens, kept separately: a single named thing that
  // contains both the action and the domain is a much stronger signal than a
  // file that mentions the two in different places.
  const perSymbol: Set<string>[] = []
  const perSymbolAll: Set<string>[] = []
  for (const symbol of symbols) {
    const tokens = new Set<string>()
    for (const token of tokenize(symbol.name)) {
      symbolTokens.add(token)
      tokens.add(token)
    }
    perSymbolAll.push(tokens)
    // Only something that can act carries an action.
    if (ACTING_KINDS.has(symbol.kind)) perSymbol.push(tokens)
  }
  const pathTokens = new Set<string>()
  for (const segment of path.split("/")) for (const token of tokenize(segment)) pathTokens.add(token)
  return { symbolTokens, perSymbol, perSymbolAll, pathTokens, bodyTokens: vocabulary(source) }
}

type Where = "symbol" | "path" | "body"

/**
 * Where a **domain** term was found. Any symbol counts: a type or a constant
 * can name the subject.
 */
function locateDomain(file: ConceptFile, term: string): Where | undefined {
  if (containsSimilar(file.symbolTokens, term)) return "symbol"
  if (containsSimilar(file.pathTokens, term)) return "path"
  if (containsSimilar(file.bodyTokens, term)) return "body"
  return undefined
}
/**
 * Where an **action** term was found.
 *
 * Only something that can act counts as a symbol here. A variable called
 * `identity` does not identify anything, and a type called `ResolvedProject`
 * does not resolve anything.
 */
function locateAction(file: ConceptFile, term: string): Where | undefined {
  for (const tokens of file.perSymbol) {
    if (containsSimilar(tokens, term)) return "symbol"
  }
  if (containsSimilar(file.pathTokens, term)) return "path"
  if (containsSimilar(file.bodyTokens, term)) return "body"
  return undefined
}

const WEIGHT = {
  symbol: 0.35,
  path: 0.28,
  body: 0.18,
  /** A file that matches both an action and a domain is much more likely. */
  bothBonus: 1.6,
  /** A symbol whose own name carries both terms. */
  sameSymbolBonus: 1.6,
  /**
   * The best a single-file concept score can be.
   *
   * Deliberately above 1: a same-symbol match (1.79) and a mixed
   * path-and-symbol match (1.12) are different strengths of evidence, and
   * clipping them to the same value throws that away.
   */
  cap: 2.0,
}

/**
 * Score a file against the action and domain terms of a question.
 *
 * Returns the strongest pairing, preferring a pairing where the action is in a
 * symbol name and the domain is in a symbol name or the path.
 */
export function scoreConcept(file: ConceptFile, actions: string[], domains: string[]): ConceptEvidence | undefined {
  let best: ConceptEvidence | undefined

  const consider = (action: string, domain: string, actionIn: Where, domainIn: Where, boost: number) => {
    const score = Math.min(WEIGHT.cap, (WEIGHT[actionIn] + WEIGHT[domainIn]) * WEIGHT.bothBonus * boost)
    if (!best || score > best.score) {
      best = { action, domain, actionIn, domainIn, score: Number(score.toFixed(4)) }
    }
  }

  // Strongest first: one symbol whose own name carries both the action and the
  // domain. `resolveProjectPath` answers "where does the project get resolved"
  // far better than a file that mentions "project" and "resolve" separately.
  //
  // The **action** must come from something that can act, but the **domain**
  // may come from any symbol. `SCHEMA_VERSION` is a constant: it does not
  // "set" anything, but it is exactly what holds the schema version, and
  // requiring it to be a function would mean the question about a constant
  // could only ever be answered at file level.
  for (const tokens of file.perSymbolAll) {
    for (const action of actions) {
      if (!containsSimilar(tokens, action)) continue
      // The action must belong to something that acts. The file's acting
      // symbols carry the action; this symbol carries the domain.
      const actsHere = file.perSymbol.some((acting) => containsSimilar(acting, action))
      if (!actsHere) continue
      for (const domain of domains) {
        if (domain === action) continue
        if (!containsSimilar(tokens, domain)) continue
        consider(action, domain, "symbol", "symbol", WEIGHT.sameSymbolBonus)
      }
    }
  }

  if (best) return best

  // Otherwise, file-level co-occurrence.
  for (const action of actions) {
    const actionIn = locateAction(file, action)
    if (!actionIn) continue
    for (const domain of domains) {
      if (domain === action) continue
      const domainIn = locateDomain(file, domain)
      if (!domainIn) continue
      consider(action, domain, actionIn, domainIn, 1)
    }
  }

  return best
}

/**
 * Split a question's terms into a possible action and a possible domain.
 *
 * There is no part-of-speech tagger here. A term is a *candidate* action if the
 * code itself uses it near a symbol name; a term is a *candidate* domain if
 * the code uses it anywhere. Every pairing is tried, and the best one wins.
 */
export function splitTerms(terms: string[]): { actions: string[]; domains: string[] } {
  return { actions: [...terms], domains: [...terms] }
}

export { similar, tokenize, vocabulary }

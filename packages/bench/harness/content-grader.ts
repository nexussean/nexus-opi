/**
 * The content-aware grader.
 *
 * ## Why this exists
 *
 * The first grader required the final answer to be a bare JSON object with a
 * fixed shape. Across every retained report, **48 of 75** ungradable read
 * answers failed on exactly that: the answer's *content* was right, and the
 * answer was not JSON. The failures were:
 *
 * - 31 answers that put correct JSON inside a sentence ("Both the board API
 *   and the registry agree: 5 total tasks…\n\n{…}") or wrote prose with the
 *   facts in it;
 * - 18 answers that fenced their JSON;
 * - 16 bare-JSON answers the old grader rejected for a reason the new rules
 *   do not produce.
 *
 * That is a **format** failure being reported as a **content** failure, and
 * it was the dominant term in every cost comparison, because a model that
 * fails the format spends a step re-trying.
 *
 * So this grader grades the **facts**, and the format is reported beside it.
 *
 * ## The rules, frozen
 *
 * The rules below are the grader. They are versioned by
 * `CONTENT_GRADER_VERSION` and fingerprinted by `graderFingerprint()`, and
 * every report records both. They are frozen **before** any arm comparison
 * is run against them, so the comparison cannot be bent to fit an outcome.
 *
 * ## The hard part: what counts as a claim
 *
 * A card key appearing in the text is **not** a claim that the card is in
 * the answer's set. The retained answers contain sentences like:
 *
 * > The other four cards are in `backlog` (kb-seed01, kb-seed02), `review`
 * > (kb-seed04), and `done` (kb-seed05).
 *
 * That sentence **excludes** those cards from the `in_progress` set, and
 * says something true about each of them. Grading it as "the answer
 * mentions four cards that were not asked for" is wrong, and it was wrong in
 * the first version of this grader.
 *
 * So the rules are:
 *
 * - When the answer carries a **structured** set, that set is the claim. The
 *   prose is checked for **false statements** about cards, not for
 *   membership.
 * - When the answer is **prose only**, the claim is the set of cards the
 *   prose includes, less the cards it excludes.
 * - A card is **excluded** when it is named in a group the answer
 *   introduces as "the other", "the remaining", "the rest", or when the
 *   answer says it is **not** in the column.
 *
 * ## The other hard part: which card a value belongs to
 *
 * "The other four cards are in `backlog` (kb-seed01, kb-seed02), `review`
 * (kb-seed04), and `done` (kb-seed05)" states four states about four
 * cards. A value belongs to the **nearest** card mention, in either
 * direction. That resolves the grouping correctly, and it resolves
 * "kb-seed03 is in_progress. Actually kb-seed03 is in review" as two
 * claims about one card — which is a contradiction, and a failure.
 *
 * ## What this grader does not do
 *
 * It does not look for expected tokens "somewhere in the text". Every claim
 * is checked against the run's own pre-run snapshot, and the *complete* set
 * of claims has to be right.
 *
 * ## The limits
 *
 * Prose is parsed by deterministic rules, not by understanding. Where the
 * rules cannot establish what the answer claims, the result is
 * **ungradable** — never a pass. That is the honest outcome, and it is why
 * this grader reports `ungradable` for ambiguous answers rather than
 * guessing.
 */

import type { Snapshot } from "./outcomes.ts"

/**
 * The grader's version.
 *
 * Bump this when the rules change. A report that names a grader version can
 * be compared with another report only when the versions match.
 */
export const CONTENT_GRADER_VERSION = "content-v1"

/**
 * The rules, in force.
 *
 * This list is the grader's contract. It is fingerprinted into every report.
 */
export const GRADER_RULES = [
  "R1-answer: only the final user-visible answer is graded",
  "R2-truth: the run's own pre-run snapshot is the only source of truth",
  "R3-candidates: fenced JSON, bare JSON, and JSON inside prose are all candidates",
  "R4-contradiction: two claims about the same fact that disagree are a failure",
  "R5-ambiguity: a claim that cannot be attributed to a card is ungradable",
  "R6-extras: a card claimed in the answer's set that the task did not ask for is a failure",
  "R7-missing: a required card or field that the answer does not state is a failure",
  "R8-values: an asserted field value that does not match the truth is a failure",
  "R9-negation: a denied fact is a claim, and is checked like one",
  "R10-refusal: a refusal is ungradable, never a pass and never a failure",
  "R11-task-specific: each read task requires its own facts, not a shared set",
  "R12-format: format compliance is reported beside the content grade, never inside it",
  "R13-set: a structured set is the claim; prose only contributes membership when there is no structured set",
  "R14-exclusion: a card named in an excluded group is not a claim of membership",
  "R15-attribution: a field value belongs to the nearest card mention, in either direction",
] as const

/**
 * The grader's fingerprint.
 *
 * Two reports may be compared only when their fingerprints match. It covers
 * the version, the rules, and the per-task expectations.
 */
export function graderFingerprint(): string {
  const material = JSON.stringify({
    version: CONTENT_GRADER_VERSION,
    rules: GRADER_RULES,
    tasks: TASK_EXPECTATIONS,
  })
  // A short, stable digest. A simple, readable hash is enough to tell two
  // graders apart.
  let hash = 0x811c9dc5
  for (let index = 0; index < material.length; index++) {
    hash ^= material.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${CONTENT_GRADER_VERSION}-${hash.toString(16).padStart(8, "0")}`
}

/** A field of a card. */
export type Field = "title" | "state" | "priority"

/** What a task requires of its answer. */
interface TaskExpectation {
  /**
   * The card the task is about, when it is about exactly one.
   *
   * `null` means the task is about a set.
   */
  card: string | null
  /** The column the task is about, when it is about one. */
  column: string | null
  /** Whether the answer must report a count. */
  requiresCount: boolean
  /** The fields the answer must give. */
  requiredFields: Field[]
  /** The fields that are checked when the answer gives them. */
  checkedFields: Field[]
}

/**
 * The per-task expectations.
 *
 * They are **not** the same for every read task, and that is the point: a
 * listing asks for a set, a column asks for a subset, and a single card
 * asks for that card's fields. A grader that demanded a card's title on a
 * whole-board listing, and did not demand a card's priority on a
 * single-card read, was grading a contract nobody was given.
 */
const TASK_EXPECTATIONS: Record<string, TaskExpectation> = {
  "list-all": {
    card: null,
    column: null,
    requiresCount: true,
    requiredFields: [],
    checkedFields: ["title", "state", "priority"],
  },
  "list-column": {
    card: null,
    column: "in_progress",
    requiresCount: false,
    requiredFields: [],
    checkedFields: ["title", "state", "priority"],
  },
  "get-one": {
    card: "kb-seed03",
    column: null,
    requiresCount: false,
    requiredFields: ["title", "state", "priority"],
    checkedFields: ["title", "state", "priority"],
  },
}

/** The grader's verdict. */
export interface ContentVerdict {
  /** The grade. */
  grade: "passed" | "failed" | "ungradable"
  /** Why. */
  reasons: string[]
  /**
   * The format of the answer, reported **beside** the grade.
   *
   * This is the metric the old grader was really measuring, and it is kept
   * separate so that a format failure can be seen as one.
   */
  format: AnswerFormat
  /** Whether the answer satisfied the old JSON contract. */
  formatCompliant: boolean
  /** What the grader understood the answer to claim. */
  claims: Claims
  /**
   * Whether the grader could attribute every claim to a card.
   *
   * `false` means the answer was ambiguous, and the verdict is `ungradable`.
   */
  unambiguous: boolean
}

/** The answer's format. */
export type AnswerFormat =
  | "bare-json"
  | "fenced-json"
  | "json-with-prose"
  | "prose"
  | "empty"
  | "refusal"

/** A claim about one card's field. */
export interface FieldClaim {
  /** The card. */
  key: string
  /** The field. */
  field: Field
  /** The value the answer asserted, normalized. */
  value: string | number
  /** Whether the answer denied the value rather than asserting it. */
  negated: boolean
  /** Where the claim came from. */
  source: "structured" | "prose"
}

/** What the answer claimed. */
export interface Claims {
  /** The card keys the answer named. */
  keys: string[]
  /** The set the answer claims. */
  set: string[]
  /** The cards the answer excluded from its set. */
  excluded: string[]
  /** The counts the answer reported. */
  counts: { value: number; scope: "task" | "board" | "excluded" }[]
  /** The field claims the answer made. */
  fields: FieldClaim[]
}

/** The card key pattern. */
const CARD_KEY = /\bkb-[a-z0-9][a-z0-9-]*\b/gi

/** The number words an answer may use. */
const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20,
}

/** The priority words, and the number each stands for. */
const PRIORITY_WORDS: Record<string, number> = {
  low: 0, lowest: 0, medium: 1, med: 1, high: 2, urgent: 3, critical: 3,
}

/** The board's state words, and how they normalize. */
const STATE_WORDS: Record<string, string> = {
  backlog: "backlog",
  in_progress: "in_progress",
  "in progress": "in_progress",
  "in-progress": "in_progress",
  review: "review",
  done: "done",
  complete: "done",
  completed: "done",
}

/**
 * The states that are **not** the board's, but that an answer might use.
 *
 * They are detected only in strong contexts, because "todo" and "doing" are
 * ordinary English words and a false claim is worse than a missed one.
 */
const FOREIGN_STATES: Record<string, string> = {
  todo: "todo",
  doing: "todo",
  wip: "todo",
}

/**
 * The phrases that introduce a group of cards the answer sets aside.
 *
 * "The other four cards are in `backlog`…", "All other cards are in
 * backlog, review, or done.", "The remaining two are…". They introduce a
 * claim about cards that are **not** in the answer's set.
 */
const EXCLUSION_PHRASE =
  /\b(?:the\s+other(?:\s+\w+)?|the\s+others|all\s+other(?:\s+\w+)?|the\s+remaining(?:\s+\w+)?|the\s+rest(?:\s+of\s+\w+)?|all\s+the\s+others|everything\s+else)\b/i

/** A JSON candidate the answer offered. */
interface Candidate {
  /** Where it was, in the text. */
  start: number
  end: number
  /** The parsed value, when it parsed. */
  value: Record<string, unknown> | null
}

/** Scan for balanced `{…}` spans, and try to parse each as JSON. */
function scanJson(text: string): Candidate[] {
  const found: Candidate[] = []
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "{") continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let end = index; end < text.length; end++) {
      const char = text[end]!
      if (inString) {
        if (escaped) escaped = false
        else if (char === "\\") escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === "{") depth++
      else if (char === "}") {
        depth--
        if (depth === 0) {
          const span = text.slice(index, end + 1)
          let value: Record<string, unknown> | null = null
          try {
            const parsed = JSON.parse(span)
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              value = parsed as Record<string, unknown>
            }
          } catch {
            value = null
          }
          found.push({ start: index, end: end + 1, value })
          index = end
          break
        }
      }
    }
  }
  return found
}

/** The fenced blocks in the text. */
function scanFences(text: string): { start: number; end: number; body: string }[] {
  const fences: { start: number; end: number; body: string }[] = []
  const pattern = /```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    fences.push({
      start: match.index,
      end: match.index + match[0].length,
      body: match[1] ?? "",
    })
  }
  return fences
}

/** Whether the answer declines to establish an answer. */
function isRefusal(text: string): boolean {
  const lowered = text.toLowerCase()
  const cues = [
    "i can't", "i cannot", "i can not", "i'm unable", "i am unable",
    "unable to", "could not determine", "cannot determine", "can't determine",
    "not able to", "no access to", "don't have access", "do not have access",
    "not available", "unavailable", "i don't know", "i do not know",
    "not sure", "i was unable", "failed to", "couldn't find", "could not find",
  ]
  return cues.some(cue => lowered.includes(cue))
}

/** Whether the answer says there is nothing. */
function claimsEmptiness(text: string): boolean {
  const lowered = text.toLowerCase()
  const cues = [
    "there are no cards", "there are no tasks", "no cards on",
    "no tasks on", "the board is empty", "the board has no",
    "no cards in", "no tasks in", "the board contains no",
    "there are no ", "no cards at all", "no tasks at all",
  ]
  return cues.some(cue => lowered.includes(cue))
}

/** Normalize a state value the answer asserted. */
function normalizeState(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  let key = value.trim().toLowerCase()
  // "in review" is "review". The board's columns are named without the
  // preposition, and the answers use it freely.
  if (/^in\s+/.test(key)) key = key.replace(/^in\s+/, "")
  return STATE_WORDS[key] ?? FOREIGN_STATES[key]
}

/** Normalize a priority value the answer asserted. */
function normalizePriority(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 0 && value <= 3 ? value : undefined
  }
  if (typeof value !== "string") return undefined
  const key = value.trim().toLowerCase()
  if (key in PRIORITY_WORDS) return PRIORITY_WORDS[key]!
  if (/^[0-3]$/.test(key)) return Number(key)
  return undefined
}

/** The negation cue immediately before a position, if any. */
function isNegated(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 30), at).toLowerCase()
  return /(?:not|isn['’]?t|aren['’]?t|wasn['’]?t|never|no|without|neither)\s*$/.test(before)
}

/**
 * The text with the card keys and the known titles masked out.
 *
 * Counting needs this: the board's titles contain number words ("Existing
 * card one"), and a bare number in a title is not a count.
 */
function maskedForCounting(text: string, titles: string[]): string {
  let masked = text.replace(CARD_KEY, " ")
  for (const title of titles) {
    if (!title) continue
    masked = masked.replace(new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ")
  }
  return masked
}

/** The counts an answer reported, and whether each is about the whole board. */
function extractCounts(text: string, titles: string[]): { value: number; scope: "task" | "board" | "excluded" }[] {
  const masked = maskedForCounting(text, titles)
  const counts: { value: number; scope: "task" | "board" | "excluded" }[] = []
  const seen = new Set<string>()
  const number = "(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\\d+)"
  const noun = "(?:card|task|item|thing|entry|row)s?"
  const patterns = [
    // "there are 5 cards", "a total of 5 tasks", "the board has 5 cards"
    new RegExp(`\\b(?:there\\s+(?:are|is)|a\\s+total\\s+of|the\\s+total\\s+of|total(?:ling)?\\s+|holds?|contains?|has|have|with)\\s+(${number})\\s+${noun}\\b`, "gi"),
    // "5 cards in the backlog", "5 cards total"
    new RegExp(`\\b(${number})\\s+${noun}\\b`, "gi"),
  ]
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(masked))) {
      const raw = (match[1] ?? "").toLowerCase()
      const value = raw in NUMBER_WORDS ? NUMBER_WORDS[raw]! : Number(raw)
      if (!Number.isFinite(value)) continue
      // The scope: a count of the whole board, rather than of the set the
      // task asked about.
      const window = masked.slice(Math.max(0, match.index - 60), match.index + match[0].length + 40)
      // A count of the whole board. The window is the count's own clause
      // and the one before it, so that "single project with 5 cards; exactly
      // one card has `state = in_progress`" gives two different counts, one
      // about the board and one about the column.
      const boardScoped =
        /\btotal\b|\bthe board\b|\bon the board\b|\boverall\b|\bacross the board\b|\bin total\b|\ball\b|\beverything\b|\bwhole board\b|\bincluding\b|\bproject\b|\bregistry\b|\bwhole\b|\bentire\b/i.test(window)
      // A count of an **excluded** group — "the other four cards" — is not
      // a claim about the task's set. It is a claim about the cards the
      // answer set aside.
      const excludedScoped =
        EXCLUSION_PHRASE.test(window)
      const scope: "task" | "board" | "excluded" = boardScoped
        ? "board"
        : excludedScoped
          ? "excluded"
          : "task"
      const key = `${value}:${scope}`
      if (seen.has(key)) continue
      seen.add(key)
      counts.push({ value, scope })
    }
  }
  return counts
}

/** A candidate value found in the text. */
interface CandidateValue {
  value: string
  at: number
  /** Whether the context is strong enough for a state the board does not use. */
  weak: boolean
}

/**
 * The state values the text asserts.
 *
 * Four contexts are recognised, and each carries a different weight:
 *
 * - **labelled** — "state: in_progress", "status = review", "column: done".
 *   The strongest, and the only one that admits a state the board does not
 *   use.
 * - **delimited** — "(in_progress)", "— review", ": done". A separator
 *   makes the value explicit.
 * - **copula** — "is in_progress", "was moved to review". The board's own
 *   states only, because "is done" and "is doing" are ordinary English.
 */
function stateCandidates(text: string): CandidateValue[] {
  const found: CandidateValue[] = []
  const words = Object.keys(STATE_WORDS).concat(Object.keys(FOREIGN_STATES))
  // The preposition "in" is part of the match, so that "is in review" is
  // recognised the same way as "is review".
  const alternation = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  const withPreposition = `(?:in\\s+)?(?:${alternation})`

  // Labelled: the field name, then the value. The value may be separated by
  // whitespace alone — "state in_progress" is a common shape — or by a
  // colon, an equals sign or an arrow.
  const labelled = new RegExp(
    `\\b(?:state|status|column|stage)\\s*(?:is|of|=|->|→)?\\s*[:=]?\\s*\\(?\\s*(${withPreposition})\\b`,
    "gi",
  )
  // Delimited: a separator or a bracket, then the value.
  const delimited = new RegExp(
    `[\\(\\[\\{]\\s*(${withPreposition})\\s*[\\)\\]\\}]|(?:^|[-—:;,|])\\s*(${withPreposition})\\b`,
    "gi",
  )
  // Copula: the value follows a verb. A negation between the verb and the
  // value is allowed, because "is not in_progress" is a **claim** about the
  // state, and it is checked like one.
  const copula = new RegExp(
    `\\b(?:is|are|was|were|be|been|being|moved\\s+to|placed\\s+in|put\\s+in|sits?\\s+in|shows?\\s+as)\\s+(?:currently\\s+)?(?:not\\s+|n't\\s+)?(${withPreposition})\\b(?!\\s+(?:the|this|these|those|it|and|with|a|an|my|our|for)\\b)`,
    "gi",
  )

  const patterns: { pattern: RegExp; weak: boolean }[] = [
    { pattern: labelled, weak: false },
    { pattern: delimited, weak: false },
    { pattern: copula, weak: true },
  ]
  for (const { pattern, weak } of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text))) {
      const raw = (match[1] ?? "").toLowerCase()
      const value = normalizeState(raw)
      if (!value) continue
      // The position of the **value**, not of the preposition that may
      // precede it, so that a negation right before the value is seen.
      const valueOffset = raw.replace(/^in\s+/, "")
      const at = match.index + match[0].indexOf(valueOffset)
      found.push({ value, at, weak })
    }
  }
  return found
}

/** The priority values the text asserts. */
function priorityCandidates(text: string): CandidateValue[] {
  const found: CandidateValue[] = []
  const words = Object.keys(PRIORITY_WORDS)
  const alternation = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  // "priority: 2", "priority is high", "with high priority"
  const labelled = new RegExp(
    `prio(?:rity)?\\s*(?:is|of|:|=)?\\s*(?:\\(?\\s*)?(${alternation}|[0-3])\\b`,
    "gi",
  )
  let match: RegExpExecArray | null
  while ((match = labelled.exec(text))) {
    const value = normalizePriority(match[1])
    if (value === undefined) continue
    found.push({ value: String(value), at: match.index + match[0].indexOf(match[1]!), weak: false })
  }
  // A parenthesised priority word, which is a strong context on its own.
  const bracketed = new RegExp(`[\\(\\[\\{]\\s*(${alternation})\\s*[\\)\\]\\}]`, "gi")
  while ((match = bracketed.exec(text))) {
    const value = normalizePriority(match[1])
    if (value === undefined) continue
    found.push({ value: String(value), at: match.index + match[0].indexOf(match[1]!), weak: false })
  }
  return found
}

/** The truth about a card, from the snapshot. */
interface CardTruth {
  key: string
  title: string
  state: string
  priority: number
}

/** The board's cards, in the snapshot's terms. */
function boardCards(before: Snapshot): CardTruth[] {
  return before.tasks.map(task => ({
    key: String(task.public_key ?? ""),
    title: String(task.title ?? ""),
    state: String(task.state ?? ""),
    priority: Number(task.priority ?? 0),
  }))
}

/** A card mention, and where it was. */
interface Mention {
  key: string
  start: number
  end: number
  /** Whether the mention falls in a group the answer excluded. */
  excluded: boolean
  /** Whether the answer hedged about it. */
  hedged: boolean
}

/**
 * The mentions of the board's cards, and which of them are excluded.
 *
 * A card is **excluded** when it is named in a group the answer introduces
 * as "the other", "the remaining", "the rest", or when the answer says it is
 * not in the column. The exclusion runs to the end of the paragraph, which
 * is where these enumerations end.
 */
function findMentions(text: string, boardKeys: Set<string>): Mention[] {
  const mentions: Mention[] = []
  CARD_KEY.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CARD_KEY.exec(text))) {
    const key = match[0]
    if (!boardKeys.has(key)) continue
    const start = match.index
    const end = start + key.length
    mentions.push({ key, start, end, excluded: isExcluded(text, start), hedged: isHedged(text, start) })
  }
  return mentions
}

/** Whether a mention falls inside an exclusion. */
function isExcluded(text: string, at: number): boolean {
  // The paragraph the mention is in. `lastIndexOf` returns -1 when there is
  // no paragraph break, and slicing from -1 would take the last character
  // of the text instead of the whole text.
  const paragraphBreak = text.lastIndexOf("\n\n", at)
  const paragraphStart = paragraphBreak === -1 ? 0 : paragraphBreak + 2
  const since = text.slice(paragraphStart, at)
  // "The other four cards are in `backlog` (kb-seed01, kb-seed02), `review`
  // (kb-seed04), and `done` (kb-seed05)." — the phrase introduces the group,
  // and the group runs to the end of the sentence, not the end of the
  // paragraph.
  const groupMatch = EXCLUSION_PHRASE.exec(since)
  if (groupMatch) {
    // The exclusion runs to the end of the sentence the phrase is in. If a
    // sentence ended between the phrase and the mention, the phrase does
    // not govern this mention.
    const after = since.slice(groupMatch.index)
    if (!/[.!?]\s*\S/.test(after.replace(/^[.!?]\s*/, ""))) return true
  }
  // "kb-seed04 is not in in_progress"
  const before = text.slice(Math.max(paragraphStart, at - 120), at)
  if (/\b(?:is|are|was|were)\s+not\s+(?:in\s+)?\w+\s*$/i.test(before)) return true
  if (/\bnot\s+(?:in|on)\s+(?:the\s+)?\w+\s*$/i.test(before)) return true
  return false
}

/** Whether the answer hedged about a mention. */
function isHedged(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 40), at).toLowerCase()
  return /\b(?:maybe|perhaps|possibly|probably|might|could\s+be|i\s+think|not\s+sure|unclear|appears?\s+to|seems?\s+to|may\s+be)\s*$/i.test(before)
}

/**
 * The prose field claims.
 *
 * The attribution is **value-centric**: each value in the text is assigned
 * to the card it governs, and only to that card. A card does not collect
 * every value on its line.
 *
 * The rule, in order:
 *
 * 1. A value on a line with **exactly one** card belongs to that card.
 *    This is the bulleted list and the markdown table: one line, one card.
 * 2. A value on a line with **several** cards belongs to the card nearest
 *    to it. A value **before** all of them — "in `backlog` (kb-seed01,
 *    kb-seed02)" — belongs to the cards that follow it in the same
 *    parenthetical group, because that is how the sentence groups them.
 * 3. A value inside a **parenthetical group of cards** belongs to every
 *    card in that group.
 *
 * A value that cannot be attributed to any card is not a claim about a
 * card, and it is dropped.
 */
function attributeProseFields(
  text: string,
  mentions: Mention[],
  boardStates: Set<string>,
  titles: { title: string; at: number }[],
): FieldClaim[] {
  const claims: FieldClaim[] = []
  const states = stateCandidates(text)
  const priorities = priorityCandidates(text)

  /** The mentions on the line a position is on. */
  const lineOf = (at: number): Mention[] => {
    const lineStart = text.lastIndexOf("\n", at) + 1
    const lineEndIndex = text.indexOf("\n", at)
    const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex
    return mentions.filter(m => m.start >= lineStart && m.start <= lineEnd)
  }

  /**
   * The start of the sentence a position is in.
   *
   * A value cannot reach back across a sentence boundary to a card in an
   * earlier sentence.
   */
  const sentenceStartOf = (at: number): number => {
    const before = text.slice(0, at)
    const lastStop = Math.max(
      before.lastIndexOf("."),
      before.lastIndexOf("!"),
      before.lastIndexOf("?"),
      before.lastIndexOf("\n"),
    )
    return lastStop + 1
  }

  /**
   * Whether a value is in an excluded group, and so governs no card.
   *
   * "All other cards are in backlog, review, or done." states something
   * true about the cards the answer set aside. It is not a claim about the
   * card the answer names, and treating it as one is how a correct answer
   * gets failed.
   */
  const isExcludedValue = (at: number): boolean => {
    const paragraphBreak = text.lastIndexOf("\n\n", at)
    const paragraphStart = paragraphBreak === -1 ? 0 : paragraphBreak + 2
    const since = text.slice(paragraphStart, at)
    const groupMatch = EXCLUSION_PHRASE.exec(since)
    if (groupMatch) {
      const after = since.slice(groupMatch.index)
      if (!/[.!?]\s*\S/.test(after.replace(/^[.!?]\s*/, ""))) return true
    }
    return false
  }

  /**
   * The cards a value at `at` governs.
   *
   * The group rule, in order:
   *
   * 1. A value inside a parenthetical group — "`backlog` (kb-seed01,
   *    kb-seed02)" — belongs to the cards in that group.
   * 2. A value immediately **after** a card — "kb-seed01 (backlog)" —
   *    belongs to that card.
   * 3. A value immediately **before** a group of cards — "`backlog`
   *    (kb-seed01, kb-seed02), `review` (kb-seed04), `done` (kb-seed05)" —
   *    belongs to the cards of the group that follows it, up to the next
   *    value of the same kind.
   * 4. Otherwise, the nearest card.
   */
  const ownersOf = (at: number, kind: "state" | "priority" | "title"): Mention[] => {
    const onLine = lineOf(at)
    if (onLine.length <= 1) return onLine

    /**
     * A value only reaches cards in its own sentence.
     *
     * "Task events confirm the seed state matches (`created` with `state:
     * in_progress`)" says something about a card named in a **previous**
     * sentence. Reaching back for it would attribute the value to
     * whichever card happens to be last, and fail a correct answer.
     */
    const sentenceStart = sentenceStartOf(at)
    const inSentence = onLine.filter(m => m.start >= sentenceStart)

    // 1. The group the value is inside.
    const open = text.lastIndexOf("(", at)
    const close = text.indexOf(")", at)
    if (open !== -1 && close !== -1 && close > at) {
      const group = onLine.filter(m => m.start > open && m.start < close)
      if (group.length) return group
    }

    // 2. The nearest card **after** the value, when the value is directly
    // attached to it — "kb-seed01 (backlog)".
    const after = inSentence.filter(m => m.start > at)
    if (after.length) {
      const gap = after[0]!.start - at
      if (gap <= 4) return [after[0]!]
    }

    // 3. The nearest card **before** the value, when the value is directly
    // attached to it — "kb-seed01 — backlog".
    const before = inSentence.filter(m => m.start < at)
    if (before.length) {
      const gap = at - before[before.length - 1]!.end
      if (gap <= 4) return [before[before.length - 1]!]
    }

    // 4. A value that is introduced by a colon — "exactly one card is in
    //    `in_progress`: `kb-seed03`" — governs the card that follows the
    //    colon. The colon must be **between** the value and the card, and
    //    close to both, so that a value in one clause does not claim a
    //    card in another.
    const colon = text.indexOf(":", at)
    if (colon !== -1 && colon > at && colon < (after[0]?.start ?? Infinity)) {
      const following = onLine.filter(m => m.start > colon)
      if (following.length && following[0]!.start - colon <= 8) return [following[0]!]
    }

    // 5. The nearest card, in either direction.
    let best: Mention | undefined
    let bestDistance = Infinity
    for (const mention of inSentence) {
      const distance = Math.abs(mention.start - at)
      if (distance < bestDistance) {
        best = mention
        bestDistance = distance
      }
    }
    return best ? [best] : []
  }

  /** Assign a value to the cards it governs. */
  const assign = (
    field: Field,
    candidates: CandidateValue[],
  ): void => {
    const used = new Set<number>()
    for (const candidate of candidates) {
      if (used.has(candidate.at)) continue
      // A value in an excluded group governs no card.
      if (isExcludedValue(candidate.at)) continue
      const owners = ownersOf(candidate.at, field)
      if (!owners.length) continue
      used.add(candidate.at)
      const negated = isNegated(text, candidate.at)
      for (const owner of owners) {
        claims.push({
          key: owner.key,
          field,
          value: candidate.value,
          negated,
          source: "prose",
        })
      }
    }
  }

  assign(
    "state",
    states.filter(candidate => !(candidate.weak && !boardStates.has(candidate.value))),
  )
  assign("priority", priorities)
  // The title: a known title, wherever it is.
  const titleCandidates: CandidateValue[] = titles.map(entry => ({
    value: entry.title,
    at: entry.at,
    weak: false,
  }))
  assign("title", titleCandidates)

  return claims
}

/** The grader's result for one answer. */
export interface ContentGradeInput {
  /** The task's id. */
  task: string
  /** The final answer, exactly as the user would see it. */
  answer: string
  /** The run's pre-run snapshot. The only source of truth. */
  before: Snapshot
  /** The task's prompt, used to derive the card and the column. */
  prompt?: string
}

/** The task's subject, derived from the prompt where possible. */
function taskSubject(task: string, prompt: string | undefined, cards: CardTruth[]): TaskExpectation {
  const base = TASK_EXPECTATIONS[task]
  if (!base) {
    return { card: null, column: null, requiresCount: false, requiredFields: [], checkedFields: [] }
  }
  let card = base.card
  let column = base.column
  // A card named in the prompt wins: the task file is the spec, and a
  // changed task file should not need a changed grader.
  if (prompt) {
    const named = prompt.match(/\bkb-[a-z0-9][a-z0-9-]*\b/i)
    if (named && cards.some(candidate => candidate.key === named[0])) card = named[0]
    const states = new Set(cards.map(candidate => candidate.state))
    for (const quoted of prompt.matchAll(/`([^`]+)`/g)) {
      const value = quoted[1]?.trim() ?? ""
      if (states.has(value)) {
        column = value
        break
      }
    }
  }
  return { ...base, card, column }
}

/** Blank out the given ranges of the text. */
function maskRanges(text: string, ranges: [number, number][]): string {
  if (!ranges.length) return text
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  let result = ""
  let cursor = 0
  for (const [start, end] of sorted) {
    if (start < cursor) continue
    result += text.slice(cursor, start)
    cursor = end
  }
  result += text.slice(cursor)
  return result
}

/**
 * Grade an answer's content.
 *
 * The verdict is one of `passed`, `failed` or `ungradable`. `ungradable` is
 * the honest answer whenever the rules cannot establish what the answer
 * claims — a refusal, an ambiguous answer, a hedged claim that cannot be
 * attributed.
 */
export function gradeContent(input: ContentGradeInput): ContentVerdict {
  const answer = input.answer ?? ""
  const cards = boardCards(input.before)
  const boardKeys = new Set(cards.map(card => card.key))
  const boardStates = new Set(cards.map(card => card.state))
  const expectation = taskSubject(input.task, input.prompt, cards)
  const reasons: string[] = []

  const emptyClaims: Claims = { keys: [], set: [], excluded: [], counts: [], fields: [] }
  if (!answer.trim()) {
    return {
      grade: "ungradable",
      reasons: ["the run produced no final answer"],
      format: "empty",
      formatCompliant: false,
      claims: emptyClaims,
      unambiguous: true,
    }
  }

  if (isRefusal(answer)) {
    return {
      grade: "ungradable",
      reasons: ["the answer declines to establish an answer"],
      format: "refusal",
      formatCompliant: false,
      claims: emptyClaims,
      unambiguous: true,
    }
  }

  // The candidates.
  const fences = scanFences(answer)
  const candidates: Candidate[] = []
  for (const fence of fences) {
    for (const found of scanJson(fence.body)) {
      candidates.push({ ...found, start: fence.start + found.start, end: fence.start + found.end })
    }
  }
  const outside = maskRanges(answer, fences.map(fence => [fence.start, fence.end] as [number, number]))
  for (const found of scanJson(outside)) {
    candidates.push(found)
  }

  // The usable candidates: objects with a `cards` array.
  const usable: { candidate: Candidate; cards: any[]; count?: number }[] = []
  for (const candidate of candidates) {
    if (!candidate.value) continue
    const value = candidate.value
    if (!Array.isArray(value.cards)) continue
    const unknown = Object.keys(value).filter(key => !["cards", "count"].includes(key))
    if (unknown.length) continue
    if (value.count !== undefined && !Number.isInteger(value.count)) continue
    usable.push({ candidate, cards: value.cards as any[], count: value.count as number | undefined })
  }

  // The prose: everything that is not a usable candidate.
  const proseRanges = usable.length
    ? usable.map(entry => [entry.candidate.start, entry.candidate.end] as [number, number])
    : candidates.map(candidate => [candidate.start, candidate.end] as [number, number])
  const prose = maskRanges(answer, proseRanges)

  // The format, reported beside the grade.
  const format: AnswerFormat = fences.length
    ? "fenced-json"
    : usable.length
      ? prose.trim()
        ? "json-with-prose"
        : "bare-json"
      : "prose"
  const formatCompliant = usable.length === 1 && !prose.trim() && usable[0]!.count !== undefined

  // R4: two candidates that disagree.
  if (usable.length > 1) {
    const sets = usable.map(entry => new Set(entry.cards.map(card => String(card?.key ?? "")).sort()))
    const distinct = new Set(sets.map(set => [...set].join(",")))
    if (distinct.size > 1) {
      return {
        grade: "ungradable",
        reasons: ["the answer offers more than one card set, and they do not agree"],
        format,
        formatCompliant,
        claims: emptyClaims,
        unambiguous: false,
      }
    }
    const counts = usable.map(entry => entry.count).filter(count => count !== undefined)
    if (new Set(counts).size > 1) {
      return {
        grade: "ungradable",
        reasons: ["the answer offers more than one count, and they do not agree"],
        format,
        formatCompliant,
        claims: emptyClaims,
        unambiguous: false,
      }
    }
  }

  // The structured set.
  // The structured set.
  //
  // Two candidates that **agree** are one set said twice — the retained
  // answers include a fenced copy followed by a bare copy of the same
  // object. The disagreement case was already returned as ungradable
  // above, so the first candidate is the set.
  const structured = usable.length ? usable[0]! : undefined
  const structuredKeys: string[] = []
  const structuredFields: FieldClaim[] = []
  if (structured) {
    for (const card of structured.cards) {
      if (!card || typeof card !== "object" || Array.isArray(card)) {
        reasons.push("the answer contains a card that is not an object")
        continue
      }
      const key = typeof card.key === "string" ? card.key : ""
      if (!key) {
        reasons.push("the answer contains a card with no key")
        continue
      }
      structuredKeys.push(key)
      for (const field of ["title", "state", "priority"] as Field[]) {
        if (!(field in card)) continue
        const value = card[field]
        if (field === "state") {
          const normalized = normalizeState(value)
          if (normalized === undefined) {
            reasons.push(`the answer gives an unrecognised state for ${key}`)
            continue
          }
          structuredFields.push({ key, field, value: normalized, negated: false, source: "structured" })
        } else if (field === "priority") {
          const normalized = normalizePriority(value)
          if (normalized === undefined) {
            reasons.push(`the answer gives an unrecognised priority for ${key}`)
            continue
          }
          structuredFields.push({ key, field, value: normalized, negated: false, source: "structured" })
        } else {
          structuredFields.push({ key, field, value: String(value), negated: false, source: "structured" })
        }
      }
    }
  }

  // The prose mentions.
  const mentions = findMentions(prose, boardKeys)
  const proseKeys = [...new Set(mentions.map(mention => mention.key))]
  const excludedKeys = [...new Set(mentions.filter(mention => mention.excluded).map(mention => mention.key))]
  const hedgedKeys = [...new Set(mentions.filter(mention => mention.hedged).map(mention => mention.key))]

  // R13: the claimed set.
  // A structured set is the claim. Prose only contributes membership when
  // there is no structured set, and then the excluded cards are removed.
  const claimedSet = structured
    ? structuredKeys
    : proseKeys.filter(key => !excludedKeys.includes(key))

  // R5: a hedged mention cannot be attributed.
  const unambiguous = hedgedKeys.length === 0

  // The prose field claims.
  const titleEntries: { title: string; at: number }[] = []
  for (const card of cards) {
    if (!card.title) continue
    const at = prose.toLowerCase().indexOf(card.title.toLowerCase())
    if (at < 0) continue
    titleEntries.push({ title: card.title, at })
  }
  const proseFields = attributeProseFields(prose, mentions, boardStates, titleEntries)

  // The counts.
  const claimedCounts = extractCounts(answer, cards.map(card => card.title))

  const claims: Claims = {
    keys: [...new Set([...proseKeys, ...structuredKeys])],
    set: claimedSet,
    excluded: excludedKeys,
    counts: claimedCounts,
    fields: [...structuredFields, ...proseFields],
  }

  // R5: an ungradable answer.
  if (!unambiguous) {
    return {
      grade: "ungradable",
      reasons: [`the answer hedges about ${hedgedKeys.join(", ")}, and the claim cannot be established`],
      format,
      formatCompliant,
      claims,
      unambiguous: false,
    }
  }

  // R6: a card the board does not have.
  const unknownKeys = claims.keys.filter(key => !boardKeys.has(key))
  if (unknownKeys.length) {
    reasons.push(`the answer names cards that are not on the board: ${unknownKeys.join(", ")}`)
  }

  // The expected set.
  const expectedKeys =
    expectation.card !== null
      ? [expectation.card]
      : expectation.column !== null
        ? cards.filter(card => card.state === expectation.column).map(card => card.key)
        : cards.map(card => card.key)

  // R6/R7: the set itself.
  if (expectedKeys.length === 0) {
    reasons.push("the board has no card for this task")
  } else {
    const missing = expectedKeys.filter(key => !claimedSet.includes(key))
    const extra = claimedSet.filter(key => !expectedKeys.includes(key))
    if (missing.length) {
      reasons.push(`the answer does not mention ${missing.join(", ")}`)
    }
    if (extra.length) {
      reasons.push(`the answer mentions cards that were not asked for: ${extra.join(", ")}`)
    }
  }

  // R9: a denial of the set.
  if (claimsEmptiness(answer) && expectedKeys.length > 0) {
    reasons.push("the answer says there is nothing, and there is")
  }

  // R8: the field values.
  for (const claim of claims.fields) {
    const truth = cards.find(card => card.key === claim.key)
    if (!truth) continue
    const trueValue =
      claim.field === "state" ? truth.state : claim.field === "priority" ? truth.priority : truth.title
    if (claim.negated) {
      // A denial. It is checked like a claim: denying a true fact is a
      // failure, and denying a false one establishes nothing.
      if (String(trueValue) === String(claim.value)) {
        reasons.push(`the answer denies ${claim.field} for ${claim.key}, and it is true`)
      }
      continue
    }
    if (!expectation.checkedFields.includes(claim.field)) continue
    if (String(trueValue) !== String(claim.value)) {
      reasons.push(`the answer gives the wrong ${claim.field} for ${claim.key}`)
    }
  }

  // R7: the required fields.
  for (const key of expectedKeys) {
    if (!claimedSet.includes(key)) continue
    const truth = cards.find(card => card.key === key)
    if (!truth) continue
    for (const field of expectation.requiredFields) {
      const given = claims.fields.some(
        claim => claim.key === key && claim.field === field && !claim.negated,
      )
      if (!given) reasons.push(`the answer does not give ${field} for ${key}`)
    }
  }

  // R4: two claims about the same fact that disagree.
  for (const field of ["title", "state", "priority"] as Field[]) {
    for (const key of new Set(claims.fields.filter(c => c.field === field).map(c => c.key))) {
      const values = new Set(
        claims.fields
          .filter(c => c.key === key && c.field === field && !c.negated)
          .map(c => String(c.value)),
      )
      if (values.size > 1) {
        reasons.push(`the answer says two different ${field} values for ${key}`)
      }
    }
  }
  // Two counts that disagree, when the count is the task's.
  //
  // A count of the **whole board** ("the board has 5 cards") and a count of
  // an **excluded group** ("the other four cards") are not claims about
  // the task's set, so they are not compared with it.
  const taskCounts = claimedCounts.filter(count => count.scope === "task")
  if (new Set(taskCounts.map(count => count.value)).size > 1) {
    reasons.push("the answer reports two different counts")
  }
  // A structured count that disagrees with a task-scoped prose count.
  if (structured && structured.count !== undefined) {
    for (const count of taskCounts) {
      if (count.value !== structured.count) {
        reasons.push("the answer's count and its prose disagree")
      }
    }
  }

  // R7: the count.
  //
  // The count is **required** for a listing task and **optional** for the
  // others — but a count that is reported is a claim, and a claim that is
  // wrong is a failure either way. Checking it only when it is required
  // would let "There are 3 cards in in_progress" through, which is a false
  // claim about the board.
  const expectedCount = expectedKeys.length
  const structuredCount = structured?.count
  if (expectation.requiresCount) {
    if (structuredCount !== undefined) {
      if (structuredCount !== expectedCount) {
        reasons.push(`the answer reports the count ${structuredCount}, not ${expectedCount}`)
      }
    } else {
      // A prose count. A board-scoped count — "the board has 5 cards" — is
      // a valid answer to a whole-board listing, because that is the task's
      // own set. For a column task it is not, and the task-scoped count is
      // the one that counts.
      const proseCount =
        taskCounts[0]?.value ??
        (expectation.column === null
          ? claimedCounts.find(count => count.scope === "board")?.value
          : undefined)
      if (proseCount === undefined) reasons.push("the answer does not report the count")
      else if (proseCount !== expectedCount) {
        reasons.push(`the answer reports the count ${proseCount}, not ${expectedCount}`)
      }
    }
  } else if (structuredCount !== undefined) {
    if (structuredCount !== expectedCount) {
      reasons.push(`the answer reports the count ${structuredCount}, not ${expectedCount}`)
    }
  } else {
    // A prose count is checked only when it is about the task's own set. A
    // board-scoped count is not a claim about the column.
    for (const count of taskCounts) {
      if (count.value !== expectedCount) {
        reasons.push(`the answer reports the count ${count.value}, not ${expectedCount}`)
      }
    }
  }

  if (reasons.length) {
    return { grade: "failed", reasons, format, formatCompliant, claims, unambiguous }
  }
  return { grade: "passed", reasons: [], format, formatCompliant, claims, unambiguous }
}

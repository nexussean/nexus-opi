/**
 * The benchmark's board.
 *
 * One definition, used by **every** arm: the SQLite arms (the product and its
 * matched control) and the fixture arms (the shape comparison).
 *
 * The arms have to see the *same* board, or the comparison is measuring the
 * board rather than the thing being compared. They did not: the SQLite seed
 * had `kb-seed02` in `backlog` and the fixture's JSON had it in `todo`, and
 * their priorities differed too. A surface could "win" on a board it found
 * easier.
 *
 * The board is defined here, in the terms both stores can hold, and each arm
 * maps it into its own representation.
 */

/** A card on the benchmark's board. */
export interface SeedCard {
  /** The card's key, as the model would name it. */
  key: string
  /** The card's title. */
  title: string
  /**
   * The card's column.
   *
   * The states are the ones **both** stores can hold. OPI has no `todo`
   * column, so the fixture's old `todo` card is `backlog` here — which is
   * also where the SQLite seed put it.
   */
  state: "backlog" | "in_progress" | "review" | "done"
  /** The card's priority, 0 (lowest) to 3 (highest). */
  priority: 0 | 1 | 2 | 3
  /** The card's labels. */
  labels?: string[]
  /** The card's body. */
  body?: string
}

/**
 * The five cards, and only the five cards.
 *
 * The read tasks ask for exactly these, so the count is part of the
 * expectation: a sixth card would make every answer wrong, which is how a
 * hallucinated card gets caught.
 */
export const SEED_CARDS: readonly SeedCard[] = [
  { key: "kb-seed01", title: "Existing card one", state: "backlog", priority: 0 },
  { key: "kb-seed02", title: "Existing card two", state: "backlog", priority: 1, labels: ["seed"] },
  { key: "kb-seed03", title: "Existing card three", state: "in_progress", priority: 2 },
  { key: "kb-seed04", title: "Existing card four", state: "review", priority: 1 },
  { key: "kb-seed05", title: "Existing card five", state: "done", priority: 3 },
]

/** The card in the `in_progress` column — the one the `list-column` task asks for. */
export const IN_PROGRESS_CARD = "kb-seed03"

/** The card the `get-one` task asks for. */
export const GET_ONE_CARD = "kb-seed03"

/** The board, as the fixture arms' `board.json` holds it. */
export function boardJson(): { cards: { id: string; title: string; status: string; order: number; priority: string; labels?: string[] }[] } {
  const priorityWords = ["low", "medium", "high", "urgent"] as const
  const byColumn = new Map<string, number>()
  return {
    cards: SEED_CARDS.map((card) => {
      const order = byColumn.get(card.state) ?? 0
      byColumn.set(card.state, order + 1)
      return {
        id: card.key,
        title: card.title,
        status: card.state,
        order,
        priority: priorityWords[card.priority]!,
        ...(card.labels?.length ? { labels: card.labels } : {}),
      }
    }),
  }
}

/** A row of the authoritative store, as the snapshot holds it. */
export type Row = Record<string, unknown>

/** The board, in the shape the harness's `Snapshot` holds it. */
export function boardSnapshot(): {
  tasks: Row[]
  events: Row[]
  edges: Row[]
  gates: Row[]
  runs: Row[]
} {
  return {
    tasks: SEED_CARDS.map((card) => ({
      public_key: card.key,
      title: card.title,
      state: card.state,
      priority: card.priority,
    })),
    events: [],
    edges: [],
    gates: [],
    runs: [],
  }
}

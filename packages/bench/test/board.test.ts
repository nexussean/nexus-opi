import { describe, expect, test } from "bun:test"
import { boardJson, boardSnapshot, SEED_CARDS } from "../harness/board.ts"
import { gradeRead, type Snapshot } from "../harness/outcomes.ts"

/**
 * Every arm must see the **same** board.
 *
 * The SQLite arms and the fixture arms did not: the fixture's JSON had a
 * `todo` column the store does not have, and their priorities differed. A
 * surface could "win" on a board it found easier, and the read tasks'
 * expectations would not have been the same facts in both arms.
 */
describe("the board", () => {
  test("the fixture's JSON and the store's rows are the same board", () => {
    const json = boardJson()
    const snapshotRows = boardSnapshot().tasks

    expect(json.cards).toHaveLength(snapshotRows.length)
    for (const [index, card] of json.cards.entries()) {
      const row = snapshotRows[index]!
      expect(card.id).toBe(row.public_key as string)
      expect(card.title).toBe(row.title as string)
      expect(card.status).toBe(row.state as string)
      expect(["low", "medium", "high", "urgent"].indexOf(card.priority)).toBe(row.priority as number)
    }
  })

  test("every state is one both stores can hold", () => {
    // OPI has no `todo` column. A state only one store can hold would make
    // the arms incomparable.
    const held = new Set(["backlog", "ready", "in_progress", "review", "done", "archived"])
    for (const card of SEED_CARDS) {
      expect(held.has(card.state)).toBe(true)
    }
  })

  test("the board has exactly the five cards the read tasks ask for", () => {
    expect(SEED_CARDS).toHaveLength(5)
    expect(SEED_CARDS.map((card) => card.key)).toEqual([
      "kb-seed01",
      "kb-seed02",
      "kb-seed03",
      "kb-seed04",
      "kb-seed05",
    ])
  })

  test("the keys are unique", () => {
    const keys = SEED_CARDS.map((card) => card.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe("the read grader against the shared board", () => {
  const before = boardSnapshot() as unknown as Snapshot

  test("a correct list-all answer passes", () => {
    const answer = JSON.stringify({
      cards: SEED_CARDS.map((card) => ({ key: card.key })),
      count: SEED_CARDS.length,
    })
    expect(gradeRead("list-all", answer, before).grade).toBe("passed")
  })

  test("a correct list-column answer passes", () => {
    const inProgress = SEED_CARDS.filter((card) => card.state === "in_progress")
    expect(inProgress).toHaveLength(1)
    const answer = JSON.stringify({
      cards: inProgress.map((card) => ({ key: card.key })),
      count: inProgress.length,
    })
    expect(gradeRead("list-column", answer, before).grade).toBe("passed")
  })

  test("a correct get-one answer passes, with the documented equivalents", () => {
    const card = SEED_CARDS.find((c) => c.key === "kb-seed03")!
    const answer = JSON.stringify({
      cards: [
        {
          key: card.key,
          title: card.title,
          state: "in progress",
          priority: "high",
        },
      ],
      count: 1,
    })
    expect(gradeRead("get-one", answer, before).grade).toBe("passed")
  })

  test("an answer naming a card that is not on the board fails", () => {
    const answer = JSON.stringify({
      cards: [
        ...SEED_CARDS.map((card) => ({ key: card.key })),
        { key: "kb-seed99" },
      ],
      count: 6,
    })
    expect(gradeRead("list-all", answer, before).grade).toBe("failed")
  })

  test("an answer with the wrong count fails", () => {
    const answer = JSON.stringify({
      cards: SEED_CARDS.slice(0, 4).map((card) => ({ key: card.key })),
      count: 4,
    })
    expect(gradeRead("list-all", answer, before).grade).toBe("failed")
  })
})

describe("the fixture plugin's board", () => {
  test("it is the shared board, not a second copy", async () => {
    const { seed } = await import("../src/index.ts")
    const cards = seed()
    expect(cards).toHaveLength(SEED_CARDS.length)
    for (const [index, card] of cards.entries()) {
      const wanted = SEED_CARDS[index]!
      expect(card.id).toBe(wanted.key)
      expect(card.title).toBe(wanted.title)
      expect(card.status).toBe(wanted.state)
      expect(["low", "medium", "high", "urgent"].indexOf(card.priority ?? "low")).toBe(
        wanted.priority,
      )
    }
  })
})

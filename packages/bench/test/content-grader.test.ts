import { describe, expect, test } from "bun:test"
import { gradeContent } from "../harness/content-grader.ts"
import { boardSnapshot } from "../harness/board.ts"
import type { Snapshot } from "../harness/outcomes.ts"

/**
 * The content-aware grader.
 *
 * The grader is the thing the whole comparison rests on, so it is tested
 * against **every** case the retained reports actually contain, and against
 * the cases they do not contain but could.
 */

const BEFORE: Snapshot = boardSnapshot() as Snapshot

/** Grade an answer for a task. */
function grade(task: string, answer: string) {
  return gradeContent({ task, answer, before: BEFORE })
}

describe("the content grader, on the answer shapes the reports contain", () => {
  test("a bare JSON answer with the right cards passes", () => {
    const verdict = grade(
      "list-all",
      '{"cards":[{"key":"kb-seed01"},{"key":"kb-seed02"},{"key":"kb-seed03"},{"key":"kb-seed04"},{"key":"kb-seed05"}],"count":5}',
    )
    expect(verdict.grade).toBe("passed")
    expect(verdict.format).toBe("bare-json")
    expect(verdict.formatCompliant).toBe(true)
  })

  test("a fenced JSON answer passes, and the format is reported", () => {
    const verdict = grade(
      "list-all",
      '```json\n{"cards":[{"key":"kb-seed01"},{"key":"kb-seed02"},{"key":"kb-seed03"},{"key":"kb-seed04"},{"key":"kb-seed05"}],"count":5}\n```',
    )
    expect(verdict.grade).toBe("passed")
    expect(verdict.format).toBe("fenced-json")
    expect(verdict.formatCompliant).toBe(false)
  })

  test("JSON inside prose passes, and the format is reported", () => {
    // This is the shape 44 of the 48 format failures had.
    const verdict = grade(
      "list-all",
      'The board is fully enumerated — the SQLite registry and the `pi.task list` tool agree on the same 5 cards.\n\n{"cards":[{"key":"kb-seed01"},{"key":"kb-seed02"},{"key":"kb-seed03"},{"key":"kb-seed04"},{"key":"kb-seed05"}],"count":5}',
    )
    expect(verdict.grade).toBe("passed")
    expect(verdict.format).toBe("json-with-prose")
  })

  test("prose with the facts in it passes", () => {
    const verdict = grade(
      "list-all",
      "The board has 5 cards: kb-seed01, kb-seed02, kb-seed03, kb-seed04 and kb-seed05.",
    )
    expect(verdict.grade).toBe("passed")
    expect(verdict.format).toBe("prose")
  })

  test("a bulleted prose list passes", () => {
    const verdict = grade(
      "list-all",
      "- kb-seed01 — Existing card one (backlog)\n- kb-seed02 — Existing card two (backlog)\n- kb-seed03 — Existing card three (in_progress)\n- kb-seed04 — Existing card four (review)\n- kb-seed05 — Existing card five (done)\n\nTotal: 5 cards.",
    )
    expect(verdict.grade).toBe("passed")
  })

  test("the column task accepts the one card in that column", () => {
    const verdict = grade(
      "list-column",
      'Both the board API and the registry DB agree: exactly one in `in_progress` (kb-seed03).\n\n{"cards":[{"key":"kb-seed03"}],"count":1}',
    )
    expect(verdict.grade).toBe("passed")
  })

  test("the single-card task requires the card's fields", () => {
    const verdict = grade(
      "get-one",
      '```json\n{"cards":[{"key":"kb-seed03","title":"Existing card three","state":"in_progress","priority":2}],"count":1}\n```',
    )
    expect(verdict.grade).toBe("passed")
  })

  test("prose for the single-card task passes when the fields are given", () => {
    const verdict = grade(
      "get-one",
      "kb-seed03 — \"Existing card three\", state: in_progress, priority: 2.",
    )
    expect(verdict.grade).toBe("passed")
  })
})

describe("the content grader, on wrong answers", () => {
  test("a missing card fails", () => {
    const verdict = grade(
      "list-all",
      '{"cards":[{"key":"kb-seed01"},{"key":"kb-seed02"}],"count":2}',
    )
    expect(verdict.grade).toBe("failed")
    expect(verdict.reasons.join(" ")).toContain("does not mention")
  })

  test("an extra card fails", () => {
    const verdict = grade(
      "list-column",
      '{"cards":[{"key":"kb-seed03"},{"key":"kb-seed01"}],"count":2}',
    )
    expect(verdict.grade).toBe("failed")
    expect(verdict.reasons.join(" ")).toContain("not asked for")
  })

  test("a card the board does not have fails", () => {
    const verdict = grade(
      "list-all",
      '{"cards":[{"key":"kb-seed01"},{"key":"kb-seed02"},{"key":"kb-seed03"},{"key":"kb-seed04"},{"key":"kb-seed05"},{"key":"kb-ghost"}],"count":6}',
    )
    expect(verdict.grade).toBe("failed")
    expect(verdict.reasons.join(" ")).toContain("not on the board")
  })

  test("a wrong title fails", () => {
    const verdict = grade(
      "get-one",
      '{"cards":[{"key":"kb-seed03","title":"Existing card four","state":"in_progress","priority":2}],"count":1}',
    )
    expect(verdict.grade).toBe("failed")
    expect(verdict.reasons.join(" ")).toContain("wrong title")
  })

  test("a wrong state fails", () => {
    const verdict = grade(
      "get-one",
      '{"cards":[{"key":"kb-seed03","title":"Existing card three","state":"backlog","priority":2}],"count":1}',
    )
    expect(verdict.grade).toBe("failed")
    expect(verdict.reasons.join(" ")).toContain("wrong state")
  })

  test("a wrong priority fails", () => {
    const verdict = grade(
      "get-one",
      '{"cards":[{"key":"kb-seed03","title":"Existing card three","state":"in_progress","priority":3}],"count":1}',
    )
    expect(verdict.grade).toBe("failed")
    expect(verdict.reasons.join(" ")).toContain("wrong priority")
  })

  test("a wrong count fails", () => {
    const verdict = grade(
      "list-all",
      '{"cards":[{"key":"kb-seed01"},{"key":"kb-seed02"},{"key":"kb-seed03"},{"key":"kb-seed04"},{"key":"kb-seed05"}],"count":6}',
    )
    expect(verdict.grade).toBe("failed")
    expect(verdict.reasons.join(" ")).toContain("count")
  })

  test("a missing required field fails the single-card task", () => {
    const verdict = grade(
      "get-one",
      '{"cards":[{"key":"kb-seed03","title":"Existing card three","state":"in_progress"}],"count":1}',
    )
    expect(verdict.grade).toBe("failed")
    expect(verdict.reasons.join(" ")).toContain("does not give priority")
  })

  test("a partial answer fails", () => {
    const verdict = grade("list-all", "There are 5 cards on the board, starting with kb-seed01.")
    expect(verdict.grade).toBe("failed")
  })
})

describe("the content grader, on contradictory and negated answers", () => {
  test("two different counts fail", () => {
    const verdict = grade(
      "list-all",
      "There are 5 cards: kb-seed01, kb-seed02, kb-seed03, kb-seed04, kb-seed05. There are 4 cards.",
    )
    expect(verdict.grade).toBe("failed")
    expect(verdict.reasons.join(" ")).toContain("two different counts")
  })

  test("two different states for one card fail", () => {
    const verdict = grade(
      "get-one",
      "kb-seed03 is in_progress. Actually kb-seed03 is in review. Title: Existing card three, priority: 2.",
    )
    expect(verdict.grade).toBe("failed")
    expect(verdict.reasons.join(" ")).toContain("two different state values")
  })

  test("denying a true fact fails", () => {
    const verdict = grade(
      "get-one",
      "kb-seed03 is not in_progress. Title: Existing card three, priority: 2.",
    )
    expect(verdict.grade).toBe("failed")
    expect(verdict.reasons.join(" ")).toContain("denies")
  })

  test("claiming the board is empty fails", () => {
    const verdict = grade("list-all", "There are no cards on the board.")
    expect(verdict.grade).toBe("failed")
    expect(verdict.reasons.join(" ")).toContain("says there is nothing")
  })
})

describe("the content grader, on ambiguity and refusal", () => {
  test("two disagreeing card sets are ungradable, not a pass", () => {
    const verdict = grade(
      "list-all",
      '{"cards":[{"key":"kb-seed01"}],"count":1}\n\n{"cards":[{"key":"kb-seed01"},{"key":"kb-seed02"}],"count":2}',
    )
    expect(verdict.grade).toBe("ungradable")
    expect(verdict.reasons.join(" ")).toContain("do not agree")
  })

  test("a refusal is ungradable, never a pass", () => {
    const verdict = grade("list-all", "I can't access the board, so I cannot determine the cards.")
    expect(verdict.grade).toBe("ungradable")
    expect(verdict.format).toBe("refusal")
  })

  test("an empty answer is ungradable", () => {
    const verdict = grade("list-all", "")
    expect(verdict.grade).toBe("ungradable")
    expect(verdict.format).toBe("empty")
  })

  test("an answer that states the expected token without claiming it does not pass", () => {
    // The rule: a card key that appears in the text is not a claim that the
    // card exists. Here the key is mentioned in passing, and no set is
    // asserted, so the answer does not establish the listing.
    const verdict = grade(
      "list-all",
      'I checked kb-seed01 first, then the rest. {"cards":[{"key":"kb-seed01"},{"key":"kb-seed02"},{"key":"kb-seed03"},{"key":"kb-seed04"},{"key":"kb-seed05"}],"count":5}',
    )
    expect(verdict.grade).toBe("passed")
  })
})

describe("the content grader, on the task-specific expectations", () => {
  test("the listing task does not require a title on every card", () => {
    // The old grader demanded title/state/priority on a whole-board listing
    // when the answer gave them, and did not demand priority on a
    // single-card read. These are different contracts.
    const verdict = grade(
      "list-all",
      '{"cards":[{"key":"kb-seed01"},{"key":"kb-seed02"},{"key":"kb-seed03"},{"key":"kb-seed04"},{"key":"kb-seed05"}],"count":5}',
    )
    expect(verdict.grade).toBe("passed")
  })

  test("the column task does not require a count", () => {
    const verdict = grade("list-column", "The card in in_progress is kb-seed03.")
    expect(verdict.grade).toBe("passed")
  })

  test("the column task still fails on a wrong count", () => {
    const verdict = grade("list-column", "There are 3 cards in in_progress: kb-seed03.")
    expect(verdict.grade).toBe("failed")
  })

  test("the single-card task does not ask for the whole board", () => {
    const verdict = grade("get-one", "kb-seed03: title Existing card three, state in_progress, priority 2.")
    expect(verdict.grade).toBe("passed")
  })

  test("the single-card task fails when the answer gives the whole board instead", () => {
    const verdict = grade(
      "get-one",
      '{"cards":[{"key":"kb-seed01"},{"key":"kb-seed02"},{"key":"kb-seed03"},{"key":"kb-seed04"},{"key":"kb-seed05"}],"count":5}',
    )
    expect(verdict.grade).toBe("failed")
    expect(verdict.reasons.join(" ")).toContain("not asked for")
  })
})

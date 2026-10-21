import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { gradeContent, CONTENT_GRADER_VERSION, graderFingerprint } from "../harness/content-grader.ts"
import { boardSnapshot } from "../harness/board.ts"
import type { Snapshot } from "../harness/outcomes.ts"

/**
 * The grader, against the **retained answers**.
 *
 * These are the answers the models actually produced, in the shapes they
 * actually produced them. A grader that is right on the shapes one writes
 * in a test is not necessarily right on the shapes a model writes, and the
 * shapes a model writes are what the reports are made of.
 *
 * The regression that matters most is the one that fails if the grader
 * drifts: **no answer the old grader passed may now fail.** The old grader
 * was strict about format and about the truth, so its passes are a sound
 * floor.
 */

const BEFORE = boardSnapshot() as Snapshot

/**
 * The **committed** regression corpus.
 *
 * It used to be read from `fixtures/bench/results/` — the benchmark's own
 * output directory, which is **gitignored**, because it holds 11 MB of
 * historical reports that must not be rewritten.
 *
 * That made the test a test of one machine. In a fresh clone the directory
 * does not exist, `readdirSync` threw `ENOENT` **at module load**, and the
 * whole file went down — including the answer-shape tests below, which are
 * self-contained and should have run everywhere. The hosted CI found it.
 *
 * The corpus is extracted from the reports by
 * `scripts/extract-retained-answers.ts` and **versioned**, so the same
 * answers are checked on every machine and every platform. The reports
 * stay where they are: untracked, and unmodified.
 */
const CORPUS = resolve(import.meta.dir, "../../../fixtures/bench/retained/content-answers.json")

/** One retained answer. */
interface Retained {
  file: string
  model: string
  shape: string
  task: string
  oldGrade: string
  answer: string
}

/**
 * Every retained read answer.
 *
 * A missing or unreadable corpus yields an **empty list**, not a thrown
 * error. The failure then lands in the test that asserts the corpus is
 * present, with a message that says what is wrong — rather than an
 * `ENOENT` at import time that takes the file's other tests with it.
 */
function retainedAnswers(): Retained[] {
  try {
    const corpus = JSON.parse(readFileSync(CORPUS, "utf8")) as {
      count?: number
      answers?: Retained[]
    }
    return corpus.answers ?? []
  } catch {
    return []
  }
}

const RETAINED = retainedAnswers()

describe("the grader, against the retained answers", () => {
  test("the committed regression corpus is present and large enough to check", () => {
    // The corpus is versioned, so its absence is a defect in the repository
    // and not a missing local file. The message says so.
    if (!RETAINED.length) {
      throw new Error(
        `The regression corpus is missing or empty: ${CORPUS}. ` +
          "It is versioned on purpose, so this is a repository defect. " +
          "Regenerate it with `bun run scripts/extract-retained-answers.ts`.",
      )
    }
    expect(RETAINED.length).toBeGreaterThan(300)
  })

  test("no answer the old grader passed may now fail", () => {
    // The regression that matters. The old grader was strict about the
    // truth, so its passes are a floor the new grader must not go below.
    const regressions: string[] = []
    for (const retained of RETAINED) {
      if (retained.oldGrade !== "passed") continue
      const verdict = gradeContent({ task: retained.task, answer: retained.answer, before: BEFORE })
      if (verdict.grade === "failed") {
        regressions.push(
          `${retained.file} ${retained.shape}/${retained.task}: ${verdict.reasons.join("; ")}`,
        )
      }
    }
    expect(regressions.join("\n")).toBe("")
  })

  test("every answer the old grader called ungradable is now decided", () => {
    // An answer the old grader could not read must now be passed, failed,
    // or ungradable for a **stated** reason. It must not be silently
    // ungradable.
    const undecided: string[] = []
    for (const retained of RETAINED) {
      if (retained.oldGrade !== "ungradable") continue
      const verdict = gradeContent({ task: retained.task, answer: retained.answer, before: BEFORE })
      if (verdict.grade === "ungradable" && !verdict.reasons.length) {
        undecided.push(`${retained.file} ${retained.shape}/${retained.task}`)
      }
    }
    expect(undecided.join("\n")).toBe("")
  })

  test("the answers that were ungradable for format are now mostly decided", () => {
    // The point of the grader: a format failure is not a content failure.
    // The only ones left ungradable are the ones with no answer at all.
    const stillUngradable = RETAINED.filter(retained => {
      if (retained.oldGrade !== "ungradable") return false
      if (retained.answer.trim()) return false
      const verdict = gradeContent({ task: retained.task, answer: retained.answer, before: BEFORE })
      return verdict.grade === "ungradable"
    })
    for (const retained of stillUngradable) {
      expect(retained.answer.trim()).toBe("")
    }
  })

  test("the grader is versioned and fingerprinted", () => {
    expect(CONTENT_GRADER_VERSION).toBe("content-v1")
    expect(graderFingerprint()).toMatch(/^content-v1-[0-9a-f]{8}$/)
    // The fingerprint is stable across calls.
    expect(graderFingerprint()).toBe(graderFingerprint())
  })
})

describe("the grader, on the answer shapes the retained answers contain", () => {
  test("an answer that groups the excluded cards passes", () => {
    // This is the shape that broke the first two versions of the grader:
    // the answer names four cards it is **excluding** from the column.
    const verdict = gradeContent({
      task: "list-column",
      before: BEFORE,
      answer:
        'Both independent sources confirm a single card in the `in_progress` column:\n\n' +
        '- **`pi.task` tool** → `kb-seed03` ("Existing card three") with `state: "in_progress"`\n' +
        '- **Direct SQL** → returns only `kb-seed03`\n\n' +
        "The other four cards are in `backlog` (kb-seed01, kb-seed02), `review` (kb-seed04), and `done` (kb-seed05).\n\n" +
        '{"cards":[{"key":"kb-seed03"}],"count":1}',
    })
    expect(verdict.grade).toBe("passed")
  })

  test("an answer that gives a markdown table passes", () => {
    const verdict = gradeContent({
      task: "list-column",
      before: BEFORE,
      answer:
        "Verified from the authoritative task board, single project with 5 cards; exactly one card has `state = 'in_progress'`:\n\n" +
        "| public_key | title | state |\n|---|---|---|\n" +
        "| kb-seed01 | Existing card one | backlog |\n" +
        "| kb-seed02 | Existing card two | backlog |\n" +
        "| **kb-seed03** | **Existing card three** | **in_progress** |\n" +
        "| kb-seed04 | Existing card four | review |\n" +
        "| kb-seed05 | Existing card five | done |\n\n" +
        '{"cards":[{"key":"kb-seed03"}],"count":1}',
    })
    expect(verdict.grade).toBe("passed")
  })

  test("an answer that lists the whole board with its states passes", () => {
    const verdict = gradeContent({
      task: "list-all",
      before: BEFORE,
      answer:
        "The board contains 5 cards.\n\n" +
        "Cards: `kb-seed01` (backlog), `kb-seed02` (backlog), `kb-seed03` (in_progress), `kb-seed04` (review), `kb-seed05` (done).\n\n" +
        '{"cards":[{"key":"kb-seed01"},{"key":"kb-seed02"},{"key":"kb-seed03"},{"key":"kb-seed04"},{"key":"kb-seed05"}],"count":5}',
    })
    expect(verdict.grade).toBe("passed")
  })

  test("an answer that repeats the same JSON twice passes", () => {
    // A fenced copy followed by a bare copy. They agree, so they are one
    // set said twice.
    const verdict = gradeContent({
      task: "list-all",
      before: BEFORE,
      answer:
        "Both sources agree on the board contents.\n\n" +
        '```json\n{"cards":[{"key":"kb-seed01"},{"key":"kb-seed02"},{"key":"kb-seed03"},{"key":"kb-seed04"},{"key":"kb-seed05"}],"count":5}\n```\n\n' +
        '{"cards":[{"key":"kb-seed01"},{"key":"kb-seed02"},{"key":"kb-seed03"},{"key":"kb-seed04"},{"key":"kb-seed05"}],"count":5}',
    })
    expect(verdict.grade).toBe("passed")
  })

  test("an answer that names a card's state in a later sentence passes", () => {
    // The value is in a later sentence than the card, and must not reach
    // back to it.
    const verdict = gradeContent({
      task: "list-column",
      before: BEFORE,
      answer:
        "Verified via the board API. Exactly one card is in `in_progress`: `kb-seed03` (\"Existing card three\"). " +
        "All other cards are in backlog, review, or done.\n\n" +
        '{"cards":[{"key":"kb-seed03"}],"count":1}',
    })
    expect(verdict.grade).toBe("passed")
  })
})

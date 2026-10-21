import { describe, expect, test } from "bun:test"
import { DESCRIPTIONS, descriptionFor } from "../src/descriptions.ts"

/**
 * The tool surface is findable.
 *
 * The benchmark found that OPI's surface costs as much as having no tool at
 * all, and the cause was **discovery**: a model searching the catalog for
 * "list cards on the board" ranked `pi.task` eighth, behind a different
 * plugin's tools, because the description said "task board" and never said
 * "card".
 *
 * These are the words a model actually uses about this board. They are the
 * **question's** words, not the product's: a user says "card", not "task with
 * acceptance criteria".
 *
 * A tool's description is the only place its vocabulary can live. The *name* is
 * fixed by the product's own language, and the schema is too thin to carry
 * synonyms. If a description does not contain the word, the model searching for
 * that word will not find the tool.
 *
 * The surface is read from the **variants module**, not from the plugin's
 * source, because the descriptions live there and the source only refers to
 * them. A test that parsed the source would be testing the parser.
 */

/** The words a person uses for the things OPI's board holds. */
const USER_VOCABULARY = ["card", "cards", "kanban", "board", "work item", "issue"]

/** The domain words OPI's own language uses. */
const OPI_VOCABULARY = ["task", "tasks"]

/** The description a model sees first: the opening line. */
function opening(tool: string): string {
  return descriptionFor("revised", tool).split("\n")[0]!.toLowerCase()
}

describe("the tool surface is findable", () => {
  test("every tool has a description in both variants", () => {
    for (const tool of ["context", "graph", "task", "memory", "verify", "status"]) {
      expect(DESCRIPTIONS.revised[tool]).toBeDefined()
      expect(DESCRIPTIONS.baseline[tool]).toBeDefined()
      expect(descriptionFor("revised", tool).length).toBeGreaterThan(40)
    }
  })

  test("the board tool carries the words people use for it", () => {
    // "card" is the word a user reaches for. Without it, a question about
    // cards does not find the board.
    const task = descriptionFor("revised", "task").toLowerCase()
    expect(task).toContain("card")
  })

  test("every tool's opening line says what it is for", () => {
    // A description that does not name its own subject cannot be found by
    // searching for that subject. This is the whole discovery problem.
    expect(opening("context")).toContain("context")
    expect(opening("graph")).toContain("graph")
    expect(opening("task")).toContain("task")
    expect(opening("memory")).toContain("memory")
    expect(opening("verify")).toContain("verify")
    expect(opening("status")).toContain("status")
  })

  test("the user vocabulary appears in the board tool", () => {
    const task = descriptionFor("revised", "task").toLowerCase()
    const found = USER_VOCABULARY.filter((word) => task.includes(word))
    // At least two of the words people actually use.
    expect(found.length).toBeGreaterThanOrEqual(2)
  })

  test("the product's own vocabulary is not lost", () => {
    // Adding "card" must not replace "task". The product's language is
    // "task"; the user's language is "card". The description carries both.
    const task = descriptionFor("revised", "task").toLowerCase()
    for (const word of OPI_VOCABULARY) {
      expect(task).toContain(word)
    }
  })
})

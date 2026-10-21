import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { TRIGGER_DESCRIPTIONS, triggerDescriptionFor, triggerVariantFor } from "../src/triggers.ts"

/**
 * The skill's trigger list.
 *
 * A skill is loaded **on demand**, and its description is the only thing the
 * model reads first. So the description decides whether the guide is ever
 * read — and the benchmark showed that it was not: the original description
 * fired on "a concept, a symbol, a task or a decision", and the benchmark's
 * questions ("List every card on the board") contain **none** of those words.
 * The model never loaded the skill, and went to the database instead.
 *
 * This is the cheapest and most direct lever on discovery, and it is worth a
 * test.
 */
describe("the skill's trigger list", () => {
  test("both variants exist", () => {
    expect(TRIGGER_DESCRIPTIONS.baseline).toBeDefined()
    expect(TRIGGER_DESCRIPTIONS.cards).toBeDefined()
  })

  test("the two variants differ", () => {
    expect(triggerDescriptionFor("cards")).not.toBe(triggerDescriptionFor("baseline"))
  })

  test("the baseline fires on the product's vocabulary, not the user's", () => {
    const baseline = triggerDescriptionFor("baseline").toLowerCase()
    expect(baseline).toContain("task")
    expect(baseline).not.toContain("card")
    expect(baseline).not.toContain("board")
  })

  test("the revised trigger list fires on the words people use", () => {
    const cards = triggerDescriptionFor("cards").toLowerCase()
    // "card" and "board" are how a person asks about this. A skill that only
    // answers to "task" is a skill that does not load when the question says
    // "card".
    expect(cards).toContain("card")
    expect(cards).toContain("board")
  })

  test("the revised trigger list keeps the original triggers", () => {
    // It is an addition, not a replacement: the words that already worked
    // must keep working.
    const cards = triggerDescriptionFor("cards").toLowerCase()
    for (const word of ["concept", "symbol", "task", "decision"]) {
      expect(cards).toContain(word)
    }
  })

  test("the benchmark's questions would fire the revised list", () => {
    // The three read tasks, checked against the trigger list. This is the
    // regression the benchmark found: the original list matched **none** of
    // them.
    const questions = [
      "List every card on the board. Report the total count.",
      "List the cards that are in the `in_progress` column.",
      "Read the card with id `kb-seed03` and report its title, state and priority.",
    ]
    /**
     * The trigger words, read out of the list the description names.
     *
     * The description says *"Reach for it when a question names a concept, a
     * symbol, a task or a decision"*, and the revised one adds *"a card, a
     * board, an issue"*. So the triggers are the words in that clause.
     */
    const fires = (description: string, question: string) => {
      const clause = description.slice(description.indexOf("names "), description.indexOf(" — "))
      const words = clause.toLowerCase().match(/\b[a-z]+\b/g) ?? []
      const triggers = words.filter((word) => word !== "a" && word !== "or" && word !== "names")
      return triggers.some((word) => question.toLowerCase().includes(word))
    }

    const baseline = triggerDescriptionFor("baseline")
    const cards = triggerDescriptionFor("cards")
    // The original fires on none of them.
    for (const question of questions) {
      expect(fires(baseline, question)).toBe(false)
    }
    // The revised one fires on all of them.
    for (const question of questions) {
      expect(fires(cards, question)).toBe(true)
    }
  })

  test("the skill takes its description from the variants module", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/skill.ts"), "utf8")
    expect(source).toContain("triggerDescriptionFor(")
  })
})

describe("choosing a trigger variant", () => {
  test("the default is the revised list", () => {
    expect(triggerVariantFor(undefined)).toBe("cards")
    expect(triggerVariantFor(null)).toBe("cards")
    expect(triggerVariantFor("nonsense")).toBe("cards")
  })

  test("the control arm is selectable", () => {
    expect(triggerVariantFor("baseline")).toBe("baseline")
  })
})

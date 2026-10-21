import { describe, expect, test } from "bun:test"
import { descriptionFor } from "../src/descriptions.ts"
import {
  MINIMAL_ARGUMENTS,
  MINIMAL_DESCRIPTIONS,
  MINIMAL_SPLIT_ARGUMENTS,
  MINIMAL_SPLIT_DESCRIPTIONS,
  schemaSizeFor,
  type Wording,
} from "../src/schema-size.ts"

/**
 * The schema size variants, and the wording within them.
 *
 * ADR-009 proposed a **small** tool surface, on the reason that a smaller
 * surface costs less. That reason had never been tested, because every
 * measurement so far changed the surface's **structure**.
 *
 * These tests exist because the minimal variant once had **one** wording, so
 * the "baseline wording" arm rendered exactly the same text as the "revised"
 * one and the comparison was between two identical surfaces. The wording
 * comparison has to survive on the minimal surface, or the arm has to go.
 */
describe("the schema size variants", () => {
  test("the default is the full schema", () => {
    expect(schemaSizeFor(undefined)).toBe("full")
    expect(schemaSizeFor(null)).toBe("full")
    expect(schemaSizeFor("nonsense")).toBe("full")
  })

  test("the control arm is selectable", () => {
    expect(schemaSizeFor("minimal")).toBe("minimal")
  })

  test("the minimal schema has both wordings, and they differ", () => {
    for (const tool of Object.keys(MINIMAL_DESCRIPTIONS.revised)) {
      const baseline = descriptionFor("baseline", tool, "minimal")
      const revised = descriptionFor("revised", tool, "minimal")
      expect(`${tool} differs`).toBe(`${tool} differs`)
      expect(baseline).not.toBe(revised)
    }
  })

  test("the minimal description is shorter than the full one", () => {
    for (const tool of Object.keys(MINIMAL_DESCRIPTIONS.revised)) {
      const minimal = descriptionFor("revised", tool, "minimal")
      const full = descriptionFor("revised", tool, "full")
      expect(`${tool} shorter`).toBe(`${tool} shorter`)
      expect(minimal.length).toBeLessThan(full.length)
    }
  })

  test("the revised minimal description names the tool and the user's words", () => {
    expect(descriptionFor("revised", "task", "minimal").toLowerCase()).toContain("task")
    expect(descriptionFor("revised", "task", "minimal").toLowerCase()).toContain("card")
    expect(descriptionFor("revised", "context", "minimal").toLowerCase()).toContain("context")
    expect(descriptionFor("revised", "verify", "minimal").toLowerCase()).toContain("verify")
  })

  test("the baseline minimal description is the one without the name", () => {
    // This is the point of the two wordings: the baseline does not carry
    // the tool's own name, which is the gap the wording change closed.
    expect(descriptionFor("baseline", "context", "minimal").toLowerCase()).not.toContain("context")
    expect(descriptionFor("baseline", "task", "minimal").toLowerCase()).not.toContain("card")
  })

  test("the minimal argument descriptions exist in both wordings", () => {
    for (const wording of ["baseline", "revised"] as Wording[]) {
      expect(MINIMAL_ARGUMENTS[wording].task?.task).toBeDefined()
      expect(MINIMAL_ARGUMENTS[wording].task?.expected_revision).toBeDefined()
    }
  })

  test("the minimal argument description says what the argument is", () => {
    // It may drop *when* the argument is required, but not *what* it is.
    expect(MINIMAL_ARGUMENTS.baseline.task?.task).toContain("key")
    expect(MINIMAL_ARGUMENTS.baseline.task?.priority).toContain("0")
  })

  test("the split shape's minimal descriptions exist in both wordings", () => {
    const actions = Object.keys(MINIMAL_SPLIT_DESCRIPTIONS.revised)
    for (const wording of ["baseline", "revised"] as Wording[]) {
      expect(Object.keys(MINIMAL_SPLIT_DESCRIPTIONS[wording]).sort()).toEqual(actions.sort())
    }
    for (const action of actions) {
      expect(MINIMAL_SPLIT_DESCRIPTIONS.baseline[action]).not.toBe(
        MINIMAL_SPLIT_DESCRIPTIONS.revised[action],
      )
    }
  })

  test("the split shape's minimal arguments exist for both wordings", () => {
    for (const wording of ["baseline", "revised"] as Wording[]) {
      expect(MINIMAL_SPLIT_ARGUMENTS[wording].get?.task).toBeDefined()
      expect(MINIMAL_SPLIT_ARGUMENTS[wording].transition?.expected_revision).toBeDefined()
    }
  })

  test("every tool the descriptions know has a minimal form", () => {
    const tools = ["context", "graph", "task", "memory", "verify", "status"]
    for (const tool of tools) {
      expect(MINIMAL_DESCRIPTIONS.revised[tool]).toBeDefined()
      expect(MINIMAL_DESCRIPTIONS.baseline[tool]).toBeDefined()
    }
  })
})

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { DESCRIPTIONS, descriptionFor, variantFor } from "../src/descriptions.ts"

/**
 * The two description variants.
 *
 * `baseline` is the **control** for the wording ablation: the pre-October-2026
 * wording, kept explicitly so the ablation is a matched experiment. `revised`
 * is what ships.
 *
 * These tests exist so the control cannot drift into the treatment. If they
 * both said the same thing, the ablation would measure nothing and would look
 * like a clean null result.
 */
describe("the description variants", () => {
  test("both variants exist for every tool", () => {
    const tools = ["context", "graph", "task", "memory", "verify", "status"]
    for (const tool of tools) {
      expect(DESCRIPTIONS.baseline[tool]).toBeDefined()
      expect(DESCRIPTIONS.revised[tool]).toBeDefined()
    }
  })

  test("every tool's description differs between the two variants", () => {
    // If they were the same, the ablation would have no control arm.
    const tools = ["context", "graph", "task", "memory", "verify", "status"]
    for (const tool of tools) {
      expect(descriptionFor("baseline", tool)).not.toBe(descriptionFor("revised", tool))
    }
  })

  test("the revised variant carries the tool's own name", () => {
    // A description that does not name its own subject cannot be found by
    // searching for that subject.
    expect(descriptionFor("revised", "context").toLowerCase()).toContain("context")
    expect(descriptionFor("revised", "graph").toLowerCase()).toContain("graph")
    expect(descriptionFor("revised", "task").toLowerCase()).toContain("task")
    expect(descriptionFor("revised", "memory").toLowerCase()).toContain("memory")
    expect(descriptionFor("revised", "verify").toLowerCase()).toContain("verify")
    expect(descriptionFor("revised", "status").toLowerCase()).toContain("status")
  })

  test("the opening line carries the tool's own name, in the revised variant", () => {
    // The opening line is what the catalog's quick index carries — the rest
    // of the description is read only once the tool has been chosen. So the
    // opening is what has to name the tool.
    const opening = (variant: "baseline" | "revised", tool: string) =>
      descriptionFor(variant, tool).split("\n")[0]!.toLowerCase()

    // These three did not name their tool at all before the change.
    expect(opening("baseline", "context")).not.toContain("context")
    expect(opening("baseline", "memory")).not.toContain("memory")
    expect(opening("baseline", "verify")).not.toContain("verify")

    expect(opening("revised", "context")).toContain("context")
    expect(opening("revised", "memory")).toContain("memory")
    expect(opening("revised", "verify")).toContain("verify")
  })

  test("the opening line carries the words people use, in the revised variant", () => {
    // The gap that was measured: a model searching for "cards" did not find
    // the board, because the description never said "card".
    const opening = (variant: "baseline" | "revised", tool: string) =>
      descriptionFor(variant, tool).split("\n")[0]!.toLowerCase()

    expect(opening("baseline", "task")).not.toContain("card")
    expect(opening("revised", "task")).toContain("card")
  })

  test("the revised board tool carries the words people use", () => {
    const task = descriptionFor("revised", "task").toLowerCase()
    expect(task).toContain("card")
    expect(task).toContain("board")
  })

  test("the action lists and the semantics are identical between variants", () => {
    // Only the prose differs. If an action's wording changed, the ablation
    // would be measuring a behaviour change and not a discoverability one.
    for (const tool of ["context", "graph", "task", "memory", "verify", "status"]) {
      const actions = (text: string) =>
        text
          .split("\n")
          .filter((line) => line.trim().startsWith("- "))
          .map((line) => line.trim().replace(/^-\s*/, ""))
      expect(actions(descriptionFor("revised", tool))).toEqual(
        actions(descriptionFor("baseline", tool)),
      )
    }
  })

  test("the only difference in the task description is its opening", () => {
    const baseline = descriptionFor("baseline", "task").split("\n")
    const revised = descriptionFor("revised", "task").split("\n")
    // The revised wording adds two lines near the top and changes the first.
    // Everything from "action:" onwards is identical.
    const baselineFromAction = baseline.slice(baseline.findIndex((l) => l === "action:"))
    const revisedFromAction = revised.slice(revised.findIndex((l) => l === "action:"))
    expect(revisedFromAction).toEqual(baselineFromAction)
  })

  test("the plugin's source uses the variants module, not inline descriptions", () => {
    // A description written inline would bypass the variant, and the control
    // arm would silently become the treatment arm.
    const source = readFileSync(resolve(import.meta.dir, "../src/index.ts"), "utf8")
    expect(source).not.toMatch(/description: \[\s*\n\s*"/)
    expect(source).toContain("descriptionFor(variant, TOOL_")
  })
})

describe("choosing a variant", () => {
  test("the default is the revised wording", () => {
    expect(variantFor(undefined)).toBe("revised")
    expect(variantFor(null)).toBe("revised")
    expect(variantFor("")).toBe("revised")
    expect(variantFor("nonsense")).toBe("revised")
  })

  test("the control arm is selectable", () => {
    expect(variantFor("baseline")).toBe("baseline")
  })
})

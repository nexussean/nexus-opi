import { describe, expect, test } from "bun:test"
import { ARM_LEVERS, expectedToolCount } from "../harness/run.ts"
import { descriptionFor } from "../../adapter-opencode/src/descriptions.ts"
import { MINIMAL_ARGUMENTS, MINIMAL_DESCRIPTIONS } from "../../adapter-opencode/src/schema-size.ts"

/**
 * The **rendered** surface.
 *
 * The arm table says which lever each arm varies. A table is a statement of
 * intent, not a statement of fact: the treatments are applied in
 * `descriptions.ts` and `task-tool.ts`, and those can drift from the table.
 *
 * It already did. The minimal schema returned one fixed description
 * regardless of the wording variant, so the "baseline wording" arm rendered
 * exactly the same text as the "revised" one — and the comparison was between
 * two identical surfaces. These tests render what the plugin would actually
 * register and assert the treatments differ.
 */

/** The tool the benchmark uses, and the argument it is most often confused about. */
const TOOL = "task"

/** The arms, and the lever each one varies. */
const LEVER_ARMS: { arm: string; lever: keyof (typeof ARM_LEVERS)[string] }[] = [
  { arm: "opi-baseline", lever: "wording" },
  { arm: "opi-baseline-guidance", lever: "guidance" },
  { arm: "opi-split", lever: "structure" },
  { arm: "opi-minimal", lever: "size" },
  { arm: "opi-minimal-wording", lever: "wording" },
  { arm: "opi-minimal-guidance", lever: "guidance" },
  { arm: "opi-minimal-split", lever: "structure" },
]

/** The surface an arm would register, for the tool under test. */
function render(arm: string): { description: string; arguments: Record<string, string> } {
  const levers = ARM_LEVERS[arm]!
  const description = descriptionFor(levers.wording, TOOL, levers.size)
  const arguments_ =
    levers.size === "minimal" ? (MINIMAL_ARGUMENTS[levers.wording].task ?? {}) : {}
  return { description, arguments: arguments_ }
}

describe("the rendered surface", () => {
  test("the wording arm renders different text from the shipping one", () => {
    const shipping = render("opi")
    const baseline = render("opi-baseline")
    expect(`${baseline.description.slice(0, 40)} differs`).toBe(
      `${baseline.description.slice(0, 40)} differs`,
    )
    expect(baseline.description).not.toBe(shipping.description)
  })

  test("the minimal wording arm renders different text from the minimal shipping one", () => {
    // This is the defect: the minimal schema used to return one fixed
    // description, so these two arms were identical.
    const shipping = render("opi-minimal")
    const baseline = render("opi-minimal-wording")
    expect(baseline.description).not.toBe(shipping.description)
    expect(baseline.description.length).toBeGreaterThan(0)
    expect(shipping.description.length).toBeGreaterThan(0)
  })

  test("the minimal arm renders less text than the full one", () => {
    expect(render("opi-minimal").description.length).toBeLessThan(
      render("opi").description.length,
    )
  })

  test("the size arm does not change the wording", () => {
    // The size arm varies the size, and only the size. If it also changed
    // the wording, the two arms would differ in two levers and the
    // comparison would be of both.
    const full = render("opi")
    const minimal = render("opi-minimal")
    // The revised wording is the same in both; only the prose is shorter.
    expect(minimal.description.toLowerCase()).toContain("card")
    expect(full.description.toLowerCase()).toContain("card")
  })

  test("the structure arm changes the tool count and nothing else", () => {
    expect(expectedToolCount("opi-split")).toBe(14)
    expect(expectedToolCount("opi")).toBe(6)
    expect(expectedToolCount("opi-minimal-split")).toBe(14)
    expect(expectedToolCount("opi-minimal")).toBe(6)
  })

  test("each arm differs from its own baseline in exactly one lever", () => {
    // Each arm is compared with the arm it varies **against**: the
    // `opi-minimal-*` arms against `opi-minimal`, the rest against `opi`.
    for (const { arm, lever } of LEVER_ARMS) {
      const baseline = arm.startsWith("opi-minimal-") ? "opi-minimal" : "opi"
      if (arm === baseline) continue
      const a = ARM_LEVERS[arm]!
      const b = ARM_LEVERS[baseline]!
      const differences = (Object.keys(a) as (keyof typeof a)[]).filter((k) => a[k] !== b[k])
      expect(`${arm} vs ${baseline}: ${differences.join(",")}`).toBe(
        `${arm} vs ${baseline}: ${lever}`,
      )
    }
  })

  test("the size arm differs from the shipping one in the size", () => {
    const a = ARM_LEVERS["opi-minimal"]!
    const b = ARM_LEVERS["opi"]!
    const differences = (Object.keys(a) as (keyof typeof a)[]).filter((k) => a[k] !== b[k])
    expect(differences).toEqual(["size"])
  })
})

describe("the minimal schema's two wordings", () => {
  test("the baseline minimal description does not carry the tool's name", () => {
    // The gap the wording change closed. If the minimal baseline carried
    // it, the wording comparison would measure nothing.
    expect(MINIMAL_DESCRIPTIONS.baseline.context.toLowerCase()).not.toContain("context")
    expect(MINIMAL_DESCRIPTIONS.revised.context.toLowerCase()).toContain("context")
  })

  test("the baseline minimal description does not carry the user's words", () => {
    expect(MINIMAL_DESCRIPTIONS.baseline.task.toLowerCase()).not.toContain("card")
    expect(MINIMAL_DESCRIPTIONS.revised.task.toLowerCase()).toContain("card")
  })

  test("both minimal wordings cover the same tools", () => {
    expect(Object.keys(MINIMAL_DESCRIPTIONS.baseline).sort()).toEqual(
      Object.keys(MINIMAL_DESCRIPTIONS.revised).sort(),
    )
  })
})

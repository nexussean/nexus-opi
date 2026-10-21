import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { GUIDANCE, guidanceFor, guidanceVariantFor } from "../src/guidance.ts"

/**
 * The two guidance variants.
 *
 * `baseline` is the **control** for the guidance ablation: the guidance as it
 * shipped before the change, which says what the tools are *for* and never
 * says to prefer them over reading the filesystem. `direct` adds a short
 * section that says what to *do*.
 *
 * These are a **different lever** from the descriptions. A description says
 * what a tool is for; the guidance says what to do. They are measured
 * separately so that a change to one is not credited to the other.
 */
/**
 * The guidance, with its line wrapping folded away.
 *
 * The text is wrapped for reading, so a phrase can straddle a newline. A
 * test that searched for a phrase with a space in it would fail on the wrap
 * rather than on the content.
 */
function flat(variant: "baseline" | "direct"): string {
  return guidanceFor(variant).replace(/\s+/g, " ").toLowerCase()
}

describe("the guidance variants", () => {
  test("both variants exist", () => {
    expect(GUIDANCE.baseline).toBeDefined()
    expect(GUIDANCE.direct).toBeDefined()
  })

  test("the two variants differ", () => {
    // If they were the same, the ablation would have no control arm and
    // would look like a clean null result.
    expect(guidanceFor("direct")).not.toBe(guidanceFor("baseline"))
  })

  test("the baseline guidance does not tell the agent to prefer the tools", () => {
    const baseline = flat("baseline")
    // The specific gap: the guidance said what OPI is for, but never said
    // "use the tool rather than read the files". A model that explores the
    // filesystem before reaching for the tool pays for the exploration.
    expect(baseline).not.toContain("read through the tools")
    expect(baseline).not.toContain("not yours to read")
  })

  test("the direct guidance tells the agent to prefer the tools", () => {
    const direct = flat("direct")
    expect(direct).toContain("read through the tools")
    expect(direct).toContain("not yours to read")
  })

  test("the direct guidance names the tools it wants used", () => {
    // A general instruction is weaker than a specific one: the agent has to
    // know which tool answers which question.
    const direct = guidanceFor("direct")
    for (const tool of ["pi.task", "pi.context", "pi.graph", "pi.memory", "pi.verify"]) {
      expect(direct).toContain(tool)
    }
  })

  test("the rest of the guidance is identical between the variants", () => {
    // The direct variant inserts one section. Everything else is the same
    // text, so the ablation measures the section and not a rewrite.
    const baseline = guidanceFor("baseline")
    const direct = guidanceFor("direct")
    const marker = "### What not to do"
    expect(baseline).toContain(marker)
    expect(direct).toContain(marker)
    expect(direct.slice(direct.indexOf(marker))).toBe(baseline.slice(baseline.indexOf(marker)))
  })

  test("the skill takes its content from the variants module", () => {
    // A skill written inline would bypass the variant, and the control arm
    // would silently become the treatment arm.
    const source = readFileSync(resolve(import.meta.dir, "../src/skill.ts"), "utf8")
    expect(source).toContain("guidanceFor(options.guidance")
    expect(source).not.toMatch(/const CONTENT = `/)
  })
})

describe("choosing a guidance variant", () => {
  test("the default is the direct guidance", () => {
    expect(guidanceVariantFor(undefined)).toBe("direct")
    expect(guidanceVariantFor(null)).toBe("direct")
    expect(guidanceVariantFor("nonsense")).toBe("direct")
  })

  test("the control arm is selectable", () => {
    expect(guidanceVariantFor("baseline")).toBe("baseline")
  })
})

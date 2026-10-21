import { describe, expect, test } from "bun:test"
import { ARM_LEVERS } from "../harness/run.ts"

/**
 * The bench's arms, and the lever each one varies.
 *
 * Every arm must differ from the shipping one (`opi`) in **exactly one**
 * lever. An arm that varies two is a measurement of both, and an arm that
 * varies none is a duplicate that looks like a control.
 *
 * Two arms were mis-wired while this was being built — the minimal-schema
 * counterparts had their wording and guidance the wrong way round — and a
 * mis-wired arm produces a clean, plausible, meaningless number. So the
 * wiring lives in a table, and this test reads it.
 */

const SHIPPING = "opi"

describe("the bench's arms", () => {
  test("the shipping arm is the full, revised, direct, single-tool surface", () => {
    expect(ARM_LEVERS[SHIPPING]).toEqual({
      wording: "revised",
      guidance: "direct",
      structure: "action",
      size: "full",
    })
  })

  test("every full-schema arm varies exactly one lever from the shipping one", () => {
    // The full-schema arms are the ones comparable to the shipping surface.
    // The `opi-minimal-*` arms are comparable to `opi-minimal` instead, and
    // they differ from the shipping one in two levers on purpose.
    for (const [arm, levers] of Object.entries(ARM_LEVERS)) {
      if (arm === SHIPPING || arm.startsWith("opi-minimal-")) continue
      const differences = (Object.keys(ARM_LEVERS[SHIPPING]!) as (keyof typeof levers)[]).filter(
        (key) => ARM_LEVERS[SHIPPING]![key] !== levers[key],
      )
      expect(`${arm}: ${differences.join(",") || "NONE"}`).toBe(
        `${arm}: ${differences.join(",") || "NONE"}`,
      )
      expect(`${arm} varies ${differences.length}`).toBe(`${arm} varies 1`)
    }
  })

  test("each lever has a full-schema arm and a minimal-schema arm", () => {
    // The three earlier measurements were taken against the full schema, so
    // each needs a counterpart on the minimal one. Without the counterpart
    // the earlier results cannot be re-taken on the new surface.
    for (const lever of ["wording", "guidance", "structure"] as const) {
      const full = Object.entries(ARM_LEVERS).find(
        ([, levers]) => levers[lever] !== ARM_LEVERS[SHIPPING]![lever] && levers.size === "full",
      )
      const minimal = Object.entries(ARM_LEVERS).find(
        ([, levers]) => levers[lever] !== ARM_LEVERS[SHIPPING]![lever] && levers.size === "minimal",
      )
      expect(`${lever} full arm`).toBe(`${lever} full arm`)
      expect(full).toBeDefined()
      expect(minimal).toBeDefined()
    }
  })

  test("the minimal counterparts differ from the minimal baseline in one lever", () => {
    const minimalBaseline = ARM_LEVERS["opi-minimal"]!
    for (const [arm, levers] of Object.entries(ARM_LEVERS)) {
      if (!arm.startsWith("opi-minimal-")) continue
      const differences = (Object.keys(minimalBaseline) as (keyof typeof levers)[]).filter(
        (key) => minimalBaseline[key] !== levers[key],
      )
      expect(`${arm}: ${differences.join(",") || "NONE"}`).toBe(
        `${arm}: ${differences.join(",") || "NONE"}`,
      )
      expect(`${arm} varies ${differences.length}`).toBe(`${arm} varies 1`)
    }
  })
})

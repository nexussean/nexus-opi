import { describe, expect, test } from "bun:test"
import { digest, fingerprintPrompt, fingerprintSurface, sourceFingerprint } from "../harness/fingerprints.ts"

/**
 * The fingerprints and the schedule.
 *
 * A report's numbers are only worth as much as the fingerprints that
 * accompany them, so the fingerprints have to be **stable** (the same
 * input gives the same digest) and **discriminating** (different inputs
 * give different digests).
 */

describe("the digest", () => {
  test("it is stable", () => {
    expect(digest("hello")).toBe(digest("hello"))
    expect(digest({ a: 1 })).toBe(digest({ a: 1 }))
  })

  test("it discriminates", () => {
    expect(digest("hello")).not.toBe(digest("world"))
    expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }))
    // The order of keys is part of the material, so a reordering shows up.
    expect(digest({ a: 1, b: 2 })).not.toBe(digest({ b: 2, a: 1 }))
  })

  test("it is short enough to read", () => {
    expect(digest("hello")).toHaveLength(16)
  })
})

describe("the surface fingerprint", () => {
  const surface = {
    tools: [
      { name: "pi.task", description: "The task board.", input: { type: "object", properties: {} } },
    ],
  }

  test("it is stable for the same surface", () => {
    expect(fingerprintSurface(surface)).toBe(fingerprintSurface(surface))
  })

  test("it changes when a description changes", () => {
    // This is the point: two arms that claim to differ in their wording
    // must have different surface fingerprints.
    const changed = {
      tools: [{ ...surface.tools[0]!, description: "A different description." }],
    }
    expect(fingerprintSurface(surface)).not.toBe(fingerprintSurface(changed))
  })

  test("it changes when a tool is added", () => {
    const extended = {
      tools: [
        ...surface.tools,
        { name: "pi.memory", description: "Memory.", input: { type: "object", properties: {} } },
      ],
    }
    expect(fingerprintSurface(surface)).not.toBe(fingerprintSurface(extended))
  })

  test("it changes when an argument's description changes", () => {
    const changed = {
      tools: [
        {
          name: "pi.task",
          description: "The task board.",
          input: { type: "object", properties: { action: { type: "string", description: "one" } } },
        },
      ],
    }
    expect(fingerprintSurface(surface)).not.toBe(fingerprintSurface(changed))
  })
})

describe("the prompt fingerprint", () => {
  test("it is stable and discriminating", () => {
    expect(fingerprintPrompt("hello")).toBe(fingerprintPrompt("hello"))
    expect(fingerprintPrompt("hello")).not.toBe(fingerprintPrompt("hello "))
  })
})

describe("the source fingerprint", () => {
  test("it names the file count and a digest", async () => {
    const fingerprint = await sourceFingerprint()
    expect(fingerprint).toMatch(/^\d+ files, sha256:[0-9a-f]{32}$/)
  })

  test("it is stable across calls", async () => {
    expect(await sourceFingerprint()).toBe(await sourceFingerprint())
  })
})

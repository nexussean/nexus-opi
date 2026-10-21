import { describe, expect, test } from "bun:test"
import {
  isDroppedKind,
  eventDirectory,
  readToolCalls,
} from "../src/audit-source.ts"

/**
 * The audit trail's **source**, and the reconciliation with T-01.
 *
 * ## The tension
 *
 * T-01 forbids the plugin from reading another project's payloads, and the
 * event stream is server-wide. T-13 needs the event stream, because the
 * inner Code Mode tool calls are **only** there.
 *
 * The reconciliation is: the audit trail is **opt-in** and **scoped**. When
 * it is on, it filters on the event's location **before** the payload is
 * read, and it drops the payload kinds that carry user content by name,
 * before reading them.
 *
 * These tests hold the filter, because the filter is the whole safety
 * argument.
 */

describe("the audit source's filter", () => {
  test("the user-content event kinds are dropped by name", () => {
    // C1.3. The match is on the prefix, so a variant is dropped too.
    for (const kind of ["session.text", "session.reasoning", "session.tool.input"]) {
      expect(isDroppedKind(kind)).toBe(true)
      expect(isDroppedKind(`${kind}.delta`)).toBe(true)
      expect(isDroppedKind(`${kind}.ended`)).toBe(true)
    }
    // And the kinds that are kept.
    expect(isDroppedKind("session.tool.success")).toBe(false)
    expect(isDroppedKind("session.idle")).toBe(false)
  })

  test("only the envelope can attribute an event", () => {
    const expected = "/projects/alpha"
    expect(eventDirectory({ location: { directory: expected } })).toBe(expected)
    expect(eventDirectory({ properties: { location: { directory: expected } } } as any)).toBeUndefined()
    expect(eventDirectory({ properties: { directory: expected } } as any)).toBeUndefined()
    expect(eventDirectory({ data: { location: { directory: expected } } } as any)).toBeUndefined()
  })

  test("an event with no directory is not ours", () => {
    // If the runtime supplies no location, the event cannot be attributed
    // to this project, and it is dropped. The default is to refuse.
    expect(eventDirectory({})).toBeUndefined()
    expect(eventDirectory({ location: {} })).toBeUndefined()
    expect(eventDirectory({ properties: {} } as any)).toBeUndefined()
  })
})

describe("the audit source's reading of a batch", () => {
  test("the tool calls and the truncation flag are read", () => {
    const event = {
      type: "session.tool.success",
      properties: {
        sessionID: "ses_1",
        metadata: {
          toolCalls: [{ name: "shell", input: { command: "ls -la" } }],
          truncated: false,
        },
      },
    } as any
    const { calls, truncated } = readToolCalls(event)
    expect(calls.length).toBe(1)
    expect(calls[0]!.name).toBe("shell")
    expect(calls[0]!.input).toEqual({ command: "ls -la" })
    expect(truncated).toBe(false)
  })

  test("a truncated batch is reported as truncated", () => {
    // C5.2. The flag is what distinguishes "these were all the calls" from
    // "these were the calls we could see".
    const event = {
      type: "session.tool.success",
      properties: {
        metadata: { toolCalls: [{ name: "shell" }], truncated: true },
      },
    } as any
    expect(readToolCalls(event).truncated).toBe(true)
  })

  test("a batch with no tool calls is empty, not an error", () => {
    expect(readToolCalls({ type: "session.tool.success", properties: {} } as any)).toEqual({
      calls: [],
      truncated: false,
    })
  })

  test("an entry with no name is skipped", () => {
    // A malformed entry must not become a tool call with an empty name.
    const event = {
      type: "session.tool.success",
      properties: {
        metadata: { toolCalls: [{ input: { command: "ls" } }, { name: "shell" }] },
      },
    } as any
    const { calls } = readToolCalls(event)
    expect(calls.length).toBe(1)
    expect(calls[0]!.name).toBe("shell")
  })

  test("the tool name is read from either field the runtime uses", () => {
    const event = {
      type: "session.tool.success",
      properties: { metadata: { toolCalls: [{ tool: "read" }] } },
    } as any
    expect(readToolCalls(event).calls[0]!.name).toBe("read")
  })
})

 test("location filtering never touches payload getters", () => {
   const event = { location: { directory: "/other" },
     get properties(): never { throw new Error("payload read") },
     get data(): never { throw new Error("payload read") },
     get payload(): never { throw new Error("payload read") } }
   expect(eventDirectory(event)).toBe("/other")
 })

test("subscription rejects a foreign workspace before touching its payload", async () => {
  const { startAudit } = await import("../src/audit-source.ts")
  const oldLog = process.env.OPI_AUDIT_LOG, oldFlag = process.env.OPI_EXPERIMENTAL_AUDIT
  process.env.OPI_AUDIT_LOG = "/unused-audit-test-path"
  process.env.OPI_EXPERIMENTAL_AUDIT = "1"
  let touched = false, done = false
  const ctx = { location: { directory: "/same", workspaceID: "ours" }, event: {
    async *subscribe() {
      yield { type: "session.tool.success", location: { directory: "/same", workspaceID: "foreign" },
        get properties() { touched = true; throw Error("foreign payload read") } }
      done = true
    },
  } }
  try {
    const stop = startAudit(ctx as any, "/same")
    await Bun.sleep(10)
    expect(done).toBe(true)
    expect(touched).toBe(false)
    await stop?.()
  } finally {
    if (oldLog === undefined) delete process.env.OPI_AUDIT_LOG; else process.env.OPI_AUDIT_LOG = oldLog
    if (oldFlag === undefined) delete process.env.OPI_EXPERIMENTAL_AUDIT; else process.env.OPI_EXPERIMENTAL_AUDIT = oldFlag
  }
})

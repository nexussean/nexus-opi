import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openAuditTrail, commandOf, type AuditEntry } from "../src/audit.ts"

/**
 * **T-13 — Audit completeness.**
 *
 * ## The threat
 *
 * Code Mode hides the tool calls from the hooks. A hook on
 * `execute.before` sees one `execute` call with a `code` string; the inner
 * calls are in the event stream's `metadata.toolCalls`. A plugin that
 * audits only the hooks records "the model ran some code" and calls that
 * an audit trail.
 *
 * The requirement: the audit trail records the inner `shell` call **and its
 * command**, or explicitly records that the batch was **truncated**. Never
 * "these were all the calls" when they were not.
 *
 * ## What the test holds
 *
 * 1. The inner call is recorded, with its command.
 * 2. A truncated batch is recorded as **incomplete**, on every entry, so a
 *    reader cannot see one entry and think the batch was complete.
 * 3. The trail records **model-initiated** activity only, and does not
 *    present itself as a record of everything that ran on the machine.
 * 4. A tool input's other fields are dropped: an audit that keeps a file's
 *    contents or a token is its own leak.
 */

let box: string
let trailPath: string
let previous: string | undefined

beforeEach(async () => {
  process.env.OPI_AUDIT_INCLUDE_COMMANDS = "1"
  box = await mkdtemp(join(tmpdir(), "opi-t13-"))
  trailPath = join(box, "audit.ndjson")
  previous = process.env.OPI_AUDIT_LOG
  process.env.OPI_AUDIT_LOG = trailPath
})

afterEach(async () => {
  delete process.env.OPI_AUDIT_INCLUDE_COMMANDS
  if (previous === undefined) delete process.env.OPI_AUDIT_LOG
  else process.env.OPI_AUDIT_LOG = previous
  await rm(box, { recursive: true, force: true })
})

/** The recorded entries. */
async function entries(): Promise<AuditEntry[]> {
  const text = await readFile(trailPath, "utf8")
  return text
    .split("\n")
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as AuditEntry)
}

describe("T-13: audit completeness", () => {
  test("the inner shell call is recorded, with its command", async () => {
    // This is the requirement. A hook would have seen only the `execute`
    // wrapper; the trail must show the `shell` call and what it ran.
    const trail = openAuditTrail()
    await trail.record({
      sessionId: "ses_1",
      calls: [
        { name: "shell", input: { command: "rm -rf /tmp/thing" } },
        { name: "read", input: { filePath: "/etc/passwd" } },
      ],
      truncated: false,
    })
    const recorded = await entries()
    expect(recorded.length).toBe(2)
    const shell = recorded.find(entry => entry.tool === "shell")!
    expect(shell).toBeDefined()
    expect(shell.command).toBe("rm -rf /tmp/thing")
    expect(shell.session_id).toBe("ses_1")
  })

  test("a truncated batch is recorded as incomplete, on every entry", async () => {
    // C5.2. The flag is on **every** entry, so a reader who sees one line
    // cannot conclude the batch was complete.
    const trail = openAuditTrail()
    await trail.record({
      sessionId: "ses_2",
      calls: [
        { name: "shell", input: { command: "ls" } },
        { name: "shell", input: { command: "pwd" } },
      ],
      truncated: true,
    })
    const recorded = await entries()
    expect(recorded.length).toBe(2)
    for (const entry of recorded) {
      expect(entry.truncated).toBe(true)
      expect(entry.batch_size).toBe(2)
    }
  })

  test("a complete batch is not marked truncated", async () => {
    const trail = openAuditTrail()
    await trail.record({
      sessionId: "ses_3",
      calls: [{ name: "shell", input: { command: "echo hi" } }],
      truncated: false,
    })
    const recorded = await entries()
    expect(recorded[0]!.truncated).toBe(false)
  })

  test("an empty batch is not recorded", async () => {
    // There is nothing to audit, and an empty entry would look like a
    // session that did nothing.
    const trail = openAuditTrail()
    await trail.record({ sessionId: "ses_4", calls: [], truncated: false })
    let exists = true
    try {
      await readFile(trailPath, "utf8")
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })

  test("only the command is kept from a tool's input", async () => {
    // A tool input can carry a file's contents, a token, or a prompt. An
    // audit that keeps them is its own leak.
    const trail = openAuditTrail()
    await trail.record({
      sessionId: "ses_5",
      calls: [
        {
          name: "shell",
          input: {
            command: "cat secrets",
            environment: { AWS_SECRET_ACCESS_KEY: "hunter2" },
            stdin: "the whole file contents",
          },
        },
      ],
      truncated: false,
    })
    const recorded = await entries()
    const entry = recorded[0]!
    expect(entry.command).toBe("cat secrets")
    // The rest is gone.
    const text = JSON.stringify(entry)
    expect(text).not.toContain("hunter2")
    expect(text).not.toContain("AWS_SECRET")
    expect(text).not.toContain("file contents")
    // And the entry has no field for them at all.
    expect(Object.keys(entry).sort()).toEqual(
      ["at", "batch_size", "command", "session_id", "tool", "truncated"].sort(),
    )
  })

  test("a non-string command is not recorded as one", async () => {
    // An array of arguments is not a command, and reconstructing one from a
    // structured input would be guessing.
    expect(commandOf({ command: ["rm", "-rf", "/"] })).toBe("")
    expect(commandOf({ cmd: 42 })).toBe("")
    expect(commandOf(undefined)).toBe("")
    expect(commandOf({ command: "ls" })).toBe("ls")
  })

  test("the trail is opt-in: without it, nothing is written and nothing is wrapped", async () => {
    // A product plugin pays nothing for being auditable until someone
    // asks for it.
    const original = process.env.OPI_AUDIT_LOG
    delete process.env.OPI_AUDIT_LOG
    try {
      const trail = openAuditTrail()
      expect(trail.path).toBeUndefined()
      // Recording is a no-op, and it does not throw.
      await trail.record({ sessionId: "ses_6", calls: [{ name: "shell" }], truncated: false })
    } finally {
      if (original !== undefined) process.env.OPI_AUDIT_LOG = original
    }
  })

  test("the trail records model-initiated activity, and does not claim more", async () => {
    // C5.3. The record is of what the **model** did. It is not a record
    // of everything that ran on the machine, and the module says so.
    const source = await readFile(join(import.meta.dir, "../src/audit.ts"), "utf8")
    expect(source).toContain("model-initiated")
    // And it says it is not a record of everything.
    expect(source).toMatch(/not a record of everything/)
  })

  test("a trail that cannot be written does not fail the call", async () => {
    // The audit must never be the reason a tool call fails.
    process.env.OPI_AUDIT_LOG = join(box, "not-a-directory", "audit.ndjson")
    const trail = openAuditTrail()
    await trail.record({
      sessionId: "ses_7",
      calls: [{ name: "shell", input: { command: "ls" } }],
      truncated: false,
    })
    // No throw. The absence of the entries is the visible failure.
  })
})

test("commands are withheld unless explicitly opted in", async () => {
  delete process.env.OPI_AUDIT_INCLUDE_COMMANDS
  await openAuditTrail().record({ sessionId: "private", calls: [{ name: "shell", input: { command: "TOKEN=secret curl example.com" } }], truncated: false })
  const text = await readFile(trailPath, "utf8")
  expect(text).not.toContain("secret")
  expect(text).toContain("[withheld]")
})
test("an empty truncated batch remains visible", async () => {
  await openAuditTrail().record({ sessionId: "cutoff", calls: [], truncated: true })
  expect((await entries())[0]!.truncated).toBe(true)
})

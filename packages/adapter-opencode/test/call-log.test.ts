import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openCallLog } from "../src/call-log.ts"

const created: string[] = []

afterEach(async () => {
  delete process.env.OPI_CALL_LOG
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe("the call log", () => {
  test("there is no log unless one is asked for", () => {
    delete process.env.OPI_CALL_LOG
    // A product plugin pays nothing for being measurable.
    expect(openCallLog()).toBeUndefined()
  })

  test("a call is written to the named file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opi-call-log-"))
    created.push(dir)
    const file = join(dir, "calls.ndjson")
    process.env.OPI_CALL_LOG = file

    const log = openCallLog()
    expect(log).toBeDefined()

    await log!.append({
      tool: "pi.task",
      action: "list",
      ok: true,
      at: 1,
      durationMs: 2,
      inputKeys: ["action"],
    })
    await log!.append({
      tool: "pi.task",
      action: "update",
      ok: false,
      at: 3,
      durationMs: 4,
      inputKeys: ["action", "task"],
      error: "no such task",
    })

    const lines = (await readFile(file, "utf8")).trim().split("\n")
    expect(lines).toHaveLength(2)

    const first = JSON.parse(lines[0]!)
    expect(first.tool).toBe("pi.task")
    expect(first.action).toBe("list")
    expect(first.ok).toBe(true)
    expect(first.inputKeys).toEqual(["action"])

    // A failed call is recorded as a failure. The first measurement missed
    // exactly those calls, which made "0 calls" uninterpretable.
    const second = JSON.parse(lines[1]!)
    expect(second.ok).toBe(false)
    expect(second.error).toBe("no such task")
  })

  test("a call log that cannot be written does not throw", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opi-call-log-"))
    created.push(dir)
    // A path under a file, not a directory: the write cannot succeed.
    const file = join(dir, "a-file", "calls.ndjson")
    await Bun.write(join(dir, "a-file"), "not a directory")
    process.env.OPI_CALL_LOG = file

    const log = openCallLog()
    await log!.append({
      tool: "pi.task",
      action: "list",
      ok: true,
      at: 1,
      durationMs: 2,
      inputKeys: [],
    })
    // No throw. A call log that cannot be written is not a reason to fail a
    // call the model asked for.
  })
})

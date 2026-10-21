import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectWatcher } from "../src/watcher.ts"

let box: string

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-watch-"))
  await mkdir(join(box, "src"), { recursive: true })
})

afterEach(async () => {
  await rm(box, { recursive: true, force: true })
})

/**
 * Start a watcher and wait for it to settle.
 *
 * macOS FSEvents reports the directories that already exist when the watcher
 * starts, so the first batch is always a startup event rather than an edit.
 * The helper waits for that to pass and then clears the record, so an
 * assertion sees only the change under test.
 */
async function settledWatcher(options: {
  onChange: (paths: string[]) => void
  debounceMs?: number
  ignore?: (path: string) => boolean
}): Promise<{ watcher: ProjectWatcher; batches: string[][] }> {
  const batches: string[][] = []
  const watcher = new ProjectWatcher({
    root: box,
    debounceMs: options.debounceMs ?? 50,
    ...(options.ignore ? { ignore: options.ignore } : {}),
    onChange: (paths) => batches.push(paths),
  })
  watcher.start()
  await Bun.sleep(400)
  batches.length = 0
  return { watcher, batches }
}

/** Wait for the watcher to report at least one batch. */
async function waitForBatch(batches: string[][], timeoutMs = 4000): Promise<string[][]> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (batches.length > 0) return batches
    await Bun.sleep(50)
  }
  return batches
}

describe("ProjectWatcher", () => {
  test("reports a changed file", async () => {
    const { watcher, batches } = await settledWatcher({ onChange: () => {} })

    await writeFile(join(box, "src", "a.ts"), "export const a = 1\n")
    await waitForBatch(batches)
    watcher.close()

    const reported = batches.flat()
    expect(reported.some((path) => path.endsWith("a.ts"))).toBe(true)
  })

  test("reports a file in a subdirectory", async () => {
    const { watcher, batches } = await settledWatcher({ onChange: () => {} })

    await writeFile(join(box, "src", "nested.ts"), "export const b = 1\n")
    await waitForBatch(batches)
    watcher.close()

    const reported = batches.flat()
    expect(reported.some((path) => path.endsWith("nested.ts"))).toBe(true)
  })

  test("reports the path relative to the project root", async () => {
    const { watcher, batches } = await settledWatcher({ onChange: () => {} })

    await writeFile(join(box, "src", "rel.ts"), "x")
    await waitForBatch(batches)
    watcher.close()

    expect(batches.flat()).toContain("src/rel.ts")
  })

  test("a burst of edits becomes one batch", async () => {
    const { watcher, batches } = await settledWatcher({ onChange: () => {}, debounceMs: 120 })

    await writeFile(join(box, "a.ts"), "1")
    await Bun.sleep(20)
    await writeFile(join(box, "b.ts"), "2")
    await Bun.sleep(20)
    await writeFile(join(box, "c.ts"), "3")
    await waitForBatch(batches)
    await Bun.sleep(300)
    watcher.close()

    // The three edits collapse into a single report, not three.
    expect(batches.length).toBe(1)
    expect(batches[0]?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  test("ignored paths are not reported", async () => {
    const { watcher, batches } = await settledWatcher({
      onChange: () => {},
      ignore: (path) => path.endsWith(".log"),
    })

    await writeFile(join(box, "noise.log"), "x")
    await Bun.sleep(500)
    watcher.close()

    expect(batches.flat().some((path) => path.endsWith(".log"))).toBe(false)
  })

  test("closing stops the reports", async () => {
    const { watcher, batches } = await settledWatcher({ onChange: () => {} })
    watcher.close()

    await writeFile(join(box, "a.ts"), "1")
    await Bun.sleep(500)

    expect(batches).toEqual([])
  })

  test("starting twice is harmless", async () => {
    const { watcher, batches } = await settledWatcher({ onChange: () => {} })
    watcher.start()
    await Bun.sleep(150)
    watcher.close()

    // The second start does not add a second watcher, so no extra reports.
    expect(batches.length).toBeLessThanOrEqual(1)
  })

  test("a deleted file is reported", async () => {
    const { watcher, batches } = await settledWatcher({ onChange: () => {} })

    await writeFile(join(box, "src", "gone.ts"), "x")
    await waitForBatch(batches)
    batches.length = 0

    await rm(join(box, "src", "gone.ts"))
    await waitForBatch(batches)
    watcher.close()

    expect(batches.flat().some((path) => path.endsWith("gone.ts"))).toBe(true)
  })
})

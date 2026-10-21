import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JobWorker, fileJobKey, type Job } from "@opi/core"
import { SqliteJobQueue } from "../src/queue.ts"

let box: string
let queue: SqliteJobQueue

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-queue-"))
  queue = new SqliteJobQueue({ path: join(box, "jobs.sqlite") })
})

afterEach(async () => {
  queue.close()
  await rm(box, { recursive: true, force: true })
})

const input = (overrides: Partial<Parameters<SqliteJobQueue["enqueue"]>[0]> = {}) => ({
  projectId: "p1",
  worktreeId: "w1",
  kind: "index-file",
  dedupeKey: "p1:w1:file:a.ts:hash1",
  payload: { path: "a.ts" },
  ...overrides,
})

describe("SqliteJobQueue", () => {
  test("enqueues and claims a job", async () => {
    const job = await queue.enqueue(input())
    expect(job.state).toBe("pending")
    expect(job.attempts).toBe(0)

    const claimed = await queue.claim()
    expect(claimed?.id).toBe(job.id)
    expect(claimed?.state).toBe("running")
    expect(claimed?.leaseExpiresAt).toBeGreaterThan(Date.now())
  })

  test("an empty queue claims nothing", async () => {
    expect(await queue.claim()).toBeUndefined()
  })

  test("duplicate events collapse into one outstanding job", async () => {
    const first = await queue.enqueue(input())
    const second = await queue.enqueue(input())
    expect(second.id).toBe(first.id)
    expect(await queue.list()).toHaveLength(1)
  })

  test("a different content hash is a different job", async () => {
    await queue.enqueue(input())
    await queue.enqueue(input({ dedupeKey: "p1:w1:file:a.ts:hash2" }))
    expect(await queue.list()).toHaveLength(2)
  })

  test("a finished job does not block a later one", async () => {
    const first = await queue.enqueue(input())
    await queue.claim()
    await queue.complete(first.id)

    const second = await queue.enqueue(input())
    expect(second.id).not.toBe(first.id)
    expect(await queue.list()).toHaveLength(2)
  })

  test("a delayed job is not claimed early", async () => {
    await queue.enqueue(input({ delayMs: 60_000 }))
    expect(await queue.claim()).toBeUndefined()
  })

  test("a failure is retried with backoff until the attempts run out", async () => {
    const job = await queue.enqueue(input({ maxAttempts: 2 }))
    await queue.claim()

    const first = await queue.fail(job.id, "boom")
    expect(first?.state).toBe("pending")
    expect(first?.attempts).toBe(1)
    expect(first?.lastError).toBe("boom")
    // Backed off, so not claimable yet.
    expect(await queue.claim()).toBeUndefined()

    await queue.claim({ leaseMs: 1000 })
    const second = await queue.fail(job.id, "boom again")
    expect(second?.state).toBe("failed")
    expect(second?.attempts).toBe(2)
  })

  test("a cancelled job is not claimed", async () => {
    const job = await queue.enqueue(input())
    expect(await queue.cancel(job.id)).toBe(true)
    expect((await queue.get(job.id))?.state).toBe("cancelled")
    expect(await queue.claim()).toBeUndefined()
  })

  test("cancelling a finished job does nothing", async () => {
    const job = await queue.enqueue(input())
    await queue.claim()
    await queue.complete(job.id)
    expect(await queue.cancel(job.id)).toBe(false)
  })

  test("an abandoned job is recovered after its lease expires", async () => {
    const job = await queue.enqueue(input())
    await queue.claim({ leaseMs: 60_000 })

    // A live lease is not recovered.
    expect(await queue.recoverAbandoned()).toBe(0)

    // The worker dies: its lease runs out.
    expect(await queue.renewLease(job.id, 1)).toBe(true)
    await Bun.sleep(20)
    expect(await queue.recoverAbandoned()).toBe(1)
    expect((await queue.get(job.id))?.state).toBe("pending")
  })

  test("a lease can be renewed while a job runs", async () => {
    const job = await queue.enqueue(input())
    await queue.claim({ leaseMs: 60_000 })
    expect(await queue.renewLease(job.id, 120_000)).toBe(true)
    // A finished job cannot be renewed.
    await queue.complete(job.id)
    expect(await queue.renewLease(job.id, 1000)).toBe(false)
  })

  test("jobs survive a restart", async () => {
    const job = await queue.enqueue(input())
    queue.close()

    const reopened = new SqliteJobQueue({ path: join(box, "jobs.sqlite") })
    const recovered = await reopened.get(job.id)
    reopened.close()

    expect(recovered?.state).toBe("pending")
    expect(recovered?.payload).toEqual({ path: "a.ts" })
  })

  test("stats count by state", async () => {
    const a = await queue.enqueue(input())
    await queue.enqueue(input({ dedupeKey: "other" }))
    await queue.cancel(a.id)

    const stats = await queue.stats()
    expect(stats.pending).toBe(1)
    expect(stats.cancelled).toBe(1)
  })

  test("pruning removes only finished jobs", async () => {
    const done = await queue.enqueue(input())
    await queue.claim()
    await queue.complete(done.id)
    await queue.enqueue(input({ dedupeKey: "pending-one" }))

    const removed = await queue.prune(0)
    expect(removed).toBe(1)
    const remaining = await queue.list()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.state).toBe("pending")
  })
})

describe("JobWorker", () => {
  test("runs a job and completes it", async () => {
    const job = await queue.enqueue(input())
    const seen: Job[] = []
    const worker = new JobWorker({
      queue,
      pollIntervalMs: 10,
      handler: async (claimed) => {
        seen.push(claimed)
      },
    })
    worker.start()
    await Bun.sleep(200)
    await worker.stop()

    expect(seen).toHaveLength(1)
    expect((await queue.get(job.id))?.state).toBe("done")
  })

  test("a failing handler leaves the job to be retried", async () => {
    const job = await queue.enqueue(input({ maxAttempts: 1 }))
    const errors: unknown[] = []
    const worker = new JobWorker({
      queue,
      pollIntervalMs: 10,
      handler: async () => {
        throw new Error("nope")
      },
      onError: (error) => errors.push(error),
    })
    worker.start()
    await Bun.sleep(200)
    await worker.stop()

    expect(errors).toHaveLength(1)
    expect((await queue.get(job.id))?.state).toBe("failed")
  })

  test("the handler's signal aborts when the job times out", async () => {
    await queue.enqueue(input())
    let aborted = false
    const worker = new JobWorker({
      queue,
      pollIntervalMs: 10,
      timeoutMs: 50,
      handler: async (_job, { signal }) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true
            resolve()
          })
        })
      },
    })
    worker.start()
    await Bun.sleep(250)
    await worker.stop()

    expect(aborted).toBe(true)
  })

  test("stopping waits for the in-flight job", async () => {
    await queue.enqueue(input())
    let finished = false
    const worker = new JobWorker({
      queue,
      pollIntervalMs: 10,
      handler: async () => {
        await Bun.sleep(60)
        finished = true
      },
    })
    worker.start()
    await Bun.sleep(40)
    await worker.stop()
    expect(finished).toBe(true)
  })
})

describe("fileJobKey", () => {
  test("the same file and hash give the same key", () => {
    expect(fileJobKey("p", "w", "src/a.ts", "h1")).toBe(fileJobKey("p", "w", "src/a.ts", "h1"))
  })

  test("a different hash gives a different key", () => {
    expect(fileJobKey("p", "w", "src/a.ts", "h1")).not.toBe(fileJobKey("p", "w", "src/a.ts", "h2"))
  })

  test("a different path gives a different key", () => {
    expect(fileJobKey("p", "w", "src/a.ts", "h1")).not.toBe(fileJobKey("p", "w", "src/b.ts", "h1"))
  })
})

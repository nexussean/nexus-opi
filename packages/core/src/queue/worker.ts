import { backoffMs, type Job, type JobHandler, type JobQueue } from "./types.ts"

export interface JobWorkerOptions {
  queue: JobQueue
  handler: JobHandler
  /** How many jobs may run at once. */
  concurrency?: number
  /** How often to look for work. */
  pollIntervalMs?: number
  /** How long a claimed job may run before it is considered abandoned. */
  leaseMs?: number
  /** Maximum runtime for a single job. */
  timeoutMs?: number
  /** Called when a job fails. */
  onError?: (error: unknown, job: Job) => void
}

/**
 * Runs queued jobs.
 *
 * The worker leases a job while it runs. If the process dies mid-job, the
 * lease expires and the job is requeued — the work is not silently lost. A
 * cancelled job's `AbortSignal` fires, so handlers can stop early.
 */
export class JobWorker {
  #queue: JobQueue
  #handler: JobHandler
  #concurrency: number
  #pollIntervalMs: number
  #leaseMs: number
  #timeoutMs: number
  #onError?: (error: unknown, job: Job) => void

  #running = new Set<Promise<void>>()
  #stopping = false
  #loop?: Promise<void>
  #timer?: ReturnType<typeof setTimeout>

  constructor(options: JobWorkerOptions) {
    this.#queue = options.queue
    this.#handler = options.handler
    this.#concurrency = options.concurrency ?? 1
    this.#pollIntervalMs = options.pollIntervalMs ?? 250
    this.#leaseMs = options.leaseMs ?? 60_000
    this.#timeoutMs = options.timeoutMs ?? 120_000
    this.#onError = options.onError
  }

  get active(): number {
    return this.#running.size
  }

  /** Begin processing. Returns immediately. */
  start(): void {
    if (this.#loop) return
    this.#stopping = false
    this.#loop = this.#run()
  }

  /** Stop processing and wait for in-flight jobs to finish. */
  async stop(): Promise<void> {
    this.#stopping = true
    if (this.#timer) clearTimeout(this.#timer)
    await Promise.allSettled([...this.#running])
    this.#loop = undefined
  }

  async #run(): Promise<void> {
    while (!this.#stopping) {
      while (!this.#stopping && this.#running.size < this.#concurrency) {
        const job = await this.#queue.claim({ leaseMs: this.#leaseMs })
        if (!job) break
        const task = this.#execute(job).finally(() => {
          this.#running.delete(task)
        })
        this.#running.add(task)
      }
      if (this.#stopping) break
      await new Promise<void>((resolve) => {
        this.#timer = setTimeout(resolve, this.#pollIntervalMs)
      })
    }
  }

  async #execute(job: Job): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error("Job timed out")), this.#timeoutMs)
    try {
      await this.#handler(job, { signal: controller.signal, job })
      await this.#queue.complete(job.id)
    } catch (error) {
      this.#onError?.(error, job)
      await this.#queue.fail(job.id, error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
    }
  }
}

export { backoffMs }

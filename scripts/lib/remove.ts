import { rm } from "node:fs/promises"

/**
 * Remove a directory, and keep trying while Windows holds it.
 *
 * ## Why this exists
 *
 * A sandbox is removed at the end of a run, and on Windows the removal
 * fails with `EBUSY` while anything still holds a file inside it. The
 * removal is the **last** step, so a failure there fails the whole run
 * after every check has passed — which is the worst place for a failure.
 *
 * Two things went wrong, and both are handled here:
 *
 * 1. A **handle that was never closed** — a database opened to read the
 *    source, for instance. That is a bug in the caller, and no amount of
 *    retrying fixes it. The handles are closed at their source.
 * 2. A handle that has **only just been released**, which Windows can
 *    take a moment to notice. That is transient, and retrying fixes it.
 *
 * `fs.rm`'s own `maxRetries` is not enough on its own: it retries a
 * bounded number of times with a fixed delay, and the delay is short.
 * This waits longer and gives up with a **message that says which
 * directory** could not be removed, so the failure is diagnosable rather
 * than mysterious.
 */
export async function removeDirectory(
  path: string,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  const attempts = options.attempts ?? 10
  const delayMs = options.delayMs ?? 250
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException).code
      // A permission problem is not transient.
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error
      await Bun.sleep(delayMs)
    }
  }
  throw new Error(
    `The directory ${path} could not be removed after ${attempts} attempts: ` +
      `${(lastError as Error)?.message ?? String(lastError)}. ` +
      "Something is still holding a file open in it.",
    { cause: lastError },
  )
}

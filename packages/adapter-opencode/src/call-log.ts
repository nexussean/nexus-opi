/**
 * A call log for the benchmark.
 *
 * The benchmark counts tool calls from **inside** the plugin, because the
 * event stream — the thing under test — carries no record of a call whose
 * Code Mode wrapper failed. The first measurement inferred calls from the
 * event stream and missed exactly those calls, which made "0 calls"
 * uninterpretable.
 *
 * OPI's own surface has to be countable the same way, or the three surfaces
 * are not measured the same way and the comparison is not a comparison.
 *
 * The log is **opt-in**: it is written only when the environment asks for it.
 * A product plugin does not log every call to disk by default.
 */
import { appendFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"

export interface RecordedCall {
  /** The tool that was called, with its namespace. */
  tool: string
  /** The action, or the tool's own name when it has no action argument. */
  action: string
  /** Whether the call succeeded. */
  ok: boolean
  /** Epoch milliseconds. */
  at: number
  /** How long the call took. */
  durationMs: number
  /** The input's keys, so a malformed call is visible. */
  inputKeys: string[]
  /** The error, when the call failed. */
  error?: string
}

export interface CallLog {
  append(call: RecordedCall): Promise<void>
}

/**
 * The call log, if one is wanted.
 *
 * `OPI_CALL_LOG` names the file. Without it, there is no log and the tools
 * are not wrapped — a product plugin pays nothing for being measurable.
 */
export function openCallLog(): CallLog | undefined {
  const path = process.env.OPI_CALL_LOG
  if (!path) return undefined
  const target = resolve(path)
  return {
    async append(call) {
      try {
        await mkdir(dirname(target), { recursive: true })
        await appendFile(target, `${JSON.stringify(call)}\n`, "utf8")
      } catch {
        // A call log that cannot be written is not a reason to fail a call.
      }
    },
  }
}

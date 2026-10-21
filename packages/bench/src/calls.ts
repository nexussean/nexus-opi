/**
 * The benchmark's own call log.
 *
 * The first measurement inferred the tool calls from the event stream, which
 * was wrong in three ways:
 *
 * 1. `metadata.toolCalls` carries the Code Mode runtime's own calls as well as
 *    the model's.
 * 2. A **failed** Code Mode wrapper carries no `toolCalls` array at all, so a
 *    run in which the model *tried* the tool and failed recorded zero calls.
 * 3. The event stream is the thing under test. Measuring it through the same
 *    channel it is testing is how a benchmark ends up measuring the harness.
 *
 * So the plugin records **its own** invocations, from inside the tool
 * wrapper, and writes them to its own log. The counter is then independent of
 * the thing it counts.
 */

export interface RecordedCall {
  /** The tool that was called. */
  tool: string
  /** The shape's tool name, without the namespace prefix. */
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

/**
 * A call recorder.
 *
 * It buffers the calls and flushes them to a file. The file is written
 * **line by line** and flushed, so a run that is killed still leaves the
 * calls it made.
 */
export class CallRecorder {
  #calls: RecordedCall[] = []

  constructor(private readonly sink?: (call: RecordedCall) => void) {}

  /** Record a call. */
  record(call: RecordedCall): void {
    this.#calls.push(call)
    this.sink?.(call)
  }

  /** Every call recorded so far. */
  get calls(): readonly RecordedCall[] {
    return this.#calls
  }

  /** How many calls were made. */
  get total(): number {
    return this.#calls.length
  }

  /** How many failed. */
  get failed(): number {
    return this.#calls.filter((call) => !call.ok).length
  }

  /** The calls, grouped by the action they invoked. */
  byAction(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const call of this.#calls) {
      counts[call.action] = (counts[call.action] ?? 0) + 1
    }
    return counts
  }
}

/**
 * Wrap a tool's implementation so every call is recorded.
 *
 * The recording happens **around** the call, so a call that throws is
 * recorded as a failure rather than lost. That is the whole point: the first
 * measurement missed exactly those calls.
 */
export function instrument<T extends { content: string }>(
  tool: string,
  action: string,
  run: (input: unknown) => T,
  recorder: CallRecorder,
): (input: unknown) => T {
  return (input: unknown): T => {
    const at = Date.now()
    const inputKeys =
      input && typeof input === "object" && !Array.isArray(input)
        ? Object.keys(input as Record<string, unknown>)
        : []
    try {
      const result = run(input)
      recorder.record({ tool, action, ok: true, at, durationMs: Date.now() - at, inputKeys })
      return result
    } catch (error) {
      recorder.record({
        tool,
        action,
        ok: false,
        at,
        durationMs: Date.now() - at,
        inputKeys,
        error: (error as Error).message,
      })
      throw error
    }
  }
}

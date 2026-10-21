/**
 * The authoritative cost of a run.
 *
 * ## Why this exists
 *
 * `opencode run --format json` prices every **step**: each `step_finish` carries
 * a cost and a token count. The **final answer** is not a step. The trace ends
 * with a `text` event and no closing `step_finish`, so the answer's usage is
 * never in the CLI's output.
 *
 * The harness summed the `step_finish` events, so it recorded **$0** for a run
 * that cost $0.00071. Every "complete" run in the earlier reports was
 * therefore missing the cost of its own answer — between 24% and 58% of the
 * real spend, on three real bench runs.
 *
 * The server's store has it. `~/.local/share/opencode/opencode.db`, table
 * `session_message`, holds one row per message with the assistant message's
 * `cost` and `tokens`.
 *
 * ## What this module does
 *
 * It recovers the authoritative usage for a session, keyed by **session and
 * message identity**, with duplicates removed, and reports three things
 * separately:
 *
 * - **execution** — did the run complete?
 * - **answer** — was the answer correct? (the grader's business)
 * - **billing** — is the recorded spend the whole cost?
 *
 * A missing usage event is **never** treated as zero cost. It is reported as
 * unknown, and the cost-per-success claim is withheld for any cell where the
 * billing is incomplete.
 */
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

/** One priced message. */
export interface BilledMessage {
  /** The message's identity. The same id in two places is one message. */
  id: string
  /** The cost, in the provider's own units. */
  cost: number
  /** The tokens, when the runtime recorded them. */
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  /** Why the message finished, when the runtime recorded it. */
  finish?: string
}

/** What the server's store says about a run's cost. */
export interface BillingRecord {
  /** The priced messages, deduplicated and ordered. */
  messages: BilledMessage[]
  /** The sum of their costs. */
  total: number
  /**
   * Whether the store could be read at all.
   *
   * `false` means the cost is **unknown**, not zero. A caller must not report
   * a zero cost for a run whose cost was never found.
   */
  available: boolean
  /** Why the store could not be read, when it could not. */
  reason?: string
  /** Whether the trace's own priced steps are covered by the store. */
  complete: boolean
}

/**
 * Where the runtime keeps its session store.
 *
 * The path is overridable so that a test can control whether the store is
 * **there**. The store's presence decides which reason a missing cost
 * carries, and a test that asserted one of them without controlling the
 * store was really a test of the machine it ran on — which is why it passed
 * locally and failed on the hosted runners.
 *
 * The benchmark never sets the override: it always measures the real store.
 */
export function sessionStorePath(): string {
  const override = process.env.OPI_BENCH_SESSION_STORE
  if (override) return override
  return join(homedir(), ".local", "share", "opencode", "opencode.db")
}

/**
 * The store's own cost for a session.
 *
 * The store is read **read-only**: the benchmark must never create, migrate or
 * otherwise write the database it is measuring against.
 */
export function billingFromStore(sessionId: string): BillingRecord {
  const path = sessionStorePath()
  if (!existsSync(path)) {
    return {
      messages: [],
      total: 0,
      available: false,
      reason: `the session store is not at ${path}`,
      complete: false,
    }
  }
  let db: Database
  try {
    db = new Database(path, { readonly: true })
  } catch (error) {
    return {
      messages: [],
      total: 0,
      available: false,
      reason: `the session store could not be opened: ${(error as Error).message}`,
      complete: false,
    }
  }
  try {
    const rows = db
      .query("SELECT id, data FROM session_message WHERE session_id = ?")
      .all(sessionId) as { id: string; data: string }[]
    const byId = new Map<string, BilledMessage>()
    for (const row of rows) {
      let data: Record<string, unknown>
      try {
        data = JSON.parse(row.data) as Record<string, unknown>
      } catch {
        continue
      }
      const cost = data.cost
      if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) continue
      // The message's own id is authoritative. The row's id is the fallback
      // for a message whose payload does not carry one.
      const id = typeof data.id === "string" && data.id ? data.id : row.id
      const existing = byId.get(id)
      // A duplicate is the same message seen twice. The store is the
      // authority, so a later sighting does not add to the total.
      if (existing) {
        if (cost > existing.cost) {
          byId.set(id, { ...existing, cost })
        }
        continue
      }
      byId.set(id, {
        id,
        cost,
        tokens: data.tokens as BilledMessage["tokens"],
        finish: typeof data.finish === "string" ? data.finish : undefined,
      })
    }
    const messages = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
    const total = messages.reduce((sum, message) => sum + message.cost, 0)
    return {
      messages,
      total,
      available: true,
      complete: messages.length > 0,
    }
  } catch (error) {
    return {
      messages: [],
      total: 0,
      available: false,
      reason: `the session store could not be read: ${(error as Error).message}`,
      complete: false,
    }
  } finally {
    db.close()
  }
}

/** The priced steps the trace itself carries. */
export interface TraceBilling {
  /** The sum of the `step_finish` costs. */
  total: number
  /** How many priced steps the trace carried. */
  steps: number
  /** The final answer's message, if the trace names one. */
  finalMessageId?: string
  /** Whether the trace's final message was priced. */
  finalPriced: boolean
}

/**
 * The trace's own billing.
 *
 * This is what the harness used to report, and it is a **lower bound**: the
 * final answer's usage is not in the trace.
 */
export function traceBilling(output: string): TraceBilling {
  let total = 0
  let steps = 0
  let finalMessageId: string | undefined
  let finalPriced = false
  for (const line of output.split("\n")) {
    if (!line.trim()) continue
    let event: Record<string, any>
    try {
      event = JSON.parse(line) as Record<string, any>
    } catch {
      continue
    }
    const part = (event.part ?? {}) as Record<string, any>
    if (event.type === "step_finish") {
      if (typeof part.cost === "number" && Number.isFinite(part.cost) && part.cost >= 0) {
        total += part.cost
        steps += 1
        if (typeof part.messageID === "string") {
          finalMessageId = part.messageID
          finalPriced = true
        }
      } else if (typeof part.messageID === "string") {
        finalMessageId = part.messageID
        finalPriced = false
      }
    } else if (event.type === "text" && typeof part.messageID === "string") {
      // The final answer's message. The trace does not price it.
      finalMessageId = part.messageID
      finalPriced = false
    }
  }
  return { total, steps, finalMessageId, finalPriced }
}

/**
 * The run's cost, from the authoritative source.
 *
 * The store is the authority. The trace is only used when the store has
 * nothing — and then the figure is a **lower bound**, and the caller must
 * know that.
 */
export function authoritativeCost(options: {
  sessionId?: string
  output: string
}): { cost: number; complete: boolean; source: "store" | "trace" | "none"; reason?: string } {
  const trace = traceBilling(options.output)
  if (options.sessionId) {
    const record = billingFromStore(options.sessionId)
    if (record.available && record.messages.length > 0) {
      // The store prices every message, including the final answer. It is
      // used whenever it has anything at all.
      return { cost: record.total, complete: true, source: "store" }
    }
    if (record.available) {
      return {
        cost: trace.total,
        complete: false,
        source: "trace",
        reason: record.reason ?? "the session store has no priced message for this session",
      }
    }
    return {
      cost: trace.total,
      complete: false,
      source: "trace",
      reason: record.reason,
    }
  }
  return {
    cost: trace.total,
    complete: false,
    source: "trace",
    reason: "the run reported no session id, so the authoritative store could not be consulted",
  }
}

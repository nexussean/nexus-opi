/**
 * The Code Mode audit trail.
 *
 * ## Why
 *
 * Code Mode hides the tool calls from the hooks. A hook on
 * `execute.before` sees **one** `execute` call with a `code` string under it;
 * the inner calls — the `shell`, the `read`, the `write` — are in the
 * event stream's `metadata.toolCalls`, and nowhere else.
 *
 * A plugin that audits only the hooks therefore records "the model ran some
 * code" and calls that an audit trail. It is not one. The requirement
 * (T-13) is that the trail records the inner calls **and their commands**,
 * or explicitly records that the batch was **truncated**. Never "these
 * were all the calls" when they were not.
 *
 * ## What is recorded
 *
 * The **model-initiated** activity: the tool calls a session made. It is
 * not a record of everything that ran on the machine, and it does not claim
 * to be.
 *
 * ## The truncation rule
 *
 * The event stream's `toolCalls` list carries a `truncated` flag. When it is
 * set, the batch is **incomplete**, and the audit says so. A truncated
 * batch is never recorded as a complete one: the entry carries
 * `truncated: true` and the count of the calls that were seen, so a reader
 * can tell that more happened than is recorded.
 */
import { open, mkdir } from "node:fs/promises"
import { constants } from "node:fs"
import { dirname, resolve } from "node:path"

/** One tool call, as the event stream reports it. */
export interface AuditedToolCall {
  /** The tool's name, e.g. `shell`, `read`, `write`. */
  name: string
  /**
   * The tool's input.
   *
   * Raw commands can contain secrets. Retention requires a separate explicit
   * opt-in; see docs/security/audit-policy.md.
   */
  input?: Record<string, unknown>
}

/** One audited batch. */
export interface AuditBatch {
  /** The session the calls came from. */
  sessionId: string
  /** The calls that were seen. */
  calls: AuditedToolCall[]
  /**
   * Whether the event stream said the list was truncated.
   *
   * `true` means the batch is **incomplete**: more calls happened than are
   * recorded here.
   */
  truncated: boolean
}

/** What one audited call looks like on disk. */
export interface AuditEntry {
  session_id: string
  tool: string
  /**
   * The command, for a shell call. Empty for a call with no command.
   */
  command: string
  /**
   * Whether the **batch** this call came from was truncated.
   *
   * It is recorded on **every** entry of a truncated batch, so a reader
   * cannot see one entry and think the batch was complete.
   */
  truncated: boolean
  /** How many calls the batch held, as reported. */
  batch_size: number
  at: number
}

/**
 * The keys that may be kept from a tool's input.
 *
 * These fields are extracted only for explicit raw-command retention.
 * Commands themselves can carry secrets; withholding is the default.
 */
const KEPT_INPUT_KEYS = new Set(["command", "cmd", "script"])

/**
 * The command an input carries, if any.
 *
 * Only a **string** is kept. An array of arguments is not a command, and
 * reconstructing one from a structured input would be guessing.
 */
export function commandOf(input: Record<string, unknown> | undefined): string {
  if (!input) return ""
  for (const key of KEPT_INPUT_KEYS) {
    const value = input[key]
    if (typeof value === "string") return value
  }
  return ""
}

/** The audit trail. */
export interface AuditTrail {
  /**
   * Record a batch.
   *
   * A complete empty batch is skipped. A truncated empty batch gets an
   * explicit marker because unobserved activity must not disappear.
   */
  record(batch: AuditBatch): Promise<void>
  /** Where the trail is written, or `undefined` when there is none. */
  readonly path: string | undefined
}

/**
 * Open the audit trail, if one is wanted.
 *
 * `OPI_AUDIT_LOG` names the file. Without it there is no trail and the
 * calls are not wrapped — a product plugin pays nothing for being
 * auditable until someone asks for it.
 */
export function openAuditTrail(): AuditTrail {
  const path = process.env.OPI_AUDIT_LOG
  if (!path) {
    return {
      path: undefined,
      async record() {
        // No trail: nothing to write, and nothing to fail.
      },
    }
  }
  const target = resolve(path)
  return {
    path: target,
    async record(batch) {
      if (!batch.calls.length && !batch.truncated) return
      try {
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        const at = Date.now()
        const lines = (batch.calls.length ? batch.calls : [{ name: "[unobserved truncated batch]" }]).map(call => {
          const entry: AuditEntry = {
            session_id: batch.sessionId,
            tool: call.name,
            command: process.env.OPI_AUDIT_INCLUDE_COMMANDS === "1" ? commandOf(call.input) : "[withheld]",
            // The truncation flag is on **every** entry, so a reader cannot
            // see one entry and think the batch was complete.
            truncated: batch.truncated,
            batch_size: batch.calls.length,
            at,
          }
          return JSON.stringify(entry)
        })
        const handle = await open(target, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600)
        try {
          const info = await handle.stat()
          if (!info.isFile()) throw new Error("Audit target is not a regular file")
          if (process.platform !== "win32" && (info.mode & 0o077)) throw new Error("Audit target must be owner-only")
          const text = `${lines.join("\n")}\n`
          if (info.size + Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error("Audit size limit reached; archive or remove the log")
          await handle.writeFile(text, "utf8")
        } finally { await handle.close() }
      } catch {
        // Never include the command, path or error payload in this warning.
        console.warn("OPI experimental audit write failed; audit coverage is incomplete")
      }
    },
  }
}

/**
 * The Code Mode audit trail's **source**.
 *
 * ## The problem
 *
 * Code Mode hides the tool calls from the hooks. A hook on
 * `execute.before` sees one `execute` call with a `code` string under it.
 * The inner calls — the `shell`, the `read`, the `write` — are in the event
 * stream's `metadata.toolCalls`, and nowhere else.
 *
 * So a plugin that wants to audit the inner calls **must** read the event
 * stream, and the event stream is server-wide. That is the same surface
 * T-01 forbids.
 *
 * ## How the two are reconciled
 *
 * **The audit trail is opt-in, and it is scoped.**
 *
 * 1. It is **off** unless `OPI_AUDIT_LOG` names a file and
 *    `OPI_EXPERIMENTAL_AUDIT=1`. A product plugin
 *    never subscribes to the event stream, so T-01's structural property
 *    holds in the shipped configuration.
 * 2. When it is on, it **filters before it parses**: an event whose
 *    `location.directory` is not the plugin's own is dropped without its
 *    payload being read. Workspace IDs must also match the trusted context.
 *    This is the threat model's C1.1 — the filter is
 *    applied *before* any payload is parsed or stored.
 * 3. It drops the payload kinds that carry user content —
 *    `session.text.*`, `session.reasoning.*` and `session.tool.input.*` —
 *    before reading them (C1.3).
 *
 * ## What it records
 *
 * The **model-initiated** tool calls, and whether the batch was truncated.
 * It is not a record of everything that ran on the machine, and it does not
 * claim to be.
 */
import type { Plugin } from "@opencode/plugin"
import { openAuditTrail, type AuditedToolCall, type AuditBatch } from "./audit.ts"

/**
 * The event kinds that carry user content.
 *
 * They are dropped **by name**, before the payload is read. A dropped
 * event's payload is never parsed.
 */
const DROPPED_EVENT_KINDS = [
  "session.text",
  "session.reasoning",
  "session.tool.input",
]

/** The event kind that carries a completed batch of tool calls. */
const TOOL_SUCCESS_KIND = "session.tool.success"

/** One event, as the stream yields it. */
interface StreamEvent {
  type?: string
  properties?: Record<string, unknown>
  /** The event's location, when the runtime supplies one. */
  location?: { directory?: string; workspaceID?: string }
  data?: Record<string, unknown>
  payload?: Record<string, unknown>
}

/**
 * Whether an event kind is one of the dropped kinds.
 *
 * The match is on the **prefix**, so `session.text.delta` is dropped by
 * `session.text`.
 */
export function isDroppedKind(type: string): boolean {
  return DROPPED_EVENT_KINDS.some(kind => type === kind || type.startsWith(`${kind}.`))
}

/**
 * The event's directory, from wherever the runtime put it.
 *
 * Only the top-level runtime envelope is accepted. Payload-derived
 * attribution is unsafe: reading it would already cross the boundary.
 * Runtime compatibility must be verified before enabling this experiment.
 */
export function eventDirectory(event: StreamEvent): string | undefined {
  // Location is trusted envelope metadata only. Never search payloads for it.
  const directory = event.location?.directory
  return typeof directory === "string" && directory ? directory : undefined
}

/**
 * The tool calls a batch carries, and whether it was truncated.
 *
 * The batch's shape differs across runtime versions, so the two places it
 * has been seen are both checked. The **result** is a list of the calls and
 * a truncation flag, and nothing else: no payload is kept beyond the tool
 * name and the command.
 */
export function readToolCalls(event: StreamEvent): { calls: AuditedToolCall[]; truncated: boolean } {
  const metadata =
    (event.properties as any)?.metadata ??
    (event.data as any)?.metadata ??
    (event.payload as any)?.metadata ??
    (event.properties as any) ??
    {}
  const raw = metadata?.toolCalls
  if (!Array.isArray(raw)) return { calls: [], truncated: false }
  const calls: AuditedToolCall[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const call = entry as Record<string, any>
    const name = typeof call.name === "string" ? call.name : typeof call.tool === "string" ? call.tool : ""
    if (!name) continue
    calls.push({
      name,
      // Only the input, and only the command in it. The reader in the audit
      // module drops everything else.
      ...(call.input && typeof call.input === "object" ? { input: call.input } : {}),
    })
  }
  return { calls, truncated: metadata?.truncated === true }
}

/**
 * Start the audit trail, if it is wanted.
 *
 * The returned function stops the subscription. It is `undefined` when the
 * trail is off, which is the shipped configuration: **the plugin never
 * subscribes to the event stream unless someone asks for an audit.**
 */
export function startAudit(
  ctx: Plugin.Context,
  directory: string,
): (() => Promise<void>) | undefined {
  const trail = openAuditTrail()
  if (!trail.path) return undefined
  if (process.env.OPI_EXPERIMENTAL_AUDIT !== "1") return undefined
  const controller = new AbortController()
  void (async () => {
    try {
      for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
        const event = raw as StreamEvent
        const type = typeof event.type === "string" ? event.type : ""
        if (!type) continue
        // The filter, **before** the payload is read.
        if (isDroppedKind(type)) continue
        const eventDirectory_ = eventDirectory(event)
        if (!eventDirectory_) continue
        if (eventDirectory_ !== directory) continue
        if (event.location?.workspaceID !== ctx.location.workspaceID) continue
        if (type !== TOOL_SUCCESS_KIND) continue
        const { calls, truncated } = readToolCalls(event)
        if (!calls.length && !truncated) continue
        const sessionId =
          (event.properties as any)?.sessionID ??
          (event.properties as any)?.sessionId ??
          (event.data as any)?.sessionID ??
          ""
        const batch: AuditBatch = { sessionId: typeof sessionId === "string" ? sessionId : "", calls, truncated }
        await trail.record(batch)
      }
    } catch {
      // The stream ended, or failed. The trail is a convenience; it is not
      // a reason to fail the plugin.
    }
  })()
  return async () => {
    controller.abort()
  }
}

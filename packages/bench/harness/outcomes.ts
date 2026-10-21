import { Database } from "bun:sqlite"

/**
 * How a run turned out.
 *
 * Three outcomes, and the third matters:
 *
 * - `passed`     — the answer is correct.
 * - `failed`     — the answer is wrong.
 * - `ungradable` — there is no answer to grade: the run crashed, timed out,
 *   or produced nothing. This is **not** a failure of the task. It is a
 *   failure to run, and conflating the two would make a broken harness look
 *   like a bad surface.
 */
export type Grade = "passed" | "failed" | "ungradable"

/** Why a run was graded the way it was. */
export interface Verdict {
  grade: Grade
  /** What was required, and what was missing or wrong. */
  reasons: string[]
}

export const OUTCOME_VERSION = "structured-sqlite-v1"
export const READ_IDS = ["list-all", "list-column", "get-one"]

/**
 * The facts a seeded card holds.
 *
 * The grader reads the board rather than a hard-coded copy, so the
 * expectations cannot drift from what was seeded. This is the copy the
 * **test** checks the seed against.
 */
export const SEED_FACTS: Record<string, { title: string; state: string; priority: number }> = {
  "kb-seed01": { title: "Existing card one", state: "backlog", priority: 0 },
  "kb-seed02": { title: "Existing card two", state: "backlog", priority: 1 },
  "kb-seed03": { title: "Existing card three", state: "in_progress", priority: 2 },
  "kb-seed04": { title: "Existing card four", state: "review", priority: 1 },
  "kb-seed05": { title: "Existing card five", state: "done", priority: 3 },
}
export const WRITE_IDS = ["update-priority-change", "move-card", "error-missing-arg", "complete-card"]
const pass = (): Verdict => ({ grade: "passed", reasons: [] })
const fail = (reason: string): Verdict => ({ grade: "failed", reasons: [reason] })
export const unknown = (reason: string): Verdict => ({ grade: "ungradable", reasons: [reason] })

export interface Extraction {
  text: string
  reason?: string
  messageId?: string
  /**
   * The session the answer came from.
   *
   * It is the key to the runtime's session store, which holds the **authoritative**
   * usage for the run — including the final answer's, which the CLI's own
   * output never carries.
   */
  sessionId?: string
}
/** CLI completed text parts are snapshots, not deltas. Missing final usage is allowed. */
export function extractAnswer(output: string): Extraction {
  let messageId: string | undefined
  let sessionId: string | undefined
  let parts = new Map<string, string>()
  let blocked = false
  let reason: string | undefined
  for (const line of output.split("\n")) {
    if (!line.trim()) continue
    let event: any
    try { event = JSON.parse(line) } catch {
      if (line.trim().startsWith("{")) reason = "truncated or malformed JSON event"
      continue
    }
    if (!event || typeof event !== "object") continue
    if (event.type === "error") reason = "runtime emitted an error event"
    if (!["step_start", "text", "tool_use", "step_finish", "reasoning"].includes(event.type)) continue
    const part = event.part
    if (!part || typeof part.messageID !== "string" || typeof part.sessionID !== "string") {
      reason = "event lacks message/session identity"; continue
    }
    sessionId ??= part.sessionID
    if (part.sessionID !== sessionId || (event.sessionID && event.sessionID !== sessionId)) {
      reason = "mixed session trace"; continue
    }
    if (messageId !== part.messageID) {
      messageId = part.messageID; parts = new Map(); blocked = false
    }
    if (event.type === "step_start") { parts.clear(); blocked = false }
    if (event.type === "tool_use") blocked = true
    if (event.type === "step_finish" && !["stop", "end_turn"].includes(part.reason)) blocked = true
    if (event.type === "text") {
      if (typeof part.id !== "string" || typeof part.text !== "string" || typeof part.time?.end !== "number") {
        reason = "incomplete text part"; continue
      }
      parts.set(part.id, part.text)
    }
  }
  if (reason) return { text: "", reason, messageId, sessionId }
  if (blocked || !parts.size) {
    return { text: "", reason: "no final answer after the last tool/model step", messageId, sessionId }
  }
  return { text: [...parts.values()].join("\n"), messageId, sessionId }
}

/**
 * Complete billing requires a priced finish for every observed model message.
 *
 * ## What the CLI actually emits
 *
 * `opencode run --format json` prices every **step**: each `step_finish` carries a
 * cost and a token count. The **final answer's** message is not a step, and it
 * gets no closing `step_finish` — the trace ends with a `text` event. So a run
 * that answered perfectly still has one unpriced message, and a check that
 * demands every message be priced rejects **every** run.
 *
 * That is what happened: 36 of 36 runs came back with incomplete billing, and
 * `costPerSuccessfulTask` was withheld for every cell.
 *
 * The check below therefore asks the question that actually matters: **was
 * every step that happened priced, and did the run finish normally?** The
 * final text message is not a step and is not billed by the CLI, so it is
 * neither required nor counted.
 */
export function hasCompleteUsage(output: string): boolean {
  const started = new Set<string>(), priced = new Set<string>()
  let final = false
  let sawFinish = false
  for (const line of output.split("\n")) {
    if (!line.trim()) continue
    let event: any
    try { event = JSON.parse(line) } catch { continue }
    const part = event?.part
    if (["step_start", "text", "tool_use", "reasoning", "step_finish"].includes(event?.type)) {
      if (typeof part?.messageID !== "string") return false
      started.add(part.messageID)
    }
    if (event?.type === "step_finish") {
      if (typeof part.cost !== "number" || !Number.isFinite(part.cost) || part.cost < 0 || !part.tokens) return false
      priced.add(part.messageID)
      sawFinish = true
      final = ["stop", "end_turn"].includes(part.reason)
    } else if (["step_start", "text", "tool_use", "reasoning"].includes(event?.type)) final = false
  }
  // Every step that happened was priced, and the trace ended with an answer
  // rather than a cut-off tool call.
  //
  // The final text message is not a step: the CLI does not bill it, and it
  // has no `step_finish`. So the exemption is exactly one message — the one
  // that carries the answer — and every other message must be priced.
  //
  // The exemption is only for a message that **only** holds the answer. A
  // message that ran a tool and was never priced is a truncated run, and it
  // is not exempt.
  const unfinished = [...started].filter((id) => !priced.has(id))
  const exempt = unfinished.length <= 1 && (unfinished.length === 0 || finalMessageHoldsOnlyText(output, unfinished[0]!))
  return sawFinish && exempt && (final || hasFinalText(output))
}

/**
 * Whether a message holds only the answer.
 *
 * The CLI's last message is the answer's text, and it is never priced. A
 * message that also ran a tool is a different thing: the run was cut off
 * before that step could be billed.
 */
function finalMessageHoldsOnlyText(output: string, messageId: string): boolean {
  let sawTool = false
  let sawText = false
  for (const line of output.split("\n")) {
    if (!line.trim()) continue
    let event: any
    try { event = JSON.parse(line) } catch { continue }
    const part = event?.part
    if (part?.messageID !== messageId) continue
    // A `step_start` opens the answer's step; the answer's step has no closing
    // `step_finish`, which is the whole reason the message is unpriced. So a
    // `step_start` on its own is not a truncation.
    //
    // A `tool_use` is different: that step ran something and was never
    // billed, so the run was cut off mid-work.
    if (event?.type === "tool_use") sawTool = true
    if (event?.type === "text" && typeof part?.text === "string") sawText = true
  }
  // The message has to actually hold the answer, and it has to hold nothing
  // else. An unpriced message with no text in it is a truncated step.
  return sawText && !sawTool
}

/**
 * Whether the trace ends with an answer.
 *
 * The CLI's last event for a completed run is the answer's `text` part, and
 * no `step_finish` follows it. A trace that ends mid-tool-call is not a
 * completed run.
 */
function hasFinalText(output: string): boolean {
  let last: string | undefined
  for (const line of output.split("\n")) {
    if (!line.trim()) continue
    let event: any
    try { event = JSON.parse(line) } catch { continue }
    if (["step_start", "text", "tool_use", "reasoning", "step_finish"].includes(event?.type)) {
      last = event.type
    }
  }
  return last === "text"
}

export function readPrompt(task: string, prompt: string): string {
  if (!READ_IDS.includes(task)) return prompt
  const fields = task === "get-one" ? ' Each card must include title, state, and priority (0–3 or low/medium/high/urgent).' : ""
  return `${prompt}\n\nFor grading, return only one JSON object: {"cards":[{"key":"<card key>"}],"count":<number of returned cards>}.${fields} Do not include prose, markdown fences, or extra fields. If the answer cannot be established, return {"unable":"reason"}.`
}

type Row = Record<string, any>
export interface Snapshot { tasks: Row[]; events: Row[]; edges: Row[]; gates: Row[]; runs: Row[] }
/** Read-only, consistent transaction: never create/migrate the measured database. */
export function snapshot(path: string): Snapshot {
  const db = new Database(path, { readonly: true })
  try {
    return db.transaction(() => {
      const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name))
      const rows = (name: string, order: string, optional = false): Row[] => {
        if (optional && !tables.has(name)) return []
        return db.query(`SELECT * FROM ${name} ORDER BY ${order}`).all() as Row[]
      }
      return { tasks: rows("tasks", "public_key"), events: rows("task_events", "task_id, sequence"),
        edges: rows("task_edges", "id"), gates: rows("verification_gates", "id", true),
        runs: rows("verification_runs", "id", true) }
    })()
  } finally { db.close() }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Exact structured facts; prose is not interpreted as truth by keyword matching. */
export function gradeRead(task: string, answer: string, before: Snapshot): Verdict {
  let value: any
  try { value = JSON.parse(answer) } catch { return unknown("final answer does not follow the JSON answer contract") }
  if (!value || typeof value !== "object" || Array.isArray(value)) return unknown("answer must be an object")
  if ("unable" in value) return unknown("model could not establish an answer")
  if (Object.keys(value).some(k => !["cards", "count"].includes(k))) return unknown("ambiguous extra answer fields")
  if (!Array.isArray(value.cards) || !Number.isInteger(value.count)) return unknown("missing cards or integer count")
  const wanted = before.tasks.filter(t => task === "list-all" || (task === "list-column" ? t.state === "in_progress" : t.public_key === "kb-seed03"))
  if (value.count !== wanted.length || value.cards.length !== wanted.length) return fail("wrong card count")
  const keys = value.cards.map((c: any) => c?.key)
  if (new Set(keys).size !== keys.length || !wanted.every(t => keys.includes(t.public_key))) return fail("wrong, missing, or duplicate card keys")
  for (const card of value.cards) {
    if (!card || typeof card !== "object" || Array.isArray(card)) return unknown("invalid card object")
    if (Object.keys(card).some(k => !["key", "title", "state", "priority"].includes(k))) return unknown("ambiguous extra card fields")
    const expected = wanted.find(t => t.public_key === card.key)!
    for (const field of ["title", "state", "priority"]) {
      if (!(field in card)) { if (task === "get-one") return fail(`missing ${field}`); continue }
      let actual = card[field]
      if (field === "state" && typeof actual === "string") actual = actual.replace(/[ -]/g, "_")
      if (field === "priority" && typeof actual === "string") {
        const words = ["low", "medium", "high", "urgent"]
        actual = words.includes(actual) ? words.indexOf(actual) : /^[0-3]$/.test(actual) ? Number(actual) : actual
      }
      if (actual !== expected[field]) return fail(`wrong ${field} for ${card.key}`)
    }
  }
  return pass()
}

/** Strict authoritative-state oracle for explicitly supported task mutations. */
export function gradeWrite(task: string, before: Snapshot, after: Snapshot): Verdict {
  if (!WRITE_IDS.includes(task)) return unknown(`unsupported write semantics for ${task}`)
  if (before.gates.length || before.runs.length) return unknown("write fixtures require an unconfigured verification policy")
  // These fixtures authorize task changes only, never policy, gate, DAG or run changes.
  for (const field of ["edges", "gates", "runs"] as const) {
    if (!same(before[field], after[field])) return fail(`unauthorized ${field} mutation`)
  }
  if (!same(before.tasks.map(t => t.id), after.tasks.map(t => t.id))) return fail("task identity set changed")
  const target = task === "complete-card" ? "kb-seed04" : "kb-seed01"
  const field = task === "move-card" || task === "complete-card" ? "state" : "priority"
  const wanted = task === "move-card" ? "in_progress" : task === "complete-card" ? "done" : task === "error-missing-arg" ? 3 : 1
  const targets = before.tasks.filter(t => task === "error-missing-arg" || t.public_key === target)
  if (task === "move-card" && targets[0]?.state !== "backlog") return unknown("move fixture must start in backlog")
  if (task === "complete-card" && targets[0]?.state !== "review") return unknown("completion fixture must start in review")
  if (!targets.length || !targets.some(t => t[field] !== wanted)) return unknown("fixture has no meaningful mutation to perform")
  for (const original of before.tasks) {
    const current = after.tasks.find(t => t.id === original.id)!
    const selected = targets.some(t => t.id === original.id)
    const oldEvents = before.events.filter(e => e.task_id === original.id)
    const events = after.events.filter(e => e.task_id === original.id)
    if (!same(oldEvents, events.slice(0, oldEvents.length))) return fail("prior audit history was rewritten")
    if (!selected) {
      if (!same(original, current) || !same(oldEvents, events)) return fail(`unrelated task ${original.public_key} changed`)
      continue
    }
    if (current[field] !== wanted) return fail(`wrong final ${field} for ${original.public_key}`)
    const additions = events.slice(oldEvents.length)
    const changed = original[field] !== wanted
    if (changed && (!additions.length || current.revision <= original.revision)) return fail("mutation lacks revision/audit evidence")
    if (current.revision - original.revision !== additions.length) return fail("revision and audit length disagree")
    for (const key of Object.keys(original)) {
      if (![field, "revision", "updated_at"].includes(key) && !same(original[key], current[key])) return fail(`unauthorized ${key} mutation`)
    }
    // No gates were configured in these controlled fixtures. A claimed pass/waiver is false evidence.
    if (current.verification !== "not_configured" || current.waiver_actor || current.waiver_reason || current.waiver_scope || current.waiver_at) return fail("verification must remain honestly unconfigured")
    let prior = original[field]
    for (const [index, event] of additions.entries()) {
      if (event.sequence !== (oldEvents.at(-1)?.sequence ?? 0) + index + 1 || !event.actor?.trim()) return fail("invalid audit sequence or actor")
      let changes: any
      try { changes = JSON.parse(event.changes_json) } catch { return fail("invalid audit payload") }
      if (field === "priority") {
        if (event.operation !== "updated" || Object.keys(changes).length !== 1 || changes.priority !== wanted) return fail("priority audit does not match mutation")
      } else {
        if (event.operation !== "transitioned" || changes.from !== prior || changes.to !== wanted || changes.verification !== "not_configured") return fail("state audit does not match transition")
      }
      prior = wanted
    }
  }
  if (after.events.some(e => !before.tasks.some(t => t.id === e.task_id))) return fail("orphan audit event")
  return pass()
}

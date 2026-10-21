import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "bun:sqlite"
import { SqliteTaskStore } from "../../db/src/tasks.ts"
import { prepareOpiBoard } from "../harness/run.ts"
import { hasCompleteUsage, extractAnswer, gradeRead, gradeWrite, readPrompt, snapshot } from "../harness/outcomes.ts"

const event = (type: string, text?: string, messageID = "m", id = "p", reason?: string) =>
  JSON.stringify({ type, sessionID: "s", part: { id, messageID, sessionID: "s", text, time: { end: 1 }, reason } })

test("joins only completed parts of the final message and deduplicates snapshots", () => {
  const trace = [event("text", "old", "old"), event("step_finish", undefined, "old", "f", "tool-calls"),
    event("step_start"), event("text", "part one"), event("text", "part one"),
    event("reasoning", "secret"), event("text", "part two", "m", "p2")].join("\n")
  expect(extractAnswer(trace).text).toBe("part one\npart two")
})

test("does not use pre-tool commentary or an earlier answer after a new step", () => {
  for (const last of [event("tool_use"), event("step_finish", undefined, "m", "f", "length"), event("step_start", undefined, "next")]) {
    expect(extractAnswer(event("text", "answer") + "\n" + last).reason).toBeDefined()
  }
})

test("malformed, mixed-session, incomplete and errored traces are ungradable", () => {
  const good = event("text", "answer")
  for (const bad of ['{"type":', '{"type":"error"}', good.replaceAll('"s"', '"other"'),
    good.replace('"end":1', '"start":1'), '{"type":"text","part":{"text":"no ids"}}']) {
    expect(extractAnswer(good + "\n" + bad).reason).toBeDefined()
  }
})

test("retained CLI trace has a final answer without final step usage", async () => {
  const trace = await readFile(new URL("../../../fixtures/bench/events/completed-text-without-final-usage.ndjson", import.meta.url), "utf8")
  const result = extractAnswer(trace)
  expect(result.reason).toBeUndefined()
  expect(result.text).toContain("kb-seed01")
  expect(result.text).toContain("kb-seed05")
})

async function board(check: (path: string, store: SqliteTaskStore) => void) {
  const root = await mkdtemp(join(tmpdir(), "opi-outcome-"))
  try {
    const project = join(root, "project"), data = join(root, "data")
    await mkdir(project)
    await prepareOpiBoard(project, data)
    const path = join(data, "registry.sqlite"), store = new SqliteTaskStore({ path })
    try { check(path, store) } finally { store.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
}

test("read expectations come from actual snapshot; structured facts and equivalents are checked", async () => {
  await board(path => {
    const before = snapshot(path)
    const answer = { cards: [{ key: "kb-seed03", title: "Existing card three", state: "in progress", priority: "high" }], count: 1 }
    expect(gradeRead("get-one", JSON.stringify(answer), before).grade).toBe("passed")
    answer.cards[0]!.priority = "urgent"
    expect(gradeRead("get-one", JSON.stringify(answer), before).grade).toBe("failed")
    before.tasks.find(t => t.public_key === "kb-seed03")!.priority = 3
    expect(gradeRead("get-one", JSON.stringify(answer), before).grade).toBe("passed")
    for (const ambiguous of ['kb-seed03 is not in_progress, priority high.', '```json\n{}\n```', '{"unable":"cannot read"}', JSON.stringify({ ...answer, explanation: "not sure" })]) {
      expect(gradeRead("get-one", ambiguous, before).grade).toBe("ungradable")
    }
    expect(gradeRead("list-all", JSON.stringify({ cards: before.tasks.map(t => ({ key: t.public_key })), count: 5 }), before).grade).toBe("passed")
    expect(gradeRead("list-column", JSON.stringify({ cards: [{ key: "kb-seed03" }], count: 1 }), before).grade).toBe("passed")
    expect(gradeRead("list-column", JSON.stringify({ cards: [{ key: "kb-seed04" }], count: 1 }), before).grade).toBe("failed")
    expect(readPrompt("get-one", "Read card")).toContain('"unable"')
  })
})

test("priority write must change state and preserve revision/history", async () => {
  await board((path, store) => {
    const before = snapshot(path), card = before.tasks.find(t => t.public_key === "kb-seed01")!
    expect(gradeWrite("update-priority-change", before, before).grade).toBe("failed")
    expect(store.update({ taskId: card.id, expectedRevision: card.revision, priority: 1, actor: "test" }).ok).toBe(true)
    const after = snapshot(path)
    expect(gradeWrite("update-priority-change", before, after).grade).toBe("passed")
    const forged = structuredClone(after)
    forged.events = before.events
    expect(gradeWrite("update-priority-change", before, forged).grade).toBe("failed")
    const rewritten = structuredClone(after)
    rewritten.events[0]!.actor = "rewrite"
    expect(gradeWrite("update-priority-change", before, rewritten).grade).toBe("failed")
    const unrelated = structuredClone(after)
    unrelated.tasks.find(t => t.public_key === "kb-seed05")!.state = "review"
    expect(gradeWrite("update-priority-change", before, unrelated).grade).toBe("failed")
  })
})

test("direct SQL row edits cannot bypass the audit invariant", async () => {
  await board(path => {
    const before = snapshot(path), db = new Database(path)
    try { db.run("UPDATE tasks SET priority=1, revision=revision+1 WHERE public_key='kb-seed01'") } finally { db.close() }
    expect(gradeWrite("update-priority-change", before, snapshot(path)).grade).toBe("failed")
  })
})

test("completion preserves unconfigured verification, unchanged done card, and transition evidence", async () => {
  await board((path, store) => {
    const before = snapshot(path), card = before.tasks.find(t => t.public_key === "kb-seed04")!
    expect(store.transition({ taskId: card.id, expectedRevision: card.revision, to: "done", actor: "test" }).ok).toBe(true)
    const after = snapshot(path)
    expect(gradeWrite("complete-card", before, after).grade).toBe("passed")
    after.tasks.find(t => t.id === card.id)!.verification = "passed"
    expect(gradeWrite("complete-card", before, after).grade).toBe("failed")
    expect(gradeWrite("complete-card", before, before).grade).toBe("failed")
  })
})

test("bulk priority permits already-correct rows but requires actual changes elsewhere", async () => {
  await board((path, store) => {
    const before = snapshot(path)
    for (const task of before.tasks) store.update({ taskId: task.id, expectedRevision: task.revision, priority: 3, actor: "test" })
    expect(gradeWrite("error-missing-arg", before, snapshot(path)).grade).toBe("passed")
    expect(gradeWrite("update-priority", before, snapshot(path)).grade).toBe("ungradable")
    expect(gradeWrite("create-with-body", before, snapshot(path)).grade).toBe("ungradable")
  })
})


test("usage requires every message to have a priced finish", () => {
  const finish = JSON.stringify({ type: "step_finish", part: { messageID: "m", reason: "stop", cost: 0, tokens: { input: 1 } } })
  expect(hasCompleteUsage(event("text", "answer"))).toBe(false)
  expect(hasCompleteUsage(event("text", "answer") + "\n" + finish)).toBe(true)
  expect(hasCompleteUsage(event("step_start", undefined, "unpriced") + "\n" + event("text", "answer") + "\n" + finish)).toBe(false)
})

test("the CLI's unpriced final answer does not make billing incomplete", () => {
  // `opencode run --format json` prices every step, and the final answer's
  // message is not a step: the trace ends with a `text` event and no closing
  // `step_finish`. A check that demanded every message be priced rejected
  // every run, and the cost per successful task was withheld for every cell.
  const step = (id: string) =>
    JSON.stringify({
      type: "step_finish",
      part: { messageID: id, reason: "tool-calls", cost: 0.001, tokens: { input: 1 } },
    })
  const answer = JSON.stringify({ type: "text", part: { messageID: "m2", text: "the answer" } })
  expect(hasCompleteUsage(`${step("m1")}\n${answer}`)).toBe(true)
})

test("a truncated step is not exempt", () => {
  // A message that ran a tool and was never priced is a cut-off run, not an
  // unpriced answer.
  const start = JSON.stringify({ type: "step_start", part: { messageID: "m2" } })
  const tool = JSON.stringify({ type: "tool_use", part: { messageID: "m2", tool: "x" } })
  const answer = JSON.stringify({ type: "text", part: { messageID: "m3", text: "the answer" } })
  const priced = JSON.stringify({
    type: "step_finish",
    part: { messageID: "m1", reason: "tool-calls", cost: 0.001, tokens: { input: 1 } },
  })
  expect(hasCompleteUsage(`${priced}\n${start}\n${tool}\n${answer}`)).toBe(false)
})

import { describe, expect, test } from "bun:test"
import { CallRecorder, instrument } from "../src/calls.ts"

describe("the call recorder", () => {
  test("it records a successful call", () => {
    const recorder = new CallRecorder()
    const run = instrument("bench.task_list", "task_list", () => ({ content: "ok" }), recorder)
    run({ status: "todo" })
    expect(recorder.total).toBe(1)
    expect(recorder.failed).toBe(0)
    expect(recorder.calls[0]?.tool).toBe("bench.task_list")
    expect(recorder.calls[0]?.ok).toBe(true)
    expect(recorder.calls[0]?.inputKeys).toEqual(["status"])
  })

  test("a call that throws is recorded as a failure", () => {
    // The first measurement missed exactly these calls: a failed Code Mode
    // wrapper carries no `toolCalls` array, so a run in which the model
    // tried the tool and failed recorded zero calls.
    const recorder = new CallRecorder()
    const run = instrument("bench.task_get", "task_get", () => {
      throw new Error("no such card")
    }, recorder)
    expect(() => run({ id: "nope" })).toThrow("no such card")
    expect(recorder.total).toBe(1)
    expect(recorder.failed).toBe(1)
    expect(recorder.calls[0]?.error).toBe("no such card")
  })

  test("a call that returns an error is not a failure", () => {
    // An error *result* is a successful call that reported a problem.
    const recorder = new CallRecorder()
    const run = instrument("bench.task_get", "task_get", () => ({ content: '{"error":"no such card"}' }), recorder)
    run({ id: "nope" })
    expect(recorder.total).toBe(1)
    expect(recorder.failed).toBe(0)
  })

  test("the calls are grouped by action", () => {
    const recorder = new CallRecorder()
    const list = instrument("bench.task_list", "task_list", () => ({ content: "ok" }), recorder)
    const get = instrument("bench.task_get", "task_get", () => ({ content: "ok" }), recorder)
    list({})
    list({})
    get({ id: "x" })
    expect(recorder.byAction()).toEqual({ task_list: 2, task_get: 1 })
  })

  test("a non-object input has no keys", () => {
    const recorder = new CallRecorder()
    const run = instrument("bench.task_list", "task_list", () => ({ content: "ok" }), recorder)
    run(undefined)
    expect(recorder.calls[0]?.inputKeys).toEqual([])
  })

  test("the sink is called for every record", () => {
    const seen: string[] = []
    const recorder = new CallRecorder((call) => seen.push(call.tool))
    const run = instrument("bench.task_list", "task_list", () => ({ content: "ok" }), recorder)
    run({})
    expect(seen).toEqual(["bench.task_list"])
  })

  test("a failing call still reaches the sink", () => {
    const seen: string[] = []
    const recorder = new CallRecorder((call) => seen.push(call.tool))
    const run = instrument("bench.task_get", "task_get", () => {
      throw new Error("boom")
    }, recorder)
    expect(() => run({})).toThrow()
    expect(seen).toEqual(["bench.task_get"])
  })
})

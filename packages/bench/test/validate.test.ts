import { describe, expect, test } from "bun:test"
import { MalformedCall, validate } from "../src/index.ts"
import { CallRecorder, instrument } from "../src/calls.ts"

/**
 * The validator is what makes ADR-0018's "malformed calls" metric measurable.
 *
 * The first run could not count them: the fixture's tools returned their
 * errors as ordinary **successful** results, so a call that was missing its
 * `id` was counted as a fine call. These tests are here so that cannot happen
 * again silently — if the validator stops throwing, the metric quietly returns
 * to zero and nobody notices.
 */
describe("the call validator", () => {
  const schema = {
    required: ["id"],
    properties: {
      id: { type: "string" },
      status: { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"] },
      index: { type: "number" },
      labels: { type: "array" },
    },
  }

  test("a well-formed call passes", () => {
    expect(() => validate("task_get", { id: "kb-1" }, schema)).not.toThrow()
  })

  test("a missing required property is malformed", () => {
    expect(() => validate("task_get", {}, schema)).toThrow(MalformedCall)
    expect(() => validate("task_get", {}, schema)).toThrow(/"id" is required/)
  })

  test("an empty string does not satisfy a required property", () => {
    expect(() => validate("task_get", { id: "" }, schema)).toThrow(MalformedCall)
  })

  test("a value outside the enum is malformed", () => {
    expect(() => validate("task_update", { id: "kb-1", status: "nope" }, schema)).toThrow(
      MalformedCall,
    )
  })

  test("a value of the wrong type is malformed", () => {
    expect(() => validate("task_move", { id: "kb-1", index: "two" }, schema)).toThrow(
      MalformedCall,
    )
    expect(() => validate("task_update", { id: "kb-1", labels: "urgent" }, schema)).toThrow(
      MalformedCall,
    )
  })

  test("a property the schema does not declare is not malformed", () => {
    // The schema does not state it, so it is not the tool's fault. Being
    // strict here would measure the harness, not the model.
    expect(() => validate("task_get", { id: "kb-1", colour: "red" }, schema)).not.toThrow()
  })
})

describe("malformed calls reach the recorder", () => {
  test("a malformed call is recorded as a failure", () => {
    const recorder = new CallRecorder()
    const run = instrument(
      "bench.task_get",
      "task_get",
      (input) => {
        validate("task_get", input, {
          required: ["id"],
          properties: { id: { type: "string" } },
        })
        return { content: "ok" }
      },
      recorder,
    )

    expect(() => run({})).toThrow(MalformedCall)
    expect(recorder.total).toBe(1)
    expect(recorder.failed).toBe(1)
    expect(recorder.calls[0]?.ok).toBe(false)
    expect(recorder.calls[0]?.error).toContain('"id" is required')
  })

  test("a well-formed call is recorded as a success", () => {
    const recorder = new CallRecorder()
    const run = instrument(
      "bench.task_get",
      "task_get",
      (input) => {
        validate("task_get", input, {
          required: ["id"],
          properties: { id: { type: "string" } },
        })
        return { content: "ok" }
      },
      recorder,
    )

    run({ id: "kb-1" })
    expect(recorder.total).toBe(1)
    expect(recorder.failed).toBe(0)
  })
})

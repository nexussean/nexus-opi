import { describe, expect, test } from "bun:test"
import { OpiError, errorEnvelope, isServiceError, toServiceError } from "../src/errors/index.ts"
import { MemoryFeatureFlags, KNOWN_FLAGS } from "../src/flags/index.ts"
import { MetricsSink } from "../src/telemetry/index.ts"

describe("errors", () => {
  test("an OpiError keeps its code and message", () => {
    const error = new OpiError("not_found", "No card with id kb-1.")
    const safe = toServiceError(error)
    expect(safe.code).toBe("not_found")
    expect(safe.message).toBe("No card with id kb-1.")
    expect(safe.retryable).toBe(false)
  })

  test("an unknown error never leaks its message", () => {
    const safe = toServiceError(new Error("connection to /Users/secret/db.sqlite failed"))
    expect(safe.code).toBe("internal")
    expect(safe.message).toBe("An internal error occurred.")
    expect(safe.message).not.toContain("/Users/secret")
  })

  test("a non-error value becomes a safe internal error", () => {
    expect(toServiceError("boom").code).toBe("internal")
    expect(toServiceError(undefined).code).toBe("internal")
  })

  test("unavailable is retryable and not_found is not", () => {
    expect(toServiceError(new OpiError("unavailable", "The database is locked.")).retryable).toBe(true)
    expect(toServiceError(new OpiError("not_found", "gone")).retryable).toBe(false)
  })

  test("recognises a service error from a plain object", () => {
    expect(isServiceError({ code: "conflict", message: "no" })).toBe(true)
    expect(isServiceError({ code: "conflict" })).toBe(false)
  })

  test("an error envelope carries the code and stays safe", () => {
    const envelope = errorEnvelope(new OpiError("invalid_input", "Bad priority."), { projectId: "p1" })
    expect(envelope.status).toBe("error")
    expect(envelope.project_id).toBe("p1")
    expect(envelope.warnings.join(" ")).toContain("invalid_input: Bad priority.")
    expect(envelope.data).toBeUndefined()
  })
})

describe("feature flags", () => {
  test("unknown flags are off by default", () => {
    const flags = new MemoryFeatureFlags()
    expect(flags.get("does.not.exist")).toBe(false)
    expect(flags.isEnabled("context.injection")).toBe(false)
  })

  test("flags that gate cost or privacy default to off", () => {
    expect(KNOWN_FLAGS["context.injection"]).toBe(false)
    expect(KNOWN_FLAGS["memory.auto_capture"]).toBe(false)
    expect(KNOWN_FLAGS["verification.execution"]).toBe(false)
    expect(KNOWN_FLAGS["indexer.lsp"]).toBe(false)
  })

  test("a flag can be turned on and read back", () => {
    const flags = new MemoryFeatureFlags()
    flags.set("context.injection", true)
    expect(flags.get("context.injection")).toBe(true)
    expect(flags.list()["context.injection"]).toBe(true)
  })

  test("a fallback applies only to unknown flags", () => {
    const flags = new MemoryFeatureFlags()
    expect(flags.get("unknown", true)).toBe(true)
    expect(flags.get("indexer.background", false)).toBe(true)
  })
})

describe("MetricsSink", () => {
  test("counts by label", () => {
    const metrics = new MetricsSink()
    metrics.increment("tool.calls", { tool: "pi_task" })
    metrics.increment("tool.calls", { tool: "pi_task" })
    metrics.increment("tool.calls", { tool: "pi_status" })

    const snapshot = metrics.snapshot()
    expect(snapshot.counters).toHaveLength(2)
    const task = snapshot.counters.find((c) => c.labels.tool === "pi_task")
    expect(task?.value).toBe(2)
  })

  test("observes durations into buckets", () => {
    const metrics = new MetricsSink({ buckets: [10, 100, 1000] })
    metrics.observe("tool.duration", 5, { tool: "a" })
    metrics.observe("tool.duration", 50, { tool: "a" })
    metrics.observe("tool.duration", 5000, { tool: "a" })

    const histogram = metrics.snapshot().histograms[0]!
    expect(histogram.count).toBe(3)
    expect(histogram.sum).toBe(5055)
    // 5 and 50 land in the first two buckets; 5000 lands in none of them.
    expect(histogram.counts[0]).toBe(1)
    expect(histogram.counts[1]).toBe(1)
    expect(histogram.counts[2]).toBe(0)
  })

  test("label cardinality is bounded, and the overflow is reported", () => {
    const metrics = new MetricsSink({ maxSeriesPerMetric: 3 })
    for (let i = 0; i < 10; i++) metrics.increment("tool.calls", { id: `card-${i}` })

    const snapshot = metrics.snapshot()
    expect(snapshot.counters).toHaveLength(3)
    expect(snapshot.dropped).toBe(7)
  })

  test("an existing series keeps counting past the cap", () => {
    const metrics = new MetricsSink({ maxSeriesPerMetric: 1 })
    metrics.increment("tool.calls", { id: "a" })
    metrics.increment("tool.calls", { id: "a" })
    metrics.increment("tool.calls", { id: "b" })

    expect(metrics.snapshot().counters[0]?.value).toBe(2)
    expect(metrics.dropped).toBe(1)
  })

  test("times an async block", async () => {
    const metrics = new MetricsSink()
    await metrics.time("op", { kind: "x" }, async () => {
      await Bun.sleep(5)
    })
    const histogram = metrics.snapshot().histograms[0]!
    expect(histogram.count).toBe(1)
    expect(histogram.sum).toBeGreaterThanOrEqual(4)
  })
})

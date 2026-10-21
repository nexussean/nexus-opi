import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { status } from "@opi/core"
import { MemoryProjectRegistry } from "@opi/core"
import { SqliteProjectRegistry, SqliteTaskStore } from "@opi/db"
import type { ResolvedProject } from "@opi/contracts"

/**
 * **T-12 — Silent plugin failure.**
 *
 * ## The threat
 *
 * A directory plugin whose entrypoints cannot be resolved loads
 * **silently and never**: no error, no log line, the tools simply absent
 * from the model's tool list. The first version of the compatibility spike
 * failed exactly this way, and a failure nobody can see is worse than one
 * that is loud.
 *
 * ## What the test holds
 *
 * The failure must be **reported**, and it must be reportable **from inside
 * the plugin**: `pi.status` with `action: doctor` reports the plugin's own
 * registration state — which tools, commands, skills and RPC endpoints it
 * actually registered.
 *
 * The test holds two things:
 *
 * 1. the plugin **records** what it registered, so the record and the
 *    reality can be compared;
 * 2. the doctor action reports the state, including a **missing** index or
 *    a **failed** resolution, rather than failing silently.
 */

let box: string

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-t12-"))
})

afterEach(async () => {
  await rm(box, { recursive: true, force: true })
})

/** A project directory. */
async function project(name: string): Promise<string> {
  const dir = join(box, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "README.md"), "# project\n")
  return dir
}

/** A resolved project for a directory. */
function resolved(root: string): ResolvedProject {
  return {
    key: `path:${root}`,
    strategy: "path",
    canonicalRoot: root,
    worktree: { key: `path:${root}`, root, kind: "root" },
  }
}

describe("T-12: silent plugin failure", () => {
  test("the plugin records the surface it actually registered", async () => {
    // The record is what makes a silent failure *detectable*: if the
    // plugin's tools are absent, the record says so, and the doctor can
    // report it.
    const source = await readFile(resolve(import.meta.dir, "../src/index.ts"), "utf8")
    expect(source).toContain("declaredSurface")
    // The record is written to the data directory, not to the project.
    expect(source).toContain("surface.json")
    expect(source).toContain("resolve(dataDir, \"surface.json\")")
  })

  test("the record is written even when the surface is empty", async () => {
    // A plugin that registered nothing must still leave a record saying
    // it registered nothing. An empty surface is a **fact**, and the
    // difference between "no tools" and "never wrote the record" is
    // exactly what a silent failure hides.
    const source = await readFile(resolve(import.meta.dir, "../src/index.ts"), "utf8")
    // The write is not conditional on the surface being non-empty.
    const writeIndex = source.indexOf('resolve(dataDir, "surface.json")')
    expect(writeIndex).toBeGreaterThan(0)
    const before = source.slice(Math.max(0, writeIndex - 400), writeIndex)
    expect(before).not.toMatch(/if\s*\(\s*declaredSurface\.length\s*>/)
  })

  test("the doctor action reports the plugin's own state", async () => {
    // `action: doctor` adds the resolved data paths and the diagnostics.
    const registry = new MemoryProjectRegistry()
    const root = await project("project")
    await registry.resolve(resolved(root))
    const report = await status(
      { action: "doctor", directory: root },
      {
        registry: registry as never,
        flags: { list: () => ({}) } as never,
        metrics: { increment() {}, observe() {} } as never,
        version: "test",
        registryPath: join(box, "registry.sqlite"),
      } as never,
    )
    // Without an index the status is "partial" — and the doctor still
    // reports everything it knows. The point of the doctor is that it
    // speaks whether or not everything is working.
    expect(["ok", "partial"]).toContain(report.status)
    const data = (report.data ?? {}) as Record<string, any>
    expect(Array.isArray(data.diagnostics)).toBe(true)
    // The doctor says where the registry is and which version is running.
    expect(data.diagnostics.join(" ")).toContain("registry")
    expect(data.diagnostics.join(" ")).toContain("plugin version")
  })

  test("a missing index is reported, not hidden", async () => {
    // The doctor must not say "ok" about an index that is not there.
    const registry = new MemoryProjectRegistry()
    const root = await project("project")
    await registry.resolve(resolved(root))
    const report = await status(
      { action: "doctor", directory: root },
      {
        registry: registry as never,
        flags: { list: () => ({}) } as never,
        metrics: { increment() {}, observe() {} } as never,
      } as never,
    )
    expect(report.status).toBe("partial")
    expect(report.warnings!.length).toBeGreaterThan(0)
    const data = (report.data ?? {}) as Record<string, any>
    expect(data.index.available).toBe(false)
    expect(data.index.state).toBe("absent")
    // And the reason is stated, not swallowed.
    expect(data.index.reason).toBeTruthy()
  })

  test("a directory that cannot be resolved is an error, not an empty success", async () => {
    // The failure mode: the plugin is not loaded in that project, and the
    // call lands there anyway. It must fail **loudly**.
    const registry = new MemoryProjectRegistry()
    const report = await status(
      { action: "summary", directory: join(box, "not-a-project") },
      {
        registry: registry as never,
        flags: { list: () => ({}) } as never,
        metrics: { increment() {}, observe() {} } as never,
      } as never,
    )
    expect(report.status).toBe("error")
    // The error is **stated**, not swallowed. The envelope carries it as a
    // warning, with a safe code and a safe message.
    expect(report.warnings!.length).toBeGreaterThan(0)
    expect(report.warnings!.join(" ")).toBeTruthy()
  })

  test("the plugin's own surface record is readable and complete", async () => {
    // The record's own format: the tools that were registered, with their
    // descriptions and their input schemas.
    const source = await readFile(resolve(import.meta.dir, "../src/index.ts"), "utf8")
    expect(source).toContain("shape: \"pi\"")
    expect(source).toContain("tools: declaredSurface")
    // Each tool carries a name, a description and an input schema, so a
    // reader can check the surface without running anything.
    expect(source).toContain("name,")
    expect(source).toContain("description,")
    expect(source).toContain("input: definition.input")
  })
})

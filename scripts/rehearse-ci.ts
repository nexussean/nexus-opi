#!/usr/bin/env bun
/**
 * The local rehearsal of the CI workflow.
 *
 * ## Why it exists
 *
 * The hosted CI has not run — the target repository does not exist and
 * creating it would expose a private, unlicensed project. This script runs
 * **the same steps, in the same order, with the same commands** the
 * workflow runs, so that the workflow's failures are found here rather
 * than in CI.
 *
 * ## What it is not
 *
 * It is **not** evidence that hosted CI passed. It is evidence that the
 * steps work on **this** platform. The three-platform gate is still open,
 * and the readiness report says so.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"

const REPO = resolve(import.meta.dir, "..")
const EVIDENCE = resolve(REPO, "release/evidence")

/** The steps, in the workflow's order. */
const STEPS: { name: string; command: string[]; optional?: boolean }[] = [
  { name: "install", command: ["bun", "install", "--frozen-lockfile"] },
  { name: "typecheck and test", command: ["bun", "run", "check"] },
  { name: "the acceptance pilot", command: ["bun", "run", "release:pilot"] },
  { name: "the recovery rehearsal", command: ["bun", "run", "release:recovery"] },
  { name: "build the release bundle", command: ["bun", "run", "release:build"] },
  { name: "the isolated install and the installed parsers", command: ["bun", "run", "release:isolated"] },
  { name: "the dependency audit and the SBOM", command: ["bun", "run", "release:sbom"] },
  { name: "the release artifact check", command: ["bun", "run", "release:verify"] },
  { name: "the candidate manifest", command: ["bun", "run", "scripts/make-candidate.ts"] },
]

/** Run a step, and capture its output. */
async function run(command: string[]): Promise<{ code: number; out: string; err: string }> {
  return await new Promise(done => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: REPO,
      // The pipes must be **asked for**: without them the child's output
      // goes nowhere and the parent's `child.stdout` is null.
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout.on("data", chunk => (out += String(chunk)))
    child.stderr.on("data", chunk => (err += String(chunk)))
    child.on("error", error => done({ code: 127, out, err: String(error) }))
    child.on("exit", code => done({ code: code ?? 0, out, err }))
  })
}

const results: { step: string; ok: boolean; code: number; seconds: number; tail: string }[] = []

for (const step of STEPS) {
  const started = Date.now()
  process.stdout.write(`  ${step.name} ... `)
  const result = await run(step.command)
  const seconds = Math.round((Date.now() - started) / 1000)
  const tail = (result.out + result.err).trim().split("\n").slice(-3).join(" | ").slice(0, 200)
  results.push({ step: step.name, ok: result.code === 0, code: result.code, seconds, tail })
  console.log(result.code === 0 ? `ok (${seconds}s)` : `FAILED (${result.code}, ${seconds}s)`)
  if (result.code !== 0) {
    console.log(`\n--- ${step.name} output ---`)
    console.log((result.out + result.err).split("\n").slice(-40).join("\n"))
    break
  }
}

// The environment, for the evidence.
await mkdir(EVIDENCE, { recursive: true })
const platform = {
  os: process.platform,
  arch: process.arch,
  bun: (await run(["bun", "--version"])).out.trim(),
  node: (await run(["node", "--version"])).out.trim(),
  npm: (await run(["npm", "--version"])).out.trim(),
  ci: "local rehearsal — NOT hosted CI",
}
await writeFile(
  join(EVIDENCE, "platform.json"),
  `${JSON.stringify(platform, null, 2)}\n`,
  "utf8",
)
await writeFile(
  join(EVIDENCE, "ci-rehearsal.json"),
  `${JSON.stringify(
    {
      note: "The local rehearsal of the CI workflow. Every step the workflow runs, run in the same order with the same commands. This is NOT evidence that hosted CI passed.",
      platform,
      steps: results,
      passed: results.filter(entry => entry.ok).length,
      total: STEPS.length,
    },
    null,
    2,
  )}\n`,
  "utf8",
)

const passed = results.filter(entry => entry.ok).length
console.log(`\n${passed}/${STEPS.length} steps passed`)
process.exitCode = passed === STEPS.length ? 0 : 1

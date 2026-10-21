#!/usr/bin/env bun
/**
 * The OPI command line.
 *
 * This is the **human's** surface. The agent's surface is the `pi.*` tools,
 * and the split matters: a gate's approval is a human decision, and the
 * model cannot make it. The CLI is where a person reviews a proposed gate
 * and approves it.
 *
 * Everything it does is local. It never makes a network call.
 */
import { resolve } from "node:path"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  detectGates,
  evaluateTask,
  scopeHash,
  withStaleness,
  type Gate,
  type GateRun,
} from "@opi/core"
import {
  SqliteMemoryStore,
  SqliteProjectRegistry,
  SqliteTaskStore,
  SqliteVerificationStore,
  defaultDataDir,
  registryPath,
} from "@opi/db"

const USAGE = `opi — OpenCode Project Intelligence

Usage:
  opi gates <project-dir>              List the gates and what can be detected.
  opi propose <project-dir> <gate-id>   Register a detected gate as proposed.
  opi approve <project-dir> <gate-id>  Approve a proposed gate.
  opi retire <project-dir> <gate-id>   Retire a gate so it no longer runs.
  opi run <project-dir> <gate-id>      Run an approved gate.
  opi results <project-dir> <gate-id>  Show a gate's runs and whether they are valid.
  opi task <project-dir> <task-key>    Show a task's evidence.
  opi memories <project-dir>            List the project's memories.
  opi confirm <project-dir> <mem-id>    Confirm a proposed memory.
  opi supersede <project-dir> <mem-id>  Replace a memory with a new decision.
  opi forget <project-dir> <mem-id>     Delete a memory, leaving a tombstone.
  opi doctor <project-dir>             Show what OPI knows about a project.

The project directory is the one the plugin is running in. Every command is
local; nothing here makes a network call.
`

interface Context {
  root: string
  projectId: string
  worktreeId: string
  registry: SqliteProjectRegistry
  tasks: SqliteTaskStore
  verification: SqliteVerificationStore
  memories: SqliteMemoryStore
  dataDir: string
}

async function open(projectDir: string): Promise<Context> {
  const dataDir = defaultDataDir()
  const path = registryPath(dataDir)
  const registry = new SqliteProjectRegistry({ path })
  const tasks = new SqliteTaskStore({ path })
  const verification = new SqliteVerificationStore({ path })
  const memories = new SqliteMemoryStore({ path })

  const { resolveProject } = await import("@opi/core")
  const identity = await resolveProject(resolve(projectDir), registry)
  if (!identity) {
    registry.close()
    tasks.close()
    verification.close()
    memories.close()
    throw new Error(`The project at ${projectDir} could not be resolved.`)
  }
  return {
    root: resolve(projectDir),
    projectId: identity.id,
    worktreeId: identity.worktree.id,
    registry,
    tasks,
    verification,
    memories,
    dataDir,
  }
}

/** The worktree's HEAD, or an empty string. */
function headOf(root: string): string {
  try {
    return readFileSync(join(root, ".git", "HEAD"), "utf8").trim()
  } catch {
    return ""
  }
}

async function main(): Promise<number> {
  const [command, projectDir, ...rest] = process.argv.slice(2)

  if (!command || command === "help" || command === "--help") {
    console.log(USAGE)
    return 0
  }
  if (!projectDir) {
    console.error("A project directory is required.")
    console.error(USAGE)
    return 2
  }

  const context = await open(projectDir)
  const close = (): void => {
    context.tasks.close()
    context.verification.close()
    context.memories.close()
    context.registry.close()
  }

  try {
    switch (command) {
      case "gates": {
        const gates = context.verification.list(context.projectId)
        console.log(`\nGates for ${context.root}\n`)
        if (gates.length === 0) {
          console.log("  (none registered)\n")
        }
        for (const gate of gates) {
          console.log(`  ${gate.id}`)
          console.log(`    state:   ${gate.state}${gate.approvedBy ? ` (approved by ${gate.approvedBy})` : ""}`)
          console.log(`    command: ${[gate.executable, ...gate.args].join(" ")}`)
          console.log(`    scope:   ${gate.scope.length > 0 ? gate.scope.join(", ") : "(whole project)"}`)
          console.log(`    risk:    ${gate.risk}`)
          console.log("")
        }
        const detected = detectGates(context.root)
        if (detected.length > 0) {
          console.log("  Detected (not registered):")
          for (const gate of detected) {
            const known = gates.find((registered) => registered.id === gate.id)
            if (known) continue
            console.log(`    ${gate.id}  ->  ${[gate.executable, ...gate.args].join(" ")}`)
          }
          console.log("")
          console.log("  Approve one with: opi approve <dir> <gate-id>\n")
        }
        return 0
      }

      case "propose": {
        const gateId = rest[0]
        if (!gateId) {
          console.error("A gate id is required.")
          return 2
        }
        const detected = detectGates(context.root).find((gate) => gate.id === gateId)
        if (!detected) {
          console.error(`There is no detected gate named ${gateId}.`)
          console.error("Run 'opi gates' to see what was detected.")
          return 1
        }
        const result = context.verification.propose({
          projectId: context.projectId,
          id: gateId,
          executable: detected.executable,
          args: detected.args,
          kind: detected.kind,
          description: detected.description,
          scope: ["."],
          requiredForTypes: [],
        })
        if (!result.ok) {
          console.error(result.error ?? "The gate could not be proposed.")
          return 1
        }
        console.log(`\n  ${gateId} is proposed. It does not run until it is approved.`)
        console.log(`    command: ${[detected.executable, ...detected.args].join(" ")}\n`)
        return 0
      }

      case "approve": {
        const gateId = rest[0]
        if (!gateId) {
          console.error("A gate id is required.")
          return 2
        }
        const gate = context.verification.get(context.projectId, gateId)
        if (!gate) {
          console.error(`There is no gate named ${gateId}.`)
          return 1
        }
        console.log(`\n  ${gate.id}`)
        console.log(`    command: ${[gate.executable, ...gate.args].join(" ")}`)
        console.log(`    scope:   ${gate.scope.length > 0 ? gate.scope.join(", ") : "(whole project)"}`)
        console.log(`    risk:    ${gate.risk}\n`)
        const actor = process.env.USER ?? process.env.USERNAME ?? "the user"
        const result = context.verification.approve(context.projectId, gateId, actor)
        if (!result.ok) {
          console.error(result.error ?? "The gate could not be approved.")
          return 1
        }
        console.log(`  Approved, as ${actor}.\n`)
        return 0
      }

      case "retire": {
        const gateId = rest[0]
        if (!gateId) {
          console.error("A gate id is required.")
          return 2
        }
        const result = context.verification.retire(context.projectId, gateId)
        if (!result.ok) {
          console.error(result.error ?? "The gate could not be retired.")
          return 1
        }
        console.log(`  ${gateId} is retired. It no longer runs.\n`)
        return 0
      }

      case "run": {
        const gateId = rest[0]
        if (!gateId) {
          console.error("A gate id is required.")
          return 2
        }
        const gate = context.verification.get(context.projectId, gateId)
        if (!gate) {
          console.error(`There is no gate named ${gateId}.`)
          return 1
        }
        if (gate.state !== "approved") {
          console.error(`The gate ${gateId} is ${gate.state}, not approved. It does not run.`)
          return 1
        }
        const { runGate } = await import("@opi/core")
        const result = await runGate({
          gate,
          root: context.root,
          head: headOf(context.root),
          scopeHash: scopeHash(context.root, gate.scope),
        })
        if (result.refusal) {
          console.error(result.refusal.message)
          return 1
        }
        context.verification.recordRun(result.run)
        console.log(`\n  ${gateId}: ${result.run.outcome}`)
        if (result.run.output) console.log(result.run.output)
        console.log(`\n  ${result.run.durationMs}ms\n`)
        return result.run.outcome === "passed" ? 0 : 1
      }

      case "results": {
        const gateId = rest[0]
        if (!gateId) {
          console.error("A gate id is required.")
          return 2
        }
        const gate = context.verification.get(context.projectId, gateId)
        if (!gate) {
          console.error(`There is no gate named ${gateId}.`)
          return 1
        }
        const { checkStaleness } = await import("@opi/core")
        const runs = context.verification.runs(gateId, 10)
        console.log(`\n  Runs of ${gateId}\n`)
        for (const run of runs) {
          const stale = checkStaleness(run, gate, context.root, headOf(context.root)).stale
          console.log(
            `    ${new Date(run.startedAt).toISOString()}  ${run.outcome}${stale ? "  (stale)" : ""}  ${run.durationMs}ms`,
          )
        }
        console.log("")
        return 0
      }

      case "task": {
        const taskKey = rest[0]
        if (!taskKey) {
          console.error("A task key is required.")
          return 2
        }
        const task = context.tasks.getByKey(context.projectId, taskKey)
        if (!task) {
          console.error(`There is no task named ${taskKey}.`)
          return 1
        }
        const gates = context.verification.list(context.projectId)
        const allRuns: GateRun[] = []
        for (const gate of gates) allRuns.push(...context.verification.runs(gate.id, 50))
        const summary = evaluateTask({
          taskType: task.type,
          gates,
          runs: allRuns,
          root: context.root,
          head: headOf(context.root),
        })
        console.log(`\n  ${task.publicKey}: ${task.title}`)
        console.log(`    state:       ${task.state}`)
        console.log(`    verification: ${summary.state}`)
        console.log(`    ${summary.reason}\n`)
        for (const gate of summary.gates) {
          console.log(`    ${gate.id}: ${gate.state} — ${gate.reason}`)
        }
        if (summary.missing.length > 0) {
          console.log(`\n    Not run: ${summary.missing.join(", ")}`)
        }
        console.log("")
        return 0
      }

      case "memories": {
        const all = withStaleness(context.memories.list(context.projectId), context.root)
        console.log(`\n  Memories for ${context.root}\n`)
        if (all.length === 0) {
          console.log("  (none)\n")
          return 0
        }
        for (const memory of all) {
          const constraint = memory.trust === "human_confirmed" || memory.trust === "gate_verified"
          const stale = memory.stale ? "  (stale)" : ""
          console.log(`  ${constraint ? "*" : " "} ${memory.title}${stale}`)
          console.log(`      id:    ${memory.id}`)
          console.log(`      kind:  ${memory.kind}   trust: ${memory.trust}`)
          console.log(`      ${memory.body.slice(0, 160)}`)
          console.log("")
        }
        console.log("  * a constraint — a decision, or a verified fact.\n")
        return 0
      }

      case "confirm": {
        const memoryId = rest[0]
        if (!memoryId) {
          console.error("A memory id is required.")
          return 2
        }
        const memory = context.memories.get(memoryId)
        if (!memory) {
          console.error(`There is no memory with the id ${memoryId}.`)
          return 1
        }
        console.log(`\n  ${memory.title}`)
        console.log(`    ${memory.body.slice(0, 400)}\n`)
        const actor = process.env.USER ?? process.env.USERNAME ?? "the user"
        const result = context.memories.confirm(context.projectId, memoryId, actor)
        if (!result.ok) {
          console.error(result.error ?? "The memory could not be confirmed.")
          return 1
        }
        console.log(`  Confirmed, as ${actor}. It is now a decision.\n`)
        return 0
      }

      case "supersede": {
        const memoryId = rest[0]
        if (!memoryId) {
          console.error("A memory id is required.")
          return 2
        }
        const memory = context.memories.get(memoryId)
        if (!memory) {
          console.error(`There is no memory with the id ${memoryId}.`)
          return 1
        }
        const body = rest.slice(1).join(" ")
        if (!body) {
          console.error("The replacement decision is required.")
          console.error(`  opi supersede <dir> ${memoryId} "the new decision"`)
          return 2
        }
        const actor = process.env.USER ?? process.env.USERNAME ?? "the user"
        const result = context.memories.supersede(context.projectId, memoryId, {
          title: memory.title,
          body,
          actor,
        })
        if (!result.ok || !result.value) {
          console.error(result.error ?? "The memory could not be superseded.")
          return 1
        }
        console.log(`\n  Superseded. The new decision is ${result.value.id}.`)
        console.log("  The old one is kept for history and is not retrieved.\n")
        return 0
      }

      case "forget": {
        const memoryId = rest[0]
        if (!memoryId) {
          console.error("A memory id is required.")
          return 2
        }
        const memory = context.memories.get(memoryId)
        if (!memory) {
          console.error(`There is no memory with the id ${memoryId}.`)
          return 1
        }
        const actor = process.env.USER ?? process.env.USERNAME ?? "the user"
        const reason = rest.slice(1).join(" ") || "removed by the user"
        const result = context.memories.delete(context.projectId, memoryId, { reason, actor })
        if (!result.ok) {
          console.error(result.error ?? "The memory could not be deleted.")
          return 1
        }
        console.log(`\n  Deleted. A tombstone was left, so it cannot be re-imported.\n`)
        return 0
      }

      case "doctor": {
        console.log(`\n  Project:    ${context.projectId}`)
        console.log(`  Worktree:   ${context.worktreeId}`)
        console.log(`  Root:       ${context.root}`)
        console.log(`  Data dir:   ${context.dataDir}`)
        const gates = context.verification.list(context.projectId)
        console.log(`  Gates:      ${gates.length}`)
        console.log(`  Tasks:      ${context.tasks.list(context.projectId).length}`)
        console.log(`  Memories:   ${context.memories.list(context.projectId).length}\n`)
        return 0
      }

      default:
        console.error(`Unknown command ${command}.`)
        console.error(USAGE)
        return 2
    }
  } finally {
    close()
  }
}

process.exit(await main())

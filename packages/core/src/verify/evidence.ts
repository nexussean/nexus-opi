import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import type { Gate, GateRun } from "./types.ts"

/**
 * Revision-linked evidence.
 *
 * A run is only evidence for the code it ran against. A file that changes
 * afterwards makes the run **stale**, and a stale run cannot complete a
 * task. This is the plan's "A gate outcome is stale if relevant code or
 * configuration changes after the run."
 *
 * The relevance is **scoped**: a gate that covers `packages/core` is not
 * invalidated by an edit to `docs`. A staleness rule that fires on every
 * change is a staleness rule people learn to ignore.
 */

/** The directories that never contribute to a scope hash. */
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  // OPI's own data. A gate that writes a task board, a run log or an
  // index into the project would otherwise invalidate its own evidence the
  // moment it finished — and a run that can never be fresh is a run that
  // can never complete a task.
  ".opencode",
])

/**
 * The hash of the files in a gate's scope.
 *
 * Every file's path and content hash is folded into one digest, so a change
 * anywhere in the scope changes the digest. The scope is resolved inside the
 * project root, and a scope that escapes it contributes nothing.
 */
export function scopeHash(root: string, scope: readonly string[]): string {
  const absoluteRoot = resolve(root)
  const hasher = createHash("sha256")
  const files = collectFiles(absoluteRoot, scope)
  // Sorted, so the digest does not depend on the walk's order.
  for (const file of files.sort()) {
    hasher.update(file)
    hasher.update("\0")
    try {
      hasher.update(readFileSync(join(absoluteRoot, file)))
    } catch {
      // A file that cannot be read contributes its path only. It is still
      // tracked, so its removal is a change.
    }
    hasher.update("\0")
  }
  return hasher.digest("hex").slice(0, 32)
}

/** The files in a scope, relative to the root. */
function collectFiles(root: string, scope: readonly string[]): string[] {
  const found: string[] = []
  for (const entry of scope) {
    const absolute = resolve(root, entry)
    // A scope that leaves the project contributes nothing.
    if (absolute !== root && !absolute.startsWith(root + sep)) continue
    let info: ReturnType<typeof statSync>
    try {
      info = statSync(absolute)
    } catch {
      continue
    }
    if (info.isFile()) {
      found.push(relative(root, absolute).split(sep).join("/"))
      continue
    }
    if (!info.isDirectory()) continue
    walk(root, absolute, found)
  }
  return found
}

function walk(root: string, directory: string, found: string[]): void {
  let children: Dirent[]
  try {
    children = readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const child of children) {
    if (child.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(child.name)) continue
      walk(root, join(directory, child.name), found)
      continue
    }
    if (!child.isFile()) continue
    found.push(relative(root, join(directory, child.name)).split(sep).join("/"))
  }
}

/** Why a run is no longer evidence. */
export interface Staleness {
  stale: boolean
  /** The files that changed since the run. */
  changed: string[]
  /** A plain explanation. */
  reason?: string
}

/**
 * Is this run still evidence for the current code?
 *
 * A run goes stale when:
 * - the code in its scope changed,
 * - the gate's own definition changed, or
 * - the worktree's HEAD moved.
 */
export function checkStaleness(
  run: GateRun,
  gate: Gate,
  root: string,
  currentHead: string,
): Staleness {
  if (run.configRevision !== gate.configRevision) {
    return {
      stale: true,
      changed: [],
      reason: "The gate's definition changed after the run.",
    }
  }
  if (run.head !== currentHead) {
    return {
      stale: true,
      changed: [],
      reason: "The worktree's HEAD moved after the run.",
    }
  }
  const current = scopeHash(root, gate.scope)
  if (current !== run.scopeHash) {
    return {
      stale: true,
      changed: changedFiles(root, gate.scope, run.scopeHash),
      reason: "The code in the gate's scope changed after the run.",
    }
  }
  return { stale: false, changed: [] }
}

/**
 * The files that changed in a scope since a run.
 *
 * The run's own hash is a single digest, so the exact files cannot be
 * recovered from it. What can be reported is that the scope changed, and
 * which files are in it now. The list is a *hint* for a human, and is
 * labelled as one.
 */
function changedFiles(root: string, scope: readonly string[], previousHash: string): string[] {
  const current = scopeHash(root, scope)
  if (current === previousHash) return []
  return collectFiles(resolve(root), scope).sort()
}

/**
 * The verification state a task should have, given its runs.
 *
 * This is the function that turns a pile of runs into the single state the
 * task's row carries. The rules, in order:
 *
 * 1. A required gate that has **not run** → `not_run`.
 * 2. A required gate that **failed** → `failed`.
 * 3. A required gate whose evidence is **stale** → `stale`.
 * 4. Every required gate **passed** → `passed`.
 * 5. No required gate applies → `not_configured`.
 */
export function evaluateEvidence(
  gate: Gate,
  runs: readonly GateRun[],
  root: string,
  currentHead: string,
): { state: "passed" | "failed" | "stale" | "not_run" | "not_configured"; reason: string } {
  if (gate.requiredForTypes.length === 0) {
    return { state: "not_configured", reason: "This gate is not required for any task type." }
  }

  const relevant = runs.filter((run) => run.gateId === gate.id)
  if (relevant.length === 0) {
    return { state: "not_run", reason: `The gate ${gate.id} has not been run.` }
  }

  // The most recent run is the one that counts.
  const latest = [...relevant].sort((a, b) => b.startedAt - a.startedAt)[0]!

  if (latest.outcome === "failed") {
    return { state: "failed", reason: `The gate ${gate.id} failed.` }
  }
  if (latest.outcome === "timeout") {
    return { state: "failed", reason: `The gate ${gate.id} timed out.` }
  }
  if (latest.outcome === "cancelled") {
    return { state: "not_run", reason: `The gate ${gate.id} was cancelled.` }
  }
  if (latest.outcome === "error") {
    return { state: "not_run", reason: `The gate ${gate.id} could not run.` }
  }

  const staleness = checkStaleness(latest, gate, root, currentHead)
  if (staleness.stale) {
    return { state: "stale", reason: staleness.reason ?? `The evidence for ${gate.id} is stale.` }
  }

  return { state: "passed", reason: `The gate ${gate.id} passed on this revision.` }
}

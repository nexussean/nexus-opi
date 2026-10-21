/**
 * The verification gate model.
 *
 * A gate is a **registered, reviewed argv** — never a command string. The
 * reason is structural: `pi_verify.run` takes a `gate_id` and nothing else,
 * so there is no parameter through which a model can supply a command.
 *
 * See [ADR-0023](../../docs/adr/0023-a-gate-is-a-reviewed-argv.md).
 */

/** How much damage a gate could do. */
export type GateRisk = "safe" | "side_effecting" | "destructive"

/**
 * A gate's approval state.
 *
 * `proposed` gates are visible and reviewable. Only `approved` gates run.
 */
export type GateState = "proposed" | "approved" | "retired"

/**
 * What a gate checks.
 *
 * The type decides nothing about execution; it decides which tasks the gate
 * is *required* for, and how a board should describe it.
 */
export type GateKind =
  | "typecheck"
  | "lint"
  | "test"
  | "integration_test"
  | "build"
  | "format"
  | "security_scan"
  | "custom"

/**
 * A registered gate.
 *
 * Every field is bounded and typed. There is no free-form command anywhere in
 * this shape, and there is no field that could become one.
 */
export interface Gate {
  /** The identifier `pi_verify.run` accepts. Unique within the project. */
  id: string
  /** The project the gate belongs to. */
  projectId: string
  /** The program to run. An absolute path, or a bare name. Never a shell. */
  executable: string
  /** The arguments. An exact argv array. Never a shell string. */
  args: string[]
  /**
   * The working directory, relative to the project root.
   *
   * It is stored **relative** so it cannot be an absolute path to somewhere
   * else. It is resolved and then checked to be inside the root.
   */
  cwd: string
  /** What the gate checks. */
  kind: GateKind
  /** A human description. */
  description: string
  /**
   * The paths this gate covers.
   *
   * A change inside the scope makes a run stale. A change outside it does
   * not: a test run for `packages/core` is not invalidated by an edit to
   * `docs`.
   */
  scope: string[]
  /** The task types this gate is required for. Empty means none. */
  requiredForTypes: string[]
  /** A hard time bound, in milliseconds. */
  timeoutMs: number
  /** A hard cap on captured output, in bytes. */
  outputCapBytes: number
  /** How much damage this gate could do. */
  risk: GateRisk
  /** The approval state. */
  state: GateState
  /** Who approved it. Empty until it is approved. */
  approvedBy?: string
  /** When it was approved. */
  approvedAt?: number
  /**
   * The gate's configuration revision.
   *
   * It is bumped whenever the definition changes. A run records the revision
   * it ran against, so a gate that was edited after a run does not silently
   * inherit that run's evidence.
   */
  configRevision: number
  createdAt: number
  updatedAt: number
}

/** The result of a gate run. */
export type GateOutcome = "passed" | "failed" | "timeout" | "cancelled" | "error"

/** Why a run's output is what it is. */
export interface GateRun {
  id: string
  gateId: string
  projectId: string
  /** The task the run was for, when it was for one. */
  taskId?: string
  /** The outcome. */
  outcome: GateOutcome
  /** The process's exit code, when it exited on its own. */
  exitCode?: number
  /** The signal that killed it, when it was killed. */
  signal?: string
  /** The captured output, capped and possibly truncated. */
  output: string
  /** True when the output hit the cap and was cut. */
  truncated: boolean
  /** A digest of the output, so a run can be compared without its body. */
  outputDigest: string
  /** The worktree HEAD at the time of the run. */
  head: string
  /** The hashes of the files in the gate's scope, at the time of the run. */
  scopeHash: string
  /** The gate's configuration revision at the time of the run. */
  configRevision: number
  /** When it started. */
  startedAt: number
  /** When it finished. */
  finishedAt: number
  /** How long it took. */
  durationMs: number
}

/** The limits a gate run is held to. */
export const LIMITS = {
  /** The default timeout. */
  defaultTimeoutMs: 120_000,
  /** The longest a gate may run. */
  maxTimeoutMs: 600_000,
  /** The default output cap. */
  defaultOutputCapBytes: 256 * 1024,
  /** The largest output that may be captured. */
  maxOutputCapBytes: 4 * 1024 * 1024,
} as const

/**
 * The gate kinds a project can be *detected* to have.
 *
 * Detection is how a project learns which gates are available without
 * running anything. This is the plan's "defaults perform detection only".
 */
export interface DetectedGate {
  /** The suggested gate id. */
  id: string
  kind: GateKind
  description: string
  /** The executable and arguments that would be run. */
  executable: string
  args: string[]
  /** Why it was suggested. */
  reason: string
  /** True when the executable exists and could actually run. */
  runnable: boolean
}

/**
 * Is this gate allowed to run?
 *
 * The checks are ordered so the most fundamental failure is reported first:
 * a retired gate is retired whatever else is true of it.
 */
export function canRun(gate: Gate): { ok: true } | { ok: false; reason: string; message: string } {
  if (gate.state === "retired") {
    return {
      ok: false,
      reason: "retired",
      message: `The gate ${gate.id} is retired and no longer runs.`,
    }
  }
  if (gate.state !== "approved") {
    return {
      ok: false,
      reason: "not_approved",
      message: `The gate ${gate.id} has not been approved, so it does not run.`,
    }
  }
  if (!gate.approvedBy) {
    return {
      ok: false,
      reason: "not_approved",
      message: `The gate ${gate.id} has no approver recorded.`,
    }
  }
  return { ok: true }
}

/**
 * The argv a gate will run, as a display string.
 *
 * This is for **display only** — it is never executed. The runner uses the
 * argv array directly.
 */
export function describeArgv(gate: Gate): string {
  return [gate.executable, ...gate.args].join(" ")
}

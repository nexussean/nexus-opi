import {
  canRun,
  detectGates,
  evaluateTask,
  runGate,
  scopeHash,
  type DetectedGate,
  type Gate,
  type GateRun,
} from "@opi/core"

/**
 * The verification service.
 *
 * It is the only thing that may execute a command, and it does so through
 * the store's approved gates. The model-facing tool is a thin shell over
 * this; every decision that matters — whether a gate may run, whether the
 * evidence is still valid, what a task's verification state is — is made
 * here or in the core.
 */

export interface VerificationServiceOptions {
  /** The gates registered for the project. */
  gates: () => Gate[]
  /** The runs of a gate. */
  runs: (gateId: string) => GateRun[]
  /** Record a run. */
  recordRun: (run: GateRun) => void
  /** The project root. */
  root: () => string
  /** The worktree's current HEAD. */
  head: () => string
  /** Is execution permitted at all? */
  executionAllowed: () => boolean
  /** The gates registered for the project, by id. */
  gate: (id: string) => Gate | undefined
}

export interface RunRequest {
  gateId: string
  taskId?: string
  signal?: AbortSignal
  onOutput?: (chunk: string) => void
}

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; message: string; required?: string }

/**
 * Run a gate.
 *
 * The gate id is the **only** input. There is no parameter through which a
 * command can be supplied, and the service does not accept one: T-06 is
 * satisfied by the shape of the API, not by a validation rule.
 */
export async function run(
  options: VerificationServiceOptions,
  request: RunRequest,
): Promise<ServiceResult<GateRun>> {
  const gate = options.gate(request.gateId)
  if (!gate) {
    return {
      ok: false,
      reason: "not_found",
      message: `There is no gate named ${request.gateId}.`,
      required: "List the gates first.",
    }
  }

  const permission = canRun(gate)
  if (!permission.ok) {
    return { ok: false, reason: permission.reason, message: permission.message }
  }

  // Execution is off by default. Detection is not.
  if (!options.executionAllowed()) {
    return {
      ok: false,
      reason: "execution_disabled",
      message:
        "Check execution is turned off for this project, so gates are detected but not run.",
      required: "Turn on the verification.execution feature flag to run gates.",
    }
  }

  const root = options.root()
  const result = await runGate({
    gate,
    root,
    ...(request.taskId ? { taskId: request.taskId } : {}),
    head: options.head(),
    scopeHash: scopeHash(root, gate.scope),
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.onOutput ? { onOutput: request.onOutput } : {}),
  })

  if (result.refusal) {
    return {
      ok: false,
      reason: result.refusal.reason,
      message: result.refusal.message,
    }
  }

  options.recordRun(result.run)
  return { ok: true, value: result.run }
}

/**
 * The gates a project *looks like* it has.
 *
 * This is detection: it reads the project's manifests and reports what could
 * be run. It never runs anything, and the result is a set of suggestions
 * that a human must approve before they become gates.
 */
export function detect(root: string): DetectedGate[] {
  return detectGates(root)
}

/**
 * The evidence summary for a task.
 *
 * This is what decides whether a task may reach `done`. It is derived from
 * the task's required gates and their runs, and it accounts for the code
 * having changed since a run.
 */
export function evaluate(
  options: VerificationServiceOptions,
  task: { id: string; type: string },
  allRuns: readonly GateRun[],
): ReturnType<typeof evaluateTask> {
  return evaluateTask({
    taskType: task.type,
    gates: options.gates(),
    runs: allRuns,
    root: options.root(),
    head: options.head(),
  })
}

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { Gate, GateOutcome, GateRun } from "./types.ts"
import { LIMITS, canRun } from "./types.ts"

/**
 * The bounded execution runner.
 *
 * Everything here is a security control, and each one exists because the
 * obvious alternative is an arbitrary-code-execution primitive:
 *
 * - The argv is **exact**. There is no shell, and no string is ever parsed
 *   into a command.
 * - The executable is **resolved before the run** and refused if it lives
 *   inside the project tree.
 * - The working directory is resolved and then **checked to be inside the
 *   project root** after symlinks are followed.
 * - The environment is **constructed**, not inherited, so a test that prints
 *   an environment variable cannot leak a token.
 * - The output is **capped**, and the **process group** is killed on a
 *   timeout or a cancellation.
 *
 * See [ADR-0023](../../docs/adr/0023-a-gate-is-a-reviewed-argv.md).
 */

export interface RunOptions {
  /** The gate to run. */
  gate: Gate
  /** The project root. The working directory must be inside it. */
  root: string
  /** The task the run is for. */
  taskId?: string
  /** The worktree HEAD, recorded on the run. */
  head: string
  /** The hash of the files in the gate's scope. */
  scopeHash: string
  /** Cancels the run. */
  signal?: AbortSignal
  /** Called with the output as it arrives, for a live view. */
  onOutput?: (chunk: string) => void
}

export interface RunResult {
  run: GateRun
  /** Why the run was refused, when it was. */
  refusal?: { reason: string; message: string }
}

/**
 * The environment a gate runs with.
 *
 * It is built from scratch, and **the user's environment is not inherited**.
 * That is the control that stops a test which prints `$SOME_TOKEN` from
 * writing a secret to a log.
 *
 * The one exception is the `PATH`, and it is a deliberate one. A toolchain
 * lives wherever the toolchain lives — `npm` under nvm, `go` under a version
 * manager — and a gate that cannot find the tool it runs is useless. The
 * `PATH` is a list of directory names, not a secret, and a directory on it
 * does not hand a gate the contents of the user's environment.
 *
 * `HOME` points inside the project, so a tool that writes to it does not
 * touch the user's home directory.
 */
export function buildEnvironment(root: string): Record<string, string> {
  const inherited = process.env.PATH ?? ""
  const pathEntries = [
    ...inherited.split(":").filter(Boolean),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    join(root, "node_modules", ".bin"),
  ]
  return {
    PATH: pathEntries.join(":"),
    HOME: join(root, ".opencode", "tmp"),
    TMPDIR: join(root, ".opencode", "tmp"),
    LANG: "C",
    LC_ALL: "C",
    // The gate's own identity, so a run is attributable in its output.
    OPI_GATE: "",
  }
}

/**
 * Is this path inside the root, after symlinks are resolved?
 *
 * The check is on the **resolved** path, so a symlink that points outside
 * the root is caught even though the path itself looks contained.
 */
export function isInside(root: string, candidate: string): boolean {
  const realRoot = safeRealpath(resolve(root))
  // A path that does not exist yet cannot be checked by resolving it, so the
  // nearest existing ancestor is resolved instead. A file inside the root
  // that has not been created yet is still inside the root.
  const realCandidate = safeRealpath(resolve(candidate)) ?? resolveExistingAncestor(resolve(candidate))
  if (!realRoot || !realCandidate) return false
  if (realCandidate === realRoot) return true
  return realCandidate.startsWith(realRoot + sep)
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/**
 * The real path of the nearest ancestor that exists.
 *
 * A path that does not exist cannot be resolved, and the check must still be
 * able to say where it *would* be. The deepest existing ancestor is resolved
 * and the missing tail is appended, so the comparison stays honest.
 */
function resolveExistingAncestor(path: string): string | undefined {
  let current = path
  const tail: string[] = []
  for (;;) {
    const parent = dirname(current)
    if (parent === current) return undefined
    const resolved = safeRealpath(parent)
    if (resolved) return join(resolved, ...tail.reverse())
    tail.unshift(basename(current))
    current = parent
  }
}

/**
 * Resolve the executable to an absolute path, or refuse.
 *
 * A bare name is looked up in `PATH` and in the project's `node_modules/.bin`.
 * An absolute path is used as given.
 *
 * In both cases the resolved path must be **outside the project tree**. A
 * repository can ship an executable called `go`, and running it would be
 * running the repository's code as if it were a trusted tool. A gate runs a
 * *system* tool, never one the project supplied.
 */
export function resolveExecutable(
  executable: string,
  root: string,
  env: Record<string, string>,
): { ok: true; path: string } | { ok: false; reason: string; message: string } {
  if (executable.includes("\u0000")) {
    return {
      ok: false,
      reason: "invalid_executable",
      message: "An executable cannot contain a null byte.",
    }
  }
  if (executable.includes("/") || executable.includes("\\")) {
    const absolute = isAbsolute(executable) ? executable : resolve(root, executable)
    if (isInside(root, absolute)) {
      return {
        ok: false,
        reason: "executable_untrusted",
        message:
          "The executable must be outside the project. A repository must not supply the tool a gate runs.",
      }
    }
    try {
      if (!statSync(absolute).isFile()) {
        return {
          ok: false,
          reason: "executable_not_found",
          message: `The executable ${executable} is not a file.`,
        }
      }
    } catch {
      return {
        ok: false,
        reason: "executable_not_found",
        message: `The executable ${executable} was not found.`,
      }
    }
    return { ok: true, path: absolute }
  }

  const searchPath = (env.PATH ?? "").split(":").filter(Boolean)
  for (const directory of searchPath) {
    const candidate = join(directory, executable)
    try {
      if (!statSync(candidate).isFile()) continue
    } catch {
      continue
    }
    if (isInside(root, candidate)) {
      // A repository shipping its own `go` must not be able to stand in for
      // the real one. The match is **skipped**, not fatal: the search
      // continues, so a real system tool further down the PATH is still
      // found. Refusing outright would make a gate unrunnable on a project
      // that happens to have a `node_modules/.bin/go`.
      continue
    }
    return { ok: true, path: candidate }
  }
  // Nothing outside the project was found. If a project-local copy exists,
  // the reason is worth saying, because it is the likely cause.
  const local = searchPath
    .map((directory) => join(directory, executable))
    .find((candidate) => {
      try {
        return statSync(candidate).isFile()
      } catch {
        return false
      }
    })
  if (local) {
    return {
      ok: false,
      reason: "executable_untrusted",
      message: `The executable ${executable} resolves inside the project. A repository must not supply the tool a gate runs.`,
    }
  }
  return {
    ok: false,
    reason: "executable_not_found",
    message: `The executable ${executable} was not found.`,
  }
}

/**
 * Run a gate.
 *
 * The run is bounded in every dimension: time, output, and the process tree.
 */
export async function runGate(options: RunOptions): Promise<RunResult> {
  const { gate, root } = options
  const startedAt = Date.now()

  const permission = canRun(gate)
  if (!permission.ok) {
    return {
      run: emptyRun(gate, options, "error", startedAt),
      refusal: { reason: permission.reason, message: permission.message },
    }
  }

  const env = buildEnvironment(root)
  env.OPI_GATE = gate.id

  const resolved = resolveExecutable(gate.executable, root, env)
  if (!resolved.ok) {
    return {
      run: emptyRun(gate, options, "error", startedAt),
      refusal: { reason: resolved.reason, message: resolved.message },
    }
  }

  // The working directory must resolve inside the project.
  const cwd = resolve(root, gate.cwd)
  if (!isInside(root, cwd)) {
    return {
      run: emptyRun(gate, options, "error", startedAt),
      refusal: {
        reason: "cwd_outside_root",
        message: "The gate's working directory must be inside the project.",
      },
    }
  }
  if (!existsSync(cwd)) {
    return {
      run: emptyRun(gate, options, "error", startedAt),
      refusal: { reason: "cwd_not_found", message: "The gate's working directory does not exist." },
    }
  }

  const timeoutMs = Math.min(LIMITS.maxTimeoutMs, Math.max(1_000, gate.timeoutMs))
  const capBytes = Math.min(LIMITS.maxOutputCapBytes, Math.max(1_024, gate.outputCapBytes))

  const outcome = await execute({
    executable: resolved.path,
    args: gate.args,
    cwd,
    env,
    timeoutMs,
    capBytes,
    signal: options.signal,
    onOutput: options.onOutput,
  })

  const finishedAt = Date.now()
  const run: GateRun = {
    id: crypto.randomUUID(),
    gateId: gate.id,
    projectId: gate.projectId,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    outcome: outcome.outcome,
    ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
    ...(outcome.signal ? { signal: outcome.signal } : {}),
    output: outcome.output,
    truncated: outcome.truncated,
    outputDigest: digest(outcome.output),
    head: options.head,
    scopeHash: options.scopeHash,
    configRevision: gate.configRevision,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
  }
  return { run }
}

/** A digest of the output, so runs can be compared without their bodies. */
export function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

interface ExecuteOptions {
  executable: string
  args: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  capBytes: number
  signal?: AbortSignal
  onOutput?: (chunk: string) => void
}

interface ExecuteOutcome {
  outcome: GateOutcome
  output: string
  truncated: boolean
  exitCode?: number
  signal?: string
}

/**
 * Spawn the process, bounded.
 *
 * The child is spawned **detached**, so it leads its own process group. That
 * is what makes it possible to kill the whole tree: a test that starts a
 * server would otherwise leave the server running.
 */
function execute(options: ExecuteOptions): Promise<ExecuteOutcome> {
  return new Promise((resolve) => {
    let output = ""
    let bytes = 0
    let truncated = false
    let settled = false

    const child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      // Its own process group, so the whole tree can be killed.
      detached: true,
      // No shell, ever. The argv is exact.
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const finish = (outcome: GateOutcome, exitCode?: number, signal?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (options.signal) options.signal.removeEventListener("abort", onAbort)
      resolve({ outcome, output, truncated, ...(exitCode !== undefined ? { exitCode } : {}), ...(signal ? { signal } : {}) })
    }

    /** Kill the whole process group, not just the direct child. */
    const killTree = (): void => {
      try {
        if (child.pid !== undefined) {
          // The negative pid is the process *group*.
          process.kill(-child.pid, "SIGKILL")
        }
      } catch {
        // The group may already be gone, or the child may never have
        // started. Either way there is nothing left to kill.
      }
      try {
        child.kill("SIGKILL")
      } catch {
        // Already dead.
      }
    }

    const timer = setTimeout(() => {
      killTree()
      finish("timeout")
    }, options.timeoutMs)
    if (typeof timer === "object" && "unref" in timer) timer.unref()

    const onAbort = (): void => {
      killTree()
      finish("cancelled")
    }
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener("abort", onAbort, { once: true })
    }

    const collect = (chunk: Buffer): void => {
      if (truncated) return
      const text = chunk.toString("utf8")
      if (bytes + chunk.length > options.capBytes) {
        const room = Math.max(0, options.capBytes - bytes)
        output += chunk.subarray(0, room).toString("utf8")
        bytes += room
        truncated = true
        options.onOutput?.("\n[output truncated at the cap]\n")
        return
      }
      output += text
      bytes += chunk.length
      options.onOutput?.(text)
    }

    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)

    child.on("error", (error) => {
      finish("error", undefined, (error as NodeJS.ErrnoException).code)
    })

    child.on("close", (code, signal) => {
      // A `close` after we killed the process is the *expected* end of a
      // timeout or a cancellation. `finish` is a no-op after the first
      // outcome is recorded, so this only matters when the process died on
      // its own — for example, killed by an out-of-memory abort.
      if (signal) {
        finish("error", code ?? undefined, signal)
        return
      }
      finish(code === 0 ? "passed" : "failed", code ?? undefined)
    })
  })
}

/** A run record for a run that never started. */
function emptyRun(
  gate: Gate,
  options: RunOptions,
  outcome: GateOutcome,
  startedAt: number,
): GateRun {
  return {
    id: crypto.randomUUID(),
    gateId: gate.id,
    projectId: gate.projectId,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    outcome,
    output: "",
    truncated: false,
    outputDigest: digest(""),
    head: options.head,
    scopeHash: options.scopeHash,
    configRevision: gate.configRevision,
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
  }
}

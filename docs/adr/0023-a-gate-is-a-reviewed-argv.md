# ADR-0023: A gate is a reviewed argv, and only an approved gate can run

**Status:** Accepted
**Date:** 2026-10-20
**Affects:** OPI-033, OPI-034, OPI-035, OPI-036, OPI-037, OPI-038, T-05, T-06, T-07, T-08
**Related:** [ADR-0022](0022-done-is-unverified-when-no-gates-are-configured.md)

## Context

The verification service is the first part of OPI that **executes anything**. Every other
subsystem reads data the repository already contains. This one runs programs.

The plan's requirement is precise:

> `pi_verify.run(gate_id)` validates command registration, asks appropriate permission,
> executes and records start/stop, output digest, result status, worktree HEAD/dirty-file
> fingerprint and config revision.

And the security doc's controls are unambiguous:

> **Execution:** never automatically run build scripts discovered in `package.json`/Makefile/Cargo
> as trusted. Propose commands for review and allowlist exact executable/argv or a clearly
> reviewed command template.
>
> **Process control:** use spawn with explicit argv/cwd, avoid shell string interpolation, set
> timeout and output caps, terminate process group, no user supplied remote URLs executed.
> Commands may have side effects; warn user and support dry-run.

The threat model adds two test requirements:

- **T-06:** "A `pi_verify.run` call with free-form command text — it is refused; only a
  registered `gate_id` executes."
- **T-05:** "A repo whose README and source comments contain instructions to run commands and
  mark tasks done — no command runs; no task transitions; the content is stored as data."

The dangerous design — and the one that is easiest to build by accident — is "let the model
pass a command string". It is convenient, and it turns every model inference into an
arbitrary-code-execution primitive. The plan's own risk list and the whole of doc 06 exist
to prevent it.

## Decision

### A gate is a registered, reviewed argv

A gate is a **row**, not a string. It has:

| Field | Why |
|---|---|
| `id` | The only thing `pi_verify.run` accepts. |
| `executable` | An exact program path or name. Never a shell, never a string to be parsed. |
| `args` | An exact argv array. Never a shell string. |
| `cwd` | A directory **under the project root**, or the root itself. |
| `timeoutMs` | A hard bound. |
| `outputCapBytes` | A hard bound on captured output. |
| `requiredForTypes` | Which task types this gate is required for. |
| `risk` | A label: `safe`, `side_effecting`, `destructive`. |
| `approvedBy` / `approvedAt` | Who approved it and when. A gate with no approval does not run. |
| `configRevision` | Bumped when the gate's definition changes. |

### The approval boundary is the product, not the model

- **The model may propose a gate.** It may not approve one, and it may not run an
  unapproved one.
- **A gate runs only if it is approved.** `propose` creates a gate in the `proposed` state.
  `approve` moves it to `approved` and records who did it.
- **`pi_verify.run` takes a `gate_id` and nothing else.** There is no parameter through
  which a command can be supplied. T-06 is satisfied structurally, not by validation: the
  capability to run an arbitrary string does not exist in the API.

### The command is never built from a shell

- **`spawn` with an explicit argv array.** No `sh -c`, no `cmd.exe /c`, no string
  interpolation anywhere in the path from a tool call to a process.
- **No `PATH` lookup for a relative name.** The executable is either an absolute path or a
  bare name resolved against a fixed, known list of directories — a bare name that resolves
  to a file inside the repository is refused.
- **The executable must exist and be a regular file** before the run starts, and it must not
  be inside the project tree unless the project has explicitly trusted it.

### The working directory cannot escape

- The `cwd` is resolved and then **checked to be inside the project root** after resolving
  symlinks. A `cwd` that escapes is refused, not clamped.
- A symlink whose target leaves the root is refused.

### The environment is not the user's environment

A gate runs with a **constructed** environment: a `HOME` inside the project so a tool that
writes to it does not touch the user's home, and the locale variables so output is
predictable.

The user's environment — which may hold tokens — is **not** inherited. This is the single
control that stops "a test that prints an environment variable" from becoming a credential
leak into a log.

**The one exception is the `PATH`**, and it was added because the first implementation made
every real gate unrunnable. A toolchain lives wherever the toolchain lives — `npm` under
nvm, `go` under a version manager — and a fixed `PATH` could not find any of them. A `PATH`
is a list of directory names, not a secret, and a directory on it does not hand a gate the
contents of the user's environment. Everything *else* is still not inherited.

### The approval boundary is a separate surface

The model can **propose** a gate. It cannot **approve** one, and there is no tool through
which it could. Approval happens through the CLI (`packages/cli`), which is a human's
surface. This is not a policy the model could decline to follow — it is a capability the
model does not have.

### Output is bounded, and the process group is killed

- Output is captured to a byte cap. Past the cap it is **truncated and marked**, not
  buffered without limit.
- A timeout terminates the **process group**, not just the direct child, so a test that
  spawns a server does not leave it running. T-08.
- A cancellation is the same path as a timeout, and leaves the task unverified.

### Evidence is tied to a revision

A run records the worktree's **HEAD** and the **hash of the files that matter**. A later
change to any of those files makes the run **stale**, and a stale run cannot complete a
task. T-07.

The "files that matter" are the gate's declared **scope** — usually a path prefix. A gate
scoped to `packages/core` is not invalidated by a change in `docs`.

**OPI's own `.opencode` directory is excluded from the scope hash.** A gate that writes a
task board, a run log or an index into the project would otherwise invalidate its own
evidence the moment it finished, and a run that can never be fresh can never complete a
task. This was found by running a real gate against a real project: the kanban plugin's
test suite writes `.opencode/kanban.json`, and the run it had just produced was immediately
stale.

### Detection is the default; execution is opt-in

`verification.execution` **defaults to off**. With the flag off:

- Gates can be proposed, listed and approved.
- `pi_verify.run` **refuses**, with a reason.
- Gates that can be detected — "this project has a `package.json` with a `test` script" —
  are reported as *available*, not run.

This is the plan's "defaults perform **detection only**, not execution".

## Consequences

**Good.**

- The model cannot execute anything. It can ask for a gate to be approved; a human decides.
  This is the difference between a tool that runs `bun test` and a tool that runs whatever
  the model felt like.
- A hostile repository cannot cause an execution. T-05 holds because README content is
  data: it is indexed, quoted in a context pack, and never interpreted as a command.
- Every run is attributable: which gate, whose approval, which revision, what output.
- A green run that is invalidated by a later edit cannot be used to complete a task. The
  board cannot go stale-green.

**Bad, and accepted.**

- The first run of any gate needs a human. This is friction, and it is the point.
- The environment is not the user's, so a gate that needs a tool from the user's shell
  profile will not find it. A gate is a *reproducible* command; that is a feature, but it
  will surprise someone. (The `PATH` is the one thing that is inherited, precisely so that
  a toolchain under a version manager is reachable.)
- Only `spawn`-able programs can be gates. A gate that needs a shell pipeline must be
  written as a script and registered as that script — which is a reviewable file, and is
  the safer shape anyway.
- A project-local copy of a tool is **skipped** rather than fatal, so a real system tool
  further down the `PATH` is still found. The refusal only happens when the *only* match
  is inside the project.

**What this does not decide.**

- Whether a *human* approving a gate is enough authority, or whether the approval should
  expire, or be scoped to a single run. The plan's `verification_runs` table has a
  "config revision", which implies the gate's definition can change under a run; this ADR
  uses that to invalidate evidence, but does not decide the approval's lifetime.
- Whether a destructive gate (`risk: destructive`) needs a second approval. It is labelled
  and reported today; requiring two approvals is a policy the owner can add.

## Alternatives rejected

| Alternative | Why not |
|---|---|
| `pi_verify.run(command: string)` | The model becomes an arbitrary-code-execution primitive. T-06 forbids it outright. |
| `pi_verify.run(gate_id, override_args: string[])` | The override is the arbitrary command. An override that can add a flag can add `--exec`. |
| A shell with the user's full environment | A test that prints `$SECRET_TOKEN` writes it to a log on disk. |
| Approving a gate from the model | Then the model approves itself, and the approval means nothing. |
| Running a gate the moment a file changes | The plan says detection only by default, and a build script discovered in `package.json` is never trusted without review. |
| Invalidating every run when any file changes | Too blunt: a change in `docs` would invalidate a test run for `packages/core`, and people would stop trusting the state. |

# Reconciliation of the October 20 architecture guide

## Recommendation

Preserve OPI's intelligence, task store, verification, memory, and adapter boundaries.
Add execution governance around them in small increments. The guide's direction fits;
its proposed lifecycle and package tree should not be copied literally.

The first implementation increment is measurement integrity: the read oracle already
exists, but regression tests exposed false positives. That increment is implemented
in this pass. A reliable benchmark is necessary to judge the claimed efficiency of
future delegation, but does not itself authorize or prove safe execution.

## Capability map

“Present” means code and tests exist, not that every integration or security gate passes.
“Partial” identifies the exact missing boundary. Paths below are implementation evidence.

| Guide capability | Current evidence | Decision and remaining gap |
|---|---|---|
| Project/worktree identity | [resolver](../../packages/core/src/project/resolve.ts), [registry](../../packages/db/src/registry.ts) | Present. Reuse identity; prove concurrent event and session isolation before delegation. |
| Persistent Kanban/task DAG | [task store](../../packages/db/src/tasks.ts), [DAG](../../packages/core/src/task/dag.ts), [state machine](../../packages/core/src/task/machine.ts) | Present with revision checks and transactional audit events. Preserve it as the authoritative task system. |
| Code and symbol graph | [graph](../../packages/retrieval/src/graph.ts), [persistent index](../../packages/retrieval/src/persistent.ts) | Present, with confidence/completeness limits. Use graph output to suggest scopes, never as proof of disjoint writes. |
| Task context packages | [context](../../packages/retrieval/src/context.ts) | Budgeted evidence packs exist. Add task/plan binding, source hashes, scope, and invalidation before dispatch. |
| Evidence-backed memory | [memory types](../../packages/core/src/memory/types.ts), [memory store](../../packages/db/src/memory.ts) | Present: proposals, provenance, confirmation, staleness, tombstones. Automatic skill promotion remains deferred. |
| Handoffs and journals | [task events](../../packages/core/src/task/types.ts), [handoffs](../../packages/core/src/memory/handoff.ts) | Partial: mutation history and bounded handoffs exist; per-execution checkpoints and attributed worker outcomes do not. |
| Ownership and atomic claims | [task model](../../packages/core/src/task/types.ts), [job queue](../../packages/db/src/queue.ts) | Task owner/execution lease absent. Queue leases are indexing-job primitives; they are not agent claims. |
| Versioned plans and approvals | [gate approvals](../../packages/db/src/verification.ts) | Gate config revisions exist; plan revisions, scoped execution grants, and revocation do not. |
| Verification completion | [completion](../../packages/core/src/verify/completion.ts), [runner](../../packages/core/src/verify/runner.ts) | Present. Preserve ADR-0022 and ADR-0023; do not equate a session ending with a task passing. |
| Permissions and budgets | [flags](../../packages/core/src/flags/index.ts), reviewed gate runner | Partial: execution opt-in and bounded checks exist. Missing agent admission policy, budget reservations, model allowlists, and trusted approval identity. |
| Agent registry/session mapping | OpenCode integration exists in [adapter](../../packages/adapter-opencode/src/index.ts) | Not implemented as an OPI execution service. Add a runtime port and version-tested adapter, not a second agent runtime. |
| Wakes/watchdogs/recovery | [worker](../../packages/core/src/queue/worker.ts), queue lease expiry | Partial infrastructure only. Add reconciliation and fencing before retrying agent work; no unattended LLM polling. |
| Isolated workers/integration queue | Git identity resolution only | Deferred until single-writer execution, cancellation, and recovery are proven. A worktree is not a sandbox. |
| Dashboard | [RPC](../../packages/adapter-opencode/src/rpc-handlers.ts), [loopback server](../../packages/adapter-opencode/src/web/server.ts) | Overview/board/memory/quality reads exist. Agent execution views and revision-safe Kanban mutations are not complete. |
| Benchmark outcome checks | [oracle](../../packages/bench/harness/oracle.ts), [harness](../../packages/bench/harness/run.ts) | Read-task lexical oracle exists and is hardened in this pass. Write-state validation and full semantic grading remain absent. |

## Conflicts to resolve explicitly

### Task progress, execution outcome, and verification are different axes

Current task states are `backlog`, `ready`, `in_progress`, `review`, `done`, `archived`.
Verification is separately `not_configured`, `not_run`, `passed`, `failed`, `stale`, or
`waived`. The guide's `Running` maps to `in_progress`; `Verified` does not replace `done`.
ADR-0022 permits `done/not_configured`, honestly labelled unverified. A waiver is also
not a passing check, even when it permits completion.

Dependency blocking is derived from `blocks` edges, not a new task column. Add structured
execution blockers for approvals, resource shortages, or human input. Failed/cancelled
attempts preserve the task and history. Do not add every attempt as a board card.

The existing DAG treats `done` and `archived` as terminal. The future scheduler must
not infer that an archived dependency produced a usable artifact or that an unverified
`done` task satisfies a verified dependency contract. Keep current board behavior;
add an explicit execution-admission check, including a separately authorized bypass
when a dependency has been intentionally abandoned.

### A lease without fencing is not worker ownership

`JobQueue.complete(id)` and `renewLease(id)` take a job ID, without a claimant token.
A previous worker can therefore still address a job after its lease expires. This is
an API limitation for reuse as an agent scheduler, not proof of a production incident.
Do not expose the current queue as the agent claim service. Require execution IDs,
monotonic fencing tokens, conditional updates, and process reconciliation.

Lease expiry alone does not prove an old writer stopped. It must not launch a second
writer against the same workspace. Fencing protects cooperative database mutations;
it cannot undo a shell command or revoke arbitrary filesystem access.

### Attribution is not authenticated approval

The adapter accepts waiver actor/reason/scope strings from tool input. Those strings
provide attribution, not proof that a human approved the action. Keep the distinction
visible; before autonomous execution, add trusted approval records and require their
IDs at the mutation boundary. Test forged actors, stale grants, and cross-project use.
Do not claim an agent-filled `actor` field is execution governance.

### Preserve the package boundaries already built

Keep `contracts`, `core`, `db`, `retrieval`, `adapter-opencode`, `cli`, `bench`, and
`compat-spike`. The dashboard is already an adapter surface; duplicating it into a new
package is not a prerequisite. Add modules inside `core` for planning, execution, and
policy as needed, and storage beside existing migrations in `db`. Add a coordinator
package only when there is a concrete host/lifecycle requirement. Do not rename `db`
to `storage-sqlite` or invent a second `plugin` package as roadmap work.

### Assisted mode needs recovery before F4

Even a read-only worker consumes money and may leave a live session after disconnect.
F3 must include durable dispatch IDs, stop handling, and uncertain-session reconciliation.
F4 extends that contract to writing worktrees and integration; it does not introduce
recovery for the first time. “Read-only” requires denied write/shell/side-effect
capabilities or a suitably isolated snapshot, not a role prompt.

## Scope decisions

Adopt for design: one authoritative board; task/attempt separation; accountable owner;
fenced claims; version-bound plans and approval grants; bounded context; execution
observability; reserved admission budgets; event wakes; deterministic verification;
one-writer assisted mode; recovery before retry. These become Proposed ADRs 0028–0031,
with implementation tickets and tests rather than implied completion.

Defer: multiple autonomous writers, integration queue, adaptive decomposition/routing,
scheduled project reviews, reusable skill activation, persistent coordinator, remote
notifications, and external orchestrator adapters. Single-agent use remains valuable
without these features or any paid model.

Exclude: a second board store, replacement runtime/Git, mandatory corporate agent
hierarchy, cloud dependency, unrestricted recursive delegation, raw-conversation memory,
default autonomous deploy/merge, LLM health polling, and invented progress percentages.

## Measurement boundary

`opi` versus `none-opi` measures product availability over equivalent seeded SQLite
boards. It does not isolate schema shape. Compare alternate schemas only through the
same task service, capabilities, prompts, and validated outcomes. Preserve per-model
and per-task outcomes, failures, invalid runs, and total measured attempt spend.

The read oracle checks declared lexical facts, not arbitrary natural-language truth.
This pass rejects misleading numeric/key prefixes, unrelated counts, contradictory
recognized counts/priorities, and facts borrowed from adjacent card records. Unknown
prose, negation, final-message extraction, and seed snapshot/versioning still require
explicit coverage before calling it a complete oracle. Write tasks remain ungradable.

## Phase gates

| Gate | Reconciled scope | Exit condition |
|---|---|---|
| F0 | Preserve working foundation; close compatibility, isolation, and measurement gaps | Supported runtime probes and named security tests pass; benchmark outcomes are interpretable. |
| F1 | Add owner, attempts, checkpoints, immutable plan revisions | Migrations preserve old rows/history; restarts, stale writes, and invalid transitions are tested. |
| F2 | Runtime capability inventory, trusted grants, budgets, admission | No session starts without valid scope/authority/reservation; forged grants and unsupported runtimes fail closed. |
| F3 | Opt-in read-only helpers, one existing primary writer, context and recovery | No helper writes; duplicate wakes and crashes do not duplicate dispatch; cost includes all helpers/retries. |
| F4 | Managed single writing worker in an isolated worktree | Cancel/crash/recovery and reviewed integration pass against exact commits. |
| F5 | Multiple writing workers and serialized integration | Reservations, conflicts, stale bases, and target-branch regressions are tested. |
| F6 | Adaptive routing/context improvements | Quality, elapsed time, or total cost improves against an equivalent validated baseline. |
| F7 | Optional persistent local coordinator | Authorized work survives host restarts and remains stoppable; no unconfigured unattended work. |

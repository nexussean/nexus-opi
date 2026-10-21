# Dependency-ordered implementation issues

Local issue drafts, reconciled 2026-10-20. IDs `OPI-Nxx` avoid colliding with the historical OPI tickets. This catalog is not a second runtime board or a set of published tracker issues. Implemented means the bounded change in that issue landed locally; it does not close the whole phase. New execution features depend on acceptance of ADRs 0028–0031.

The table is topologically ordered. Items without mutual dependencies can be developed independently; that does not authorize autonomous parallel workers. Machine-readable issue bodies and acceptance criteria are in [implementation-backlog.json](implementation-backlog.json).

| Issue | Phase | Status | Depends on | Work |
|---|---|---|---|---|
| [OPI-N01](#opi-n01) | F0 | implemented | — | Harden the existing read oracle and outcome accounting |
| [OPI-N02](#opi-n02) | F0 | partial | OPI-N01 | Finish outcome validation and freeze comparable experiments |
| [OPI-N03](#opi-n03) | F0 | open | OPI-N01 | Close the named security coverage gaps |
| [OPI-N04](#opi-n04) | F0 | open | — | Probe and pin runtime execution capabilities |
| [OPI-N05](#opi-n05) | F1 | open | OPI-N03 | Add accountable ownership and durable execution attempts |
| [OPI-N06](#opi-n06) | F1 | open | OPI-N05 | Persist immutable plan revisions |
| [OPI-N07](#opi-n07) | F1 | open | OPI-N05 | Implement fenced claims and writer-slot reservations |
| [OPI-N08](#opi-n08) | F2 | open | OPI-N06, OPI-N03 | Add trusted, scoped, revocable approval grants |
| [OPI-N09](#opi-n09) | F2 | open | OPI-N05 | Reserve and reconcile execution budgets |
| [OPI-N10](#opi-n10) | F2 | open | OPI-N04, OPI-N05 | Implement the native runtime adapter port |
| [OPI-N11](#opi-n11) | F2 | open | OPI-N07, OPI-N08, OPI-N09, OPI-N10 | Compose transactional execution admission |
| [OPI-N12](#opi-n12) | F3 | open | OPI-N11 | Reconcile dispatch, cancellation and expired workers |
| [OPI-N13](#opi-n13) | F3 | open | OPI-N06 | Bind bounded context packages to tasks and source revisions |
| [OPI-N14](#opi-n14) | F3 | open | OPI-N12, OPI-N13, OPI-N03 | Enable opt-in read-only research/review helpers |
| [OPI-N15](#opi-n15) | F3 | open | OPI-N05, OPI-N09, OPI-N12 | Expose execution state through existing RPC/dashboard |
| [OPI-N16](#opi-n16) | F3 | open | OPI-N02, OPI-N14, OPI-N15 | Validate assisted mode against a single-agent baseline |
| [OPI-N17](#opi-n17) | F4 | deferred | OPI-N16 | Add one managed writing worker and reviewed integration |
| [OPI-N18](#opi-n18) | F5 | deferred | OPI-N17 | Enable bounded concurrent writers and integration queue |
| [OPI-N19](#opi-n19) | F6 | deferred | OPI-N16 | Evaluate adaptive routing and reusable workflows |
| [OPI-N20](#opi-n20) | F7 | deferred | OPI-N16, OPI-N17 | Add optional persistent local coordinator |

## Delivery order

Complete the remaining F0 evidence gates before declaring the foundation ready. F1 schema/plan work may proceed without a live runtime. F2 enables no sessions until grants, budget reservations, claims and capability probes are composed. F3 includes cancellation/recovery from its first helper; do not defer that to F4. F4–F7 remain disabled future increments.

## OPI-N01

**Harden the existing read oracle and outcome accounting** — F0; implemented. Dependencies: none.

Keep the current read tasks; reject key/value substring false positives and unrelated counts. Include all attempts in success rate and spend, retain all-invalid cells in task-level outcome reports, and version the oracle.

Acceptance:

- Negative cases reproduce the old false positives and pass after the fix.
- Expected fixture facts match the actual SQLite seed.
- One pass, one wrong answer, and one timeout produce 1/3 attempt success and total attempt spend divided by one success; zero successes produce null cost/success.

Implementation locations: `packages/bench/harness/oracle.ts`, `packages/bench/harness/run.ts`, `packages/bench/test/oracle.test.ts`, `packages/bench/test/harness.test.ts`.

## OPI-N02

**Finish outcome validation and freeze comparable experiments** — F0; partial. Dependencies: OPI-N01.

Strengthen final-message extraction using captured versioned event fixtures; classify ambiguous prose instead of accepting keyword presence. Snapshot expectations from the authoritative seeded store before execution. Add write oracles, then run a small matched read pair before a large matrix.

Implemented increment: structured read snapshots, final-message extraction, four SQLite write contracts, retained evidence and incomplete-usage accounting. See [outcome validation](../bench/outcome-validation.md). Remaining experiment and unsupported-write work is explicitly open.

Acceptance:

- Reasoning, earlier text, negated/contradictory statements, truncated messages, and multi-part finals cannot create a false pass.
- Write checks compare before/after state, revision and event history; a pre-existing target value cannot count as a mutation. Completion checks distinguish passed, waived and not_configured evidence.
- Report unknown/missing billing separately from zero; record runtime/source/prompt/oracle identities and interleave matched runs.
- Product availability and same-backend schema ablation are separate experiments; neither declares a winner without comparable success.

Implementation locations: `packages/bench/harness`, `packages/bench/test`, `scripts/seed-bench-board.ts`, `fixtures/bench/tasks`.

## OPI-N03

**Close the named security coverage gaps** — F0; open. Dependencies: OPI-N01.

Turn T-01, T-02, T-03, T-04, T-11, T-12, T-13 and T-14 into explicit adversarial integration tests and a coverage register. Preserve existing T-05 through T-10 checks; do not equate unit counts with runtime isolation.

Acceptance:

- Two live project locations cannot leak task, memory or event data, including model-supplied internal IDs.
- Omitted locations fail closed; event payload filtering happens before sensitive payload processing/persistence.
- Uninstall and invalid entrypoint behavior are verified; Code Mode audit truncation is explicit.

Implementation locations: `docs/security/threat-model-v2.md`, `packages/adapter-opencode/test`, `packages/core/test`.

## OPI-N04

**Probe and pin runtime execution capabilities** — F0; open. Dependencies: none.

Extend the existing V2 compatibility probe for agent/session creation, dispatch, cancellation, permission enforcement and reconnect. Verify the exact executable/package tuple; public SDK documentation alone is not acceptance evidence.

Acceptance:

- Capture runtime version and immutable build identity per probe/run; desktop updates cannot silently change a matrix.
- Exercise child sessions and project locations, cancellation, permission denial inside Code Mode, usage fields and duplicate dispatch semantics.
- Unsupported read-only enforcement or idempotency is recorded as unavailable and blocks the dependent mode.

Implementation locations: `packages/compat-spike`, `docs/compatibility/opencode-v2.md`.

## OPI-N05

**Add accountable ownership and durable execution attempts** — F1; open. Dependencies: OPI-N03.

Implement ADR-0028 additively in core/db. Keep tasks, attempts and verification separate; add structured blockers/checkpoints and owner assignment with revision checks.

Acceptance:

- Old database migration preserves tasks, public keys, events, revisions, memory and verification; repeat migration is safe.
- A task survives failed/cancelled attempts without duplicate board cards; cross-project attempt links fail.
- Execution success cannot mutate verification or bypass the task completion service.

Implementation locations: `packages/core/src/task`, `packages/core/src/execution (new)`, `packages/db/src/tasks.ts`, `packages/db/src/execution-migrations.ts (new)`.

## OPI-N06

**Persist immutable plan revisions** — F1; open. Dependencies: OPI-N05.

Add plan snapshots with objective, criteria, allowed scope, dependencies, content hash and revision history. Tasks reference revisions without replacing their existing acceptance text until a documented migration is adopted.

Acceptance:

- An approved revision cannot be edited in place.
- Scope changes create a new revision; attempts retain their original revision.
- Historical plans and task links survive restart and migration.

Implementation locations: `packages/core/src/planning (new)`, `packages/db/src/plans.ts (new)`.

## OPI-N07

**Implement fenced claims and writer-slot reservations** — F1; open. Dependencies: OPI-N05.

Implement ADR-0029 execution claims independently from index_jobs. Claim a primary execution and workspace writer slot transactionally; support separately bounded helper claims.

Acceptance:

- Competing database connections/processes cannot acquire two primary claims or two conflicting writer slots.
- Expired or superseded fencing tokens cannot renew, checkpoint, complete, release or fail the replacement execution.
- Lease expiry changes admission authority but does not automatically assert the previous process stopped.

Implementation locations: `packages/core/src/execution (new)`, `packages/db/src/executions.ts (new)`, `packages/db/test`.

## OPI-N08

**Add trusted, scoped, revocable approval grants** — F2; open. Dependencies: OPI-N06, OPI-N03.

Implement ADR-0030 grants through a trusted user/control path. Bind project, plan hash, operations, workspace/path scope and limits. Replace actor-string authority assumptions at autonomous waiver/dispatch boundaries.

Acceptance:

- An agent cannot approve by supplying a human name or replaying a grant from another project.
- Plan changes, expiry and revocation invalidate grants; work within an unchanged approved scope does not prompt again.
- Waivers remain visibly waived and retain trusted approval provenance.

Implementation locations: `packages/core/src/governance (new)`, `packages/db/src/approvals.ts (new)`, `packages/adapter-opencode/src/index.ts`.

## OPI-N09

**Reserve and reconcile execution budgets** — F2; open. Dependencies: OPI-N05.

Add transactional model/provider allowlists, concurrency and spending reservations. Track known, pending and unknown usage for helpers, retries and failed attempts.

Acceptance:

- Concurrent admissions cannot spend the same available reservation twice.
- Duplicate/late usage events are idempotent; missing usage stays unknown and does not release an uncertain reservation.
- Exhausted budgets deny new work; in-flight provider costs are explicitly not a guaranteed hard cap.

Implementation locations: `packages/core/src/governance (new)`, `packages/db/src/budgets.ts (new)`.

## OPI-N10

**Implement the native runtime adapter port** — F2; open. Dependencies: OPI-N04, OPI-N05.

Define adapter-neutral capabilities, dispatch, status, cancellation and usage interfaces. Implement them using the verified OpenCode V2 surface and persist project/session mapping.

Acceptance:

- Core imports no OpenCode types.
- A session and event map to one trusted project/worktree context before use.
- Unsupported capabilities fail closed; no fallback to another paid model or wider permission set.

Implementation locations: `packages/core/src/execution/runtime.ts (new)`, `packages/adapter-opencode/src/execution.ts (new)`.

## OPI-N11

**Compose transactional execution admission** — F2; open. Dependencies: OPI-N07, OPI-N08, OPI-N09, OPI-N10.

Compose readiness, scope, grants, claims and reservations into one admission operation plus durable dispatch intent. Distinguish board-terminal dependencies from satisfied execution prerequisites.

Acceptance:

- No runtime call occurs if any check fails.
- A failed admission leaves no orphan claim/reservation; an admitted intent survives restart.
- Archived or unverified dependencies cannot silently satisfy an artifact/verification requirement.
- Only explicitly activated modes run; recursive spawning is denied and limits include the primary.

Implementation locations: `packages/core/src/execution/admission.ts (new)`, `packages/db/src/executions.ts (new)`.

## OPI-N12

**Reconcile dispatch, cancellation and expired workers** — F3; open. Dependencies: OPI-N11.

Implement bounded event wakes and deterministic liveness checks with dispatch reconciliation. Recovery is required for read-only helpers too, before managed writing is introduced.

Acceptance:

- Crash before dispatch, after accepted dispatch but before acknowledgement, and after result/commit never blindly launches a duplicate.
- Pause/stop denies new admissions and cancels/reconciles existing sessions; ambiguous state becomes an operator-visible blocker.
- No LLM is called for liveness polling; unchanged deterministic failures are not retried in a loop.

Implementation locations: `packages/core/src/execution/recovery.ts (new)`, `packages/adapter-opencode/src/execution.ts (new)`.

## OPI-N13

**Bind bounded context packages to tasks and source revisions** — F3; open. Dependencies: OPI-N06.

Reuse retrieval and memory to assemble dispatch context with task/plan references, acceptance criteria, file hashes, provenance, scope and resource limits. Add delta handoffs and explicit freshness checks.

Acceptance:

- Changed source or plan invalidates the cached pack.
- Untrusted/stale memory cannot become an execution instruction or trusted constraint.
- Context stays within configured budget and includes omissions/uncertainty.

Implementation locations: `packages/retrieval/src/context.ts`, `packages/core/src/memory/handoff.ts`, `packages/core/src/execution/context.ts (new)`.

## OPI-N14

**Enable opt-in read-only research/review helpers** — F3; open. Dependencies: OPI-N12, OPI-N13, OPI-N03.

Implement assisted mode with at most three total agents including the primary and only the existing primary allowed to write. Helpers return attributed findings through the coordinator.

Acceptance:

- Helper edit, unrestricted shell, task mutation, waiver, trusted-memory promotion, and recursive delegation attempts are denied.
- If runtime permissions cannot enforce this, require a separately enforced environment or refuse assisted mode.
- One approved dispatch produces one attributable result; helper failures cannot self-mark task completion.

Implementation locations: `packages/core/src/execution`, `packages/adapter-opencode/src/execution.ts (new)`.

## OPI-N15

**Expose execution state through existing RPC/dashboard** — F3; open. Dependencies: OPI-N05, OPI-N09, OPI-N12.

Add bounded execution projections to existing RPC and views: owner, attempt/session, state, blocker, freshness, usage and cancellation status. Preserve dashboard auth and project confinement.

Acceptance:

- Stale observation and unknown usage are visible.
- No raw reasoning or conversation is persisted as project memory.
- No unsupported progress percentages; mutating controls use trusted grants and revisions.

Implementation locations: `packages/adapter-opencode/src/rpc-handlers.ts`, `packages/adapter-opencode/src/web`.

## OPI-N16

**Validate assisted mode against a single-agent baseline** — F3; open. Dependencies: OPI-N02, OPI-N14, OPI-N15.

Run opt-in failure-injection and matched feature experiments. Freeze tasks, acceptance criteria, model/runtime configurations and corpus before evaluating delegation.

Acceptance:

- Report successful accepted work, all attempt spend/tokens, elapsed time, failures and rework.
- Cross-project, forged approval, denied tool, exhausted budget, crash and cancellation scenarios pass.
- Installation alone creates no child sessions or paid traffic; ordinary single-agent use remains functional offline.

Implementation locations: `fixtures/acceptance`, `packages/bench`, `docs/architecture`.

## OPI-N17

**Add one managed writing worker and reviewed integration** — F4; deferred. Dependencies: OPI-N16.

Introduce isolated worktrees, changed-file audits, exact commit/base recording and human-approved integration. This extends recovery to code side effects.

Acceptance:

- Main checkout remains untouched by workers.
- Unexpected writes, stale base, changed target branch and failing checks prevent integration.
- Recovery inspects existing commits/artifacts before retry; cancellation does not claim rollback.

Implementation locations: `packages/core/src/execution`, `packages/adapter-opencode`.

## OPI-N18

**Enable bounded concurrent writers and integration queue** — F5; deferred. Dependencies: OPI-N17.

Add scope reservations, conflict handling and a serialized integration queue only after single-writer validation.

Acceptance:

- Graph predictions do not replace actual changed-file checks.
- Candidate/target commits are revalidated at integration; conflicts and target regressions block landing.

Implementation locations: `packages/core/src/execution`.

## OPI-N19

**Evaluate adaptive routing and reusable workflows** — F6; deferred. Dependencies: OPI-N16.

Propose routing, decomposition and context/skill changes from verified historical outcomes; use held-out evaluations before activation.

Acceptance:

- Quality, cost or latency improves on a frozen equivalent baseline.
- No automatic activation of an untested skill or material plan change.

Implementation locations: `packages/bench`, `packages/core/src/memory`.

## OPI-N20

**Add optional persistent local coordinator** — F7; deferred. Dependencies: OPI-N16, OPI-N17.

Host the same durable protocol outside interactive sessions. Add explicit scheduled authorization, reconciliation across restarts and optional notification/external adapters.

Acceptance:

- No unattended work without a current grant; work is stoppable and recoverable after host restart.
- External adapters do not introduce a competing task authority.

Implementation locations: `packages/coordinator (future)`.

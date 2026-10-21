# ADR-0029: Execution claims require fencing and reconciliation

- **Status:** Proposed
- **Date:** 2026-10-20
- **Depends on:** ADR-0028
- **Implementation:** OPI-N07, OPI-N12 in the [backlog](../architecture/implementation-backlog.md)

## Context

The indexing queue persists jobs and recovers expired leases. Its mutation APIs accept
job IDs without claimant tokens. That is insufficient for agents that may continue
running after a coordinator disconnects or a lease expires.

## Decision

Introduce a task-execution claim contract with execution ID, owner identity, lease
expiry, and monotonic fencing token. Acquire claims and the applicable writer slot
transactionally, checking task revision, dependency admission, plan/grant validity,
and available budget. One active primary execution per task; helper slots are separately
bounded. All cooperating renew, checkpoint, release, completion, and failure operations
must match the current execution ID/token and satisfy the lease contract.

Persist an idempotent dispatch intent before calling OpenCode. Use a runtime idempotency
key only where the pinned adapter's behavior is verified. If the external call may have
succeeded but the response was lost, reconcile using saved IDs/metadata. If the outcome
cannot be resolved, block for operator action; do not create another session blindly.

Expiry revokes authority to commit authoritative state. It does not prove an external
process stopped. Reconcile session/process, worktree, commits, and artifacts before
reassigning a writer. Cancellation stops new admissions immediately, requests runtime
cancellation, and reconciles in-flight work. It does not imply filesystem rollback.

Use bounded deterministic watchdog checks; they do not call a model merely to establish
liveness. Retries have limits and failure classes. Do not retry unchanged deterministic
verification failures. Repeated events/wakes must not duplicate execution or billing.

## Migration and validation

Keep index jobs separate until a deliberate migration introduces equivalent fencing.
Execution claims use new versioned tables/indexes. Test competing connections/processes,
expired-owner renew/complete, old-token completion after reassignment, duplicate delivery,
crash before/after external dispatch, crash after commit, stop during launch, and ambiguous
runtime state. Verify artifact reconciliation before a replacement starts.

## Limits and alternatives

A task `owner` string, optimistic task revision alone, and a lease timestamp alone are
insufficient ownership protocols. Fencing cannot prevent arbitrary external shell side
effects; workspace isolation, permissions, and confirmed process termination remain
separate controls. At-least-once event delivery is expected; exactly-once external effects
must not be promised without runtime/provider support.

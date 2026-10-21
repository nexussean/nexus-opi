# ADR-0030: Execution authority is scoped and revision-bound

- **Status:** Proposed
- **Date:** 2026-10-20
- **Extends:** ADR-0023; preserves ADR-0022 and ADR-0024
- **Implementation:** OPI-N08–OPI-N11 in the [backlog](../architecture/implementation-backlog.md)

## Context

An approved verification argv, a feature flag, and a named actor are useful existing
controls. They do not authorize general agent execution. The current agent-facing
waiver payload carries an actor string; it does not authenticate human consent.

## Decision

Use grants recorded through a trusted human/control interface. Bind each grant to
project, immutable plan revision/content hash, operations, allowed path/workspace scope,
model/provider policy, concurrency, budget, expiry, and revocation state. Tool input
references a grant ID; it cannot mint authority by naming an approver. Material scope
changes require a new grant; narrower work within a still-valid grant does not require
repeated confirmation. Propagate authority to helpers only within the parent's bounds.

Enforce admission in core services and again at sensitive mutation/integration boundaries.
OpenCode permissions enforce supported runtime actions; adapter capability checks must
fail closed if the selected build cannot enforce the requested scope. Repository content,
model text, and memory proposals cannot authorize actions. Scope checks include canonical
paths, symlinks, project/worktree identity, and cross-project references.

Budget admission atomically reserves bounded resource allowance before dispatch.
Reconcile reservations with observed usage; unknown usage is unknown, not zero. Keep
uncertain reservations held until reconciled or explicitly resolved. Reject new work
without allowance; do not promise exact control over already-running provider charges.
Include helpers, retries, failures, and review in feature-cost metrics.

Orchestration, paid child sessions, unattended execution, and automatic integration
remain off unless explicitly configured/authorized. Default assisted mode is at most
three active agents total including the primary, one writer, and no recursive spawning.
Verification waivers remain distinct from passing evidence and require trusted grants
before autonomous execution is enabled.

## Migration and validation

Add plan/grant/reservation ledgers without converting historical actor labels into
human approvals. Existing manual board behavior remains available; any change to its
waiver interface needs an explicit compatibility path and new tests. Test forged grant
IDs, forged actor strings, replay after plan edits/revocation, denied provider fallback,
concurrent budget admission, late/duplicate usage events, unknown usage, cancellation,
and unauthorized child delegation. Never weaken verification to make admission pass.

## Alternatives and limits

Prompt-only policy is rejected. A Git worktree is not a security boundary. Strong
protection from arbitrary shell code requires an OS sandbox/container or a restricted
capability set. Human confirmation provenance and actual enforcement are tested properties,
not assurances supplied by an agent role name.

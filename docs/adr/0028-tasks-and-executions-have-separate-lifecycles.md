# ADR-0028: Tasks and executions have separate lifecycles

- **Status:** Proposed
- **Date:** 2026-10-20
- **Preserves:** ADR-0022, ADR-0024, ADR-0025
- **Implementation:** OPI-N05, OPI-N06 in the [backlog](../architecture/implementation-backlog.md)

## Context

The guide proposes ownership, plans, journals and agent attempts. OPI already has a
revisioned task store, dependency edges, verification evidence, and task events.
Replacing it would discard working behavior and create competing sources of truth.

## Decision

Keep the task as the deliverable. Add an optional accountable owner and link a task
to zero or more execution attempts. Ownership can outlive a session; an execution
claim is temporary authority, not a transfer of task identity. Research/review helpers
are attempts with roles, not separate deliverables unless explicitly decomposed.

Preserve task states and the separate verification axis. Dependency waiting remains
derived. Execution outcomes are proposed as `pending`, `running`, `blocked`,
`reconciling`, `succeeded`, `failed`, `cancelled`; dispatch admission has its own durable
intent. An uncertain dispatch is reconciled, never silently marked failed and repeated.
An execution that succeeds may leave the task in review; it never self-certifies `done`.

Persist attempts in the existing application database with project/task foreign keys,
role, runtime/session IDs, plan revision, authorization ID, worktree, start/end times,
outcome, usage status, and structured blocker/checkpoint references. Actual columns
and indexes are finalized with migration tests in OPI-N05, not inferred from this ADR.

Keep immutable, content-hashed plan revisions and criteria. Superseding a plan preserves
old attempts and approvals. Scope edits cannot mutate an approved revision in place.
Task-event updates and their corresponding task mutations remain transactional.

## Migration and validation

Additive migrations preserve every current task, key, revision, event, and verification
state. Existing tasks start with no owner and no attempts. Do not backfill verified
status or turn historical actor strings into approval grants. Test old database upgrade,
restart, repeated migration, foreign-project links, multiple failed attempts on one task,
and rejection of execution success as completion evidence.

## Alternatives and consequences

A second agent task board is rejected: it would require status synchronization.
A single combined task/run/verification status is rejected: it loses crash history and
misrepresents unverified completion. JSON-only execution state is rejected for claims
that must be committed with database state. Journals must remain bounded structured
records with provenance, not full transcripts.

Revisit if attempt cardinality or retention needs a separate physical store; logical
ownership and transactional task history must remain singular.

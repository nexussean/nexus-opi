# Architecture reconciliation and implementation entry point

Reconciled 2026-10-20 against the current repository and the supplied Consolidated
Architecture & Feature Decision Guide. This is an implementation map, not a claim that
orchestration already ships. New architectural choices remain Proposed ADRs; existing
accepted ADRs remain authoritative. Runtime changes in this pass are limited to the
benchmark oracle and reporting.

Read in order:

1. [Reconciliation](reconciliation.md): what exists, what changes, what stays deferred.
2. [Task and execution decision](../adr/0028-tasks-and-executions-have-separate-lifecycles.md).
3. [Ownership and recovery decision](../adr/0029-execution-claims-require-fencing-and-reconciliation.md).
4. [Governance decision](../adr/0030-execution-authority-is-scoped-and-revision-bound.md).
5. [Runtime and rollout decision](../adr/0031-orchestration-reuses-the-runtime-and-starts-read-only.md).
6. [Dependency-ordered issues](implementation-backlog.md): implementation scope and exit tests.
7. [Reference research](reference-research.md): checked sources and their limits.

The existing `docs/p0-status.md` is a historical ticket register, not a claim that
only Phase 0 exists. The guide's F0–F7 are new rollout gates, not replacements for
existing OPI ticket IDs or historical P0–P8 phases. F0 and F1 therefore mean reuse and
close gaps, not rebuild the foundation.

No new task database, agent runtime, package reorganization, external issues, or
unattended execution is introduced by this documentation package. Local issue drafts
are the reviewable backlog until a destination tracker is selected.

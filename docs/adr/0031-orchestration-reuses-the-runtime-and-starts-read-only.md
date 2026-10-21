# ADR-0031: Orchestration reuses the runtime and starts read-only

- **Status:** Proposed
- **Date:** 2026-10-20
- **Depends on:** ADR-0028–0030; preserves ADR-0013–0015, ADR-0026–0027
- **Implementation:** OPI-N04, OPI-N13–OPI-N17 in the [backlog](../architecture/implementation-backlog.md)

## Context

OPI already separates core services, SQLite storage, retrieval, and the OpenCode adapter.
The guide's new package tree is conceptual, not a reason to move working modules.
Public runtime documentation is useful, but must be verified against installed types
and live probes for the exact selected version.

## Decision

Core orchestration uses an adapter-neutral runtime port: capabilities, session discovery,
dispatch, status, cancel, and usage/events. It stores opaque runtime IDs rather than
importing OpenCode session types. The OpenCode adapter supplies native agent/session
behavior. No replacement model loop, tools runtime, or Git implementation is introduced.

Keep orchestration in-process initially. Optional persistent hosting comes later and
must use the same durable execution protocol. No automatic cloud dependence. Keep the
current six-tool grouping provisional under ADR-0027; do not add one tool per planned
capability before measuring an actual user-facing workflow.

F3 permits opt-in research/review helpers with enforced read-only capabilities and
bounded context. The existing primary is the only writer. A helper may not mutate the
board, grant approvals, write memory constraints, execute arbitrary shell code, or
spawn more helpers. If the runtime cannot enforce the boundary, refuse the mode or
use an independently enforced read-only environment; a prompt is insufficient.

Context packages bind task, plan, worktree/source revision or content hashes, evidence,
acceptance criteria, allowed operations, and budget. Refresh or reject stale packs.
Only structured attributed results enter journals; promotion to trusted memory keeps
its existing confirmation rules.

F4 adds one managed writer with worktree isolation and reviewed integration. F5 adds
multiple writers only after reconciliation and serialized integration pass. The graph
suggests file scopes; actual changed files, exact candidate commit, target branch/head,
and verification determine whether integration is allowed. An advanced scheduler must
remain optional for single-agent users.

## Validation and revisit

Probe create/dispatch/cancel/reconnect, project filtering before payload processing,
permission enforcement including Code Mode, and usage accounting on each supported
runtime. Refuse unknown capability combinations. Test F3 crash/cancel recovery before
F4, and include all delegated spend in comparisons against an equivalent single-agent
baseline. Separate product-availability experiments from schema-shape experiments.

Keep dashboard execution views over existing RPC projections with honest state and
freshness; no invented progress percentage. A persistent coordinator, parallel writers,
and external orchestration adapters require their own implementation gates and cannot
be enabled by installing the plugin alone.

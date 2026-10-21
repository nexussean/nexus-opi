# ADR-0018: The tool surface is decided by measurement, not by taste

- **Status:** Accepted — **the decision it deferred has been made**, in
  [ADR-0027](0027-the-tool-surface-is-grouped-by-domain.md). The measurement is in
  [`docs/bench/tool-surface-results.md`](../bench/tool-surface-results.md).
- **Date:** 2026-10-19
- **Extends:** ADR-009

## Context

ADR-009 proposes a **small tool surface**: seven namespaced tools, each taking an `action`
argument. The stated reason is reduced schema and prompt overhead.

A working prototype (the kanban plugin) took the opposite shape: five separate tools, one per
action, each with its own description and schema.

Both are defensible and neither has been measured. The plan's own doc 05 demands paired
benchmarks for token overhead, so applying that standard here is consistent.

## Decision

Deferred. The tool surface is chosen after a harness measures both shapes on the same task
set.

The measurement counts, over a fixed set of tasks:

- malformed or rejected calls (schema violations, missing ids, invalid enum values),
- calls needed to complete the task,
- total tool-schema bytes in the prompt, and
- total tokens for the task.

`ctx.tool.hook("execute.before")` reports the effective tool name and input shape for every
call, so malformed calls are countable without changing the model.

## Consequences

- OPI-004 must include the tool-shape fixture, not only the token baseline.
- The seven-tool layout of doc 03 is a **hypothesis**, not a settled design. Implementations
  should not treat the exact names or the action list as fixed.
- The tool *names* (`pi_status`, `pi_task`, `pi_graph`, `pi_context`, `pi_memory`,
  `pi_verify`, `pi_metrics`) are worth keeping regardless: they are collision-resistant and
  self-describing, and the plan's seven-namespace split is a good taxonomy even if the
  grouping changes.
- The first measurement favours `actions` on schema size and tokens, but produced **4
  malformed calls** where `separate` produced **0** — and the counter was not yet
  trustworthy, so neither number decides anything. The measurement must come from the
  plugin's own record of its invocations, not from the event stream it is testing.

## Alternatives

- **Decide now on the plan's reasoning.** Rejected: the plan's reasoning is plausible and
  untested, and the cost of choosing wrong is a permanent schema cost on every request.
- **Seven separate tools, one per action.** Retained as the leading candidate; it is what the
  prototype used, and it gives each action a description that can be specific.

## Revisit condition

The harness produces results. — **Met.** The harness produced results on 2026-10-20, and
they are in [`docs/bench/tool-surface-results.md`](../bench/tool-surface-results.md).

## Outcome

The measurement overturned this ADR's own framing. It was written expecting the decision
to be about *how many tools* and *how big the schema*; the measurement showed the schema
is a second-order effect and the real lever is whether a tool exists at all. See
[ADR-0027](0027-the-tool-surface-is-grouped-by-domain.md).

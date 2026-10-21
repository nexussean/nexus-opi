# ADR-0013: OpenCode V2 is the integration target

- **Status:** Accepted
- **Date:** 2026-10-19
- **Supersedes:** the V1-shaped integration contract in `03-opencode-integration-and-api.md`
- **Evidence:** `docs/compatibility/opencode-v2.md`

## Context

The planning package describes the OpenCode plugin surface using the **V1** API:
`@opencode-ai/plugin`, a plugin `tool` map with a `tool()` helper, an `event` hook map,
`tool.execute.after`, `experimental.session.compacting`, and the `plugin` config key.

The installed release is OpenCode **2.0.28** with `@opencode/plugin@2.0.32**. None of those
shapes exist. Building 50 tickets against the V1 contract would fail at the first tool
registration.

## Decision

Target OpenCode **V2** exclusively. The verified surface is recorded in
`docs/compatibility/opencode-v2.md` and is the single source of truth for every integration
ticket. The V1 shapes are never used, and no compatibility shim for V1 is written.

The pinned target is **2.0.28**; the plugin API package is **2.0.32**.

## Consequences

- Every hook, tool, command, skill and RPC in the plan is re-expressed in V2 terms.
- `docs/compatibility/opencode-v2.md` must be re-verified against each pinned OpenCode release
  in the CI matrix, not assumed to carry forward.
- The `event` hook map becomes `ctx.event.subscribe()` (server) and `context.data.listen()`
  (terminal TUI).

## Alternatives

- **Support V1 and V2 from one package.** The V1 and V2 surfaces are different enough that this
  is two implementations behind one export. Not worth it for a product with no V1 users.
- **Target the dev branch.** Rejected: the dev branch moves faster than the pinned releases and
  the plan's compatibility matrix requires testing released versions.

## Revisit condition

The pinned OpenCode release changes, or the plugin API undergoes a breaking change.

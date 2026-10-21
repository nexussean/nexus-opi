# ADR-0019: Plugin tools stay in Code Mode's catalog, and discovery is part of the cost

- **Status:** Accepted
- **Date:** 2026-10-19
- **Evidence:** `docs/compatibility/opencode-v2.md` §12.1, §12.2
- **Affects:** OPI-009, OPI-014, OPI-027, OPI-004

## Context

OpenCode 2.0.28 routes tools through **Code Mode** by default. The model reaches a tool
by calling `search()` in the Code Mode runtime and then invoking the tool it finds. Two
consequences matter for a plugin:

1. `Tool.Options.codemode` is not "list this tool directly". It is "is this tool available in
   Code Mode". Setting `codemode: false` **excludes** the tool from the Code Mode catalog,
   and the default agent reaches tools through Code Mode — so the tool becomes unreachable in
   practice. Observed directly: a plugin tool with `codemode: false` was reported by the
   model as "not exposed in this session".
2. The model must **discover** the tool before it can call it. A `search()` call is part of
   the real cost of a tool surface, and it is not free.

Separately, a plugin's `setup` is asynchronous and runs **after** the location boots. A
session whose first model call begins before `setup` finishes sees no tools at all.

## Decision

- OPI's tools leave `codemode` **unset**, so they are available in the Code Mode catalog and
  reachable by the default agent. No tool sets `codemode: false`.
- The tool-surface benchmark measures the **whole** cost of a surface: the discovery call,
  the tool calls, malformed calls and tokens. A shape that is cheaper to search for but
  produces more malformed calls is not cheaper.
- Anything that drives OPI programmatically — the compatibility fixture, the benchmark
  harness, a "resume" flow — **waits until the plugin is active** before it prompts. The
  readiness signal is the plugin appearing in `GET /api/plugin` for its location, or its own
  registration marker on disk.

## Consequences

- The tool *description* is load-bearing. It is what `search()` matches against, and it is
  charged to every request. A single tool with a long description covering six actions is
  harder to match than six tools with focused descriptions — which is one of the things
  ADR-0018 measures.
- The tool namespace is also load-bearing: a distinctive namespace (`pi_*`) makes
  `search()` results obvious.
- No OPI flow may assume a plugin's tools are present in a session's first turn. The
  compatibility fixture must assert this explicitly.
- The benchmark harness boots a location, waits for the plugin, then prompts — and it does
  so through the OpenCode API rather than the CLI, because a non-interactive `opencode run`
  against the shared service does not load project-config plugins at all.

## Alternatives

- **Set `codemode: false` so tools are listed directly.** Rejected: it removes the tool from
  the catalog the default agent actually uses.
- **Have the plugin pre-register its tools at session creation.** Not possible: registration
  happens in `setup`.
- **Ignore the discovery call in the measurement.** Rejected: it would flatter whichever
  shape happens to match first and hide a real cost.

## Revisit condition

OpenCode changes how tools are discovered, or gains a stable "list tools directly" mode for
agents that want it.

# ADR register

ADRs 001–012 are **carried over from the planning package**
(`02-architecture-and-adrs.md` in `opencode-project-intelligence-plan/`). They are
**Proposed**: they have not been individually reviewed here, and some of their premises
turned out to be wrong — see ADR-0020, which replaces the plan's assumption that an LSP is
available.

ADRs 0013–0027 record the implemented foundation and its measurement decisions.
ADRs 0028–0031 are proposed execution extensions from the architecture reconciliation.

| ADR | Title | Status | Source |
|---|---|---|---|
| 001 | TypeScript/Bun for adapter and core | Proposed | plan |
| 002 | SQLite WAL; per-project logical database | Proposed | plan |
| 003 | Native plugin tools instead of MCP for v0.x | Proposed | plan |
| 004 | Tree-sitter symbol parsing + optional LSP resolution | Proposed — **the LSP half is void**, see [0020](0020-the-plans-lsp-dependency-does-not-exist.md) | plan |
| 005 | FTS + bounded graph hops first; embeddings optional | Proposed | plan |
| 006 | Separate local dashboard API | Proposed — extended by [0017](0017-the-board-ui-is-a-local-web-app.md) | plan |
| 007 | Explicit/opt-in memory promotions | Proposed | plan |
| 008 | Verification commands opt-in allowlist | Proposed | plan |
| 009 | Prefer small tool surface (7 tools) | Proposed — deferred by [0018](0018-tool-surface-decided-by-measurement.md) | plan |
| 010 | Derived graph is disposable; source control authoritative | Proposed — **implemented** in the persistent index's epochs | plan |
| 011 | Bounded passive hooks; no routine prompt injection | Proposed | plan |
| 012 | Observable evidence and uncertainty everywhere | Proposed — **implemented** as the `resolved`/`syntactic`/`unresolved` vocabulary | plan |
| [0013](0013-opencode-v2-is-the-integration-target.md) | OpenCode V2 is the integration target | **Accepted** | Phase 0 |
| [0014](0014-event-streams-are-not-location-scoped.md) | Event streams are not location-scoped, so every consumer filters by `ctx.location` | **Accepted** | Phase 0 |
| [0015](0015-file-change-detection-uses-our-own-watcher.md) | File-change detection uses our own filesystem watcher, with tool events as a fast path | **Accepted** (rationale revised after the tool-failure probe) | Phase 0 |
| [0016](0016-directory-plugins-resolve-entrypoints-by-path.md) | Directory plugins resolve entrypoints by path, not by the exports map | **Accepted** | Phase 0 |
| [0017](0017-the-board-ui-is-a-local-web-app.md) | The board UI is a local web app, not a terminal panel | **Accepted** | Phase 0 |
| [0018](0018-tool-surface-decided-by-measurement.md) | The tool surface is decided by measurement, not by taste | **Accepted** — the decision it deferred is in [0027](0027-the-tool-surface-is-grouped-by-domain.md) | Phase 0 |
| [0019](0019-tools-stay-in-code-mode-and-discovery-is-a-cost.md) | Plugin tools stay in Code Mode's catalog, and discovery is part of the cost | **Accepted** | Phase 0 |
| [0020](0020-the-plans-lsp-dependency-does-not-exist.md) | The plan's LSP dependency does not exist in OpenCode V2 | **Accepted** | P3 |
| [0021](0021-the-index-is-persisted-and-watched.md) | The index is persisted per worktree and watched, not rebuilt on every start | **Accepted** | P3 |
| [0022](0022-done-is-unverified-when-no-gates-are-configured.md) | `done` is recorded as unverified when no gates are configured | **Accepted** | P2 |
| [0023](0023-a-gate-is-a-reviewed-argv.md) | A gate is a reviewed argv, and only an approved gate can run | **Accepted** | P6 |
| [0024](0024-a-memory-is-trusted-by-confirmation-not-by-content.md) | A memory is trusted by who confirmed it, not by what it says | **Accepted** | P5 |
| [0025](0025-a-command-reports-the-rules-it-does-not-make-them.md) | A command reports the rules; it does not make them | **Accepted** | P5 |
| [0026](0026-the-dashboard-reads-through-rpc-and-is-optional.md) | The dashboard reads through the plugin's RPC, and it is optional | **Accepted** | P7 |
| [0027](0027-the-tool-surface-is-grouped-by-domain.md) | Retain domain grouping provisionally; measure successful task completion | **Accepted; performance rationale provisional; success metric withdrawn and replaced (2026-10-21)** | OPI-004 |
| [0028](0028-tasks-and-executions-have-separate-lifecycles.md) | Tasks and executions have separate lifecycles | **Proposed** | Architecture reconciliation |
| [0029](0029-execution-claims-require-fencing-and-reconciliation.md) | Execution claims require fencing and reconciliation | **Proposed** | Architecture reconciliation |
| [0030](0030-execution-authority-is-scoped-and-revision-bound.md) | Execution authority is scoped and revision-bound | **Proposed** | Architecture reconciliation |
| [0031](0031-orchestration-reuses-the-runtime-and-starts-read-only.md) | Orchestration reuses the runtime and starts read-only | **Proposed** | Architecture reconciliation |

## Protocol

Before shipping phase 1, each ADR is set to Proposed/Accepted/Superseded with its
alternatives and failure conditions recorded. Changes to plugin hooks, schema, privacy
defaults, completion gates or project identity require an ADR and a migration/test plan.

## What the Phase 0 and P3 work changed in the plan's own ADRs

| Plan claim | Status after the work |
|---|---|
| The plugin API is the V1 shape | **Wrong.** See [0013](0013-opencode-v2-is-the-integration-target.md). |
| The hook matrix uses `session.created/updated/idle`, `file.edited`, `file.watcher.updated` | **Wrong for V2.** `session.updated` and `file.watcher.updated` do not exist; `file.edited` does not fire. See [0015](0015-file-change-detection-uses-our-own-watcher.md). |
| Tree-sitter "plus optional LSP resolution" | **The LSP half is void.** See [0020](0020-the-plans-lsp-dependency-does-not-exist.md). |
| "Do not rely on … plugin UI panel API" | **Right, for a sharper reason.** See [0017](0017-the-board-ui-is-a-local-web-app.md). |
| Seven tools with action arguments (009) | **Unsettled.** Grouping is retained provisionally; current measurements do not isolate schema size or establish a winning product surface. See [0018](0018-tool-surface-decided-by-measurement.md) and [0027](0027-the-tool-surface-is-grouped-by-domain.md). |
| Does a smaller surface cost less? (009) | **No, not as a general property — and the minimal schema does not ship.** Re-measured on 2026-10-21 with a pre-registered rule: 41% cheaper on minimax (p = 0.036) and 6.9% *more expensive* on deepseek (p = 0.59), with the bootstrap intervals overlapping on both. The pre-registered verdict is **NOT RESOLVED**. The benefit is a property of the **model**, not the surface: shorter descriptions reduce the work needed to produce an answerable answer, which is worth money to a model that struggles with the format and nothing to one that does not. The intervention is **shorter descriptions**, not schema size in isolation. See [the result](../bench/schema-size-result.md) and [the regrade findings](../bench/regrade-findings.md). |
| The wording, guidance and structure levers (0027) | **Unsettled on cost.** Their apparent correctness differences were format differences. Regraded, every lever answers every question on both models. The cost comparison has to be re-taken with the corrected grader. |
| Project isolation from trusted adapter context (NFR-03) | **Right, but requires explicit filtering.** See [0014](0014-event-streams-are-not-location-scoped.md). |
| A plugin's tools are available in a session's first turn | **Not guaranteed.** See [0019](0019-tools-stay-in-code-mode-and-discovery-is-a-cost.md). |
| The derived graph is disposable (010) | **Implemented.** The index has epochs; a failed build leaves the previous one visible and marked stale. |
| Observable evidence and uncertainty (012) | **Implemented.** Every result carries a confidence and a completeness statement. |

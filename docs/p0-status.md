# Historical implementation ticket status

For the current architecture and new F0–F7 rollout gates, see the
[reconciliation](architecture/README.md). The observations below retain their original
version context; they are not a claim that current runtime compatibility is fully certified.

**Pinned target:** OpenCode `2.0.28` (channel `latest`, app `desktop`), plugin API
`@opencode/plugin@2.0.32`, macOS.

Evidence: `fixtures/compat-evidence/run-2026-10-19/`, analysis:
`docs/compatibility/opencode-v2.md`, probe source: `packages/compat-spike/`.

---

## Ticket status

| ID | Ticket | Status | Evidence / note |
|---|---|---|---|
| **OPI-001** | Pin OpenCode compatibility target | **Done** | Version, app channel and package versions recorded. Hook signatures and event payloads verified against the installed types and a live server, not the docs. |
| **OPI-002** | Create API spike for global plugin | **Done** | `packages/compat-spike`. Loads globally from `~/.config/opencode/plugins/`; tool, command, skill and RPC all register and are callable; events, session hooks and tool hooks all observed. |
| **OPI-003** | Approve scope, ADRs and threat model | **Done** | ADR register written: plan ADRs 001–012 carried over as Proposed, new ADRs 0013–0018 raised with evidence. The threat model has been re-derived against the verified V2 surface in [`security/threat-model-v2.md`](security/threat-model-v2.md), with 14 named test requirements (T-01…T-14). **All 14 now have tests**: T-05…T-10 were already covered; T-01…T-04 and T-11…T-14 were implemented on 2026-10-21, and the register is [`security/coverage-register.md`](security/coverage-register.md). T-13 needed a capability that did not exist, so the Code Mode audit trail was built (`packages/adapter-opencode/src/audit.ts` and `audit-source.ts`). |
| **P8** | Portability and v1 release | **Prepared, not published** | The release candidate is `@nexussean/opencode-project-intelligence` 0.1.0, under the **AGPL-3.0**, with artifact SHA-256 `bdfdf85d…`. Every technical gate that can run on one platform has: the suite (701 pass), the acceptance pilot (13/13), the isolated install with npm and **normal peer validation** (9/9, with TypeScript, JavaScript and Go parsing from the installed package), the dependency audit and SBOM (6/6, `npm audit` clean), the recovery rehearsal against a **copy of the real registry** (13/13, all four migration families, rollback and restore verified), the **live final artifact** in a real OpenCode session (12/12), and a **reproducibility proof** — the bundle is packed twice and the two tarballs are byte-identical. The owner decisions are made: the scope is `@nexussean`, the licence is AGPL-3.0, and the repository is **public** so the hosted CI can run. The **cross-platform CI has passed**: run `39696790101` at revision `7198b46` succeeded on macOS, Linux **and** Windows, each uploading its own evidence. The candidate stays `private: true` and **unpublished**. See [`docs/release/release-readiness.md`](release/release-readiness.md). |
| **OPI-004** | Define benchmark fixtures and baseline | **Partly done — repaired 2026-10-21** | The harness was repaired after a review found six defects, and **the earlier success metric is withdrawn**: format compliance substantially distorted it, though the old grader did check content and every one of its passes is still a pass. The retained read answers were regraded with a content-aware grader (`content-v1`): 392 old passes all still pass, all 48 of the answers the old grader could not read are correct, and there are no false failures. The 27 runs that did not complete are excluded from the **content accuracy** but stay in the **end-to-end success rate** and the **execution failure rate** — four metrics, kept apart, so an unreliable arm cannot look successful by failing quietly. The authoritative cost is now recovered from the runtime's session store, so the earlier spend figures were lower bounds (24–58% missing). The expected tool count is derived from the structure, so the `opi-minimal-split` arm — whose 18 runs had all been invalidated — now produces data. The runs are scheduled in a seeded, randomised, blocked order. Reports carry the source, surface, prompt, grader and runtime fingerprints. **What remains open**: the wording, guidance and structure levers are still unsettled on cost, and the schema-size decision was re-taken under a pre-registered rule and came out **NOT RESOLVED** — the minimal schema does not ship. See [the repair plan](bench/repair-plan.md), [the regrade findings](bench/regrade-findings.md), [the pre-registration](bench/preregistration-schema-size.md), [the result](bench/schema-size-result.md), [results](bench/tool-surface-results.md) and [ADR-0027](adr/0027-the-tool-surface-is-grouped-by-domain.md). |
| **OPI-005** | TypeScript/Bun monorepo scaffolding | **Done** | Bun workspace at the repo root: `packages/contracts`, `packages/core`, `packages/db`, plus the Phase 0 `packages/compat-spike` and `packages/bench`. `bun run check` typechecks every package and runs every test. |
| **OPI-006** | Implement project/worktree resolver | **Done** | `packages/core/src/project`. 15 fixture tests over real git repositories: plain repo, linked worktree, two clones of one origin, no-git directory, nested repository, submodule, symlinked path, moved project with relink, and a workspace boundary. |
| **OPI-007** | Implement SQLite registry and schema runner | **Done** | `packages/db`. WAL, foreign keys, busy timeout, versioned idempotent migrations, project and worktree tables, relink aliases. 6 tests covering restart persistence, re-migration safety, worktree registration and relink survival. |
| **OPI-008** | Implement bounded service errors/telemetry | **Done** | `packages/core/src/errors`, `.../telemetry`, `.../flags`. Safe error codes that never leak a path or a provider's raw message; a metrics sink with **bounded label cardinality** that reports what it dropped; feature flags that default to off for anything touching cost or privacy. 17 tests. |
| **OPI-009** | Implement global plugin adapter and `pi.status` | **Done** | `packages/adapter-opencode`. Verified live: loads globally, reports two different repos with different ids, stores them in the registry, and survives uninstall without touching user code. Evidence in `fixtures/acceptance/opi-009/`. |
| **OPI-010** | Implement durable worker queue and lifecycle | **Done** | `packages/core/src/queue` (types, worker) and `packages/db/src/queue.ts` (SQLite). Jobs persist, deduplicate while outstanding, retry with exponential backoff, and are recovered by lease expiry when a worker dies. 22 tests covering duplicate events, crash recovery, cancellation, timeouts and restart survival. |
| **OPI-016** | Build file inventory and ignore/secret policy | **Done** | `packages/retrieval/src/inventory.ts`. Gitignore semantics via `ignore`, secret-path patterns, size and binary limits, and a symlink that leaves the root is refused **before** the file is read. 6 tests. |
| **OPI-017** | Create Tree-sitter adapter interface | **Done** | `packages/retrieval/src/adapter.ts`. Every adapter reports `resolved / syntactic / ambiguous / unresolved` — the TypeScript and Go adapters report only `syntactic`, because neither proves a binding. |
| **OPI-018** | Implement JS/TS parser adapter | **Done** | `packages/retrieval/src/adapters/typescript.ts`. Definitions, imports, requires and dynamic imports. |
| **OPI-019** | Implement Go parser adapter | **Done** | `packages/retrieval/src/adapters/go.ts`. Functions, methods (qualified by their receiver), types, constants, imports. |
| **OPI-020** | Implement graph schema/transactions/epochs | **Done** | `packages/retrieval/src/persistent.ts`. An epoch is a consistent snapshot; a failed build leaves the previous one visible and marks it stale. |
| **OPI-021** | Implement incremental reindex/invalidation | **Done** | `refresh()` re-indexes only files whose **content hash** changed. Tests cover delete, rename, rapid edit and a no-op refresh. **Now wired to a live watcher** — see OPI-051 below. |
| **OPI-023** | Add optional LSP resolution spike | **Done — differently** | OpenCode V2 has **no LSP implementation**: no `lsp.ts`, no `LanguageClient`, and no LSP symbol in the plugin API, the client, or the schema. The `lsp.updated` event is declared and never produced. See [ADR-0020](adr/0020-the-plans-lsp-dependency-does-not-exist.md). Resolved instead by **module-level resolution**: an import whose name matches a declaration in the imported file is provably `resolved`. |
| **OPI-024** | Implement lexical and path indexes | **Done** | `packages/retrieval/src/lexical.ts` over the **same** tables the graph reads, so the two views cannot disagree. The FTS table, the symbol rows, the import edges and the references are one store. 11 tests. |
| **OPI-025** | Implement candidate ranking and dedupe | **Done** | `packages/retrieval/src/context.ts`. Weighted signals, one candidate per file, and a tiebreak that puts implementation before test file. |
| **OPI-026** | Implement token/byte capped evidence packs | **Done** | The plan's budgets: default 1 500 tokens, 300–6 000, clamped. A cut pack says so, and an empty pack distinguishes *cut by budget* from *nothing scored*. |
| **OPI-027** | Implement `pi.context` and retrieval evaluation | **Done** | `pi.context` ships and is verified live. **The evaluation is done on the shipping path**: the held-out set run through `assembleContext` over a `PersistentIndex` — the code `pi.context` actually calls — scores hit@5 **0.920** (23/25) against grep's **0.240**, and reaches the answer in **57 tokens** against grep's 8 872. The plan's 90% target is met. Harness: `scripts/evaluate-retrieval.ts`; output: `fixtures/retrieval/heldout-shipping-output.txt`. Two misses remain: `hold-09` and `hold-22` — both vocabulary gaps, and **neither was fixed**, because tuning the retriever against the held-out set would invalidate the measurement. The evaluation also caught a **parity gap**: the shipping path had lost the compound-name match the spike had, which the fix restored. |
| **OPI-051** | Persist the index and watch for changes | **Done** | `packages/retrieval/src/watcher.ts` and `packages/retrieval/src/persistent.ts`. The index is now a **per-worktree SQLite database** that survives a restart, a plugin-owned `node:fs.watch` reports **debounced batches** of changed paths, and `reindexPaths()` re-reads only those files. Verified live: a new file moved the index 24→25 files / epoch 1→2, a restart **reused** epoch 2 rather than rebuilding, and a deletion moved it back to 24 files / epoch 3. See [ADR-0021](adr/0021-the-index-is-persisted-and-watched.md). |
| **OPI-011** | Create task schema and audit ledger | **Done** | `packages/core/src/task/types.ts` and `packages/db/src/tasks.ts`. Tasks carry a **workflow state** and, separately, a **verification state**. Every mutation is a transaction that also appends to `task_events`, so the history and the row cannot disagree. 28 store tests. |
| **OPI-012** | Implement dependency DAG and readiness | **Done** | `packages/core/src/task/dag.ts`. `blocks` is the only relation that affects readiness; `parent` and `related` do not. A cycle is refused at insertion, not discovered later. Readiness and the *waiting* list are separate: a task waiting for a dependency stays `backlog` and the board says what it waits for. |
| **OPI-013** | Implement state transitions and revisions | **Done** | `packages/core/src/task/machine.ts`. Writes need `expected_revision`; a stale one is a **conflict**, and the first write stands. The evidence rule and its one exception are in [ADR-0022](adr/0022-done-is-unverified-when-no-gates-are-configured.md). A waiver is attributed — actor, reason, scope, timestamp — and is in the history, not a flag on the task. |
| **OPI-014** | Implement `pi_task` tool | **Done** | Nine actions: `list`, `get`, `create`, `update`, `transition`, `link`, `unlink`, `history`, `delete`. Scoped to the session's project, bounded, and every task carries its verification state and a plain note about it. Verified live: the illegal transition, the stale revision, the cycle and the incomplete waiver were all refused with an explanation, and a valid waiver completed a task. |
| **OPI-015** | Add task export and import validation | **Not started** | Deferred. Export is a P2 convenience; the durable store and the audit ledger are the thing that must not be lost, and the round-trip validation is better designed once the format is settled by a real export. |
| **OPI-039** | Implement loopback API and browser auth | **Done** | The plugin registers an `opi` RPC — five read methods over the same stores the tools use — and `packages/adapter-opencode/src/web/server.ts` serves a page that proxies to it. Loopback bind, a random token per start, auth on every `/api/` route, **no CORS headers**, and a CSP of `default-src 'none'`. 15 tests, including T-09 and T-10. See [ADR-0026](adr/0026-the-dashboard-reads-through-rpc-and-is-optional.md). |
| **OPI-040** | Build project dashboard shell | **Done** | Four views — Overview, Board, Memory, Quality — over the RPC. The board shows the tasks, the waiting list, the index health and the checks. The memory view keeps **Decisions**, **Proposals** and **Superseded** apart, and the quality view shows each run's staleness. |
| **OPI-041** | Build Kanban interactions | **Partly done** | The board **reads** the state, and the card shows the key, the title, the verification badge and what it is waiting for. The **drag-and-drop with optimistic rollback** is not built: the RPC carries the revision, so the server-side check is there, but the optimistic half is not. |
| **OPI-033** | Implement gate configuration and approvals | **Done** | `packages/core/src/verify/types.ts` and `packages/db/src/verification.ts`. A gate is a **reviewed argv**, never a command string. It is proposed, then approved by a named person; only an approved gate runs. See [ADR-0023](adr/0023-a-gate-is-a-reviewed-argv.md). |
| **OPI-034** | Implement bounded execution sandbox controls | **Done** | `packages/core/src/verify/runner.ts`. `spawn` with an exact argv and no shell; the executable is resolved and refused if it comes from the project; the cwd is checked to be inside the root; the environment is constructed rather than inherited; output is capped; the **process group** is killed on a timeout or a cancellation. 28 tests, including T-05, T-06 and T-08. |
| **OPI-035** | Implement revision-linked verification evidence | **Done** | `packages/core/src/verify/evidence.ts`. A run records the worktree HEAD, the gate's config revision and a hash of the files in the gate's **scope**. A change in the scope makes the run stale; a change outside it does not. OPI's own `.opencode` directory is excluded, so a gate cannot invalidate its own evidence by writing to the project. |
| **OPI-036** | Enforce task completion gate invariants | **Done** | `packages/core/src/verify/completion.ts` and `SqliteTaskStore.setVerification`. The task's evidence state is **derived** from its required gates and their runs, and it is the only path that writes it — an ordinary update cannot claim a task is verified. The state machine's `done` rule now has real evidence behind it. |
| **OPI-037** | Implement impact-to-tests recommendation | **Not started** | Deferred. It needs the graph's `related_tests` to be evidence-backed rather than heuristic, and that is a P4 improvement. |
| **OPI-028** | Create typed memory schema and provenance | **Done** | `packages/core/src/memory/types.ts` and `packages/db/src/memory.ts`. A memory's trust comes from **who confirmed it**, never from what it says. Six trust states, a provenance record, and a tombstone table so a deleted memory cannot be resurrected by a re-import. See [ADR-0024](adr/0024-a-memory-is-trusted-by-confirmation-not-by-content.md). |
| **OPI-029** | Implement proposal/confirm/supersede flow | **Done** | `SqliteMemoryStore.propose / confirm / verify / supersede / delete`. A proposal is untrusted. A confirmation needs a **named actor**. A supersession keeps the old memory for history and never retrieves it by default. A source-linked fact goes stale when its source changes. |
| **OPI-030** | Implement handoff and session linking | **Done** | `packages/core/src/memory/handoff.ts`. A handoff is a fixed, bounded, machine-readable shape — a session report, not an architecture fact. It never becomes a decision by being read. Sessions are linked to a project and a current task. |
| **OPI-031** | Integrate optional compaction context | **Not started** | Deferred deliberately. The plan says to use OpenCode's **experimental** `session.compacting` hook, and says the manual alternatives must be preserved. The manual alternatives — `pi_memory.resume` and `/pi-handoff` — are in place, so the hook is an addition and not a dependency. Nothing is injected automatically. |
| **OPI-032** | Implement `pi_memory` and commands/skills | **Done** | `pi.memory` with five actions: `search`, `list`, `propose`, `handoff`, `resume`. **There is no `confirm` action** — the schema does not accept it, so the model cannot express the operation. Decisions are confirmed by a person through the CLI. Search returns constraints and leads in **separate** sections, so a proposal is never read as a decision. **Six slash commands** — `/pi-board`, `/pi-next`, `/pi-blockers`, `/pi-review`, `/pi-handoff`, `/pi-list` — and **one skill**, registered through `ctx.command.transform` and `ctx.skill.transform`. A command **reports** the rules; it never makes them (ADR-0025). |
| **OPI-038** | Implement `pi_verify` and quality report | **Done** | `pi.verify` with six actions: `list_gates`, `propose_gates`, `run`, `results`, `waive`, `evaluate_task`. `run` takes a **gate id and nothing else** — the capability to run an arbitrary string does not exist in the API, so T-06 is satisfied structurally. Execution is **off by default** (`verification.execution`); detection works without it. A CLI (`packages/cli`) is the human's surface for approving a gate. |
| **OPI-022** | Implement `pi.graph` bounded queries | **Done** | `packages/retrieval/src/graph.ts` and the `pi_graph` tool. All seven actions the plan names. Every node cites a file and a line; every result states its completeness. `callers` and `references` are **supersets** and say so. 15 tests. |
| **The retrieval spike** | Falsification test for the whole product | **Run — 2 of 3 criteria pass** | `packages/retrieval`. Tree-sitter (TS/JS), one-shot index, SQLite FTS, a file-import graph, a **concept layer** (action x domain co-occurrence, no embeddings), and a grep baseline given the same query interpretation. **Tuning set** hit@5 1.000 vs 0.726; **held-out set** (25 questions written after tuning, never used to change it) hit@5 **0.960 vs 0.640**, cost to reach the answer **34 vs 38** tokens. Two of three criteria pass on the held-out set; the token criterion (a third of the baseline) was **not met**. See [`docs/spike/retrieval-hypothesis.md`](spike/retrieval-hypothesis.md) and `fixtures/retrieval/spike-output.txt`. |

---

## What the spike proved

| Claim | Result |
|---|---|
| A plugin can load globally, from `~/.config/opencode/plugins/` | **yes** — a symlinked directory works |
| Plugin tools are callable by the model | **yes** — `echo`, `status` observed in the tool list and called |
| A plugin command registers and appears in `/` completion | **yes** |
| A plugin skill registers and appears in the skill list | **yes** |
| A plugin RPC registers and round-trips | **yes** |
| Session `prompt` hook fires | **yes** — once per admission |
| Session `context` hook fires and can inject | **yes** — 8× per run, one per model call |
| Tool `execute.before` / `execute.after` hooks fire | **yes** — with real tool names and input shapes |
| Events are observable | **yes** — 188 events for one session |

## What the spike disproved

| Plan claim | Reality |
|---|---|
| `file.edited` signals a source edit | **It does not fire.** A tool-driven edit produced zero file events in 1 666 captured events. |
| `file.watcher.updated` exists | **It does not exist** in V2. |
| `session.updated` exists | **It does not exist.** Use `session.renamed` / `session.metadata.updated`. |
| `session.idle` marks session completion | **Ephemeral and client-side.** Did not fire in a headless run. Use `session.execution.succeeded` / `.failed`. |
| The event stream is scoped to the plugin's project | **It is server-wide.** One instance saw seven directories. |
| The plugin API is the V1 shape | **It is not.** See [ADR-0013](adr/0013-opencode-v2-is-the-integration-target.md). |
| Tool hooks reveal every tool call | **Only direct calls.** Code Mode wraps them as one `execute` call. |

## Blockers carried into P1–P3

| # | Blocker | Lands in | Handling |
|---|---|---|---|
| B1 | `file.edited` never fires | P3 | [ADR-0015](adr/0015-file-change-detection-uses-our-own-watcher.md) — plugin-owned watcher with hash reconciliation |
| B2 | Event stream is server-wide | P1 | [ADR-0014](adr/0014-event-streams-are-not-location-scoped.md) — filter by `ctx.location` at the adapter boundary |
| B3 | Code Mode hides inner tool calls | P3 | Same as B1 |
| B4 | `session.idle` unreliable | P1 | Use `session.execution.succeeded` / `.failed` |
| B5 | Compaction hook not exercised | P5 | Needs a fixture that forces a compaction |
| B6 | Threat model not re-walked | P0 | Must be done before OPI-009 |
| B7 | `session.created` timing | P1 | Observed firing in one run and not another — likely a subscription-timing race. The adapter must tolerate a session it did not see created, and reconcile by listing sessions rather than by event. |
| B8 | **Plugin activation races the session's first model call** | P0, P1 | A first turn can see **no tools at all**. Every harness and fixture must wait for the plugin to be active before prompting. See the compat doc §12.1. |
| B9 | **`codemode: false` removes a tool from Code Mode's catalog** | P0 | The default agent reaches tools through Code Mode, so the tool becomes unreachable. Leave `codemode` unset. §12.2. |
| B10 | **A non-interactive `opencode run` does not load project-config plugins** | P0 | Use `--standalone`, or install the plugin globally. §12.3. |
| B11 | **A plugin that throws during `setup` loses its entire tool surface** | P0 | Every tool disappears; only a WARN in the log. No setup step may throw. The index degrades to empty rather than preventing load. See [ADR-0021](adr/0021-the-index-is-persisted-and-watched.md). |

---

## Next ready tickets

1. **Decide the token criterion.** The spike misses the 1/3 bar it set and clears the plan's
   own 15% target by 4x. The three options are in
   [`spike/retrieval-hypothesis.md`](spike/retrieval-hypothesis.md). This is the owner's call,
   not the spike's.
2. **Measure OPI's own surface.** The benchmark is trustworthy and reusable, and it
   decided the shape question — but OPI's shipped surface (10,017 bytes, 5.1× the largest
   measured shape) was not measured. The plugin now records its own declared tools to
   `<data dir>/surface.json` in the benchmark's format, so the harness can run against it
   directly. This is the one measurement left that bears on the surface.
3. **OPI-003** — **done.** All fourteen threat-model test requirements are
   implemented as tests. T-05…T-10 were covered earlier; T-01, T-02, T-03, T-04, T-11,
   T-12, T-13 and T-14 were implemented on 2026-10-21. The register is
   [`security/coverage-register.md`](security/coverage-register.md).
4. **OPI-041 remainder** — the drag-and-drop with optimistic rollback, if the board is
   worth it. The RPC carries the revision, so the server-side check is there.
5. **OPI-031** — the compaction hook. Deliberately last: the plan calls OpenCode's
   `experimental.session.compacting` hook experimental, and says the manual alternatives
   must be preserved. They are — `pi_memory.resume` and the handoff record — so this is an
   addition and not a dependency.
6. **OPI-015** — task export and import validation, once the format is settled by a real
   export.
7. **OPI-037** — impact-to-tests recommendation, once the graph's `related_tests` is
   evidence-backed rather than heuristic.
8. **P8** — the installers, the red team, and the release. **OPI-046** (the Rust and Python
   adapters) and **OPI-042** (the graph explorer) are the two most expensive remaining
   items, and they are the two with the least evidence of need.

The foundations are in place: project identity, a durable registry, a durable job queue, a
plugin that reports all of it, and a retrieval layer that beats grep by 24 points of hit rate
at a quarter of the cost. The index is now **persisted per worktree and watched**, so it
survives a restart and reflects an edit within about a second (OPI-051).

The **task engine** (OPI-011 → OPI-014) and the **verification service** (OPI-033 → OPI-036,
OPI-038) are both in. Together they make the chain the product promises: a task can be
created, worked, and only reaches `done` on evidence that is current — or on a recorded
waiver that names who accepted the risk.

The **memory model** (OPI-028 → OPI-030, OPI-032) is in as well, and it is the piece that
makes a project remember. A decision is trusted because a *person* confirmed it, not because
the text says so; a proposal is a lead and is never returned among the decisions; and a
handoff is a session report that survives a restart. The model can propose and report. It
cannot confirm.

The product now has **both surfaces**: six tools for an agent, six commands and a skill
for a person. A command reports the rules rather than making them, so the two surfaces
cannot disagree.

B1–B3 shape the P3 indexer design and should be read before OPI-016 is implemented.

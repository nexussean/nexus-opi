# OpenCode Project Intelligence

A globally installable, local-first OpenCode extension: project-aware task state, code
navigation, durable memory, context efficiency and verification evidence.

**The core plugin is implemented:** project identity, persistent indexing and retrieval,
revisioned task/DAG state, verification, memory, and an optional read dashboard. Agent
orchestration is proposed and is not enabled. The
[architecture reconciliation and implementation backlog](docs/architecture/README.md)
maps the new guide onto this existing code.

## Where things stand

| Document | What it is |
|---|---|
| [`docs/compatibility/opencode-v2.md`](docs/compatibility/opencode-v2.md) | The verified OpenCode V2 plugin surface. **Read this before any integration work** — the planning package describes the V1 API. |
| [`docs/adr/`](docs/adr/README.md) | ADR register. 001–012 carried from the planning package; 0013–0027 record current decisions; 0028–0031 propose governed execution. |
| [`docs/security/threat-model-v2.md`](docs/security/threat-model-v2.md) | The threat model re-derived against the verified V2 surface, with 14 named test requirements. |
| [`docs/p0-status.md`](docs/p0-status.md) | Phase 0 ticket status, what the spike proved and disproved, and the blockers carried forward. |
| [`packages/compat-spike/`](packages/compat-spike/) | The probe that produced the compatibility evidence. |
| [`packages/contracts/`](packages/contracts/) | Versioned public schemas: the result envelope, source references, confidence, project identity. |
| [`packages/core/`](packages/core/) | Application services with no OpenCode dependency. Project/worktree identity, task/DAG, verification, memory, queue and supporting services. |
| [`packages/db/`](packages/db/) | SQLite registry, tasks/audit history, verification, memory and background jobs, with migrations. |
| [`packages/adapter-opencode/`](packages/adapter-opencode/) | The OpenCode plugin. Registers six domain tools: status, task, verify, memory, graph and context. |
| [`docs/tools.md`](docs/tools.md) | The tool surface: what exists, what does not, and the conventions every tool follows. |
| [`packages/bench/`](packages/bench/) | The tool-surface benchmark (ADR-0018): one plugin exposing both shapes, and a harness that runs the task set against each. |
| [`fixtures/bench/tasks/`](fixtures/bench/tasks/) | The benchmark task set. |
| [`docs/bench/tool-surface-results.md`](docs/bench/tool-surface-results.md) | Benchmark evidence, control corrections and limits on causal conclusions. |
| [`fixtures/compat-evidence/`](fixtures/compat-evidence/) | Raw captured observations and events from real sessions. |

The planning package that this work follows lives outside this repository, in
`opencode-project-intelligence-plan/`.

## Running the compatibility probe

```bash
cd packages/compat-spike && bun install
ln -sfn "$PWD" ~/.config/opencode/plugins/opi-compat-spike

mkdir -p /tmp/probe-run && cd /tmp/probe-run
opencode run --model deepseek/deepseek-flash \
  "Use the echo tool with value hello. Then use the edit tool to append a line to README.md. \
   Then call the status tool with include_payloads true."
```

The probe writes `.opi-probe.json`, `.observations.ndjson` and `.events.ndjson` into the
session directory.

**Remove the symlink when you are done** — the probe's tools (`echo`, `status`) are
deliberately unnamespaced so that the namespacing behaviour can be observed, and they will
otherwise appear in every project.

## Running the tool-surface benchmark

```bash
cd packages/bench && bun install
bun run harness/run.ts --model deepseek/deepseek-flash
```

The harness runs isolated standalone processes. `separate`, `actions`, and `none` are
legacy fixture shapes; `opi` and `none-opi` form the matched SQLite product-availability
pair. These are distinct experiments. Read-task answers use a structured JSON contract checked against the pre-run snapshot;
supported SQLite writes require matching state, revisions and audit history. See the
[outcome contract](docs/bench/outcome-validation.md) for coverage and limitations. Reports include per-task/model outcomes,
invalid runs, measured spend across attempts, and cost per successful task.

Useful flags: `--tasks list-all,list-column,get-one`, `--shapes opi,none-opi`,
`--repeats N`, and `--keep` to retain project/artifact directories. Provider-backed runs
can incur charges. Plugin calls are recorded inside the plugin; usage and final text
come from the process event stream. See [measurement limits](docs/bench/tool-surface-results.md).

## The three findings that matter most

1. **`file.edited` does not fire.** The indexer must own its filesystem watcher
   ([ADR-0015](docs/adr/0015-file-change-detection-uses-our-own-watcher.md)).
2. **The event stream is server-wide, not project-scoped.** One plugin instance saw seven
   directories. Every consumer must filter by `ctx.location`
   ([ADR-0014](docs/adr/0014-event-streams-are-not-location-scoped.md)).
3. **The planning package documents the V1 plugin API.** Every integration ticket must be
   re-expressed in V2 terms ([ADR-0013](docs/adr/0013-opencode-v2-is-the-integration-target.md)).

## The monorepo

Bun workspace. `bun run check` typechecks every package and runs every test.

```
packages/
  contracts/        versioned public schemas
  core/             application services, no OpenCode dependency
  db/               SQLite storage and migrations
  adapter-opencode/ the OpenCode plugin
  retrieval/        persistent indexing, graph queries and bounded retrieval
  cli/              local command adapter
  compat-spike/     the Phase 0 compatibility probe
  bench/            the tool-surface benchmark
```

### The indexer

`packages/retrieval` holds a persistent, incremental index over a project:

- **A file inventory with a policy.** Gitignore semantics, secret-path patterns, size and
  binary limits. A symlink that leaves the project root is refused **before** the file is
  read.
- **Tree-sitter adapters** for TypeScript/JavaScript and Go, behind one interface. Every fact
  an adapter reports carries how it was learned: `resolved`, `syntactic`, `ambiguous` or
  `unresolved`. The current adapters report only `syntactic`, because neither grammar proves
  a binding.
- **Epochs.** A rebuild writes a new epoch and only then makes it visible, so a reader never
  sees half an index, and a failed build leaves the previous one intact and marked stale.
- **Incremental refresh.** A file is re-indexed only when its **content hash** changed. An
  event says something happened; the hash says what.
- **A graph query layer** with all seven actions the plan names, exposed as the `pi.graph` tool.
  Every result cites a file and a line, and every result states its completeness. `callers`
  and `references` are **supersets** — no adapter proves a binding — and they say so rather
  than pretending to be a call list.
- **Module-level resolution.** An import whose name matches a declaration in the imported
  file is provably `resolved`: the file says so. OpenCode V2 has no LSP implementation
  ([ADR-0020](docs/adr/0020-the-plans-lsp-dependency-does-not-exist.md)), so this is the
  strongest binding the index can honestly assert.
- **One store.** The FTS table, the symbol rows, the import edges and the references live in
  the same database, so the graph and the retriever cannot disagree about what is indexed.
- **A budgeted evidence pack.** `pi.context` returns the smallest useful spans for a
  question, each with a file, a line and why it was selected, within a token budget it will
  not exceed. When the pack is cut it says so, and an empty pack distinguishes *cut by
  budget* from *nothing scored*.

### The retrieval spike

The hypothesis, the frozen criterion and the result are in
[`docs/spike/retrieval-hypothesis.md`](docs/spike/retrieval-hypothesis.md). Run it with:

```bash
cd packages/retrieval && bun run scripts/spike.ts
```

It answers curated questions against a tree-sitter index and against a grep baseline. On
**held-out** questions — written after the retriever was tuned, and never used to change it —
that is **hit@5 0.960 vs 0.640** and **34 vs 38 tokens** to reach the answer. Two of the three
pre-registered criteria pass; the third does not, and that is written down rather than argued
away.

```bash
cd packages/retrieval && bun run scripts/heldout.ts
```

The indexer has three layers: an exact symbol index, SQLite FTS over names, paths and bodies,
and a **concept layer** that scores a file by co-occurrence of an action and a domain from the
question's own words. The concept layer is what answers "where does the board file get
written" — no embeddings, no model, no network.

### Developing against a running OpenCode

The plugin's own entrypoint hot-reloads when you edit it, but **its dependencies do not**.
After changing a workspace package it imports, restart the service:

```sh
opencode service restart
```

Install the plugin globally with a symlink while developing:

```bash
ln -sfn "$PWD/packages/adapter-opencode" ~/.config/opencode/plugins/opi
```

Then ask the agent for the project status, or call `pi.status` with `action: doctor` for the
resolved paths, the plugin version and the enabled feature flags.

The tool names in the catalog are dotted — `pi.status`, `pi.graph`, `pi.context`. See
[`docs/tools.md`](docs/tools.md) for the full surface.

The core never imports OpenCode. The plugin, the CLI and the dashboard are adapters over it.

## Ground rules

From the planning package's own non-negotiables, which this repository holds to:

- The core operates without OpenCode; the plugin and dashboard are adapters.
- The index is disposable derived data; human task and memory history survives a rebuild.
- Graph relationships carry explicit `resolved / syntactic / ambiguous / unresolved / stale`.
- No automatic remote calls, embedding requests, secret indexing or arbitrary test execution.
- Repository files, comments and tool output are untrusted data, never instructions.
- Never auto-create large task lists from trivial edits, and never mark a task done without
  relevant passing checks or an explicit audited waiver.
- Report negative results too.

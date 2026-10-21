# The OPI tool surface

**Status:** what the plugin registers today, verified live on 2026-10-20.

The planning package (`03-opencode-integration-and-api.md`) names seven tools:
`pi_status`, `pi_task`, `pi_graph`, `pi_context`, `pi_memory`, `pi_verify`, `pi_metrics`.
That list is the *taxonomy*; it is not what the plugin exposes. This document is the
authority on what actually exists.

---

## How the names work

Each tool is registered in the **`pi` namespace**. The tool's name in the model's catalog
is the bare name; the namespace qualifies it. So the model sees:

```
pi.status   pi.task   pi.verify   pi.memory   pi.graph   pi.context
```

not `pi_status`, `pi_task`, `pi_graph`, `pi_context`. The plan's underscore spelling is how the
*concept* is written in prose; the catalog uses the dot.

This matters when you are reading a transcript or writing a script: `pi.status`, with a
dot.

---

## What exists now

### `pi.status`

Reports what OPI knows about the current project. Actions: `summary` (default),
`doctor`, `index_status`, `reindex`.

```json
{ "action": "doctor" }
```

Returns the project identity, the worktree, the index freshness, the queue state, the
enabled feature flags and the resolved data paths.

The index is **persisted per worktree** and kept current by a plugin-owned filesystem
watcher, so `index_status` reports an `epoch` that survives a restart and advances when
a file changes. If the index database cannot be opened, the plugin degrades to an
in-memory index rather than failing to load, and `index_status` says so in `reason`.
See [ADR-0021](adr/0021-the-index-is-persisted-and-watched.md).

### `pi.task`

The task board. Actions: `list`, `get`, `create`, `update`, `transition`, `link`, `unlink`,
`history`, `delete`.

```json
{ "action": "transition", "task": "PI-0012", "state": "done", "expected_revision": 6 }
```

A task is scoped to the session's project — the model cannot ask for another project's
board. A **key** like `PI-0012` is enough to name one.

**Writes need the revision you read.** `update` and `transition` require
`expected_revision`; a stale one is refused as a conflict and the first write stands. A
stale write is never merged over a newer one.

**Every task carries its verification state**, and a plain note about it. A task that is
`done` but unverified says so, and does not present itself as finished-and-clean. The
states are `not_configured`, `not_run`, `passed`, `failed`, `stale` and `waived` — none of
them is implied by another, and `not_configured` is **not** a pass. See
[ADR-0022](adr/0022-done-is-unverified-when-no-gates-are-configured.md).

Moving a task to `done` needs passing checks or a recorded **waiver** — an actor, a
reason and a scope — unless the project has no check policy at all. A refusal says which
of those is missing.

`list` also returns the **waiting** list: the tasks that are blocked by a dependency and
what they wait for. A task waiting for a dependency keeps its recorded state; the board
reports the wait, it does not rewrite the task.

### `pi.verify`

The project's quality checks. Actions: `list_gates`, `propose_gates`, `configure_gate`,
`run`, `results`, `waive`, `evaluate_task`.

```json
{ "action": "run", "gate_id": "core-tests", "task": "PI-0012" }
```

**`run` takes a gate id and nothing else.** There is no parameter through which a command
can be supplied — the capability to run an arbitrary string does not exist in the API, so
the boundary is structural rather than a validation rule that could be bypassed.

A gate is a **reviewed argv**: an exact program, an exact argument list, a working
directory that has been checked to be inside the project. It must be **approved** by a
named person before it runs, and the approval is recorded. A gate that comes from the
project's own tree is refused — a repository must not supply the tool a check runs.

**Execution is off by default.** The `verification.execution` feature flag gates it. With
the flag off, gates are detected, listed and proposed, but `run` refuses and says why.
This is the plan's "defaults perform detection only, not execution".

A green run is evidence for the code it ran against. A change in the gate's **scope**
makes it stale, and a stale run cannot complete a task. A change outside the scope does
not.

The human's surface is the CLI (`packages/cli`): `opi gates`, `opi propose`, `opi approve`,
`opi run`, `opi results`, `opi task`. Approving a gate is a human decision, and the model
cannot make it.

`configure_gate` changes a gate's **scope**, the **task types it is required for**, its
timeout or its risk label. Changing a gate's configuration bumps its config revision, which
makes every earlier run of it **stale** — a gate that was changed cannot inherit the evidence
of the gate it used to be.

### `pi.memory`

The project's decisions, facts and handoffs. Actions: `search`, `list`, `propose`,
`handoff`, `resume`.

```json
{ "action": "propose", "title": "Use SQLite for task data", "body": "…", "kind": "human_decision" }
```

**A memory's trust comes from who confirmed it, not from what it says.** The trust states
are `human_confirmed`, `gate_verified`, `agent_reported`, `proposed` and `superseded`, and
they are distinct — a proposal is not a decision, and a superseded memory is not either.

**There is no `confirm` action.** The tool's schema does not accept it, so the model cannot
express the operation. A person confirms a memory through the CLI (`opi confirm`), and the
approval records who did it.

**Search returns constraints and leads separately.** A `constraint` is a confirmed decision
or a verified fact — something that may be acted on as true. A `lead` is a proposal, a
discovery or a risk: useful, and labelled as untrusted. A superseded memory is not returned
by default.

A memory with a **source** goes stale when that file changes. A stale memory is still
returned — knowing what was decided is useful — but it is marked, and it may not be acted on
as a fact.

`handoff` records what happened in a session: what was done, what is blocked, what is next.
`resume` reads the last handoff back. A handoff is a **session report, not an architecture
fact** — it never becomes a decision by being read.

### `pi.graph`

Queries the code graph. Actions: `symbol_search`, `neighbors`, `references`, `callers`,
`importers`, `impact`, `related_tests`.

```json
{ "action": "importers", "query": "BoardStore" }
```

Every node cites a file and a line. Every result states its completeness, and the
`callers` and `references` actions are **supersets** — no adapter proves a binding, so
they say so rather than pretending to be a call list.

### `pi.context`

The evidence pack: the code most likely to answer a question, within a token budget.

```json
{ "query": "where is the board store defined", "budget_tokens": 1500 }
```

Each candidate carries a file, a line, a snippet, a confidence and **why it was
selected**. The budget defaults to 1 500 tokens and is clamped to 300–6 000. When the
pack is cut it says so; an empty pack distinguishes *cut by the budget* from *nothing
scored*.

---

## The commands and the skill

The tools are the **agent's** surface. The commands are the **person's**.

### The commands

Six slash commands, registered through `ctx.command.transform`:

| Command | What it does |
|---|---|
| `/pi-board` | The task board, what is waiting, and what to do next. |
| `/pi-next` | The next task, its acceptance criteria, and the checks it needs. |
| `/pi-blockers` | The tasks waiting for a dependency, and on what. |
| `/pi-review <task>` | A task's evidence against its acceptance criteria. |
| `/pi-handoff [task]` | The last handoff, so a session can pick up where one left off. |
| `/pi-list` | The project's tasks with their states. |

**A command reports the rules; it never makes them.** The state machine decides what a task
may be, the evidence rules decide whether it is done, and the trust model decides which
memory is a constraint. A command only *reports* what those already decided, and it says
the reasoning — so `/pi-review` tells you the evidence is stale rather than moving the
task, and it never offers to mark anything done.

The commands are a **shortcut into the tools**, not a second implementation. Everything
they show comes from the same functions the tools call, so they cannot drift from the
rules.

### The skill

One skill, `project-intelligence`, registered through `ctx.skill.transform`. It is loaded
**on demand**, so a project that never uses OPI pays nothing for it. It tells the agent
what OPI is for, when to reach for it, and — importantly — what *not* to do with it: don't
read a whole file to answer a question, don't treat a graph edge as a proven call, don't
mark a task done because you believe the work is correct.

### The dashboard

An **optional** local web app. It is a separate process the user starts:

```
bun run packages/adapter-opencode/scripts/dashboard.ts <project-dir>
```

The plugin does not open a port, and the product works without it. The dashboard reads
through the plugin's `opi` RPC — the same stores the tools read — so the browser and the
agent cannot disagree about what a task is or whether it is done.

It binds `127.0.0.1`, mints a random token per start, and requires that token on every
`/api/` route. **It sends no CORS headers**, so a cross-origin page cannot read a response
or set the token header. The page's content security policy is `default-src 'none'`: it
loads nothing from the network.

A card's **verification badge comes from the task's evidence state, never from the column
it is in**. A card in Done whose checks failed says so.

---

## What does not exist yet

| Planned tool | State | Depends on |
|---|---|---|
| `pi_metrics` | not started | OPI-044. Aggregates, not transcripts. |

---

## Conventions every tool follows

- **The project is never an argument.** The scope comes from OpenCode's location. A tool
  takes no path, no project id and no directory — a model cannot ask for another
  project's data.
- **Structured output.** Every tool returns JSON with a `schema_version`, a `status`
  (`ok` / `partial` / `stale` / `error`), `data`, `warnings`, `sources` and `truncated`.
- **Confidence is explicit.** Results that rest on a parse say `syntactic`; results that
  rest on a proven binding say `resolved`. Nothing is claimed more strongly than it is
  known. See [ADR-0020](adr/0020-the-plans-lsp-dependency-does-not-exist.md) for why
  `resolved` is currently unreachable for call edges.
- **Nothing is silently dropped.** A file with no adapter, an import that does not
  resolve, a pack that exceeds its budget — each is reported, not omitted.

---

## The shape of the tool surface is not settled

[ADR-0018](adr/0018-tool-surface-decided-by-measurement.md) proposes measuring whether
one tool per namespace (with an `action` argument) or one tool per action is cheaper.
The current three tools are a **hybrid**: `pi_status` and `pi_graph` use the action
form, `pi_context` is single-purpose.

The measurement has not been made, so this may change. See
[`docs/bench/tool-surface-results.md`](bench/tool-surface-results.md) for why the first
attempt did not settle it.

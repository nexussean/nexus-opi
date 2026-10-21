# The kanban plugin: absorb the data model, keep the package

**Date:** 2026-10-21. This is the analysis behind owner decision **O-5** in
[`release-readiness.md`](release-readiness.md).

The question: should the `opencode-kanban` plugin be absorbed into OPI, ship
alongside it, or be deferred?

**Recommendation: absorb the data model, keep the package.** The kanban
plugin's JSON store, column model and state machine are retired; the plugin
becomes a second surface over OPI's `SqliteTaskStore`, the way OPI's own
dashboard already is. The TUI, the card→session link and `kanban.start` are
the parts worth importing — and they are exactly what OPI lacks.

Nothing was changed to reach this conclusion. It is an analysis of the two
codebases as they stand.

---

## 1. What the kanban plugin is today

`opencode-kanban` is a server plugin (`src/index.ts`) plus a separate TUI
plugin (`src/tui.tsx`). It registers five namespaced tools — `kanban.list`,
`kanban.add`, `kanban.update`, `kanban.remove`, `kanban.start`
(`src/tools.ts:44-202`) — over an RPC contract of six methods and three
events (`src/rpc.ts:58-185`).

**Its data model is JSON, not SQLite.** A `Board` holds `version`,
`columns[]` and `cards[]` (`src/board/types.ts:27-31`); a `Card` holds
`id`, `title`, `body`, `status`, `priority`, `labels`, `sessionID`, `order`
and three timestamps (`src/board/types.ts:11-25`). Columns are **data, not an
enum** (`src/board/types.ts:64-70`). The board lives in
`<projectRoot>/.opencode/kanban.json`, written atomically through a
temporary file and a rename, with mutations serialised by a promise queue
(`src/board/store.ts:68-104, 249-254`).

**There is no history.** `update` mutates the card in place and overwrites
the old values (`src/board/store.ts:151-189`); `remove` deletes the row
(`:206-218`). Only `createdAt`, `updatedAt` and `completedAt` survive, on
the current card. There is no event ledger, no actor, and no revision.

**There is no state machine.** `status` is a free-form string, and `move`
accepts any existing column id (`src/board/store.ts:191-204`). The only
conditional in `#applyMove` is renumbering `order` and stamping
`completedAt` when the target column is marked `done` (`:224-245`).

**There are two real UIs.** The TUI is a full-page board panel with a
`<leader>k` / `<leader>p` keymap, card editing, and live session status and
cost badges (`src/tui.tsx`, `src/ui/board.tsx:28-79`). The web UI is a
`Bun.serve` on 127.0.0.1 with a per-run token, no CORS, and every read and
write proxied through the plugin's RPC rather than reading the store
(`src/web/server.ts:97-113`).

**It has no release process at all.** `git rev-parse` reports *not a git
repository*; there is no `.github/`; the README is literally `# probe`; the
package has no `repository`, `homepage` or `bugs` field. Its own board
lists 13 open defects, including *"Initialize a git repository"* and *"Add
npm repository metadata and finish publish prep."*

---

## 2. The overlap in purpose

The concepts map cleanly, and mostly one-to-one:

| kanban `Card` | OPI `Task` | |
|---|---|---|
| `id` | `publicKey` | OPI's key is human-typed and unique per project |
| `title` | `title` | direct |
| `body` | `description` | direct |
| `status` (a column id) | `state` | 4 of 6 map 1:1 |
| `priority` (low/medium/high/urgent) | `priority` (0–3) | the mapping already exists in OPI's bench harness |
| `labels` | `type` | OPI's nearest analogue |
| `createdAt` / `updatedAt` | `createdAt` / `updatedAt` | direct |
| — | `acceptance` | OPI-only: what "done" means |
| — | `verification` | OPI-only: the evidence state |
| — | `revision` | OPI-only: every write states the revision it read |
| — | `projectId` / `worktreeId` | OPI-only |
| — | `task_edges` | OPI-only: blocks / parent / related, with cycle detection |
| — | `task_events` | OPI-only: the append-only ledger |
| `sessionID` | — | **kanban-only** |
| `order` | — | **kanban-only** |
| `completedAt` | — | replaceable by `state=done` + verification |

**The state machines are not comparable.** OPI's is a real FSM with an
explicit transition table (`packages/core/src/task/machine.ts:51-58`):
`backlog → ready | in_progress | archived`, `ready → in_progress | backlog |
archived`, `in_progress → review | ready | archived`, `review → done |
in_progress | archived`, `done → in_progress | archived`, `archived → ∅`.
Moving to `done` additionally requires verification evidence of `passed`,
`waived` or `not_configured`, or a waiver carrying an actor, a reason and a
scope (`machine.ts:81-154`). OPI deliberately removed a `blocked` state and
derives blocked-ness from `blocks` edges instead (`machine.ts:41-50`).

**The history difference is the sharpest.** OPI's `task_events` table is
append-only, with a per-task monotonic `sequence`, an `actor`, an
`operation`, a `changes_json` payload and an `evidence_ref`
(`packages/db/src/task-migrations.ts:67-77`). It is written inside the same
transaction as every mutation (`packages/db/src/tasks.ts:279-309, 364-377,
483-511`) and is exposed as `pi_task action=history`
(`packages/adapter-opencode/src/task-tool.ts:505-509`). The kanban plugin is
current-state-only.

---

## 3. The overlap in mechanism

| Capability | kanban | OPI |
|---|---|---|
| SQLite | **No** — a JSON file | Yes — `registry.sqlite`, WAL, foreign keys on, a 5 s busy timeout |
| Project registry | **No** — no reference to `projectId`, `registry` or `worktree` anywhere in `src/` | Yes — `projects`, `worktrees`, `project_aliases`, with relink |
| Worktrees | No | Yes — git common-dir, worktree and submodule resolution |
| Session link | **Yes** — `sessionID` on a card, and `kanban.start` creates a session and prompts it (`src/tools.ts:168-201`) | **No** — OPI has no session↔task concept at all |
| Code indexing | **No** | Yes — `packages/retrieval`, tree-sitter grammars, a watcher, a symbol graph |
| Release gate | **None** | 701 tests over 58 files, a three-OS CI workflow, migrations, a candidate manifest |
| Board UI | TUI **and** web | web only — there is no TUI plugin, and ADR-0017 calls a terminal board "a secondary surface" |

**OPI has no TUI plugin at all.** ADR-0017 says the board UI is a local web
app, and that a terminal board is "a **secondary** surface … never the
product surface" (`docs/adr/0017-the-board-ui-is-a-local-web-app.md:29-37`).

---

## 4. The overlap in queries — and it is a strict superset

**OPI's `pi_task action=list`** returns the tasks filtered by state, the
**waiting list** (tasks blocked by a dependency), the **next** task to work
on, per-task verification state, the revision, and `blocked_by`
(`packages/adapter-opencode/src/task-tool.ts:377-387` →
`packages/core/src/task/service.ts:129-153`). `formatBoard`
(`packages/core/src/command/index.ts:47-108`) already renders the
column-grouped view. The commands `/pi-board`, `/pi-list`, `/pi-next`,
`/pi-blockers` and `/pi-review` exist
(`packages/adapter-opencode/src/commands.ts:55-97`).

**The kanban plugin's board query** is `kanban.list` → `store.read()` →
`formatBoard(board, {status, id})` (`src/tools.ts:53-74` →
`src/board/format.ts:43-64`), plus a board summary injected into the system
prompt (`src/tools.ts:206-212`) and a `/kanban-summary` command.

So: **there is no kanban query that OPI does not already answer, and there
are three that the kanban plugin cannot answer** — what is blocked, what is
next, and what is verified. A kanban board has no dependency model at all.

**And the collision is already measured, in OPI's own documentation.**
`docs/bench/comparable-projects.md:19-32` records a live catalog ranking
probe:

| Query | Top hits | `pi.task` |
|---|---|---|
| `list cards on the board` | `kanban.list`, `browser.*.list` | **8th** |
| `kanban board card create move column priority` | `kanban.remove`, `kanban.add` | **8th** |
| `card` | `kanban.*` | **not in the top 8** |
| `task` | — | **1st** |

OPI's own diagnosis: *"`pi.task`'s description says 'Work with the project's
task board.' It never says **card**. The competing board plugin's tools say
'List kanban cards.'"* OPI has already responded by putting the word "card"
into the descriptions (`packages/adapter-opencode/src/descriptions.ts:178-204`).

The cost is measurable too: a wider catalog gives a model more to explore.
Under the six-tool shape, minimax called `task_list` **10, 15 and 10 times
for one question**, against **9 calls across 3 runs** for the single tool
(`docs/bench/tool-surface-results.md:263-284`).

One caveat, stated plainly: the bench's "separate" arm is a **fixture**
modelled on the kanban plugin's shape, not the real plugin
(`packages/bench/harness/board.ts`). The real competing-catalog condition
has never been run — that experiment is specified and unrun
(`docs/bench/tool-surface-results.md:700-701`).

---

## 5. The arguments

### Why absorb, not separate

1. **OPI's architecture already forbids the alternative.**
   `docs/architecture/reconciliation.md:107` lists *"a second board store"*
   under **Exclude**, and `:22` says *"Preserve it as the authoritative task
   system."* Shipping separately creates the excluded thing; absorbing
   removes it. This is not a new preference — it is a decision OPI has
   already written down.

2. **Absorption removes queries rather than adding them.** `pi_task list`
   already answers "what's in progress", "what's blocked" and "what's
   next", each with evidence and a revision. There is nothing for a second
   board tool to add.

3. **What the kanban plugin uniquely contributes is UI and session linkage —
   exactly what OPI lacks — not a data model.** OPI has no TUI plugin, and
   no session↔task link. Those are the two things to import.

4. **The maturity asymmetry makes absorption cheap and separation
   expensive.** OPI has a release gate, migrations, and 701 tests. The
   kanban plugin has ~50 tests, no git repository, no CI, and a README of
   `# probe`. It is the thing that should be absorbed, not the absorber.

### What absorption would cost, concretely

| Kanban concept | OPI's situation | The decision it forces |
|---|---|---|
| Custom columns | OPI's `state` is a hard `CHECK` constraint (`packages/db/src/task-migrations.ts:31-33`) | drop configurability, or add a mapping layer |
| The `todo` column | no counterpart | map to `ready` (or keep `backlog`) |
| String priorities | OPI uses integers 0–3 | `low→0 … urgent→3`; the bench harness already does exactly this (`packages/bench/harness/board.ts:69-73`) |
| `order` (position in a column) | no counterpart; OPI orders by `priority DESC, created_at ASC, public_key ASC` (`packages/db/src/tasks.ts:190-197`) | a new field, if drag-order matters |
| `labels` | no counterpart; nearest is `type` | map or drop |
| `sessionID` | no session concept at all | a new column **and** a new task API |
| `completedAt` | replaceable | `state=done` + `verification` |

### Why not defer

O-5 has been open across at least two release-readiness reviews, and the one
experiment that would settle it is specified but unrun — and would cost
model spend. Deferring keeps the catalog collision live and unmeasured.

If a data point is wanted first, the **cheap** version needs no model spend
at all: re-run the catalog ranking probe with both plugins installed, and
see whether `pi.task` still ranks below `kanban.*` for card and board
queries. That measures the collision without paying for a benchmark run.

---

## 6. The recommendation, stated as a boundary

**Retire** kanban's `BoardStore`, its JSON file, its column model and its
free-form state machine. **Import** the TUI, the card→session link and
`kanban.start`. **Keep** the store, the state machine, the audit trail, the
revisions, the evidence and the project scoping in OPI, where they already
work and are already tested.

The kanban plugin then becomes what OPI's dashboard already is: a surface
over `SqliteTaskStore`, reached through the same RPC, so there is one
authoritative board and one set of answers.

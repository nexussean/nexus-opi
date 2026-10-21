# ADR-0026: The dashboard reads through the plugin's RPC, and it is optional

**Status:** Accepted
**Date:** 2026-10-20
**Affects:** OPI-039, OPI-040, OPI-041, T-09, T-10
**Related:** [ADR-0017](0017-the-board-ui-is-a-local-web-app.md), [ADR-0025](0025-a-command-reports-the-rules-it-does-not-make-them.md)

## Context

The plan's P7 is seven tickets and 10–15 days: a loopback API with browser auth, a
dashboard shell, kanban interactions, a lazy graph explorer, memory and quality panels, a
metrics panel, and a metrics page.

The product currently has **no visible surface**. The tools work and a person can only
see them by reading JSON. The commands fix the *acting* half of that; the dashboard is
for *watching*.

Two things make this much cheaper than the plan's estimate:

- **The kanban plugin already has a working web board** — 718 lines, drag-and-drop, a
  live event stream, and a security model that already satisfies most of doc 06's
  dashboard controls: loopback bind, a random token, auth on every `/api/` route, and
  **no CORS headers at all**, which is exactly what T-09 asks for.
- **The board proxies to the plugin's RPC.** The browser and the agent therefore share one
  source of truth, and the dashboard cannot become a second source of truth that drifts.

The risk is that P7 becomes a large, underused project — seven tickets of visualisation
of data nobody has looked at.

## Decision

### The dashboard is a **read-mostly view over the plugin's RPC**

The plugin registers an RPC definition. The web server proxies to it. The browser never
talks to SQLite and never talks to the plugin's internals.

The methods are the ones the plan's information architecture needs, and no more:

| Method | What it returns |
|---|---|
| `overview` | The project, its tasks, the next action, the blockers, the index health, the gates. |
| `board` | The board: columns, cards, and the waiting list. |
| `task` | One task: acceptance criteria, dependencies, evidence, history. |
| `memory` | The decisions, the proposals, and the superseded records — separately. |
| `quality` | The gates, their runs, and whether each run is still valid. |

**Mutations go through the same rules.** A card drop calls the same `transition` the tool
calls, with the same expected-revision check. The dashboard does not get a shortcut, and
it cannot move a task the agent could not.

### The dashboard is **optional**, and the product does not depend on it

The plan says it plainly: "The dashboard is optional; functionality remains accessible
through native OpenCode tools and commands." It also says "Avoid running an additional
large daemon until the dashboard is opened unless profiling justifies it."

So: **the web server is a separate process the user starts.** It is not started by the
plugin, it does not run in the background, and the plugin does not know whether it exists.
Opening the dashboard is a deliberate act.

### The board has no "Blocked" column, and that is deliberate

The plan's board has six columns: Backlog, Ready, In Progress, **Blocked**, Review, Done.

OPI's task model has no `blocked` state, on purpose (ADR-0022's neighbourhood, and the
plan's own note): *"The UI may show waiting for dependency without changing the task's
recorded state to blocked."* A task that is waiting for a dependency is still `backlog` —
it has not been blocked by a decision, it is simply not ready yet.

So the dashboard **shows the waiting list as a distinct visual state** on the Backlog
column, rather than as a column of its own. The plan's requirement — that a person can
see which tasks are waiting and why — is met. The plan's *column layout* is not, and the
difference is that a card's recorded state and its displayed state are the same thing.

### The dashboard never claims more than the core knows

- A card shows a **verification badge** from the task's evidence state, never from the
  column it is in. A card in Done that is unverified says so.
- The quality panel shows the **exact gate command**, the run id, the timestamp, and
  whether the run has since been invalidated.
- The memory panel shows **`Confirmed by`**, **`Verified against`**, **`Proposed`** and
  **`Superseded`** — the four trust labels, kept apart.

The plan's rule — "never claim verified based on visual column alone" — is the rule the
whole dashboard is built around.

### The security controls are the kanban plugin's, and they are tested

| Control | How |
|---|---|
| Bind | `127.0.0.1` by default. Never a public interface. |
| Auth | A random token per start, required on every `/api/` route. |
| CORS | **No CORS headers are sent.** A cross-origin page cannot read a response, and cannot set the custom header without a preflight that is never approved. |
| Path traversal | The dashboard never takes a path from the request. The project comes from the process's own configuration. |
| Secrets | The dashboard reads project state. It never returns a token, a password, or a file outside the project. |

T-09 and T-10 are the two threat-model requirements that belong to the dashboard, and
both are properties of *not doing something* rather than of a check.

## Consequences

**Good.**

- The dashboard is a **view**, not a second implementation. It cannot drift from the
  rules, because it has no rules of its own.
- The kanban plugin's board and its security model are reused rather than rewritten.
- The product gains a visible surface for a fraction of the plan's estimate, and the
  remaining P7 tickets (the graph explorer, the metrics page) stay optional.

**Bad, and accepted.**

- The dashboard shows **one project at a time**. The plan's `/projects` page, with a
  project switcher, is not in this increment. The process is started in a directory, so
  it knows its project.
- **No drag-and-drop with optimistic rollback.** The kanban board's drag-and-drop is
  reused through the RPC, but the plan's "optimistic UI with server-side revision check
  and rollback on conflict" is a later increment. The RPC carries the revision, so the
  server-side check is there; the *optimistic* half is not.
- The **graph explorer and the metrics page are not built.** They are the two most
  expensive parts of P7 and the two with the least evidence of need.

**What this does not decide.**

- Whether the board's frontend is the kanban plugin's HTML or a rewrite. This ADR
  assumes the former, and the assumption is what makes the estimate a day rather than
  two weeks.
- Whether the metrics page is worth building at all. OPI-044 has to land first, and
  until there are metrics to show, a page about them is a page about nothing.

## Alternatives rejected

| Alternative | Why not |
|---|---|
| Build the plan's full P7 | Seven tickets, 10–15 days, of visualisation. The evidence says the tools, the commands and one board cover the need. |
| The dashboard reads SQLite directly | Two readers of the same database, one of which can write. The dashboard would need the same rules the core has, and would drift from them. |
| The plugin starts the web server | The plan says not to run a daemon until the dashboard is opened. A plugin that opens a port on every project load is a surprise, and a liability. |
| Add a `blocked` task state | It would duplicate the dependency graph in a second place, and the two would disagree. The plan explicitly says the UI may show waiting without changing the recorded state. |
| A "Blocked" column in the dashboard | It would be a column of cards whose recorded state is `backlog` — the same drift, in the UI. The waiting list is shown as a state on the card instead. |
| Trust the column to show verification | The plan forbids it. A card dragged to Done with failing checks would read as done, which is the exact lie ADR-0022 exists to prevent. |

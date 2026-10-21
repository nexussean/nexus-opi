# What comparable projects do, and what it tells us about OPI's surface

**Why this is here.** The benchmark found that OPI's tool surface costs **6.7×** the
single-tool shape and **1.5×** having no tool at all — and that the cost is
**discovery**, not schema: 9 discovery steps against the fixtures' 0.

Discovery is a solved problem, and four other projects have solved it. This note
records what they do and which of it applies to OPI.

---

## The finding in one sentence

**The model searches the catalog for what the question says, and takes what comes
first.** OPI's tools are not found because the *words people use* ("card", "board")
are not in OPI's tool descriptions, and because another plugin's tools **are** — and
rank higher.

Measured on the live catalog, with the queries a model actually issues:

| Query | Top hits | `pi.task` |
|---|---|---|
| `list cards on the board` | `kanban.list`, `browser.*.list` ×4 | **8th** |
| `change card priority` | `kanban.update`, … | **2nd** |
| `kanban board card create move column priority` | `kanban.remove`, `kanban.add`, … | **8th** |
| `show me the board` | `session_rename`, `pi.memory`, `browser.*` | **not in the top 8** |
| `card` | `kanban.*` | **not in the top 8** |
| `task` | — | **1st** |

OPI's own `pi.task` description says *"Work with the project's task board."* It never
says **card**. The competing board plugin's tools say *"List kanban cards"* and *"Update
a kanban card"*. For a question about cards, the other plugin wins.

**A vocabulary test proved this is not the whole story.** Prompts saying "card" and
prompts saying "task" both reached `pi.task` successfully. What differs is *how
much exploration happens before* the call — and a wider catalog gives a model more to
explore.

---

## What the other projects do

### Hermes Agent — 14 separate `kanban_*` tools, one namespace

> `kanban_show`, `kanban_list`, `kanban_complete`, `kanban_request_review`,
> `kanban_request_changes`, `kanban_block`, `kanban_heartbeat`, `kanban_comment`,
> `kanban_attach`, `kanban_attach_url`, `kanban_attachments`, `kanban_create`,
> `kanban_link`, `kanban_unblock`

The **shape** is the opposite of what the benchmark favours — 14 tools, not one. But
notice the **names**: every one is `kanban_<verb>`, and every one is about the *same*
thing. A model that wants to list cards searches "kanban list" and every hit is
relevant.

Three transferable ideas:

1. **One namespace, one subject.** The model searches a *domain* and gets a set of
   tools that all answer questions about that domain. There is no ambiguity about
   which tool is for cards, because they are all for cards.
2. **The name is the discovery surface.** `kanban_list` is findable by the words
   "kanban" and "list". `pi.task` is findable by the word "task" — and not by "card".
3. **The model is told to use the tools, not the shell.** Hermes is explicit: *"The
   model reads and routes tasks by calling tools directly, not by shelling out to
   `hermes kanban`."* That is the failure we measured: the model shelled out.

Hermes also keeps a **second front door for humans** — a CLI, a slash command, and a
dashboard — over the same database. The agent surface and the human surface do not
drift, because they share a layer.

### OpenClaw Workboard — a plugin, driven by RPC, not by tools

A board plugin with cards, boards, labels, comments, dependencies, artifacts,
diagnostics and lifecycle events. Three ideas that bear on us:

1. **Explicit write guard.** Every write takes an `expectedUpdatedAt`; a stale write
   fails with a conflict and returns the current card. We have this
   (`expected_revision`) and it is worth keeping.
2. **Diagnostics as first-class.** `stranded_ready`, `running_without_heartbeat`,
   `blocked_too_long`, `repeated_failures`, `missing_proof`, `orphaned_session`. The
   board tells you when it is in a bad state. We have `pi.status` but not this.
3. **Templates with pre-filled content.** `bugfix`, `docs`, `release`, `pr_review`.
   A card that starts from a template is a card that is already well-formed.

### OpenClaw Code Mode — a **hidden catalog** with search and describe

> "Most useful for agents with a large enabled tool catalog, or workflows where the
> model needs to search, combine, and call several tools before answering."

This is the direct answer to our problem. OpenClaw does **not** put every tool's full
schema in the prompt. It gives the model a *compact index* and two controls:

- `catalog.search(...)` → returns **callable handles**, not schemas
- `handle.describe()` → the exact schema, on demand

The model pays for a tool **when it uses it**, not on every request. And:

> "Remote descriptions and schemas stay out of the trusted quick index."

They also report the *measurement* discipline we are adopting:

> "Small catalogs are measured rather than assumed to benefit from compaction."

**OpenCode already has this.** Code Mode's `search()` is exactly `catalog.search()`.
We can call it today. The benchmark's discovery metric is the instrument that measures
whether it is being used well.

### kanban-workflow (skill) — verbs, canonical stages, and "What next?"

A TypeScript skill that defines a canonical stage model (`backlog`, `blocked`,
`in-progress`, `in-review`), a set of verbs (`show`, `next`, `start`, `update`, `ask`,
`complete`, `create`), and — the useful part — **every command prints a "What next:"
tip** telling the agent the canonical next step.

> `setup → next → start → ( ask | update ) → complete → next`

The idea that applies to us: **the tool tells the agent what to do next.** A tool that
returns a result *and* the next action is cheaper to use than one that returns a
result and leaves the agent to guess.

### The rest

- **agent-kanban** (dyh) — a dashboard skill, for monitoring agents. Not a
  tool-surface answer.
- **vibe-kanban-mcp** — an MCP server driven through a CLI (`mcporter`). The right
  lesson is the **verb-per-operation** naming: `list_organizations`,
  `list_projects`, `list_issues`, `create_issue`, `update_issue`.

---

## What applies to OPI

Ranked by what the measurement says the cost is.

### 1. Own the vocabulary, in the description, not in the name

`pi.task` is findable by "task" and not by "card". The question was about cards. The
fix is one line in the description, and it is worth measuring.

This is the highest-value, lowest-cost change, and it is **testable today** with the
catalog search.

### 2. Say the domain in every one of the tool's actions

Hermes's `kanban_list` and `kanban_create` both carry "kanban". OPI's `pi.task`
carries "task" in its own name but its *actions* are `list`, `get`, `create`,
`update`, `transition`, `link`, `unlink`, `history`, `delete` — nine words that mean
nothing on their own. A model searching "create card" should find it.

### 3. A tool that finds the right tool

OpenClaw's answer is a platform-level hidden catalog. We do not need a platform
change: we need a tool that **answers "which of my tools do I want?"** — and Code
Mode's `search()` already exists, if only the model uses it.

### 4. Return the next action with the result

`kanban-workflow`'s "What next:" tip. A `pi.task` result that says *"3 tasks are
ready; the next is PI-0031"* costs the model no extra round trip. We have the data
for this — the board already knows what is ready.

### 5. The name is a last resort, and it is not ours to change alone

`pi.task` cannot be renamed to `pi.card` without knowing how the product's own
language is meant to read. "Task" is the right word for a work item with acceptance
criteria, verification evidence and a review state; "card" is the right word for a
sticky note. The **description** can carry both. That is the cheap fix, and it is
the one that does not make a product decision by accident.

---

## What does not apply

- **14 tools.** The benchmark says the opposite: the single-tool shape was better on
  every axis. Hermes can afford 14 tools because they are all one domain; OPI's six
  are six domains, and merging them would make one very large schema.
- **A separate board product.** OPI is not a board; it is project intelligence that
  happens to have a task board. The board is one of six things it does.
- **A CLI front door.** We have commands and a dashboard, which is the same idea.

---

## The honest limit

None of this has been measured yet. The research says what the shape of the problem
is; the benchmark is the instrument that says whether a change fixes it. Every item
above is a **hypothesis with a test**, and the tests are cheap: the catalog search
for the ranking, and one benchmark run over the `opi` shape for the cost.

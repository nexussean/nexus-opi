# ADR-0025: A command reports the rules; it does not make them

**Status:** Accepted
**Date:** 2026-10-20
**Affects:** OPI-032, W1, W5, W6
**Related:** [ADR-0022](0022-done-is-unverified-when-no-gates-are-configured.md), [ADR-0024](0024-a-memory-is-trusted-by-confirmation-not-by-content.md)

## Context

The plan's OPI-032 acceptance criterion is *"commands/skills work"*, and the plan lists
eight slash commands:

| Command | Behaviour |
|---|---|
| `/pi-board` | Summarize active board and blockers; link to local UI |
| `/pi-plan <goal>` | Propose scoped tasks/dependencies; explicit acceptance before extensive writes |
| `/pi-next` | Explain highest ready task and required validation |
| `/pi-impact <symbol-or-path>` | Show affected symbols/files/tests with uncertainty |
| `/pi-handoff` | Persist concise evidence-backed continuity state |
| `/pi-review` | Evaluate current task's evidence; no forced Done |
| `/pi-doctor` | Diagnose plugin, project, parser, LSP, SQLite, ignore rules, permissions |
| `/pi-dashboard` | Show local dashboard URL; start server only when requested |

The plan also says: *"The commands instruct the agent to call tools but the system must
still be usable without them."* That is the constraint that shapes this.

OPI had six tools, a durable store, an evidence model and a memory model — and **no way for
a person to reach any of it** except asking an agent to call a tool and reading the JSON.
The plan's W1 — "resume any project and see the next task, blocked tasks, known decisions" —
was unreachable.

## Decision

### A command is a prompt a person can run

A slash command gathers what OPI knows and hands it to the agent, with the **reasoning
included**. It is not a UI and it is not a rule engine.

The commands are registered through `ctx.command.transform`, which is part of the verified
OpenCode V2 plugin surface (the compat doc, §190). The skill is registered through
`ctx.skill.transform` (§191). Both are recorded as working in the Phase 0 spike.

### A command reports the rules; it never makes them

This is the important part. A command does not decide what a task may be, whether it is
done, or which memory is a constraint. The **state machine** decides what a task may be.
The **evidence rules** decide whether it is done. The **trust model** decides which memory
is a constraint.

A command only *reports* what those rules already decided, and it says the reasoning:

- `/pi-next` names the next task, states its evidence, and lists the checks it needs.
- `/pi-review` reports whether the evidence is current. It **never forces `done`**. The
  plan says "no forced Done" and this is where that is enforced.
- `/pi-board` shows the waiting list before the ready list, because a blocked task is the
  thing a person needs to know about.

If a command could set a state, it would be a second path around the state machine — and
the state machine is the thing that keeps the board honest.

### The commands are additive, not load-bearing

The plan says the system must be usable without them. Every command is a **shortcut into
the tools**: it gathers context and asks the agent to act, and the agent acts through
`pi.task`, `pi.verify` and `pi.memory` as usual. A command that fails is a lost
convenience, not a lost capability.

### Nothing is injected into a prompt

A command produces text for the session the person is already in. It does not add
instructions to a system prompt, and it does not run on its own. The plan's prohibited
anti-pattern — "copying every remembered decision into every prompt" — is avoided by
construction: a command says what it says, once, to the person who asked for it.

### The skill is the agent's guide, and it is small

One skill, loaded on demand, that tells the agent what OPI is for and when to reach for
it. The plan says "a small global `SKILL.md` loaded on demand rather than a large always-on
`AGENTS.md`". It is not a script: the agent calls the tools.

## Consequences

**Good.**

- A person can now see the board, the next task, the blockers and a task's evidence
  without reading JSON.
- The commands cannot drift from the rules, because they do not implement the rules — they
  call the same functions the tools call.
- The plugin is usable by the tools alone, which is what the plan asks for and what keeps
  the dependency on the command API non-critical.

**Bad, and accepted.**

- A command's output is a snapshot. It says "this is the next task" as of the moment it
  ran, and it goes stale like anything else.
- The commands are **chatty**. `/pi-next` prints several lines of reasoning, which is
  right for a person and wrong for a machine. The tools are the machine surface.
- The command set is a **second surface to keep in step** with the tools. A tool that
  changes may need its command to change with it.

**What this does not decide.**

- Whether `/pi-dashboard` should start a server. The plan says "start server only when
  requested", and that is a P7 decision, not this one.
- Whether `/pi-plan` may create tasks without confirmation. The plan says "explicit
  acceptance before extensive writes", and the plan's own model requires it.

## Alternatives rejected

| Alternative | Why not |
|---|---|
| Put everything in an `AGENTS.md` | The plan says a small on-demand skill, not a large always-on file. An always-on file is prompt cost on every turn for every project, including the ones that never use OPI. |
| Have the commands call the tools over RPC | A needless round trip through the model's own tool surface. The plugin has the data already, and calling its own functions directly is simpler and more honest. |
| Let `/pi-review` offer to mark the task done | The plan says "no forced Done", and a command that transitions is a second path around the state machine. The agent can transition; the command reports. |
| One command that takes a verb | The plan's eight commands are the vocabulary a person learns. A verb parameter is the plan's `pi_task` design, and it has a tool for it. |
| Skip the commands and build the dashboard | The dashboard is for watching; the commands are for *acting*. A person who wants to know what to do next does not want to start a web server. |

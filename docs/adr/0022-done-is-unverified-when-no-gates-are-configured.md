# ADR-0022: `done` is recorded as unverified when no gates are configured

**Status:** Accepted
**Date:** 2026-10-20
**Affects:** OPI-011, OPI-012, OPI-013, OPI-014, OPI-033–038
**Related:** [ADR-0008](0008-the-board-is-separate-from-agent-runtime.md) (plan), [ADR-0021](0021-the-index-is-persisted-and-watched.md)

## Context

The plan's task state machine ends with:

```
review --> done: verified or explicitly waived
```

and the security doc says:

> `done` requires passing required gates on the relevant worktree revision and acceptance
> criteria reviewed as appropriate; or recorded waiver with actor, reason, scope and timestamp.
>
> `unverified`, `not_run`, `failed`, `stale`, `waived` and `passed` are distinct states; no false
> passing indication.

The problem is a **sequencing** one. The verification service (P6, OPI-033–038) does not exist
yet. If the task engine is built to the letter, then:

- No gate can ever pass, because there are no gates to run.
- Therefore `done` can never be reached without a recorded waiver.
- Therefore every task that a human completes by hand needs a waiver.
- A waiver on every task is noise, and a board where every card needs a waiver is a board
  nobody trusts.

The alternative — build the task engine with a `done` transition that requires nothing — is
worse. It produces exactly the "board that lies" the plan's own risk R14 warns about.

There is a third option the plan already gestures at:

> Quality gates are configured per project; defaults perform **detection only**, not execution.

A project with **no gates configured** has no gate requirements. A task in such a project is
not failing a gate; it is in a project that has not expressed any gate policy.

## Decision

**A task records its verification state separately from its workflow state.**

`tasks.state` is the workflow position: `backlog`, `ready`, `in_progress`, `review`, `done`,
`archived`.

`tasks.verification` is the evidence state, and it is one of:

| Value | Meaning |
|---|---|
| `not_configured` | The project has no gate policy. Nothing was required, so nothing can be missing. |
| `not_run` | Gates are configured; none has been run against this revision. |
| `passed` | All required gates passed on this revision. |
| `failed` | A required gate failed. |
| `stale` | A gate passed, but the code or config changed since the run. |
| `waived` | A human waived the requirement, with actor, reason, scope and timestamp. |

**The rules.**

1. **A task reaches `done` only when `verification` is `passed` or `waived`** — *except* when
   the project's gate policy is empty, in which case `verification` is `not_configured` and
   `done` is allowed.
2. **`not_configured` is a distinct state from `passed`.** A task in a project with no gates
   is not "verified"; it is in a project that has not said what verification means. The
   distinction is what stops `not_configured` from being read as a pass.
3. **The transition to `done` is refused** when `verification` is `not_run`, `failed` or
   `stale`, and the refusal says which gate is outstanding.
4. **A `done` task with `verification = not_configured` is reported as unverified** wherever
   it is listed, not as done-and-clean. The board and `pi_task.get` both say so.
5. **The gate policy is a per-project setting**, and it is **empty by default**. Nothing is
   executed, ever, without a registered gate.
6. **The waiver is a first-class, attributed record** — actor, reason, scope, timestamp — and
   it is in the task's event history, not a boolean on the task.

## Consequences

**Good.**

- The task engine can ship before the verification service, and the two fit together without
  a migration.
- When P6 lands, it fills in `not_configured` → `not_run` → `passed`/`failed`/`stale` and
  nothing else has to change. The state machine already has the vocabulary.
- The board never lies: a task that says "done" either has passing evidence, a recorded
  waiver, or an explicit "unverified — this project has no gate policy" marker.
- The plan's metric — "unverified completion rate, target 0 except signed waiver" — becomes
  measurable and reportable from day one rather than aspirational.

**Bad, and accepted.**

- A task can be `done` without any evidence, as long as the project has no gates. This is
  the deviation from the plan, and it is deliberate: the alternative is a board where every
  card needs a waiver.
- The distinction between `not_configured` and `passed` has to be carried through every
  surface that shows a task. A surface that collapses them reintroduces the lie.
- The plan's "done requires verified or waived" is now conditional on project configuration.
  That condition is stated in the tool output, not assumed.

**What this does not decide.**

- Whether P6's default for a **new** project should be "no gates" (this decision) or
  "detect-only gates that can never pass" (the plan's literal reading). The second makes
  `done` unreachable without a waiver, so this ADR chooses the first. If the plan's owner
  disagrees, the change is one line in the gate policy default plus a migration of existing
  `not_configured` tasks.

## Alternatives rejected

| Alternative | Why not |
|---|---|
| `done` requires passing gates, always | No gate can pass before P6 exists, so every task needs a waiver. A waiver on every card is noise, and a board nobody trusts is the plan's own R14. |
| `done` requires nothing | The board says "done" and means "someone moved a card". This is the failure the plan set out to avoid. |
| `done` means "done", with verification as a separate field nobody reads | A field that is not surfaced is not a constraint. It would be a note, not a gate. |
| Build P6 before P2 | P6 needs the task engine to attach evidence to. It is the larger and riskier piece — arbitrary command execution — and building it first means building it against a task model that does not exist yet. |

## Revisit condition

P6 lands, and the gate policy gains a non-empty default.

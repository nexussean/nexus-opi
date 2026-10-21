# The security test coverage register

**Date:** 2026-10-21. **Release follow-up:** T-13 remains experimental and
unverified against the live runtime. Commands are now withheld by default;
raw retention requires a separate opt-in. T-01 attribution uses only the envelope
and checks workspace identity. See [audit policy](audit-policy.md); the original
coverage descriptions below are evidence of unit behavior, not a complete audit
guarantee.

 Every test requirement in
[`threat-model-v2.md`](threat-model-v2.md) §4, and where it is satisfied.

This register exists because a count of unit tests is not a coverage
register. The question is not "how many tests are there" but "which named
requirement does each test hold, and what would have to be true for it to
fail".

## The register

| ID | Test | Where | What the test holds | Kind |
|---|---|---|---|---|
| **T-01** | Cross-project event leakage | `packages/adapter-opencode/test/security-t01.test.ts` | The shipped configuration **does not subscribe** to the event stream. Exactly one module can, and it is opt-in. The registry holds no record from another project, and the project id is derived from the root, never supplied. | structural + behavioural |
| **T-02** | Event payload discipline | `packages/adapter-opencode/test/security-t020304.test.ts` | The user-content event kinds are **named only in the drop list**, and the drop runs before the payload is read. No persisted schema holds a transcript, reasoning or tool-input column. | structural + durable |
| **T-03** | Omitted location | `packages/adapter-opencode/test/security-t020304.test.ts` | The project identity comes from the plugin's own context. The RPC resolves from the plugin's root, not from the call. A directory that is not a project is **refused, not guessed**, and a directory outside the boundary does not resolve. | structural + behavioural |
| **T-04** | Model-supplied path | `packages/adapter-opencode/test/security-t020304.test.ts` | A traversal in a task body round-trips **verbatim as data** and resolves to nothing. The index never reads a file outside its root — a symlink out is skipped. The graph's `path` is a **parameterised lookup key**, never a filesystem path. The index refuses to serve a root it was not built for. | behavioural |
| **T-11** | Uninstall | `packages/db/test/security-t11.test.ts` | Every path OPI writes is under the data directory. Removing that directory leaves the user's code **byte for byte**. The plugin's footprint inside the project is empty. There is **no** uninstall or purge command, so a wipe would have to be added deliberately. | behavioural |
| **T-12** | Silent plugin failure | `packages/adapter-opencode/test/security-t12.test.ts` | The plugin records the surface it actually registered, and records it **even when the surface is empty**. The doctor reports the plugin's own state, reports a missing index as `partial` with a stated reason, and an unresolvable directory is an **error, not an empty success**. | structural + behavioural |
| **T-13** | Audit completeness | `packages/adapter-opencode/test/security-t13.test.ts`, `security-audit-source.test.ts` | The inner `shell` call is recorded **with its command**. A truncated batch is recorded as incomplete **on every entry**, so a reader cannot see one line and think the batch was complete. Only the command is kept from a tool's input. The trail is opt-in and records **model-initiated** activity only. | behavioural |
| **T-14** | Project isolation under concurrency | `packages/db/test/security-t14.test.ts`, `concurrent-processes.test.ts` | A task is only readable through its own project. **Two OS processes contend on one database**, 40 rounds each, produce no cross-project reads and no cross-project writes. The audit ledger does not mix. The per-project databases remain independent across a close and reopen. | behavioural |

The six that were already covered — T-05, T-06, T-07, T-08, T-09, T-10 —
are in `packages/core/test/verify.test.ts`, `evidence.test.ts`,
`completion.test.ts` and `packages/adapter-opencode/test/dashboard.test.ts`.
They are **preserved**; the register does not replace them.

## What was built for this

Two modules, because T-13 needed a capability that did not exist.

### `packages/adapter-opencode/src/audit.ts`

The audit trail itself. It records the **model-initiated** tool calls and
whether the batch was truncated.

The truncation rule is the requirement's own: a truncated batch is recorded
as incomplete, **on every entry**, so a reader who sees one line cannot
conclude the batch was complete.

A tool's input is reduced to its **command** before it is written. A shell
call's command is kept, because an audit that does not say what was run is
not an audit; every other field is dropped, because a tool input can carry a
file's contents, a token or a prompt.

The trail requires `OPI_EXPERIMENTAL_AUDIT=1` and `OPI_AUDIT_LOG`.
`OPI_AUDIT_INCLUDE_COMMANDS=1` additionally enables raw command retention;
otherwise commands are withheld and T-13 command capture is not satisfied.

### `packages/adapter-opencode/src/audit-source.ts`

The trail's source, and the reconciliation with T-01.

**The tension.** T-01 forbids the plugin from reading another project's
payloads, and the event stream is server-wide. T-13 needs the event stream,
because the inner Code Mode tool calls are **only** there — a hook on
`execute.before` sees one `execute` call with a `code` string under it.

**The reconciliation.**

1. The audit is **opt-in**. A product plugin never subscribes, so T-01's
   structural property holds in the shipped configuration.
2. When it is on, it **filters before it parses**: an event whose location
   is not the plugin's own is dropped without its payload being read
   (C1.1).
3. It drops `session.text.*`, `session.reasoning.*` and
   `session.tool.input.*` **by name**, before reading them (C1.3).

The **order** is the safety argument, so it is asserted directly: the drop
is before the directory filter, and the directory filter is before the read.

## The limits of this register

- **These are unit and integration tests, not a penetration test.** They
  hold the properties the threat model names. They do not claim that no
  other path exists.
- **T-13's trail has not been exercised against a live Code Mode session.**
  The reading of the batch is tested against the shapes the runtime has
  used, and the event shape has changed across runtime versions. The
  reading is **defensive** — it accepts only the top-level location envelope
  and refuses an event it cannot attribute — but a live run has not
  confirmed it.
- **T-01's behavioural half is about the registry.** The event stream is
  server-wide and the plugin does not read it by default, so the
  behavioural test is about the persisted state, which is what survives.
- **T-14 now includes two OS processes and a held write transaction.**
  This passed locally on macOS; Windows/Linux CI remains pending.

## The evidence

The suite, in full:

```
bun run check
```

which typechecks every package and runs every test. The exact result is
recorded in the [release-readiness report](../../docs/release/release-readiness.md).

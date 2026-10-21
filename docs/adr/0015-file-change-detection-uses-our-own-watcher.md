# ADR-0015: File-change detection uses our own filesystem watcher, with tool events as a fast path

- **Status:** Accepted (rationale revised 2026-10-19 after the tool-failure probe;
  implemented 2026-10-20, see [ADR-0021](0021-the-index-is-persisted-and-watched.md))
- **Date:** 2026-10-19
- **Evidence:** `docs/compatibility/opencode-v2.md` §5, §6
- **Affects:** OPI-016, OPI-021, OPI-029, W4, P3

## Context

The plan's hook matrix relies on `file.edited` and `file.watcher.updated` to invalidate the
index after a source edit (W4).

In OpenCode 2.0.28:

- `file.watcher.updated` **does not exist** in the event schema.
- `file.edited` **exists** in the schema (`data: { file: string }`) but **did not fire** during
  either probe session in which the agent used the `edit` tool to modify a file. The file
  changed on disk; zero `file.*` events appeared in 1 666 captured events.

Tool *hooks* are also blind to the inner calls: under Code Mode they observe a single
`execute` call carrying a `code` string, not the `edit`/`read`/`shell` calls inside it.

Tool *events*, however, are not blind. `session.tool.success` carries
`metadata.toolCalls`, which lists every inner call with its name, input and status — including
calls rejected by schema validation:

```json
"metadata": { "toolCalls": [
  { "tool": "echo", "status": "error", "input": { "value": 42 } },
  { "tool": "echo", "status": "error" },
  { "tool": "echo", "status": "completed", "input": { "value": "ok" } }
], "truncated": false }
```

## Decision

The indexer owns file-change detection, with the tool event stream as an optimisation:

1. **Primary: a plugin-owned filesystem watcher** over the resolved project root, honouring
   the ignore and exclusion policy before hashing, with paths normalised to worktree-relative
   form. The watcher is `node:fs.watch` — Bun 1.4.2 has no `Bun.watch`.
2. **Fast path: the tool event stream.** `session.tool.success.metadata.toolCalls` gives the
   exact `write`/`edit`/`patch` calls a model made, so the affected paths can be re-hashed
   immediately instead of waiting for the watcher.
3. **Authoritative: content hashes.** A tool call is a *request*, not a completed change, and
   the watcher sees every writer. Freshness metadata is always derived from the hash.

The watcher stays primary because tool events cover only **model-initiated** edits. They miss:

- edits the user makes in their editor,
- `git checkout`, `git revert`, branch switches,
- formatters, codegen and build tools,
- any other process writing into the tree.

## Consequences

- The indexer owns a watcher, its debounce policy, and a periodic reconciliation scan.
- The tool stream gives a *fast hint*; the hash gives the *truth*. A tool call that fails or
  is never applied must not mark a file dirty on its own.
- `metadata.toolCalls` is truncated for very large batches (`truncated: true`). A truncated
  batch cannot be trusted as a complete list — the watcher still catches what it misses.
- The same primitive gives the benchmark its **malformed-call metric**: inner calls with
  `status: "error"` are exactly the malformed or rejected calls ADR-0018 needs.
- **The watcher reports debounced _batches_, not individual paths.** A burst of edits is one
  unit of work. The indexer re-reads a set of files, not a stream of them.
- **The watcher uses the project's own ignore rules**, via the same filter the inventory uses,
  so a file the indexer would skip never generates an event.

## Implementation

Implemented in [ADR-0021](0021-the-index-is-persisted-and-watched.md):
`packages/retrieval/src/watcher.ts` (the watcher), `reindexPaths()` in
`packages/retrieval/src/persistent.ts` (the targeted reindex), and a 5-minute
reconciliation sweep in `packages/adapter-opencode/src/index.ts`.

## Alternatives

- **Use `file.edited`.** Rejected: it did not fire for a real tool-driven edit, twice.
- **Rely on the tool event stream alone.** Rejected: it misses every non-model writer, and it
  observes requests rather than outcomes.
- **Parse Code Mode `code` strings.** Rejected: brittle, and unnecessary — the event stream
  already resolves the inner calls.
- **Re-index the whole tree on every session boundary.** Rejected: too slow for the p95
  targets, and it loses the incremental property.

## Revisit condition

OpenCode emits a reliable, location-scoped file-change event.

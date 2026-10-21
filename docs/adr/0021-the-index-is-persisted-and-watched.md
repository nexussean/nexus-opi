# ADR-0021: The index is persisted per worktree and watched, not rebuilt on every start

**Status:** Accepted
**Date:** 2026-10-20
**Supersedes:** part of [ADR-0015](0015-file-change-detection-uses-our-own-watcher.md)
**Touches:** OPI-020, OPI-021, OPI-029

## Context

Until now the index behaved correctly but uselessly in practice:

- It lived **in memory**. Every plugin start walked the whole tree and re-parsed
  every file.
- Nothing ever called `refresh()`. The method existed, was tested, and was
  never wired to anything.
- There was **no watcher at all**. The index could not notice a file changing,
  so `pi.context` and `pi.graph` returned results that were silently stale
  from the moment the user opened their editor.

The gap was invisible in tests and obvious in use. The plan's W4 — "after a
source edit, files touched and dependent nodes are marked dirty" — was not
implemented at all.

The measurement that motivated the change:

| Operation | Cost |
|---|---|
| Full build (59 files, 2 046 symbols) | 216 ms |
| `refresh()` with nothing changed | 5 ms |
| Targeted reindex (1 file of 200) | 2 ms |
| Full refresh (200 files) | 9 ms |

The machinery was cheap. It simply was not connected.

## Decision

1. **The index is a per-worktree SQLite database** under the data directory,
   not an in-memory structure. It survives a restart, so a restart costs a
   refresh rather than a rebuild.

2. **The key is the worktree's own directory**, not the project id. Every
   worktree of a project shares the project id, so keying on it would let two
   worktrees with different contents share one index.

3. **A plugin-owned `node:fs.watch` reports debounced *batches* of changed
   paths.** `Bun.watch` does not exist in Bun 1.4, so the watcher is
   `node:fs.watch`. This corrects ADR-0015, which named the wrong API.

4. **`reindexPaths()` re-reads only the reported files.** It never walks the
   tree, so cost is proportional to the change rather than to the repository.

5. **A periodic reconciliation sweep** (5 minutes) runs a full `refresh()`.
   A watcher can miss events — a checkout, an editor that renames a tree, a
   write outside the watched root. The sweep is what makes the index
   *eventually* correct rather than *usually* correct.

6. **The watcher uses the project's own ignore rules**, via the same
   `buildPathFilter` the inventory uses. A file the indexer would skip never
   generates an event.

## Consequences

**Good.**

- A restart reuses the index. Verified live: epoch 2 survived a restart rather
  than reverting to epoch 1.
- Edits are visible within about a second. Verified live: a new file moved
  the index from 24 to 25 files and epoch 1 to epoch 2; a deletion moved it
  back to 24 files and epoch 3.
- The index is correct after a missed event, not just after a caught one.

**Bad, and accepted.**

- A stale index is now a *reachable* state that the reconciliation sweep
  exists to repair. The window is bounded by the sweep interval.
- The index database is real state on disk. It is derived data, so deleting it
  is safe, but it now needs the same deletion discipline as the registry.

**New failure mode found while implementing this.**

The first attempt keyed the index path on the project id and put it in a
`<dataDir>/indexes/` directory that nothing created. SQLite creates the
database *file* but not the *directory*, so the plugin failed to load with
`SQLiteError: unable to open database file` — at plugin setup, which is the
worst possible moment, and it took the whole tool surface down with it.

The fix is threefold: the database layer creates its own parent directory, the
adapter creates the data directory before opening anything, and there is a
regression test that opens an index in a directory that does not exist.

The lesson is worth recording: **a failure in the index is a failure of the
plugin.** The index is not optional to loading; a plugin that cannot open its
database cannot offer any tools at all. The index must degrade to empty
rather than prevent load.

## Alternatives rejected

| Alternative | Why not |
|---|---|
| Keep the index in memory, rebuild on start | A 216 ms rebuild is survivable, but the staleness is not. A user who edits a file and immediately asks a question gets the old answer with no indication that it is old. |
| Watch with the tool event stream only | Tool events cover only model-initiated edits. They miss the user's own editor, which is the common case. ADR-0015. |
| `Bun.watch` | Does not exist in Bun 1.4.2. Verified: `typeof Bun.watch === "undefined"`. |
| Report each changed path individually | A burst of three edits produced four callbacks. The plan says "debounced change **batches**", and the indexer re-reads a *set* of files. |
| Rebuild the whole index on any change | Correct, but the cost is proportional to the repository instead of to the change. |

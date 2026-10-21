# ADR-0016: Directory plugins resolve entrypoints by path, not by the exports map

- **Status:** Accepted
- **Date:** 2026-10-19
- **Evidence:** `docs/compatibility/opencode-v2.md` §9
- **Affects:** OPI-002, OPI-047 (installers), global install

## Context

OpenCode's `Host.resolve({ directory })` resolves a plugin's entrypoints by **file path**:
`<dir>/index.ts` for the server entrypoint, `<dir>/tui.tsx` for the TUI entrypoint,
`<dir>/rpc.ts` for the RPC contract. It does **not** consult the package's `exports` map when
the target is a directory.

A package resolved by **name** (an npm install) *does* use the `exports` map.

The first attempt at the compatibility spike kept the implementation in `src/index.ts` with
`exports: { ".": "./src/index.ts" }`. The plugin loaded **silently and never** — no error, no
log line, the tool simply absent from the model's tool list.

## Decision

The published package ships **root-level shims** that re-export the implementation:

```
index.ts   -> export { default } from "./src/index.ts"
tui.tsx    -> export { default } from "./src/tui.tsx"
rpc.ts     -> export { Kanban } from "./src/rpc.ts"
```

The `exports` map points at those same root files, so the package behaves identically whether
it is installed by name or linked by path.

Installers and the compatibility fixture assert that all three entrypoints resolve. A plugin
that fails to resolve must **fail loudly**, never silently.

## Consequences

- The package has three files at its root that exist only to re-export. They are covered by
  the contract test so they cannot rot.
- The global install path (a symlink or directory under `~/.config/opencode/plugins/`) works
  identically to the npm path.
- Any future entrypoint kind needs its own root shim.

## Alternatives

- **Put the implementation at the package root.** Rejected: it flattens the source tree.
- **Ship compiled JS instead of TypeScript.** Rejected for now: OpenCode runs Bun and loads
  TypeScript directly; compiling adds a build step to every consumer. Revisit if a
  non-Bun client ever needs to load the plugin.

## Revisit condition

OpenCode changes directory-plugin resolution to consult the `exports` map.

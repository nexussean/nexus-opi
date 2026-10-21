# The tree-sitter peer conflict: analysis and resolution

**Date:** 2026-10-21. Recorded before the fix, so the analysis is on the
record and not reconstructed afterwards.

## The conflict

The retrieval package declared:

```json
"tree-sitter": "^0.25.1",
"tree-sitter-typescript": "^0.23.2",
"tree-sitter-go": "^0.25.0"
```

The three grammars do not agree on which `tree-sitter` they want:

| Package | Peer requirement | Satisfied by `0.25.1`? |
|---|---|---|
| `tree-sitter-typescript@0.23.2` | `tree-sitter@^0.21.0` | **no** |
| `tree-sitter-javascript@0.23.1` (transitive) | `tree-sitter@^0.21.1` | **no** |
| `tree-sitter-go@0.25.0` | `tree-sitter@^0.25.0` | yes |

**There is no single `tree-sitter` version that satisfies all three.** The
TypeScript and JavaScript grammars are stuck on the `0.21` line, and the Go
grammar moved to `0.25`.

## Why it was not visible

Bun's workspace install **resolved the conflict silently**: it placed
`tree-sitter@0.25.1` at the top and the grammars underneath, and the
grammars worked. The conflict only shows in a **packaged install**, where
the peer requirement is checked.

A clean install of the same three packages in an empty directory reports:

```
+ tree-sitter@0.25.1
+ tree-sitter-go@0.25.0
+ tree-sitter-typescript@0.23.2

Blocked 2 postinstalls. Run `bun pm untrusted` for details.
```

The `tree-sitter-javascript` grammar is pulled in by
`tree-sitter-typescript` and has a peer range that `0.25.1` does not
satisfy. The workspace hid it; a packaged install would not.

## The constraint set, solved

The `tree-sitter-go` line that keeps the `0.21` peer:

| `tree-sitter-go` | Peer requirement |
|---|---|
| `0.23.0` | `tree-sitter@^0.21.0` |
| `0.23.1` | `tree-sitter@^0.21.0` |
| `0.23.2` – `0.23.4` | `tree-sitter@^0.21.1` |
| `0.25.0` | `tree-sitter@^0.25.0` |

`tree-sitter-javascript@0.23.1` needs `^0.21.1`, so the consistent set is:

```json
"tree-sitter": "^0.21.1",
"tree-sitter-typescript": "^0.23.2",
"tree-sitter-go": "^0.23.4"
```

Every peer requirement is then satisfied, **with no peer validation
bypassed** and **no language dropped**.

## Why Go moves and TypeScript does not

`tree-sitter-typescript` has **no release after `0.23.2`**. Its peer range
is `^0.21.0` and that is not going to change. `tree-sitter-go` has a
`0.23.4` that predates its `0.25.0` and keeps the `0.21` line.

So the `0.21` line is the one both can live on, and Go is the package that
has to move.

## What this does **not** do

- **It does not bypass peer validation.** The set is consistent, so no
  `--legacy-peer-deps` flag, no `overrides` block, and no
  `peerDependenciesMeta` escape is needed. The installer is left to do its
  job.
- **It does not drop a language.** TypeScript, TSX, JavaScript and Go are
  all still parsed, and the verification in
  [`release-readiness.md`](../../docs/release/release-readiness.md) proves
  it from an isolated install.
- **It does not change the JavaScript grammar.** The project uses the
  TypeScript grammar for JavaScript by design, and says so in
  `packages/retrieval/src/grammar.ts` and in the TypeScript adapter. That
  decision is unchanged.

## The native build

Both grammars need `node-gyp-build` to compile their native addon, and Bun
**blocks lifecycle scripts** by default. A packaged install therefore
needs the grammar packages to be trusted:

```
bun pm trust tree-sitter-go tree-sitter-javascript
```

or, in CI, `bun pm --trusted` at install time. This is a property of Bun's
supply-chain default, not of the conflict, and it is recorded in the
release-readiness report as a deployment step.

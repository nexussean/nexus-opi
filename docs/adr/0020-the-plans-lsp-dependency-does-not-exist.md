# ADR-0020: The plan's LSP dependency does not exist in OpenCode V2

- **Status:** Accepted
- **Date:** 2026-10-20
- **Affects:** OPI-023, OPI-017, OPI-022, P3, P4
- **Evidence:** `docs/compatibility/opencode-v2.md`, and the source check below

## Context

OPI-023 is *"Add optional LSP resolution spike — Opt-in, versioned, degrades when server
missing"*, and ADR-004 picks Tree-sitter *"plus optional LSP resolution"*. The plan treats LSP
as an available enrichment for reference resolution, with Tree-sitter as the base.

The premise needs checking, because the whole justification for the `syntactic`/`resolved`
distinction rests on it.

## What the source says

Checked against the OpenCode repository at `dev` on 2026-10-20, and against the published
`@opencode/plugin@2.0.32`, `@opencode/client@2.0.32` and `@opencode/schema@2.0.32`:

| Surface | LSP present? |
|---|---|
| `@opencode/plugin` (the plugin API) | **No.** No `lsp` symbol anywhere in the published package. |
| `@opencode/client` | **No.** |
| `@opencode/schema` | A `lsp.updated` event and a `LspEvent.Definitions` inventory exist. |
| `packages/core/src` | **No LSP implementation.** `grep -rln "lsp" packages/core/src` matches only a models snapshot, a config normaliser, a skill document and a tool description. |
| `packages/core/src/lsp/` | **Does not exist.** There is no `lsp.ts`, no `LanguageClient`, no `textDocument/definition` call anywhere in the repository. |

The `lsp.updated` event is **declared and never produced**. The docs page
(`packages/web/src/content/docs/lsp.mdx`) describes configuring `lsp` servers, and the config
schema accepts the setting — but no code acts on it.

So OpenCode V2 has an LSP *configuration surface* and no LSP *implementation*. A plugin
cannot ask OpenCode for definitions or references, because there is nothing to ask.

## Consequences

1. **OPI-023 as written cannot be done.** There is no OpenCode LSP to opt into, and the plan's
   fallback — "degrades when server missing" — would mean degrading to *always*.

2. **The `resolved` confidence level is currently unreachable through LSP.** It would have to
   come from a resolution OPI implements itself, or from a different mechanism entirely.

3. **`pi_graph.callers` stays a documented superset.** The plan's rule that it "never claims
   complete without resolved binding" is satisfied by labelling it `partial` and saying why.
   That is the honest position, and it is what the tool now does.

## Decision

**Do not build an LSP client inside OPI.** Instead:

1. Keep the confidence vocabulary. `syntactic` is what a grammar can prove. The `resolved`
   level stays in the type system and stays unused until something can prove it — which is
   exactly the discipline the plan asks for when it says "never report `calls` as resolved if
   only a token/string match exists".

2. **Resolve bindings ourselves, narrowly.** A symbol reference can often be resolved
   *within* the project without a language server: a name imported from a known module
   resolves to that module's export, because the index already knows both. This is a **module
   resolution**, not a type resolution, and it is honest — it is `resolved` for the import
   edge, and it remains `syntactic` for the call site.

3. **If a language server is wanted later, it is a separate process OPI starts itself**,
   opt-in per project, with a versioned configuration. That is a real project with its own
   failure modes, and the plan's own risk register calls LSP "unreliable" and "optional".
   It is not a spike; it is a feature, and it should be scoped as one when there is evidence
   it is worth it.

4. **Record the finding as a compatibility fact**, so nobody else spends a week looking for
   an LSP client that is not there.

## Alternatives

- **Vendor an LSP client (`vscode-languageserver-protocol`) and speak LSP ourselves.**
  Rejected for now: it means managing a language-server process per project, a versioned
  configuration per language, and a fallback for every language that has no server. The
  benefit over a module-level resolver is precise call-graph edges, and the plan's own
  language-coverage policy already says "LSP is optional and may add accuracy where
  installed; **not** assumed present across every host".
- **Wait for OpenCode to implement LSP.** Sensible, and the reason this ADR exists: it is not
  available, and building against it would be building against a plan.

## Revisit condition

OpenCode ships an LSP implementation that plugins can query, or OPI decides to build its own
language-server integration as a scoped feature rather than a spike.

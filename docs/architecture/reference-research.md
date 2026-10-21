# Reference research and compatibility limits

Checked 2026-10-20. External descriptions are design references, not proof that OPI has
implemented a capability. Repository claims below were checked at documentation level;
no external concurrency/security implementation audit was performed.

## OpenCode

Context7 resolved OpenCode to `/anomalyco/opencode`, with a `v2.0.32` documentation
version available. Separate queries examined V2 plugin lifecycle/permissions and session
creation/dispatch/recovery. The pinned V2 documentation describes registration in setup,
scoped domain APIs, and durable prompt admission. This supports using an adapter rather
than implementing another agent runtime.

- [V2 plugin API](https://github.com/anomalyco/opencode/blob/v2.0.32/services/www/src/docs/content/build/plugins/index.mdx)
- [V1 migration guide](https://github.com/anomalyco/opencode/blob/v2.0.32/services/www/src/docs/content/build/plugins/migrate-v1.mdx)
- [V2 session contract](https://github.com/anomalyco/opencode/blob/v2.0.32/specs/v2/session.md)

One Context7 session result referenced the moving `dev` branch despite the versioned
query. Treat that result as a lead, not a pinned contract. Confirm idempotent dispatch,
permissions, cancellation, and location handling with installed types and live probes
before using them for admission/recovery guarantees. The repository's own
[compatibility observations](../compatibility/opencode-v2.md) remain the evidence for
its tested builds. The user's confirmed desktop 2.1.0→2.1.1 update explains the previous
benchmark's disappearing executable; it does not certify every 2.1.1 integration API.

## Paperclip

The [primary repository](https://github.com/paperclipai/paperclip) describes atomic
checkout/execution locks, persistent task context, wake queues, isolated workspaces,
approval workflows, and budget policies. It also acknowledges that recorded usage and
in-flight requests can delay budget enforcement. These are useful reference concepts
for OPI's task/attempt separation, reconciliation, and admission policy. They do not
justify importing its organizational hierarchy or assuming its locking semantics match
OPI's SQLite/runtime boundaries. Implementation correctness must be demonstrated locally.

## Swarm references

[OpenCode Swarm](https://github.com/ZaxbyHub/opencode-swarm) describes guarded worktree
lanes, phased review, and explicit opt-in orchestration. Its documentation also distinguishes
V2 adapter behavior and remaining live-host verification. This supports staged validation,
not assuming compatibility merely because both products say “OpenCode.” OPI should use
its own task DAG, provenance and verification rather than importing a second plan/board.

The supplied [Oh My OpenCode link](https://github.com/code-yeongyu/oh-my-opencode)
redirected to [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent). Record that
as reference drift. No capability or compatibility guarantee is inferred from the old
name, and no implementation dependency is added.

## Evidence rule

Use checked primary docs to identify candidate interfaces; installed types to compile;
version-pinned probes to establish observed behavior; adversarial tests to support the
specific guarantee. Marketing text, search ranking, successful registration, and a single
happy-path run do not establish fencing, authorization, or recovery correctness.

# Release readiness — NO GO (two gates cleared)

Updated 2026-10-21, later the same day. Candidate 0.1.0, prepared locally,
**not published**.

**What changed:** the tree-sitter peer conflict is resolved, the isolated
install now succeeds, and the SBOM and audit are regenerated. The two gates
that were **blocked** on the dependency conflict — *package installation* and
*dependency resolution / SBOM* — are now **passed**. The other four gates are
unchanged. The overall verdict is still **NO GO**, because the remaining
gates are not about dependencies.
The owner selected a cross-platform release requiring macOS, Linux, and Windows
CI. The full schema remains the default. No optimization matrix was run.

The [previous report](release-readiness-before-artifact-audit.md) is historical;
its “ready to publish” conclusion is superseded by the isolated artifact checks.

## Confirmed defects and changes

- The npm `files` allowlist omitted `packages/`, despite the entry point importing
  that directory. The allowlist now includes the shipped code and manifest.
- The copied dashboard executable imported `../src/web/server.ts`, which does not
  exist in the bundle. Its import now points to the bundled adapter.
- Runtime dependencies used by retrieval were absent from the release manifest.
  The builder now gathers all shipped packages' external production dependencies,
  pins their installed versions, and rejects version conflicts. Workspace-linked
  imports are only a preliminary smoke check, never proof of a working install.
- The inventory now covers all first-party bundle files, including the entry point,
  launcher, package manifest and changelog, with full SHA-256 hashes. The inventory
  excludes itself; the packed tarball has its own full SHA-256 in the artifact report.
- Audit attribution previously searched payload fields before filtering. It now
  accepts top-level envelope location only and checks workspace identity too.
  A getter-trap regression test checks that a foreign workspace payload is untouched.
- Code Mode auditing requires an experimental opt-in. Commands are withheld unless
  separately enabled; log size/access controls and failure warnings were added.
  See [the audit policy](../security/audit-policy.md). Live T-13 compliance is not claimed.
- A real two-process test now contends on a held SQLite write transaction and checks
  project-isolated results and task histories. The old Promise.all test was sequential.
- **The tree-sitter peer conflict is resolved.** The three grammars disagreed about
  which `tree-sitter` they wanted, and no single version satisfied all three:
  `tree-sitter-typescript@0.23.2` needs `^0.21.0`, the transitive
  `tree-sitter-javascript@0.23.1` needs `^0.21.1`, and `tree-sitter-go@0.25.0`
  needs `^0.25.0`. The Go grammar moved to the `0.23` line, which keeps the
  `0.21` peer; the TypeScript grammar stayed, because it has no release after
  `0.23.2`. The declared set is now `tree-sitter@^0.21.1`,
  `tree-sitter-typescript@^0.23.2` and `tree-sitter-go@^0.23.4` — consistent,
  with **no peer validation bypassed and no language dropped**. The full
  analysis is in [the peer-conflict note](tree-sitter-peer-conflict.md).
- The release manifest's dependencies are now **derived from the workspace**
  rather than copied by hand. The hand-copied list is how the conflict
  survived: the workspace moved to `tree-sitter@0.21.1` and the manifest still
  said `0.25.1`, and the packaged install was the only place it showed.

## Release commands

| Command | Purpose |
|---|---|
| `bun run check` | Workspace typechecks and test suite |
| `bun run release:pilot` | Existing MVP acceptance pilot in temporary data |
| `bun run release:recovery` | Legacy registry/task upgrade, failed migration transaction, exact backup restore |
| `bun run release:build` | Construct the distributable directory |
| `bun run release:verify` | Pack, inspect, extract outside the repo, install dependencies, import plugin, build launcher, SBOM and audit |
| `bun run release:isolated` | Pack the bundle, install the tarball into an **empty** directory with peer validation left on, and parse TypeScript, JavaScript and Go **from the installed tree** |
| `bun run release:sbom` | The dependency audit and the SBOM, computed from the **installed** tree rather than the declarations |

`release:verify --diagnostic-peer-tree` may generate a diagnostic dependency graph
after a peer conflict. It **still exits nonzero** and cannot satisfy the release gate.
A diagnostic lockfile is not an approved release lockfile. The script does not publish.

The source manifest fingerprints packages, scripts, workflow definitions and lockfiles.
`release/evidence/artifact-check.json` identifies the exact tarball and available
validation. The dependency audit and license inventory have narrower scopes than a
complete security review. The secret pattern scan is deliberately labeled limited.

## Local verification results

- `bun run check`: **700 passed, 0 failed**, 58 test files; all workspace typechecks passed. The full run required localhost/watcher access outside the sandbox; the sandbox-only run failed those environment-dependent tests.
- `bun run release:pilot`: **13/13** passed using temporary project/data directories.
- `bun run release:build`: **11/11** passed. The manifest's version and dependencies are **derived from the workspace**.
- The three release scripts passed a separate strict TypeScript check.
- Recovery fixture: upgrade, original-row preservation, injected transaction failure and exact restore passed.
- Actual packed artifact: **87 files**, SHA-256 `42959686edcd5497b70e0e5e7b7cf09b77159d725e65beefe67e3c5d0ab0ea87`.
- Source manifest digest: `bb09cf1403ce5a04b0fa2c0932eb8790327a1fc48820c855e60f8cd909fd42ff`.
- **Isolated installation: passed.** The tarball installs into an empty directory with
  peer validation left on, with **no** `--force` and **no** `--legacy-peer-deps`.
  The installed tree is `tree-sitter@0.21.1`, `tree-sitter-typescript@0.23.2`,
  `tree-sitter-go@0.23.4` and the transitive `tree-sitter-javascript@0.23.1`, and
  **every peer requirement is met by the installed tree**.
- **The isolated check: 9/9 passed** (`bun run release:isolated`). The bundle packs
  into a tarball, the tarball installs into an **empty** directory, the install
  reports **no peer conflict**, and every installed package's `tree-sitter` peer
  requirement is met by the installed tree.
- **Parsing from the installed package: passed.** TypeScript, JavaScript and Go each
  parse from the installed tree — `root=program`, `root=program` and
  `root=source_file`, with named children in each case. No language was dropped.
- **The installed plugin loads: passed.** `id=opencode-project-intelligence`,
  `version=0.1.0`, a plugin object as the default export.
- Dependency audit: **passed**. Every peer requirement met, no declared-range
  violation, every licence known (MIT), computed from the **installed** tree.
- SBOM: **passed**. `release/sbom.json` (CycloneDX 1.5, 4 components) and npm's own
  `release/evidence/sbom.cdx.json` (269 components) are both generated.
- `npm audit`: **exit 0**, **zero** vulnerabilities at every severity.
- `release:verify`: `artifact-checks-passed`, `isolatedImport: true`,
  `sbomComplete: true`, `diagnosticPeerTree: false`, **`published: false`**.
- Limited packed-file secret pattern scan: no matches; this is not a comprehensive secret scan.
- GitHub repository lookup: the connection returned **404** for `nexussean/nexus-opi`. Repository existence versus access cannot be distinguished from that response. No hosted CI ran.

Detailed evidence is in `release/evidence/`. No package was published and no real
OpenCode configuration or user database was changed. Licensing is undecided;
`private: true` and `UNLICENSED` prevent an accidental npm publish of the candidate.

## Gates remaining

| Gate | Current state | Completion criterion |
|---|---|---|
| Package installation | **Passed** | A clean isolated install and a runtime import, with no dependency overrides. Met: the tarball installs into an empty directory, every peer requirement is met, the plugin imports, and TypeScript, JavaScript and Go all parse from the installed tree. |
| Dependency resolution / SBOM | **Passed** | Compatible tree-sitter peer declarations, a valid SBOM, and an audit of the final resolved graph. Met: the declared set is internally consistent, the audit is computed from the installed tree, the SBOM is generated, and `npm audit` reports zero vulnerabilities. |
| Hosted CI | **Pending** | Successful required macOS, Linux and Windows jobs on the same revision; workflow preparation alone is not platform evidence |
| Registry identity | **Owner input pending** | Confirm package name/scope and publishing owner; re-pack after metadata changes |
| Licensing | **Owner undecided** | Choose terms before publication; candidate is private/UNLICENSED, with no new license grant |
| Recovery | **Partial** | Run the rehearsal against a representative historical database copy; include memory and verification migrations and document the supported rollback boundary |
| Live compatibility | **Pending** | Exercise final isolated artifact on the supported OpenCode runtime/platforms; previous live evidence predates these changes |

**Resolved.** The clean npm install no longer rejects anything: the declared set
is `tree-sitter@^0.21.1`, `tree-sitter-typescript@^0.23.2` and
`tree-sitter-go@^0.23.4`, which is internally consistent. The Go grammar moved
to the `0.23` line, which keeps the `0.21` peer its sibling grammars need; the
TypeScript grammar stayed, because it has no release after `0.23.2`.

No `--force` and no `--legacy-peer-deps` was used, and no language was dropped:
TypeScript, JavaScript and Go all parse from the installed tree. The set is
pinned by `packages/retrieval/test/dependencies.test.ts`, which fails if a
future bump of one grammar breaks the others. The analysis is in
[the peer-conflict note](tree-sitter-peer-conflict.md).

## CI and distribution boundaries

`.github/workflows/release-checks.yml` defines PR, main, nightly and manual checks
on all three operating systems, uploads evidence even on failure, and has read-only
repository permissions. There is no publication job. The owner selected `nexussean/nexus-opi` as the target. This workspace has no `.git`
metadata or configured remote; hosted execution cannot be claimed locally.
The matrix covers OS families, not every CPU architecture or OpenCode version.
Browser e2e, broader runtime compatibility, resource testing, and a full secret
scanner remain outside this initial workflow and must be reconciled with P8 scope.

Only the combined bundle is intended for distribution. Private workspace packages
remain internal `0.0.0` build inputs; they are not individually published. See
[the changelog](../../CHANGELOG.md). Rust/Python parsing is not included; existing
TypeScript/JavaScript and Go adapters remain in the candidate.

## Recovery limitations

The automatic rehearsal uses a synthetic legacy registry/task database, verifies
pre-existing row values survive upgrade, injects a failed transaction, checks SQLite
integrity, and restores the snapshot to a new filename. `--source /path/to/copy.sqlite`
opens that source read-only and rehearses in a temporary directory. Original user
data is never migrated by this script. It is not a general reverse migration.
Stop all writers before operational restoration; replacing a database while old
WAL sidecars or connections remain is unsafe. No real database was rehearsed here.

## Decision

**Do not publish yet.** The dependency blockers are **cleared**: the isolated
install passes with peer validation on, all three languages parse from the
installed tree, the SBOM and audit are regenerated, and `npm audit` is clean.
What remains is **hosted CI on three platforms, a live run of the final
isolated artifact, a representative recovery rehearsal, and two owner
decisions** (registry identity and licensing). Keep the full schema default.
The experimental Code Mode audit is excluded from release security guarantees;
if complete T-13 auditing is required for P8, its live validation blocks P8 too.

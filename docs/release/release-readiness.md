# Release readiness — the technical gates

**Date:** 2026-10-21. **Candidate:** `opencode-project-intelligence` 0.1.0.
**Source revision:** `f120729` on `main`, pushed to the private
`nexussean/nexus-opi`.
**Artifact SHA-256:** `42959686edcd5497b70e0e5e7b7cf09b77159d725e65beefe67e3c5d0ab0ea87`.
**Published:** **no.** The candidate is `private: true` and `UNLICENSED`.

**Verdict: the technical gates are met on this platform. The hosted
three-platform CI was dispatched and every job was refused by the account's
Actions billing, and the owner decisions are outstanding.**

The previous report is preserved at
[`release-readiness-before-artifact-audit.md`](release-readiness-before-artifact-audit.md).
Nothing in it was rewritten; this report adds evidence for this candidate.

---

## 1. The gates

| Gate | State | Evidence |
|---|---|---|
| **Unit and integration suite** | **PASS** | 701 pass, 0 fail, 4 123 assertions, 58 files; every package typechecks. `bun run check`. |
| **Acceptance pilot** | **PASS** | 13/13. The plan's own MVP shipping checklist, in a temporary data directory. `bun run release:pilot`. |
| **Package installation** | **PASS** | The tarball installs into an empty directory with **npm and normal peer validation**. Every installed package's `tree-sitter` peer requirement is met by the installed tree. 9/9. `bun run release:isolated`. |
| **Installed parsers** | **PASS** | TypeScript (`root=program`), JavaScript (`root=program`) and Go (`root=source_file`) each parse **from the installed package**. |
| **Dependency audit and SBOM** | **PASS** | 6/6. Computed from the **installed** tree. Every peer requirement met, no declared-range violation, every licence known (MIT). `release/dependency-audit.json`, `release/sbom.json` (CycloneDX 1.5). |
| **Release artifact check** | **PASS** | `artifact-checks-passed`, `isolatedImport: true`, `sbomComplete: true`, `diagnosticPeerTree: false`, `npm audit` exit 0 with **zero vulnerabilities** at every severity, `published: false`. |
| **Recovery rehearsal** | **PASS** | 13/13 against a **copy of the real registry**. 36 project identities, 17 tasks and 19 task events preserved byte for byte; a controlled migration failure rolled back; the restore is exact; the source is unchanged. |
| **Live final artifact** | **PASS** | 12/12. The **packaged tarball** in a real OpenCode session, with a temporary configuration, temporary project and temporary data. `fixtures/acceptance/release/live-artifact.json`. |
| **CI rehearsal** | **PASS** | 9/9 local rehearsal of the workflow's steps, in the workflow's order. `release/evidence/ci-rehearsal.json`. |
| **Cross-platform CI (macOS, Linux, Windows)** | **BLOCKED — account billing** | The repository was created (private), the branch pushed and the workflow dispatched. All six jobs were refused by GitHub: *"recent account payments have failed or your spending limit needs to be increased."* See §3. |
| **T-13 live validation** | **NOT RUN** | The experimental Code Mode audit is disabled, as the plan requires. See §4. |
| **Registry identity** | **BLOCKED — owner** | The package name and scope are undecided. |
| **Licensing** | **BLOCKED — owner** | The candidate is `UNLICENSED`. No licence was selected. |

---

## 2. The exact checks performed

Every command, and what it returned.

| Command | Result |
|---|---|
| `bun run check` | **exit 0** — 701 pass, 0 fail, 4 123 assertions, 58 files, 22.4 s. Every package typechecks. |
| `bun run release:pilot` | **exit 0** — 13/13 steps. |
| `bun run release:build` | **exit 0** — 11/11 steps. The manifest's version and dependencies are **derived from the workspace**. |
| `bun run release:isolated` | **exit 0** — 9/9 steps. npm, peer validation on. |
| `bun run release:sbom` | **exit 0** — 6/6 steps. |
| `bun run scripts/verify-release.ts` | **exit 0** — `artifact-checks-passed`, `published: false`. |
| `bun run scripts/rehearse-migration.ts --source <copy>` | **exit 0** — 13/13 steps. |
| `bun run scripts/live-artifact-test.ts` | **exit 0** — 12/12 steps. |
| `bun run release:ci-rehearsal` | **exit 0** — 9/9 steps. |
| `bun run scripts/make-candidate.ts` | **exit 0** — 6/6 steps. The source digest matches the tree over 193 source files, and the candidate covers 195 files. |

### The live artifact test, in detail

One local session, on `darwin/arm64`, OpenCode `v2.1.2`, model
`ollama-cloud/deepseek-v4.1-flash`, artifact
`42959686edcd5497b70e0e5e7b7cf09b77159d725e65beefe67e3c5d0ab0ea87`.

| Check | Outcome |
|---|---|
| The packaged artifact installs | The tarball installed into a temporary directory |
| The plugin loads and its tools are called | `pi.status` called through the Code Mode wrapper |
| The six expected tools register, and no others | `pi.context`, `pi.graph`, `pi.memory`, `pi.status`, `pi.task`, `pi.verify` |
| A read works | A task created and listed; the key is the title's slug, `live-artifact-task` |
| A write works | The title updated; the revision advanced **1 → 2** |
| A revision conflict is refused | `"This task is at revision 2, not 1."` |
| Verification is enforced | The board refused `backlog → done`; the allowed path was required |
| An observable failure path | A write against a missing task: `"No task with that key."` |
| Context retrieval | `src/widget.ts`, symbol `makeWidget` |
| Graph retrieval | `src/widget.ts` (TypeScript) and `src/engine.go` (Go) |
| The index is for **this** project | 3 files indexed for `/private/var/folders/lf/gjpczfx55cd5ypnzpqd1mbmr0000gn/T/opi-live-iZQH8T/project` |

**Scope:** one local session on one platform. It does **not** establish
cross-platform live compatibility, and it does not claim to.

---

## 3. The cross-platform CI gate — dispatched, and blocked by the account

**The repository was created (private), the branch was pushed, and the
workflow was dispatched. The jobs did not start.**

| Check | Result |
|---|---|
| `gh repo create nexussean/nexus-opi --private` | Created. `visibility: PRIVATE`, `isPrivate: true` |
| `git push -u origin main` | Pushed. 279 files; no database, key or `.env` file was pushed |
| `gh workflow list` | `Release checks (no publication)` — **active** |
| `gh api …/actions/permissions` | `enabled: true` |
| The workflow dispatch | Run `39669805379` |
| The push-triggered run | Run `39669757531` |
| **All six jobs, both runs** | **failure** — and they never started |

GitHub's own annotation, on every job:

> The job was not started because recent account payments have failed or
> your spending limit needs to be increased. Please check the 'Billing &
> plans' section in your settings.

**This is an account-level billing or spending-limit condition, not a
workflow, code, or configuration problem.** The evidence that it is not the
workflow:

- The workflow is **active** and GitHub accepted the dispatch.
- The jobs failed in **2 seconds**, before any runner was allocated — a
  workflow defect produces a *failed step* with output, not a refusal to
  start.
- The workflow file is the same one the **local rehearsal** ran end to end,
  9/9, in the workflow's order.
- The account's Actions API reports `enabled: true`.

The account's billing details could not be read to say which half of the
cause applies: the API needs the `user` scope, and the token carries
`gist, read:org, repo, workflow`. The message names both possibilities.

### What closes it

For a **private** repository, GitHub Actions bills against the account's
**spending limit**, and a limit of $0 refuses to start any job. The owner
must do one of:

1. **Resolve the payment failure** and raise the Actions **spending limit**
   above $0 — the private repository then runs, and nothing is exposed.
2. **Make the repository public**, where Actions are free — but that
   **exposes an unlicensed project**, and it is what the earlier
   instructions ruled out.

Option 1 is the one that keeps the project private. The repository stays
private as it stands.

### The workflow is prepared and reviewable

`.github/workflows/release-checks.yml` runs on `ubuntu-latest`,
`macos-latest` and `windows-latest` with `fail-fast: false`, so one
platform's failure does not cancel the others' evidence. It runs the
typecheck, the suite, the pilot, the recovery rehearsal, the build, the
isolated install with the installed parsers, the dependency audit and the
SBOM, the artifact check, and the candidate manifest; it records the runtime
versions, the revision and the dependency information; and it uploads the
per-platform evidence **whatever happened**. It has `permissions: contents:
read` and **no publication job**.

The local rehearsal (`release/evidence/ci-rehearsal.json`) ran **all nine
steps of the workflow, in the workflow's order, on this platform**, and all
nine passed. That is evidence that the steps work **here**. It is not
evidence that hosted CI passed, and it is not evidence that Linux or Windows
pass.

---

## 4. The T-13 live validation — a separate gate

The experimental Code Mode audit is **disabled** in the live test, as the
plan requires, and its live validation is **not** claimed.

The audit trail itself is implemented (`packages/adapter-opencode/src/audit.ts`
and `audit-source.ts`), it is opt-in, it filters on the event's location
**before** reading a payload, and it drops the user-content event kinds by
name. Its **unit** behaviour is covered. What is missing is a **live**
Code Mode session with `OPI_AUDIT_LOG` set, on a runtime whose event
metadata shape matches what the reader expects.

**If complete T-13 auditing is required for P8, that is a separate gate**,
and it is not closed by this report.

---

## 5. The recovery rehearsal — against real data

The source was a **copy** of the owner's real registry, taken with `cp` and
verified to carry the same 36 projects, 17 tasks and 19 task events. The
**original was never opened for writing**, and the rehearsal re-checks that
at the end by comparing the source's logical state with its own first
reading.

| Check | Outcome |
|---|---|
| The source opens read-only | The copy was opened read-only; the original's mtime is unchanged |
| The backup is a consistent snapshot, including committed WAL data | `VACUUM INTO` — a file copy alone would miss committed WAL content |
| The copy reaches the current schema in **every** family | registry, task, memory, verification: all true |
| Every original row is preserved, byte for byte | 17 tables checked, no losses |
| The data under test is present | projects=36, worktrees=36, tasks=17, task_events=19 |
| Project identities are preserved | 36 compared by id, key and root |
| Task histories and revisions are preserved | 19 events compared by task, sequence, actor, operation and payload |
| A failed migration rolls back with nothing leaked | The injected failure left the database unchanged |
| The upgraded database passes the integrity check | `integrity_check=ok` |
| The restore reproduces the backup exactly | The restored logical state equals the backup |
| The restore has no stale WAL sidecar | The restored file is new |
| The source is unchanged | The original's logical state is identical |

### What "rollback" means here

**Restoring a backup, not running reverse migrations.** No reverse migrations
exist, and the migrations are not all reversible. A restore returns the
database to the state it was in when the backup was taken, so **any write
made after the backup is lost**. That is the boundary.

Operationally: **stop all writers before a restore.** Replacing a database
while old WAL sidecars or connections remain is unsafe.

### What the rehearsal does not cover

It exercised the **registry, task, memory and verification** migration
families against real data. The owner's registry has **no** memory rows, no
verification gates and no verification runs — the tables exist and are
migrated, but the rehearsal could not exercise a **non-empty** memory or
verification table, because there is no such data. A database with populated
memory and verification tables would be a better fixture, and the owner's
does not have one.

---

## 6. The candidate

`release/candidate.json` ties everything to one revision and one hash, and
the check **fails** if the tree has moved since the artifacts were built.

| | |
|---|---|
| Source revision | `f1207291401f` on `main`, pushed to the private `nexussean/nexus-opi` |
| Build source digest | `fcac726c6b340156…` over **195** files, matching the tree |
| Artifact SHA-256 | `42959686edcd5497b70e0e5e7b7cf09b77159d725e65beefe67e3c5d0ab0ea87` |
| Files in the artifact | 87 |
| Published | **false** |
| Package name | `opencode-project-intelligence` (a placeholder for an undecided scope) |
| License | `UNLICENSED` |

The candidate includes the release manifest, the lockfile, the resolved
dependency inventory, the SBOM, the licence inventory, the source manifest,
the migration rehearsal, the artifact check and the candidate manifest
itself.

**The version is derived, not written twice.** The bundle's manifest takes
its version from `PLUGIN_VERSION` in the adapter, and the two cannot drift.

---

## 7. Two findings worth keeping

### The dependency policy was wrong, and the fix is a policy, not a version

The dependency test prohibited `tree-sitter@0.25` **by version number**.
That is the wrong policy: `0.25` is not wrong, it is simply not compatible
with the grammar versions declared at the time. A future release of
`tree-sitter-typescript` that supports `0.25` would be a **correct**
upgrade, and a test that fails on the version number would block it for the
wrong reason.

The test now checks the actual condition — every grammar's **peer
requirement** must be met by the resolved `tree-sitter`, the **resolved
tree** rather than the declaration is examined, and no language may be
dropped — and it keeps the bypass checks (`overrides`,
`peerDependenciesMeta`, `--legacy-peer-deps`). A forward-compatibility test
states the policy: a hypothetical version is judged by the same peer rule,
so a compatible `0.25` set would pass.

**And Bun's installer does not enforce peer requirements.** It installed a
knowingly conflicting set without a word. The isolated install therefore
uses **npm**, which does. A check that cannot fail proves nothing, and the
negative control is recorded: npm rejects the original set with `ERESOLVE`
and names the exact conflict.

### The floating-dependency fragility is upstream, and it clears

The isolated install failed three times with `ETARGET`, each time naming a
different package. The debug log gave the cause: `@aws-sdk/types@3.975.0`
was **listed** in the registry's metadata, tagged `latest`, with a shasum —
and its **tarball 404'd**. The AWS SDK publishes several packages at once,
and for a short window the tarball is not yet propagated to the CDN that
serves it.

The **locked** set is unaffected; the release's own lockfile resolves to
working versions. The fragility is in the **floating** install, and it is a
property of `@opencode/plugin`'s transitive dependencies, not of OPI's.

It cleared on its own within minutes, and a plain `npm install` then
succeeded with no intervention. **No `overrides` block was added**: it would
have been a workaround for an upstream defect that had already cleared, and
it would have pinned a transitive version in the shipped manifest for no
lasting reason. The full account is in
[`floating-dependency-fragility.md`](floating-dependency-fragility.md).

**What this means for the gate:** a transient registry fault will appear as
a failure in the isolated-install step, it is **not** a code defect, and the
diagnosis is the same every time — re-run with a fresh cache and compare
the named package against the registry's tarball URL. The gate does not
become optional, and a registry fault is not recorded as a pass.

---

## 8. What remains

### Technical blockers

| # | Blocker | What closes it |
|---|---|---|
| **T-1** | **Cross-platform CI was dispatched and every job was refused.** GitHub: *"recent account payments have failed or your spending limit needs to be increased."* | An owner action in **Billing & plans**: resolve the payment failure and raise the Actions **spending limit** above $0. The repository is private and stays that way. |
| **T-2** | **The live T-13 audit has not been validated.** | A live Code Mode session with `OPI_AUDIT_LOG` set. Only required if complete T-13 auditing is in P8's scope. |
| **T-3** | **The recovery rehearsal could not exercise a non-empty memory or verification table.** The owner's registry has none. | A database with populated memory and verification tables. |
| **T-4** | **Only macOS has been exercised.** | The hosted matrix. |
| **T-5** | **The Rust and Python parser adapters do not exist.** P8's scope names them. | Implementation, or an explicit scope decision to drop them from v1. |

### Owner decisions

| # | Decision | Why it is the owner's |
|---|---|---|
| **O-1** | **The registry identity**: the package name and the scope. | The candidate is a placeholder. It needs a scope the owner controls. |
| **O-2** | **The licence.** | The candidate is `UNLICENSED` and `private: true`. No licence was selected and none was invented. |
| **O-3** | **Whether to keep the repository private** at the cost of a spending limit, or make it public so Actions are free. | A public repository would expose an unlicensed project. It was created **private**. |
| **O-4** | **The retrieval token criterion.** | The spike missed its own 1/3 bar; the shipping path clears the plan's 15% target by 4×. |
| **O-5** | **The kanban plugin's fate** — absorb it or ship it separately. | It competes for the same board queries. |

### Not blocking

- The **wording, guidance and structure levers** are unsettled on cost. The
  shipping configuration is unchanged and the unresolved question is
  documented, so this does not block a release.
- The **schema-size decision** is **NOT RESOLVED** and the minimal schema
  does not ship. The full schema remains the default, and that is the
  shipping configuration.

---

## 9. What was deliberately not done

- **Nothing was published.** `published: false`; the candidate is `private:
  true` and `UNLICENSED`; the user's `~/.config/opencode` is unchanged; the
  bundle is not in it; the real registry's mtime is unchanged.
- **The repository was created PRIVATE**, the branch was pushed, and the
  workflow was dispatched — all authorised by the owner. It is private, and
  **publication remains disabled**: the package is `private: true` and
  `UNLICENSED`, the workflow has no publish job, and `published: false`.
- **The shipping schema default was not changed.**
- **No optimisation matrix was run.**
- **No real user configuration or data was modified.** The live test used a
  temporary `XDG_CONFIG_HOME`, a temporary project and a temporary data
  directory. The recovery rehearsal opened the source read-only and did
  every mutation in a copy.
- **No historical report was rewritten.** The earlier readiness report is
  preserved, and the regrade wrote new files alongside the originals.

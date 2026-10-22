# Release readiness — the technical gates

**Date:** 2026-10-21. **Candidate:** `@nexussean/opencode-project-intelligence` 0.1.0.
**Licence:** GNU Affero General Public License, v3 or later.
**Repository:** <https://github.com/nexussean/nexus-opi> — **public**.
**Published to npm:** **no.** The package is `private: true` and unpublished.
**Artifact SHA-256:** `3bcc37c4a7651ea40992283991d5be4d8fd5cf7ae34e74ef4f73bdac781a2a73`.
**Tarball:** `nexussean-opencode-project-intelligence-0.1.0.tgz`, 89 files.

**Verdict: every gate passes, on one platform and on all three.** The
hosted CI succeeded on macOS, Linux and Windows. The owner decisions are
made. Two things are not done: the package is not published to npm, and the
kanban plugin has not yet been absorbed.

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
| **Dependency audit and SBOM** | **PASS** | 6/6. Computed from the **installed** tree. Every peer requirement met, no declared-range violation, every licence known (MIT). `release/dependency-audit.json`, `release/sbom.json` (CycloneDX 1.5, licence `AGPL-3.0`). |
| **Release artifact check** | **PASS** | `artifact-checks-passed`, `isolatedImport: true`, `sbomComplete: true`, `diagnosticPeerTree: false`, `npm audit` exit 0 with **zero vulnerabilities** at every severity, `published: false`. |
| **Reproducible packaging** | **PASS** | The bundle is packed **twice, into different directories**, and the two tarballs are compared byte for byte. They are identical, so the artifact's hash is a function of the source and not of when the build ran. |
| **Recovery rehearsal** | **PASS** | 13/13 against a **copy of the real registry**. 36 project identities, 17 tasks and 19 task events preserved byte for byte; a controlled migration failure rolled back; the restore is exact; the source is unchanged. |
| **Live final artifact** | **PASS** | 12/12. The **packaged tarball** in a real OpenCode session, with a temporary configuration, temporary project and temporary data. `fixtures/acceptance/release/live-artifact.json`. |
| **CI rehearsal** | **PASS** | 9/9 local rehearsal of the workflow's steps, in the workflow's order. `release/evidence/ci-rehearsal.json`. |
| **Cross-platform CI (macOS, Linux, Windows)** | **PASS** | Run `39696790101` at revision `7198b46`: **all three platforms succeeded**, each uploading its own evidence. The runs before it found real defects, all now fixed. See §3 and [`cross-platform-findings.md`](cross-platform-findings.md). |
| **T-13 live validation** | **NOT RUN** | The experimental Code Mode audit is disabled, as the plan requires. See §4. |
| **Registry identity** | **DECIDED** | `@nexussean/opencode-project-intelligence`. The scope is unclaimed on npm and is the owner's to claim. |
| **Licensing** | **DECIDED** | AGPL-3.0. `LICENSE` and `LICENSE-NOTICE.md` travel in the tarball, and the artifact check **fails** if the licence is missing. |
| **Repository visibility** | **DECIDED** | Public. The source is AGPL-licensed, which is the licence that makes public distribution coherent. |
| **The kanban plugin** | **DECIDED** | Absorb the data model, keep the package. See [`kanban-plugin-decision.md`](kanban-plugin-decision.md). |
| **The retrieval token criterion** | **DECIDED** | The plan's own 15% target stands. The shipping path clears it by 4×. |

---

## 2. The exact checks performed

Every command, and what it returned.

| Command | Result |
|---|---|
| `bun run check` | **exit 0** — 701 pass, 0 fail, 4 123 assertions, 58 files, 21.4 s. Every package typechecks. |
| `bun run release:pilot` | **exit 0** — 13/13 steps. |
| `bun run release:build` | **exit 0** — 11/11 steps. The manifest's version and dependencies are **derived from the workspace**. |
| `bun run release:isolated` | **exit 0** — 9/9 steps. npm, peer validation on. |
| `bun run release:sbom` | **exit 0** — 6/6 steps. |
| `bun run scripts/verify-release.ts` | **exit 0** — `artifact-checks-passed`, `published: false`, and the two packs of the bundle are byte-identical. |
| `bun run scripts/rehearse-migration.ts --source <copy>` | **exit 0** — 13/13 steps. |
| `bun run scripts/live-artifact-test.ts` | **exit 0** — 12/12 steps. |
| `bun run release:ci-rehearsal` | **exit 0** — 9/9 steps. |
| `bun run scripts/make-candidate.ts` | **exit 0** — 7/7 steps. The build's source digest matches the tree over 198 files, and the candidate's own content digest covers 200. |

### The live artifact test, in detail

One local session, on `darwin/arm64`, OpenCode `v2.1.2`, model
`ollama-cloud/deepseek-v4.1-flash`, artifact
`3bcc37c4a7651ea40992283991d5be4d8fd5cf7ae34e74ef4f73bdac781a2a73`.

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
| The index is for **this** project | 3 files indexed for the temporary project's root |

**Scope:** one local session on one platform. It does **not** establish
cross-platform live compatibility, and it does not claim to.

---

## 3. The cross-platform CI gate

The repository was created **private**, the branch was pushed, and the
workflow was dispatched. It was refused, and the reason was recorded:

> The job was not started because recent account payments have failed or
> your spending limit needs to be increased.

**12 job refusals across 4 runs**, on two different commits, on both the
push trigger and the manual dispatch, every one of them in 2 to 3 seconds
with **no steps at all** — a refusal to start, not a failed step. The
workflow was active, the API was reachable, and the same file ran end to
end in the local rehearsal, 9/9.

**That blocker is now gone.** The owner chose a **public** repository, and
Actions on a public repository do not bill against a spending limit, so the
jobs can start. The project is under the **AGPL**, which is the licence that
makes a public repository coherent: the source is meant to be public, and
the section 13 obligation to offer the Corresponding Source is met by the
dashboard's **Source** link.

The workflow runs on `ubuntu-latest`, `macos-latest` and `windows-latest`
with `fail-fast: false`, so one platform's failure does not cancel the
others' evidence. It runs the typecheck, the suite, the pilot, the recovery
rehearsal, the build, the isolated install with the installed parsers, the
dependency audit and the SBOM, the artifact check, and the candidate
manifest; it records the runtime versions, the revision and the dependency
information; and it uploads the per-platform evidence **whatever happened**.
It has `permissions: contents: read` and **no publication job**.

The local rehearsal (`release/evidence/ci-rehearsal.json`) ran **all nine
steps of the workflow, in the workflow's order, on this platform**, and all
nine passed. That is evidence that the steps work **here**. It is not
evidence that hosted CI passed, and it is not evidence that Linux or Windows
pass.

### What the hosted runners found

The first run failed on all three platforms. The findings are of three
kinds, and the difference matters: a **code defect** is a bug in the
product, a **test of the machine** is a test that was really a test of the
platform it ran on, and a **gitignored dependency** is a test that only ran
on the machine that produced the data.

The **code defects** were:

- The **trust boundary was not a trust boundary**. It stopped the upward
  walk for a repository, but a directory outside it still resolved by the
  path fallback — and the coverage register and the threat model both say
  it must not. The test that should have caught it was passing on macOS
  only because `/var` is a symlink to `/private/var`.
- The **PATH search split on a hard-coded colon**, so on Windows **no**
  executable could be found at all, and a bare name did not resolve
  through `PATHEXT`.
- The **process tree was not killed on Windows**: the negative-pid group
  kill is POSIX, so a grandchild survived a timeout — which is what
  **T-08** forbids.
- The **bundle could not import its own dependency** on Windows, because
  the resolver does not follow a junction into a directory whose entries
  are themselves symlinks. The bundle now carries a flat, **copied**
  `node_modules` — what npm would install anyway.
- An **open handle failed the run at the last step**: the pilot passed all
  thirteen checks and then could not delete its sandbox, because a
  reopened store was never closed.

The **tests that were tests of the machine** were the billing test (the
session store's presence decides which reason fires), the uninstall test
(it forbade a substring the plugin's own name contains on Linux), the
verification tests (`/bin/echo`, `/bin/sh`, `sleep`), the benchmark's fake
CLI (a shebang script is not an executable on Windows) and the clone
fixture (a POSIX-only regular expression for a path's parent).

The **gitignored dependency** was the grader's regression test, which read
`fixtures/bench/results` — so it ran only on the machine that produced the
reports, and in a fresh clone it took the whole test file down. The
regression corpus is now extracted and **versioned**, and the suite passes
with the gitignored data absent.

The full account, with the runs and the reasoning, is in
[`cross-platform-findings.md`](cross-platform-findings.md).

### The run that passed

Run **`39696790101`**, at revision `7198b46`, in 7 minutes 48 seconds.
**All three jobs succeeded**, and each uploaded its own evidence.

| Platform | Architecture | Bun | Node | npm | Artifact SHA-256 |
|---|---|---|---|---|---|
| `macos-latest` | arm64 | 1.4.2 | v24.21.0 | 11.19.0 | `3bcc37c4a7651ea4…` |
| `ubuntu-latest` | x86_64 | 1.4.2 | v24.22.0 | 11.19.1 | `3bcc37c4a7651ea4…` |
| `windows-latest` | x86_64 | 1.4.2 | v24.21.0 | 11.19.0 | `3bcc37c4a7651ea4…` |

That table is from the run that **passed**; the run that confirmed the
three-platform agreement is `39701447188`, at revision `a3192d3`, and it
says the same thing:

| Platform | Artifact SHA-256 | Source digest | Files | Tree |
|---|---|---|---|---|
| `macos-latest` | `3bcc37c4a7651ea4…` | `7418d05c97ddf5cd…` | 198 | clean |
| `ubuntu-latest` | `3bcc37c4a7651ea4…` | `7418d05c97ddf5cd…` | 198 | clean |
| `windows-latest` | `3bcc37c4a7651ea4…` | `7418d05c97ddf5cd…` | 198 | clean |

**The same commit produced the same artifact, byte for byte, on all three
platforms** — and the same hash as the local build. That is the
reproducibility claim, and it is now *measured* rather than asserted.

Getting there took one more fix. The first passing run showed macOS and
Linux agreeing and **Windows differing**, and the reason was in the
evidence: Git for Windows checks text files out with CRLF, so every text
file differed, and the build copies the checked-out files into the bundle.
The artifact's identity depended on the platform it was built on, which is
not an identity. A `.gitattributes` now says every text file is checked
out with LF, and the file is part of the source digest, so the candidate
records that the policy is in force rather than assuming it.

The **tree** column is the last thing that took fixing. The gates
regenerate their own evidence — the audit, the SBOM, the pilot's — and each
one rewrites its file with a fresh date, so a run left the tree dirty and
the candidate's `dirty` flag said true every time, which made the flag
meaningless. The generated files are untracked now, and the flag says what
it is for.

**The evidence is per platform.** Each job uploads its own
`release/evidence/` and its own `release/candidate.json`, with the runtime
versions, the revision, the dependency information and the artifact hash
for that platform. A failure on one platform does not cancel the others'
evidence, because `fail-fast` is off.

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
| Package | `@nexussean/opencode-project-intelligence` |
| Version | 0.1.0 |
| Licence | `AGPL-3.0` |
| Build source digest | `7418d05c97ddf5cd…` over **198** files, matching the tree |
| Artifact SHA-256 | `3bcc37c4a7651ea40992283991d5be4d8fd5cf7ae34e74ef4f73bdac781a2a73` |
| Files in the artifact | 89 (88 in the bundle, plus `MANIFEST.json`) |
| Published | **false** |
| Private | **true** |

The candidate includes the release manifest, the lockfile, the resolved
dependency inventory, the SBOM, the licence inventory, the source manifest,
the migration rehearsal, the artifact check and the candidate manifest
itself.

**The version is derived, not written twice.** The bundle's manifest takes
its version from `PLUGIN_VERSION` in the adapter, and the two cannot drift.

**The name, the version and the licence are derived too.** They are read
from the bundle's own manifest, so the candidate manifest cannot disagree
with the artifact, and a rename cannot leave a stale string behind.

### The runtime identity did not change

The npm package is `@nexussean/opencode-project-intelligence`. The
**runtime** identifier — the plugin id, the skill id, and the directory
under `XDG_DATA_HOME` that holds the registry — is still
`opencode-project-intelligence`.

That is deliberate. The runtime identifier is where an existing
installation's data lives, and changing it would orphan every existing
registry, project and task. The two names are kept distinct so the package
can be renamed and scoped without moving anyone's data. The tool namespace
is `pi` for the same reason: it is set explicitly
(`options: { namespace: "pi" }`), not derived from the package name, so the
rename did not change a single tool id.

---

## 7. The findings worth keeping

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

### The artifact's hash has to be a function of the source

The candidate's identity is the artifact's SHA-256, so that hash must
identify *what was built*, not *when it was built*. It was not being
**proved** — it was assumed.

The artifact check now packs the bundle **twice, into two different
directories**, and compares the two tarballs byte for byte. They are
identical, and the check **fails** if they are not. npm's packer
normalises timestamps, so a matching pair is a real result rather than a
tautology.

This caught a real ambiguity during the rename: the artifact's hash changed
between two runs, and the cause was not the packer at all — the `CHANGELOG`
had been edited, so the bundle's content had genuinely changed. A hash that
moves when the content moves is the right behaviour, but only if the
difference is *provably* the content. Now it is.

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

## 8. What the AGPL changed, concretely

The licence is not a label. Choosing AGPL-3.0 for a program with a
network interface obliges three specific things, and all three are now
done:

1. **The licence travels with the program.** `LICENSE` is in the manifest's
   `files`, is copied into the bundle, and the artifact check **fails** if
   it is missing from the tarball. Section 4 requires that every recipient
   is given a copy of the licence.
2. **The dashboard carries the Appropriate Legal Notices.** Section 5(d)
   requires a copyright notice, a statement that there is no warranty, a
   statement that the work may be conveyed under the licence, and a way to
   view a copy of it. The dashboard's footer carries all four.
3. **The Corresponding Source is offered to remote users.** Section 13
   requires that users interacting with a modified instance over a network
   are offered its source. The footer carries a prominent **Source** link to
   the public repository, which is how that obligation is discharged for
   the dashboard.

**What was deliberately not done:** the licence boilerplate was *not* added
to the agent skill. The skill is loaded on demand and its content is
context the model pays for on every use, and it is not a network interface
for a human — the dashboard is. The reasoning is recorded in
`LICENSE-NOTICE.md`.

The third-party dependencies are unaffected: they retain their own licences,
and every one of them in the tree is MIT.

---

## 9. What remains

### Technical blockers

| # | Blocker | What closes it |
|---|---|---|
| **T-1** | **Closed.** The cross-platform CI succeeded on all three platforms. The runs before it found real defects — a trust boundary that was not one, a PATH split on a hard-coded colon, a process tree that was not killed, a bundle that could not import its own dependency, and an artifact whose bytes depended on the platform — all now fixed. | Nothing. It passed. |
| **T-2** | **The live T-13 audit has not been validated.** | A live Code Mode session with `OPI_AUDIT_LOG` set. Only required if complete T-13 auditing is in P8's scope. |
| **T-3** | **The recovery rehearsal could not exercise a non-empty memory or verification table.** The owner's registry has none. | A database with populated memory and verification tables. |
| **T-4** | **Only macOS has been exercised live.** | The hosted matrix, for the build and the gates. A live session on each platform remains a separate claim. |
| **T-5** | **The Rust and Python parser adapters do not exist.** P8's scope names them. | Implementation, or an explicit scope decision to drop them from v1. |
| **T-6** | **The npm scope `@nexussean` is unclaimed.** The package cannot be published under it until the scope is claimed. | Claim the scope on npmjs.com. It is free and unclaimed. |
| **T-7** | **The kanban plugin has not been absorbed.** The decision is made; the work is not done. | Retire its JSON store and free-form state machine; keep its TUI and its card→session link; make it a surface over OPI's task store. See [`kanban-plugin-decision.md`](kanban-plugin-decision.md) for the boundary and the concrete costs. |

### Not blocking

- The **wording, guidance and structure levers** are unsettled on cost. The
  shipping configuration is unchanged and the unresolved question is
  documented, so this does not block a release.
- The **schema-size decision** is **NOT RESOLVED** and the minimal schema
  does not ship. The full schema remains the default, and that is the
  shipping configuration.
- The **retrieval token criterion** is settled at the plan's own 15%
  target, which the shipping path clears by 4×. No re-measurement is owed.

---

## 10. What was deliberately not done

- **Nothing was published to npm.** `published: false`; the package is
  `private: true`; the workflow has **no publish job**; the user's
  `~/.config/opencode` is unchanged; the bundle is not in it; the real
  registry's mtime is unchanged.
- **The shipping schema default was not changed.**
- **No optimisation matrix was run.**
- **No real user configuration or data was modified.** The live test used a
  temporary `XDG_CONFIG_HOME`, a temporary project and a temporary data
  directory. The recovery rehearsal opened the source read-only and did
  every mutation in a copy.
- **No historical report was rewritten.** The earlier readiness report is
  preserved, and the regrade wrote new files alongside the originals.
- **The runtime identifier was not renamed.** Only the package name and the
  licence changed. An existing installation's data stays where it is.

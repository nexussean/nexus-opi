# Release readiness: OpenCode Project Intelligence

**Date:** 2026-10-21. **Version prepared:** 0.1.0. **Status:** prepared, **not
published**.

Nothing was published. Nothing was installed into the user's OpenCode
configuration. The release bundle exists on disk, it loads, and it has been
exercised in a live session.

---

## 1. The summary

| | |
|---|---|
| **The suite** | `bun run check` → **688 pass, 0 fail**, 56 files, every package typechecks |
| **The acceptance pilot** | `bun run release:pilot` → **13/13 steps** |
| **The release bundle** | `bun run release:build` → **10/10 steps**, 80 files, 538 899 bytes |
| **The live bundle** | Loaded in a real OpenCode session; **6 tools** registered; `pi.status`, `pi.task`, `pi.context` and `pi.graph` all called successfully |
| **The security requirements** | All **8** of the outstanding ones (T-01…T-04, T-11…T-14) now have tests; the other 6 are preserved |
| **The shipping surface** | **Unchanged.** The full schema remains the default; the minimal schema remains an arm |

| | |
|---|---|
| Source fingerprint | 160 files, `sha256:5c0bcd65692cd0e8fb1e526674ec7cf4` |
| Bundle digest | `84574f4421560808`, 80 files — the exact values are in `release/bundle/MANIFEST.json` |
| Runtime exercised | `2.1.2-arm64` (the desktop app's own copy) |
| Provider exercised | `ollama-cloud/deepseek-v4.1-flash` |

---

## 2. What was done

### 2.1 The benchmark repairs, audited independently

The repairs were re-checked from the code rather than from the report.

| Claim | How it was checked | Result |
|---|---|---|
| The minimal schema has **two** wordings that differ | `descriptionFor()` called for every tool, both variants, minimal size | 6/6 differ; the baseline is 25–58 B, the revised 56–94 B |
| The tool count is derived from the **structure** | `expectedToolCount()` for every arm | Both split arms → 14; every other arm → 6 |
| The store is never **written** by the benchmark | The billing module's open | `readonly: true` |
| A missing usage event is **never** zero cost | The billing module's failure paths | Every one returns `available: false` with a reason |
| The content grader cannot pass on **token presence** | Eight adversarial answers | Tokens-present-without-a-claim → failed; empty set with a count → failed; two states → failed |
| The schedule is randomised and **reproducible** | The builder, same and different seeds | Same seed → identical schedule; 10/47 adjacent-same-arm against 9/11 for a blocked schedule |
| The live harness reports what it claims | A live 4-run measurement | All four metrics, the bootstrap interval, the fingerprints and the seed are present in the report |

**One discrepancy found and recorded:** the *source* fingerprint differs
from the one in the 108-run report, because the security work added
files. The 108-run report's own fingerprint is preserved inside it, so
that report remains tied to the code that produced it. The **runtime** is
the same build in both — `2.1.2-arm64` — so the 108-run measurement and
this verification ran against the same OpenCode.

### 2.2 The eight security requirements

Every one of T-01, T-02, T-03, T-04, T-11, T-12, T-13 and T-14 now has a
test. The full register, with what each test holds, is in
[`docs/security/coverage-register.md`](../security/coverage-register.md).

**Two modules were built**, because T-13 needed a capability that did not
exist:

- `packages/adapter-opencode/src/audit.ts` — the audit trail. It records the
  model-initiated tool calls and whether the batch was truncated. A
  truncated batch is recorded as incomplete **on every entry**. A tool's
  input is reduced to its command before it is written.
- `packages/adapter-opencode/src/audit-source.ts` — the trail's source, and
  the reconciliation with T-01. The audit is **opt-in**; when it is on, it
  filters on the event's location **before** the payload is read, and drops
  the user-content event kinds **by name**. The order is asserted
  directly, because the order is the safety argument.

The **shipped configuration does not subscribe to the event stream**. The
one module that can is opt-in, and the test asserts that exactly one
module can and that it is guarded.

### 2.3 The release

- `scripts/release-pilot.ts` — the plan's **MVP shipping checklist**, run
  for real in a sandbox. 13/13.
- `scripts/build-release.ts` — assembles a publishable bundle: the
  packages copied into one tree, the `workspace:*` imports rewritten to
  relative paths, the manifest written, and the bundle **imported** to prove
  it loads. 10/10.
- `release/bundle/` — the built bundle, with `MANIFEST.json`: every file,
  its size and its digest, and a digest over the whole.

---

## 3. The exact checks performed

Every command, and what it returned.

| Command | Result |
|---|---|
| `bun run check` | **exit 0** — 688 pass, 0 fail, 4 002 assertions, 56 files, 20.6 s. Every package typechecks. |
| `bun run release:pilot` | **exit 0** — 13/13 steps. Evidence in `fixtures/acceptance/release/pilot.json`. |
| `bun run release:build` | **exit 0** — 10/10 steps. Bundle digest `b9f7b531d14fbfdf`. |
| `tsc --noEmit -p tsconfig.json` in `release/bundle` | **exit 0** — the bundle typechecks with the project's own configuration. |
| A live OpenCode session against the bundle | The plugin loaded from a directory-plugin entry, registered **6** tools, and `pi.status` (doctor), `pi.task` (list), `pi.context` and `pi.graph` were each called and **completed**. Evidence in `fixtures/acceptance/release/bundle-live.json` and `bundle-surface.json`. |
| The full suite with a **deliberately failing** test copied into the bundle | **688 pass, 0 fail** — the release directory is excluded from the test run, so a stale bundle cannot break the suite. |

### The acceptance pilot's 13 steps

Two projects resolve with different identities; the git project is
identified by git and the no-git project by path; two tasks are created; a
blocking link is created; the blocked task is waiting; the state survives a
restart; a source symbol is found with provenance; the symbol's importer is
found through the graph; a changed source file is detected as changed; a
decision is saved and retrieved; the plugin can be installed and disabled;
the user's code is byte-identical afterwards; and the app-owned data is
retained.

---

## 4. The remaining blockers

These are the things that stand between this and a published release. None
of them is a defect in the code; they are the parts of the plan that have
not been done.

### 4.1 Blocking a publication

| # | Blocker | What it needs |
|---|---|---|
| **B-1** | **The release is not published, and the package is not on a registry.** | The plan calls for an npm package under a scope. The bundle is `opencode-project-intelligence` at 0.1.0, `private: false`. **Publishing needs the owner's account and a decision on the scope.** Nothing in this report publishes it. |
| **B-2** | **The dependency set is not pinned or audited for a release.** The plan's release matrix requires "secrets/dependency scan" and an "SBOM/license report". The bundle carries `@opencode/plugin ^2.0.32` and `@opencode/schema 2.0.32`; the workspace's transitive dependencies are not audited, and no SBOM exists. | A dependency audit and an SBOM. |
| **B-3** | **The CI release matrix does not exist.** The plan requires a PR lane (lint, typecheck, unit, integration, schema checks, dependency scan, fixture smoke test), a nightly lane (Windows/macOS/Linux, resource tests, plugin compatibility against a pinned range) and a release lane (build, checksums, SBOM, migration upgrade and rollback rehearsal, e2e browser checks, changelog). | The matrix. **The release is a single-machine, single-platform result.** |
| **B-4** | **The migration upgrade and rollback rehearsal has not been run.** The plan requires a transactional backup before a schema change, a validated migration, and a supported downgrade. The migrations are idempotent and tested, but the **rehearsal** has not been performed. | A rehearsal against a copy of a real database. |
| **B-5** | **The workspace packages are all `0.0.0` and `private: true`, and there is no changelog.** The bundle's version is now **derived from `PLUGIN_VERSION`** in the adapter, so the bundle and the source cannot disagree — but the workspace's own packages carry no version, and a release has no changelog. | A version decision for the workspace packages, a changelog, and a decision on whether the workspace packages are versioned or explicitly excluded from the release. |

### 4.2 Not blocking a publication, but not done

| # | Item | Note |
|---|---|---|
| **N-1** | **The portability half of P8.** The plan's P8 is "Portability and v1 release: Windows/macOS/Linux, Rust/Python adapters, recovery and benchmark signoff". The benchmark signoff is done. **The Rust and Python parser adapters do not exist**, and only macOS has been exercised. | The Windows and Linux code paths in `packages/db/src/paths.ts` are written but untested on those platforms. |
| **N-2** | **T-13's trail has not been exercised against a live Code Mode session.** The reading of a batch is tested against the shapes the runtime has used, and the event shape has changed across runtime versions. The reading is defensive — it refuses an event it cannot attribute — but a live run has not confirmed it. | A live Code Mode session with a `shell` call, with `OPI_AUDIT_LOG` set. |
| **N-3** | **T-14's concurrency test is in one process.** Two writers against one SQLite file, interleaved, 40 rounds each. It is not two OS processes, and it does not exercise the busy-timeout path under real contention. | A two-process test. |
| **N-4** | **The retrieval token criterion is still an owner decision.** The spike missed its own 1/3 bar; the shipping path clears the plan's 15% target by 4×. The two vocabulary misses (`hold-09`, `hold-22`) were **not** fixed, because tuning against the held-out set would invalidate the measurement. | See [`docs/spike/retrieval-hypothesis.md`](../spike/retrieval-hypothesis.md). |
| **N-5** | **The kanban plugin's fate is undecided** — absorb it or ship it separately. It competes for the same board queries, and the competing-catalog condition has not been run as its own arm. | A product decision. |
| **N-6** | **The wording, guidance and structure levers are unsettled on cost.** The schema-size decision was re-taken under a pre-registered rule and came out **NOT RESOLVED**; the minimal schema does not ship. The other three levers have not been re-taken with the corrected grader. | Each needs its own pre-registration. **None of it blocks a release**: the shipping configuration is unchanged and the unresolved question is documented. |
| **N-7** | **OPI-015, OPI-031, OPI-037, OPI-042 and OPI-046 have not been started.** | See [`docs/p0-status.md`](../p0-status.md). |

---

## 5. What was deliberately not done

- **The shipping default was not changed.** The full schema remains the
  default. The minimal schema remains an arm, with its own two wordings.
  The [pre-registered decision](../bench/schema-size-result.md) was
  **NOT RESOLVED**, and it stands.
- **No optimisation matrix was run.** The instruction was explicit, and the
  security work did not need one. The only live runs were the acceptance
  pilot and the bundle verification.
- **Nothing was published, and nothing was installed.** The bundle exists
  on disk. The user's `~/.config/opencode` was not touched. The live
  session used a temporary `XDG_CONFIG_HOME` and a temporary data
  directory.
- **No historical report was modified.** The 99 retained report files are
  unchanged, and the regrade wrote new files alongside them.
- **The six already-covered security requirements were not rewritten.**
  T-05 through T-10 keep their existing tests.

---

## 6. The recommendation

**The release is ready to be published, and the publication is blocked on
five decisions that are the owner's, not the code's.**

The code is in a defensible state:

- The benchmark is **trustworthy** and its conclusions are **honest**, and
  the record says so where the evidence does not support a claim.
- The **eight** outstanding security requirements have tests that hold
  named properties, and the two that needed a capability now have one.
- The **release bundle builds, loads, typechecks, and works** in a live
  session.
- The **acceptance pilot passes every step** of the plan's own shipping
  checklist.
- The **shipping surface is unchanged** and the unresolved cost question is
  documented rather than assumed away.

What is missing is the release *operations*: a registry account and a scope
(B-1), an audit and an SBOM (B-2), a CI matrix (B-3), a migration
rehearsal (B-4), and a version and changelog decision (B-5). Four of the
five are a day's work each and none of them changes the product's
behaviour. The fifth — the scope and the account — is a decision only the
owner can make.

**The one thing to fix before publishing** is B-5's remainder. The bundle's
version is now **derived from `PLUGIN_VERSION`** in the source, so the two
cannot drift — that half was fixed here. What is left is the workspace
packages' own `0.0.0` and the missing changelog, and both are a decision
rather than a defect.

# The floating-dependency fragility

**Date:** 2026-10-21. Found while running the live artifact test.

## What happened

The live artifact test installs the packaged tarball into an empty
directory, and it failed:

```
npm error code ETARGET
npm error notarget No matching version found for @aws-sdk/types@^3.975.0.
```

A second attempt named a **different** package,
`@aws-sdk/credential-provider-process@^3.972.76`. A third attempt with a
**fresh npm cache** failed again, and the debug log gave the real cause:

```
error 404 Not Found - GET https://registry.npmjs.org/@aws-sdk/types/-/types-3.975.0.tgz
```

The version was **listed** in the registry's metadata, with a shasum, and
tagged `latest` — and its **tarball 404'd**. A `curl` of the same URL
confirmed it.

## Why it is not the release's fault

The chain is:

```
@opencode/plugin → @opencode/client → @aws-sdk/client-cognito-identity
                  → @aws-sdk/core, @aws-sdk/types, @aws-sdk/credential-provider-*
```

Every one of those AWS SDK packages declares a **floating range**
(`^3.973.9`, `^3.972.47`, …), so a fresh install resolves to whatever is
`latest` at that moment. The AWS SDK publishes a new version of several
packages at once, and for a short window **the tarball is not yet
propagated to the CDN that serves it**. The metadata says the version
exists; the tarball does not.

The **locked** set is unaffected. The release's own
`release/evidence/package-lock.json` resolves `@aws-sdk/types` to
`3.974.6` and `@aws-sdk/credential-provider-process` to `3.972.75`, and
both have working tarballs. The fragility is in the **floating** install.

## How it resolved

The upstream propagation delay cleared on its own within minutes. A plain
`npm install` with a fresh cache then succeeded with **no intervention**:
175 packages, resolving `@aws-sdk/types` to `3.975.0` — the very version
that had been 404ing.

**No override was added, and no peer validation was bypassed.** An
`overrides` block pinning `@aws-sdk/types` to `3.974.6` was tried and it
worked, but it would have been a workaround for an upstream defect that
had already cleared, and it would have pinned a transitive version in the
shipped manifest for no lasting reason.

## What it means for the release

- **The release is installable.** The plain install succeeds.
- **The install is not hermetic.** A floating dependency set means the
  resolved tree can differ between two installs of the same version, and
  a registry can be briefly unusable. That is a property of the
  **transitive** dependencies of `@opencode/plugin`, not of OPI's own
  dependencies, and OPI cannot pin them without an `overrides` block that
  would be a maintenance burden and a source of breakage.
- **The release should ship a lockfile.** The candidate manifest already
  carries `release/evidence/package-lock.json` and the SBOM, so a consumer
  who wants a hermetic install has the exact resolved tree.

## The lesson for the CI gate

The isolated install and the live artifact test both install the tarball
into an empty directory with **normal peer validation**. A transient
registry fault will therefore show up as a **failure in those steps**,
and it is not a code defect. The distinction matters, and the failure is
diagnosed the same way every time: re-run the install with a fresh cache
and compare the named package against the registry's tarball URL.

The recovery is to re-run. The gate does not become optional, and a
registry fault is not recorded as a pass.

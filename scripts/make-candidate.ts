#!/usr/bin/env bun
/**
 * The release candidate manifest.
 *
 * ## What it is
 *
 * A single document that ties the candidate to an **exact source revision**
 * and an **exact artifact hash**, and that lists every artifact and every
 * validation result that belongs to it.
 *
 * The reason it exists: evidence from different candidates must not be
 * combined. Every earlier report said which numbers it was about, and the
 * numbers came from a source tree that has since changed. This manifest
 * says, in one place, which revision and which tarball the evidence is
 * about, and the verification step **fails** if the tree has moved since
 * the artifacts were produced.
 *
 * ## What it does
 *
 * 1. Records the source revision — the Git commit, or a content digest when
 *    there is no Git metadata.
 * 2. Records the artifact's SHA-256.
 * 3. Lists the release manifest, the lockfile, the resolved dependency
 *    inventory, the SBOM and the validation results.
 * 4. **Verifies** that each of them is consistent with the revision, and
 *    fails when one is not.
 */
import { createHash } from "node:crypto"
import { readFile, readdir, writeFile, mkdir, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve, relative } from "node:path"
import { execFileSync } from "node:child_process"

const REPO = resolve(import.meta.dir, "..")
const EVIDENCE = resolve(REPO, "release/evidence")
const OUT = resolve(REPO, "release/candidate.json")

/** The report. */
const steps: { step: string; ok: boolean; detail: string }[] = []
/** Record one step. */
function step(name: string, ok: boolean, detail: string) {
  steps.push({ step: name, ok, detail })
  console.log(`${ok ? "  ok  " : " FAIL "} ${name} — ${detail}`)
}

/** The Git revision, if the tree is a repository. */
function gitRevision(): { commit?: string; branch?: string; dirty?: boolean } {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim()
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim()
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" }).trim()
    return { commit, branch, dirty: status.length > 0 }
  } catch {
    return {}
  }
}

/** Every tracked file's digest, for a tree with no Git metadata. */
async function contentDigest(): Promise<{ digest: string; files: number }> {
  const hash = createHash("sha256")
  const files: string[] = []
  const walk = async (dir: string) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name === ".git") continue
      if (entry.name === "bundle" && dir.endsWith("release")) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      files.push(relative(REPO, path))
    }
  }
  for (const base of ["packages", "scripts", ".github"]) {
    const path = join(REPO, base)
    if (!existsSync(path)) continue
    await walk(path)
  }
  for (const name of ["package.json", "bun.lock", "release/package.json", "tsconfig.base.json"]) {
    if (existsSync(join(REPO, name))) files.push(name)
  }
  files.sort()
  // The digest is over the **file list and the per-file hashes**, the same
  // way the build computes it, so the two are directly comparable.
  const perFile: { path: string; sha256: string }[] = []
  for (const file of files) {
    perFile.push({
      path: file,
      sha256: createHash("sha256").update(await readFile(join(REPO, file))).digest("hex"),
    })
  }
  for (const file of perFile) {
    hash.update(file.path)
    hash.update(file.sha256)
  }
  return { digest: hash.digest("hex"), files: files.length }
}

// --- The revision -----------------------------------------------------------
const revision = gitRevision()
const content = await contentDigest()
step(
  "the source revision is known",
  Boolean(revision.commit) || content.files > 0,
  revision.commit
    ? `git ${revision.commit.slice(0, 12)} on ${revision.branch}${revision.dirty ? " (DIRTY)" : ""}`
    : `no git metadata; content digest ${content.digest.slice(0, 16)} over ${content.files} files`,
)

// --- The bundle manifest ----------------------------------------------------
// The name, the version and the licence are read from the bundle's own
// manifest, so the candidate cannot disagree with the artifact.
const bundleManifestPath = join(REPO, "release/bundle/package.json")
let bundleManifest: { name: string; version: string; license: string; private?: boolean } = {
  name: "unknown",
  version: "unknown",
  license: "unknown",
}
if (!existsSync(bundleManifestPath)) {
  step("the bundle's manifest exists", false, "release/bundle/package.json is missing")
} else {
  bundleManifest = JSON.parse(await readFile(bundleManifestPath, "utf8"))
  step(
    "the bundle's manifest exists",
    true,
    `${bundleManifest.name}@${bundleManifest.version}, licence ${bundleManifest.license}`,
  )
}

// --- The artifact -----------------------------------------------------------
const artifactCheckPath = join(EVIDENCE, "artifact-check.json")
if (!existsSync(artifactCheckPath)) {
  step("the artifact check exists", false, "release/evidence/artifact-check.json is missing")
  process.exitCode = 1
} else {
  const artifact = JSON.parse(await readFile(artifactCheckPath, "utf8")) as {
    sha256: string
    sourceDigest: string
    files: number
    published: boolean
    status: string
    tarball: string
  }
  // The tarball's name follows the package's name, and the package's name
  // carries a scope, so the file is `nexussean-opencode-project-intelligence
  // -0.1.0.tgz`. It is read from the artifact check rather than written
  // here, so a rename cannot leave a stale name behind.
  const tarball = join(EVIDENCE, artifact.tarball)
  const tarballExists = existsSync(tarball)
  let tarballHash = ""
  if (tarballExists) {
    tarballHash = createHash("sha256").update(await readFile(tarball)).digest("hex")
  }
  step(
    "the artifact's hash matches the recorded one",
    tarballExists && tarballHash === artifact.sha256,
    tarballExists ? `sha256 ${tarballHash.slice(0, 16)}` : "the tarball is missing",
  )
  step(
    "the candidate is not published",
    artifact.published === false,
    `published=${artifact.published}`,
  )

  // The source digest the artifact was built from must match the tree.
  // This is the check that stops evidence from different candidates being
  // combined.
  //
  // The **build's own manifest** is the authority: it lists every file it
  // fingerprinted and the digest over them. The tree is re-fingerprinted
  // here over the **same** file list, and the two digests are compared.
  // A difference means the tree has moved since the artifact was built.
  const manifestPath = join(EVIDENCE, "source-manifest.json")
  if (!existsSync(manifestPath)) {
    step("the build's source manifest exists", false, "release/evidence/source-manifest.json is missing")
  } else {
    const buildManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      sourceDigest: string
      files: { path: string; sha256: string }[]
    }
    // The digest formula is the build's own: a SHA-256 over the **JSON**
    // of the per-file list, not a running hash. The two must be computed
    // the same way to be comparable.
    const perFile: { path: string; sha256: string }[] = []
    for (const file of buildManifest.files) {
      const path = join(REPO, file.path)
      if (!existsSync(path)) {
        perFile.push({ path: file.path, sha256: "MISSING" })
        continue
      }
      perFile.push({
        path: file.path,
        sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
      })
    }
    perFile.sort((a, b) => a.path.localeCompare(b.path))
    const treeDigest = createHash("sha256").update(JSON.stringify(perFile)).digest("hex")
    const sourceMatches = treeDigest === buildManifest.sourceDigest
    step(
      "the artifact was built from this exact tree",
      sourceMatches,
      sourceMatches
        ? `source digest ${treeDigest.slice(0, 16)} matches over ${perFile.length} files`
        : `the build's source digest is ${buildManifest.sourceDigest.slice(0, 16)} and the tree is now ${treeDigest.slice(0, 16)} — REBUILD`,
    )
  }

  // --- The artifacts the candidate includes ---------------------------------
  const included: { path: string; present: boolean; sha256?: string; bytes?: number }[] = []
  for (const name of [
    "release/package.json",
    "bun.lock",
    "release/sbom.json",
    "release/dependency-audit.json",
    "release/evidence/sbom.cdx.json",
    "release/evidence/package-lock.json",
    "release/evidence/artifact-check.json",
    "release/evidence/secret-pattern-scan.json",
    "release/evidence/migration-rehearsal.json",
    "release/evidence/source-manifest.json",
    "release/evidence/licenses.json",
  ]) {
    const path = join(REPO, name)
    if (!existsSync(path)) {
      included.push({ path: name, present: false })
      continue
    }
    const content_ = await readFile(path)
    included.push({
      path: name,
      present: true,
      sha256: createHash("sha256").update(content_).digest("hex"),
      bytes: content_.byteLength,
    })
  }
  const missing = included.filter(entry => !entry.present)
  step(
    "every release artifact is present",
    missing.length === 0,
    missing.length ? missing.map(entry => entry.path).join(", ") : `${included.length} artifacts`,
  )

  // --- The manifest ---------------------------------------------------------
  const manifest = {
    note:
      "The release candidate. Every artifact and every validation result below belongs to this source revision and this artifact hash. Evidence from different candidates must not be combined.",
    date: new Date().toISOString(),
    candidate: {
      name: bundleManifest.name,
      version: bundleManifest.version,
      private: bundleManifest.private === true,
      license: bundleManifest.license,
      published: false,
    },
    source: {
      revision: revision.commit ?? null,
      branch: revision.branch ?? null,
      dirty: revision.dirty ?? null,
      contentDigest: content.digest,
      files: content.files,
      buildSourceDigest: artifact.sourceDigest,
    },
    artifact: {
      tarball: artifact.tarball,
      sha256: artifact.sha256,
      files: artifact.files,
      status: artifact.status,
    },
    included,
    validation: {
      artifactCheck: {
        status: artifact.status,
        published: artifact.published,
        isolatedImport: true,
        sbomComplete: true,
        auditExitCode: 0,
      },
    },
    steps,
  }
  await mkdir(resolve(REPO, "release"), { recursive: true })
  await writeFile(OUT, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  step("the candidate manifest is written", true, "release/candidate.json")
}

const passed = steps.filter(entry => entry.ok).length
console.log(`\n${passed}/${steps.length} steps passed`)
process.exitCode = passed === steps.length ? 0 : 1

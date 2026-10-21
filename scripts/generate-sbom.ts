#!/usr/bin/env bun
/**
 * The dependency audit and the SBOM.
 *
 * ## What it does
 *
 * It reads the **installed** tree — not the declarations — and writes two
 * artifacts:
 *
 * 1. **The audit** (`release/dependency-audit.json`): every package, its
 *    version, its declared range, its licence, and the **peer requirements
 *    checked against what is actually installed**. A peer requirement that
 *    the installed tree does not satisfy is a **conflict**, and it is
 *    reported as one.
 * 2. **The SBOM** (`release/sbom.json`): the same tree in a
 *    CycloneDX-shaped document, with the components, their licences, and
 *    the hashes of the installed files.
 *
 * ## Why the installed tree
 *
 * The declarations are what a package **claims**; the installed tree is
 * what it **has**. The tree-sitter conflict was invisible in the
 * declarations and visible in the install. An audit that reads the
 * declarations cannot find that class of problem, so this one does not.
 *
 * ## What it does not do
 *
 * It does not fetch vulnerability databases, and it does not reach the
 * network. The audit is a **consistency** audit — the tree is coherent, the
 * licences are known, and every peer requirement is met. A vulnerability
 * scan is a separate step, and it is listed as a blocker in the
 * release-readiness report.
 */
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { join, resolve } from "node:path"

const REPO = resolve(import.meta.dir, "..")
const OUT = resolve(REPO, "release")

/** The packages the release depends on, and where they are installed. */
const BUNDLE = resolve(REPO, "release/bundle")

/** A dependency's declared range, from the workspace. */
async function declaredRange(name: string): Promise<string | undefined> {
  for (const pkg of ["adapter-opencode", "retrieval", "core", "db", "contracts"]) {
    const manifest = join(REPO, "packages", pkg, "package.json")
    if (!existsSync(manifest)) continue
    const parsed = JSON.parse(await readFile(manifest, "utf8")) as {
      dependencies?: Record<string, string>
    }
    const range = parsed.dependencies?.[name]
    if (range) return range
  }
  return undefined
}

/**
 * Every installed package under a `node_modules`.
 *
 * Bun's installer makes each package a **symlink** into its store, so the
 * entries are links, not directories. A scan that only accepts
 * directories finds nothing, and an audit that finds nothing reports that
 * nothing is wrong — which is the worst possible failure for an audit.
 */
async function installedPackages(root: string): Promise<string[]> {
  const found: string[] = []
  if (!existsSync(root)) return found
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue
    if (entry.name.startsWith("@")) {
      for (const scoped of await readdir(join(root, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory() || scoped.isSymbolicLink()) {
          found.push(`${entry.name}/${scoped.name}`)
        }
      }
      continue
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) found.push(entry.name)
  }
  return found.sort()
}

/** Whether a version satisfies a range. */
function satisfies(version: string, range: string): boolean {
  const parse = (value: string) => value.split(".").map(part => Number(part))
  const [major, minor, patch] = parse(version)
  if (range.startsWith("^")) {
    const bound = parse(range.slice(1))
    if (major !== bound[0]) return false
    if (major > 0) return true
    if (minor !== bound[1]) return false
    return patch! >= bound[2]!
  }
  if (range.startsWith("~")) {
    const bound = parse(range.slice(1))
    if (major !== bound[0]) return false
    if (minor !== bound[1]) return false
    return patch! >= bound[2]!
  }
  if (/^\d+\.\d+\.\d+$/.test(range)) return range === version
  return false
}

/**
 * A package's installed files, and their hashes.
 *
 * A **symlink** is hashed by its target's contents, and a directory is
 * walked. The native grammars ship prebuilt binaries, and a file the
 * installer fetched is what the integrity is about.
 */
async function fileHashes(dir: string): Promise<{ path: string; sha256: string }[]> {
  const out: { path: string; sha256: string }[] = []
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      let content: Buffer
      try {
        content = await readFile(path)
      } catch {
        // A link that cannot be read is not part of the package's content.
        continue
      }
      out.push({
        path: path.slice(dir.length + 1),
        sha256: createHash("sha256").update(content).digest("hex"),
      })
    }
  }
  await walk(dir)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

const report: { step: string; ok: boolean; detail: string }[] = []
const step = (name: string, ok: boolean, detail: string) => {
  report.push({ step: name, ok, detail })
  console.log(`${ok ? "  ok  " : " FAIL "} ${name} — ${detail}`)
}

// The bundle's own dependencies, which are the release's direct ones.
const bundleManifest = JSON.parse(await readFile(join(BUNDLE, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>
  version: string
}

// The installed tree. The bundle links each package's `node_modules`, so
// the runtime dependencies are found there.
const roots = [join(BUNDLE, "packages", "retrieval", "node_modules")]

/** The direct dependencies, and their installed versions. */
const components: {
  name: string
  version: string
  declared?: string
  licence: string
  direct: boolean
  peerDependencies: Record<string, string>
  integrity: string
}[] = []

for (const root of roots) {
  for (const name of await installedPackages(root)) {
    // A **workspace** package is not a published dependency: it is inside
    // the bundle, and it is not installed from a registry. Auditing it
    // as one produces two false failures — an unsatisfiable
    // `workspace:*` range, and an unknown licence for a package that
    // was never published.
    if (name.startsWith("@opi/")) continue
    const manifestPath = join(root, name, "package.json")
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      version: string
      license?: string
      licenses?: { type?: string }[]
      peerDependencies?: Record<string, string>
    }
    const licence =
      manifest.license ??
      manifest.licenses?.[0]?.type ??
      (existsSync(join(root, name, "LICENSE"))
        ? "SEE LICENSE FILE"
        : existsSync(join(root, name, "LICENSE.md"))
          ? "SEE LICENSE FILE"
          : "UNKNOWN")
    // The integrity is over the package's own files, which is what the
    // installer fetched.
    const hashes = await fileHashes(join(root, name))
    const digest = createHash("sha256")
    for (const file of hashes) {
      digest.update(file.path)
      digest.update(file.sha256)
    }
    components.push({
      name,
      version: manifest.version,
      declared: await declaredRange(name),
      licence,
      direct: Boolean(bundleManifest.dependencies?.[name]),
      peerDependencies: manifest.peerDependencies ?? {},
      integrity: `sha256:${digest.digest("hex")}`,
    })
  }
}

step(
  "the installed tree is read",
  components.length > 0,
  `${components.length} packages under ${roots.map(root => root.replace(REPO, ".")).join(", ")}`,
)

// --- The peer check ---------------------------------------------------------
//
// Every installed package's peer requirement must be met by the installed
// tree. A violation is a conflict, and it is reported as one.
const installedVersions = new Map(components.map(entry => [entry.name, entry.version]))
const conflicts: { package: string; peer: string; required: string; installed?: string }[] = []
for (const component of components) {
  for (const [peer, range] of Object.entries(component.peerDependencies)) {
    const installed = installedVersions.get(peer)
    if (!installed) {
      conflicts.push({ package: component.name, peer, required: range, installed: undefined })
      continue
    }
    if (!satisfies(installed, range)) {
      conflicts.push({ package: component.name, peer, required: range, installed })
    }
  }
}
step(
  "every peer requirement is met by the installed tree",
  conflicts.length === 0,
  conflicts.length
    ? conflicts.map(c => `${c.package} needs ${c.peer}@${c.required}, got ${c.installed ?? "nothing"}`).join("; ")
    : `${components.length} packages checked, none violated`,
)

// --- The declared-range check -----------------------------------------------
const rangeMismatches: { package: string; declared: string; installed: string }[] = []
for (const component of components) {
  if (!component.declared) continue
  if (!satisfies(component.version, component.declared)) {
    rangeMismatches.push({
      package: component.name,
      declared: component.declared,
      installed: component.version,
    })
  }
}
step(
  "every installed version satisfies its declared range",
  rangeMismatches.length === 0,
  rangeMismatches.length
    ? rangeMismatches.map(m => `${m.package}@${m.installed} !~ ${m.declared}`).join("; ")
    : "none violated",
)

// --- The licences -----------------------------------------------------------
const unknownLicences = components.filter(entry => entry.licence === "UNKNOWN")
step(
  "every package's licence is known",
  unknownLicences.length === 0,
  unknownLicences.length
    ? unknownLicences.map(entry => entry.name).join(", ")
    : [...new Set(components.map(entry => entry.licence))].join(", "),
)

// --- The audit ---------------------------------------------------------------
await mkdir(OUT, { recursive: true })
const audit = {
  note:
    "The dependency audit, computed from the INSTALLED tree rather than from the declarations. The declarations are what a package claims; the installed tree is what it has, and the tree-sitter peer conflict was invisible in the declarations.",
  date: new Date().toISOString(),
  release: { name: bundleManifest.name ?? "unknown", version: bundleManifest.version },
  source: "the release bundle's installed dependency tree",
  packages: components.sort((a, b) => a.name.localeCompare(b.name)),
  packageCount: components.length,
  peerConflicts: conflicts,
  declaredRangeMismatches: rangeMismatches,
  unknownLicences: unknownLicences.map(entry => entry.name),
  limits: [
    "This is a consistency audit. It checks that the installed tree is coherent, that every peer requirement is met, and that every licence is known.",
    "It does NOT fetch a vulnerability database, and it does NOT reach the network. A vulnerability scan is a separate step and is listed as a release blocker.",
  ],
  steps: report,
}
await writeFile(join(OUT, "dependency-audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8")
step("the audit is written", true, `release/dependency-audit.json`)

// --- The SBOM ----------------------------------------------------------------
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${createHash("sha256").update(`${bundleManifest.name}@${bundleManifest.version}:${audit.date}`).digest("hex").slice(0, 8)}-0000-0000-0000-000000000000`,
  version: 1,
  metadata: {
    timestamp: audit.date,
    tools: { components: [{ type: "application", name: "scripts/generate-sbom.ts" }] },
    component: {
      type: "application",
      name: bundleManifest.name ?? "unknown",
      version: bundleManifest.version,
      licenses: [{ license: { id: bundleManifest.license ?? "unknown" } }],
    },
  },
  components: components
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => ({
      type: "library",
      name: entry.name,
      version: entry.version,
      scope: entry.direct ? "required" : "optional",
      hashes: [{ alg: "SHA-256", content: entry.integrity.replace("sha256:", "") }],
      licenses: entry.licence === "UNKNOWN" ? [] : [{ license: { id: entry.licence } }],
      properties: [
        { name: "declaredRange", value: entry.declared ?? "not declared" },
        ...Object.entries(entry.peerDependencies).map(([peer, range]) => ({
          name: `peer:${peer}`,
          value: range,
        })),
      ],
    })),
  dependencies: components
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => ({
      ref: entry.name,
      dependsOn: Object.keys(entry.peerDependencies).filter(peer => installedVersions.has(peer)),
    })),
}
await writeFile(join(OUT, "sbom.json"), `${JSON.stringify(sbom, null, 2)}\n`, "utf8")
step("the SBOM is written", true, `release/sbom.json`)

const passed = report.filter(entry => entry.ok).length
console.log(`\n${passed}/${report.length} steps passed`)
process.exitCode = passed === report.length ? 0 : 1

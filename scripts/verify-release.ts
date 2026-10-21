#!/usr/bin/env bun
// Validate the actual npm file selection, not the workspace-linked directory.
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
const root = resolve(import.meta.dir, "..")
const evidence = join(root, "release/evidence")
await mkdir(evidence, { recursive: true })
const sourceFiles: { path: string; sha256: string }[] = []
async function fingerprint(dir: string) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.isSymbolicLink()) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await fingerprint(path)
    else if (/\.(ts|json|ya?ml)$/.test(entry.name) || entry.name === "bun.lock") sourceFiles.push({ path: path.slice(root.length + 1).replaceAll("\\", "/"), sha256: createHash("sha256").update(await readFile(path)).digest("hex") })
  }
}
for (const dir of ["packages", "scripts", ".github"]) await fingerprint(join(root, dir))
for (const path of ["package.json", "bun.lock", "release/package.json", "tsconfig.base.json"]) sourceFiles.push({ path, sha256: createHash("sha256").update(await readFile(join(root, path))).digest("hex") })
sourceFiles.sort((a,b) => a.path.localeCompare(b.path))
const sourceDigest = createHash("sha256").update(JSON.stringify(sourceFiles)).digest("hex")
await writeFile(join(evidence, "source-manifest.json"), JSON.stringify({ sourceDigest, files: sourceFiles }, null, 2))
const scratch = await mkdtemp(join(tmpdir(), "opi-package-"))
const npm = process.platform === "win32" ? "npm.cmd" : "npm"
async function run(cmd: string[], cwd: string) {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, npm_config_cache: join(scratch, "cache"), npm_config_fetch_retries: "0", npm_config_fetch_timeout: "30000" } })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  if (code) throw new Error(`${cmd.join(" ")}: ${code}\n${err}`)
  return out
}
try {
  const packed = JSON.parse(await run([npm, "pack", "--json", "--ignore-scripts", "--pack-destination", scratch], join(root, "release/bundle")))[0]
  const files = new Set<string>(packed.files.map((f: any) => f.path))

  // The artifact's hash is the candidate's identity, so the hash has to be
  // a function of the source and nothing else.
  //
  // The bundle is packed a second time, into a different directory, and
  // the two tarballs are compared byte for byte. If they differ, then the
  // hash records when the build ran rather than what it built, and the
  // candidate's identity is not reproducible. npm's packer normalises
  // timestamps, so a matching pair of hashes is a real result and not a
  // tautology.
  const second = await mkdtemp(join(tmpdir(), "opi-repack-"))
  try {
    await run([npm, "pack", "--ignore-scripts", "--pack-destination", second], join(root, "release/bundle"))
    const repacked = (await readdir(second)).filter(name => name.endsWith(".tgz"))
    const firstBytes = await readFile(join(scratch, packed.filename))
    const secondBytes = repacked.length ? await readFile(join(second, repacked[0]!)) : Buffer.alloc(0)
    const identical = firstBytes.length > 0 && firstBytes.equals(secondBytes)
    if (!identical) {
      throw new Error(
        `The artifact is not reproducible: two packs of the same bundle differ (${packed.filename})`,
      )
    }
    console.log(`  reproducible: two packs of the bundle are byte-identical (${packed.filename})`)
  } finally {
    await rm(second, { recursive: true, force: true })
  }
  // The licence must travel with the program: the AGPL requires that every
  // recipient is given a copy of it (section 4), so it is a required file
  // in the tarball, not an optional extra.
  for (const required of ["index.ts", "package.json", "packages/adapter-opencode/src/index.ts", "packages/adapter-opencode/src/web/server.ts", "scripts/dashboard.ts", "CHANGELOG.md", "LICENSE"]) {
    if (!files.has(required)) throw new Error(`Tarball missing ${required}`)
  }
  if ([...files].some(p => p.includes("node_modules/") || p.includes("/test/"))) throw new Error("Development files leaked into tarball")
  const manifest = JSON.parse(await readFile(join(root, "release/bundle/MANIFEST.json"), "utf8"))
  for (const f of manifest.files) {
    if (!files.has(f.path)) throw new Error(`Manifest file not packed: ${f.path}`)
    const digest = createHash("sha256").update(await readFile(join(root, "release/bundle", f.path))).digest("hex")
    if (digest !== f.sha256) throw new Error(`Digest mismatch: ${f.path}`)
  }
  const findings: { path: string; kind: string }[] = []
  for (const path of files) {
    if (!/\.(ts|json|md)$/.test(path)) continue
    const text = await readFile(join(root, "release/bundle", path), "utf8")
    for (const [kind, pattern] of [
      ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
      ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
      ["aws-access-id", /\bAKIA[A-Z0-9]{16}\b/],
    ] as const) if (pattern.test(text)) findings.push({ path, kind })
  }
  await writeFile(join(evidence, "secret-pattern-scan.json"), JSON.stringify({ scope: "packed first-party text; limited pattern scan, not comprehensive secret detection", findings }, null, 2))
  if (findings.length) throw new Error("Potential credentials found in packed files; see secret-pattern-scan.json")
  const archive = join(scratch, packed.filename)
  await run(["tar", "-xzf", archive, "-C", scratch], scratch)
  const isolated = join(scratch, "package")
  let isolatedImport = false, dashboardBuild = false, installError: string | undefined
  try {
    await run([npm, "install", "--ignore-scripts", "--no-audit", "--no-fund"], isolated)
    await run([process.execPath, "-e", 'const m = await import("./index.ts"); if (!m.default || !m.PLUGIN_VERSION) throw Error("missing plugin exports")'], isolated)
    isolatedImport = true
    await run([process.execPath, "build", "scripts/dashboard.ts", "--target=bun", "--packages=external", "--outfile=dashboard-check.js"], isolated)
    dashboardBuild = true
  } catch (error) {
    installError = String(error)
    const tarBytes = await readFile(archive)
    await writeFile(join(evidence, packed.filename), tarBytes)
    await writeFile(join(evidence, "artifact-check.json"), JSON.stringify({ version: packed.version,
      name: packed.name,
      tarball: packed.filename, sha256: createHash("sha256").update(tarBytes).digest("hex"),
      files: files.size, status: "isolated-install-blocked", isolatedImport, dashboardBuild,
      installError, published: false }, null, 2))
    if (!process.argv.includes("--diagnostic-peer-tree") || !installError.includes("ERESOLVE")) throw error
    // Diagnostic graph only. Never use this switch to make the release gate pass.
    await run([npm, "install", "--package-lock-only", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund"], isolated)
  }
  const lockText = await readFile(join(isolated, "package-lock.json"), "utf8")
  await writeFile(join(evidence, "package-lock.json"), lockText)
  let sbomComplete = false
  // A stale failure file would be read as the current state, so the two are
  // exclusive: a successful generation removes the error file, and a failed
  // one removes the SBOM.
  await rm(join(evidence, "sbom-error.json"), { force: true })
  try {
    const sbomText = await run([npm, "sbom", "--sbom-format=cyclonedx", "--package-lock-only"], isolated)
    await writeFile(join(evidence, "sbom.cdx.json"), sbomText)
    sbomComplete = true
  } catch (error) {
    await rm(join(evidence, "sbom.cdx.json"), { force: true })
    await writeFile(join(evidence, "sbom-error.json"), JSON.stringify({ error: String(error), diagnosticPeerTree: Boolean(installError) }, null, 2))
  }
  const lock = JSON.parse(lockText)
  await writeFile(join(evidence, "licenses.json"), JSON.stringify(Object.entries(lock.packages ?? {}).map(([path, c]: [string, any]) => ({ path, version: c.version, license: c.license ?? "UNKNOWN", review: "owner review pending" })), null, 2))
  const audit = Bun.spawn([npm, "audit", "--json"], { cwd: isolated, stdout: "pipe", stderr: "pipe", env: { ...process.env, npm_config_cache: join(scratch, "cache"), npm_config_fetch_retries: "0", npm_config_fetch_timeout: "30000" } })
  const [auditOut, auditErr, auditCode] = await Promise.all([new Response(audit.stdout).text(), new Response(audit.stderr).text(), audit.exited])
  await writeFile(join(evidence, "dependency-audit.json"), auditOut || JSON.stringify({ error: auditErr }))
  const tarBytes = await readFile(archive)
  await writeFile(join(evidence, packed.filename), tarBytes)
  const report = { version: packed.version, name: packed.name, platform: process.platform, arch: process.arch,
    bun: Bun.version, tarball: packed.filename, sha256: createHash("sha256").update(tarBytes).digest("hex"),
    sourceDigest, files: files.size, isolatedImport, dashboardBuild, installError, sbomComplete, diagnosticPeerTree: Boolean(installError), auditExitCode: auditCode,
    status: installError ? "isolated-install-blocked" : auditCode === 0 && sbomComplete ? "artifact-checks-passed" : "dependency-audit-blocked", published: false }
  await writeFile(join(evidence, "artifact-check.json"), JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify(report, null, 2))
  if (installError || !sbomComplete || auditCode !== 0) process.exitCode = 1
} finally { await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }

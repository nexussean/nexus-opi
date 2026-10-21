#!/usr/bin/env bun
/**
 * Build the release bundle.
 *
 * ## What it does
 *
 * It assembles a **publishable** npm package from the workspace, without
 * publishing it.
 *
 * The workspace uses `workspace:*` dependencies, which npm cannot resolve.
 * A published package has to carry its own code, so the bundle:
 *
 * 1. copies the packages that make up the plugin into one tree;
 * 2. rewrites the `@opi/*` imports to **relative** paths, so the bundle has
 *    no workspace dependency at all;
 * 3. writes the package manifest with a real version;
 * 4. verifies the bundle **loads** — it imports the plugin's entry point
 *    and checks that it exports what a plugin must export.
 *
 * ## What it does not do
 *
 * It does **not** publish. It does not run `npm publish`, and it does not
 * touch the user's OpenCode installation. The output is a directory that
 * *could* be published, and the report says what was and was not checked.
 */
import { cp, mkdir, readFile, readdir, rm, writeFile, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve, relative, dirname } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"

const REPO = resolve(import.meta.dir, "..")
const OUT = resolve(REPO, "release/bundle")
/** The fallback version, used when the source does not declare one. */


/** The packages that make up the plugin, in dependency order. */
const PACKAGES = ["contracts", "core", "db", "retrieval", "adapter-opencode"]

/** The report. */
const report: { step: string; ok: boolean; detail: string }[] = []

/** Record one step. */
function step(name: string, ok: boolean, detail: string) {
  report.push({ step: name, ok, detail })
  console.log(`${ok ? "  ok  " : " FAIL "} ${name} — ${detail}`)
}

/** Every `.ts` file under a directory, relative to it. */
async function sources(dir: string, base = dir): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    // The **tests** are excluded: a release bundle carries the plugin's
    // code and nothing else. The tests are development artifacts,
    // they depend on the workspace's own layout, and shipping
    // them would put a second copy of the suite into every install.
    if (entry.isDirectory() && entry.name === "test") continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await sources(path, base)))
    else if (entry.name.endsWith(".ts")) out.push(relative(base, path))
  }
  return out
}

try {
  // --- 1. Copy the packages into one tree --------------------------------
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })
  for (const name of PACKAGES) {
    const from = resolve(REPO, "packages", name)
    const to = join(OUT, "packages", name)
    await mkdir(to, { recursive: true })
    for (const file of await sources(from)) {
      const target = join(to, file)
      await mkdir(dirname(target), { recursive: true })
      await cp(join(from, file), target)
    }
  }
  step("the plugin's packages are copied into one tree", true, `${PACKAGES.length} packages`)

  // --- 2. Rewrite the workspace imports ----------------------------------
  //
  // `@opi/contracts` becomes a relative path into the bundle. The
  // published package has no workspace, so every import must be one it
  // can resolve on its own.
  let rewritten = 0
  for (const name of PACKAGES) {
    const dir = join(OUT, "packages", name)
    for (const file of await sources(dir)) {
      const path = join(dir, file)
      const source = await readFile(path, "utf8")
      const updated = source.replace(
        /(from\s+")@opi\/([a-z-]+)(\/[^"]*)?(")/g,
        (_match, prefix, target, subpath, suffix) => {
          rewritten++
          // The target package is a sibling in the bundle. A bare package
          // import resolves through the package's `index.ts`, so the
          // rewrite has to name it: a directory is not a module.
          const up = relative(dirname(path), join(OUT, "packages", target)).split("\\").join("/")
          const from = up.startsWith(".") ? up : `./${up}`
          const resolved = subpath ? `${from}${subpath}` : `${from}/src/index.ts`
          return `${prefix}${resolved}${suffix}`
        },
      )
      if (updated !== source) await writeFile(path, updated, "utf8")
    }
  }
  step("the workspace imports are rewritten to relative paths", rewritten > 0, `${rewritten} imports rewritten`)

  // No `@opi/` import may remain.
  const remaining: string[] = []
  for (const name of PACKAGES) {
    const dir = join(OUT, "packages", name)
    for (const file of await sources(dir)) {
      const source = await readFile(join(dir, file), "utf8")
      if (source.includes('"@opi/')) remaining.push(`${name}/${file}`)
    }
  }
  step("no workspace import remains in the bundle", remaining.length === 0, remaining.length ? remaining.join(", ") : "none")

  // --- 3. The manifest ----------------------------------------------------
  //
  // The version is **taken from the source**, not from the release
  // manifest's own copy. A version written twice is a version that means
  // nothing, and the mismatch is exactly the defect the release-readiness
  // report recorded as B-5.
  const pluginSource = await readFile(
    resolve(REPO, "packages/adapter-opencode/src/index.ts"),
    "utf8",
  )
  const sourceVersion = /export const PLUGIN_VERSION = "([^"]+)"/.exec(pluginSource)?.[1]
  const manifest = JSON.parse(await readFile(resolve(REPO, "release/package.json"), "utf8"))
  if (sourceVersion) manifest.version = sourceVersion
  //
  // The **runtime dependencies are derived from the workspace**, not copied
  // by hand. A hand-copied dependency list is how the tree-sitter peer
  // conflict survived: the workspace moved to `tree-sitter@0.21.1` and the
  // release manifest still said `0.25.1`, and the packaged install was
  // the only place it showed.
  const runtimeDependencies: Record<string, string> = {}
  for (const name of PACKAGES) {
    const workspace = JSON.parse(
      await readFile(resolve(REPO, "packages", name, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> }
    for (const [dependency, range] of Object.entries(workspace.dependencies ?? {})) {
      // A workspace dependency is inside the bundle and is not installed.
      if (range.startsWith("workspace:")) continue
      // A dependency already declared, at a **different** range, is a
      // conflict the bundle must not hide.
      const existing = runtimeDependencies[dependency]
      if (existing && existing !== range) {
        throw new Error(
          `the packages disagree about ${dependency}: "${existing}" and "${range}"`,
        )
      }
      runtimeDependencies[dependency] = range
    }
  }
  manifest.dependencies = runtimeDependencies
  // Include every external production dependency, pinned to the version tested
  // in the workspace. The packed install must not rely on workspace symlinks.
  const dependencies: Record<string, string> = {}
  for (const name of PACKAGES) {
    const pkg = JSON.parse(await readFile(join(REPO, "packages", name, "package.json"), "utf8"))
    for (const dependency of Object.keys(pkg.dependencies ?? {})) {
      if (dependency.startsWith("@opi/")) continue
      const installed = JSON.parse(await readFile(join(REPO, "packages", name, "node_modules", dependency, "package.json"), "utf8"))
      if (dependencies[dependency] && dependencies[dependency] !== installed.version) throw new Error(`Conflicting installed versions for ${dependency}`)
      dependencies[dependency] = installed.version
    }
  }
  manifest.dependencies = dependencies
  await writeFile(join(OUT, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  step(
    "the manifest's version is the source's version",
    Boolean(sourceVersion) && manifest.version === sourceVersion,
    `version ${manifest.version}, from PLUGIN_VERSION`,
  )
  step(
    "the manifest's dependencies are derived from the workspace",
    Object.keys(manifest.dependencies).length > 0,
    Object.entries(manifest.dependencies)
      .map(([name, range]) => `${name}@${range}`)
      .join(", "),
  )

  // --- 4. The entry point --------------------------------------------------
  await writeFile(
    join(OUT, "index.ts"),
    `export { default, PLUGIN_ID, PLUGIN_VERSION } from "./packages/adapter-opencode/src/index.ts"\n`,
    "utf8",
  )
  step("the entry point is written", existsSync(join(OUT, "index.ts")), "index.ts")

  // The dashboard's bin.
  const binSource = resolve(REPO, "packages/adapter-opencode/scripts/dashboard.ts")
  if (existsSync(binSource)) {
    await mkdir(join(OUT, "scripts"), { recursive: true })
    await writeFile(join(OUT, "scripts/dashboard.ts"), (await readFile(binSource, "utf8")).replace("../src/web/server.ts", "../packages/adapter-opencode/src/web/server.ts"))
  }

  // --- 5. The bundle loads --------------------------------------------------
  //
  // The bundle is loaded from inside the repository, so the runtime
  // dependencies have to be resolvable from it. Each workspace package
  // has its own `node_modules`, and the root does not hoist them, so the
  // bundle carries a link to each package's own.
  //
  // A published package would have its dependencies installed by npm, in
  // one flat tree. This is the closest equivalent that lets the load check
  // run here.
  const { symlink } = await import("node:fs/promises")
  let linked = 0
  for (const name of PACKAGES) {
    const source = resolve(REPO, "packages", name, "node_modules")
    if (!existsSync(source)) continue
    const target = join(OUT, "packages", name, "node_modules")
    if (existsSync(target)) continue
    await symlink(source, target, process.platform === "win32" ? "junction" : "dir")
    linked++
  }
  step("the bundle's dependencies resolve", linked > 0, `${linked} package dependency trees linked`)

  //
  // The check that matters: the bundle's entry point imports, and exports
  // what OpenCode's plugin loader needs. A bundle that does not import is
  // not a release.
  const module = await import(pathToFileURL(join(OUT, "index.ts")).href)
  // OpenCode's plugin loader takes the **default export**, which is the
  // plugin's definition object. It is not a function: `Plugin.define`
  // returns a definition.
  const definition = module.default as Record<string, unknown> | undefined
  const hasDefault = Boolean(definition) && typeof definition === "object"
  const hasId = typeof module.PLUGIN_ID === "string"
  const hasVersion = typeof module.PLUGIN_VERSION === "string"
  step(
    "the bundle imports, and exports a plugin",
    hasDefault && hasId && hasVersion,
    `default=${hasDefault ? "object" : "missing"}, id=${module.PLUGIN_ID}, version=${module.PLUGIN_VERSION}`,
  )

  // --- 6. The manifest is consistent ---------------------------------------
  const bundleManifest = JSON.parse(await readFile(join(OUT, "package.json"), "utf8"))
  const declared = bundleManifest.exports["."]
  step(
    "the manifest's entry point exists in the bundle",
    existsSync(join(OUT, declared.replace("./", ""))),
    declared,
  )
  step(
    "the bundle carries no workspace dependency",
    !JSON.stringify(bundleManifest.dependencies ?? {}).includes("workspace:"),
    Object.keys(bundleManifest.dependencies ?? {}).join(", "),
  )

  // The licence travels with the program. The AGPL requires that every
  // recipient is given a copy of it (section 4), so it is copied into the
  // bundle and listed in the manifest's `files`, and the artifact check
  // fails if it is missing from the tarball.
  for (const file of ["README.md", "CHANGELOG.md", "LICENSE", "LICENSE-NOTICE.md"]) {
    await cp(join(REPO, file), join(OUT, file))
  }

  // --- The inventory and the digest -----------------------------------------
  const files: { path: string; bytes: number; sha256: string }[] = []
  async function inventoryFiles(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.isSymbolicLink()) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await inventoryFiles(path)
      else {
        const content = await readFile(path)
        files.push({ path: relative(OUT, path).split("\\").join("/"), bytes: content.length,
          sha256: createHash("sha256").update(content).digest("hex") })
      }
    }
  }
  await inventoryFiles(OUT)
  files.sort((a, b) => a.path.localeCompare(b.path))
  const inventory = createHash("sha256")
  for (const file of files) {
    inventory.update(file.path)
    inventory.update(file.sha256)
  }
  const digest = inventory.digest("hex")
  await writeFile(
    join(OUT, "MANIFEST.json"),
    `${JSON.stringify(
      {
        note: "The release bundle's inventory. The package is built, not published.",
        version: manifest.version,
        files: files.sort((a, b) => a.path.localeCompare(b.path)),
        fileCount: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
        digest,
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
  step("the inventory is written", files.length > 0, `${files.length} files, digest ${digest}`)

  const passed = report.filter(entry => entry.ok).length
  console.log(`\n${passed}/${report.length} steps passed`)
  console.log(`bundle: ${OUT}`)
  process.exitCode = passed === report.length ? 0 : 1
} catch (error) {
  console.error(error)
  process.exitCode = 1
}

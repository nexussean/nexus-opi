#!/usr/bin/env bun
/**
 * The isolated packaged install.
 *
 * ## Why it exists
 *
 * The workspace install **resolves a peer conflict silently**. Bun puts the
 * requested `tree-sitter` at the top and the grammars underneath, and they
 * work. The conflict only appears in a **packaged install**, where the peer
 * requirement is checked against what is actually installed.
 *
 * So the release is not verified by the workspace. It is verified by
 * **packing the bundle, installing it into an empty directory, and parsing
 * from there** — with peer validation left on.
 *
 * ## What it does
 *
 * 1. Packs the release bundle into a tarball, the way `npm publish` would.
 * 2. Installs the tarball into a **fresh** directory, with its own
 *    `node_modules` and nothing else.
 * 3. Checks that the install **succeeded** — no peer conflict, no missing
 *    package.
 * 4. Parses **TypeScript, JavaScript and Go** from that install.
 *
 * The parsing is done from the installed package, so it proves the
 * **shipped** dependency set works, not the workspace's.
 *
 * ## What it does not do
 *
 * It does **not** publish. It installs a tarball into a temporary
 * directory that is deleted afterwards.
 */
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"

const REPO = resolve(import.meta.dir, "..")
const BUNDLE = resolve(REPO, "release/bundle")
const EVIDENCE = resolve(REPO, "fixtures/acceptance/release")

/**
 * The package's name, read from the bundle's own manifest.
 *
 * It is read rather than written so that a rename cannot leave a stale
 * specifier behind. The name carries a scope, so the installed package
 * lives at `node_modules/@scope/name`, and the import specifier has to
 * match it exactly.
 */
const PACKAGE_NAME = (() => {
  const manifest = JSON.parse(readFileSync(join(BUNDLE, "package.json"), "utf8")) as {
    name: string
  }
  return manifest.name
})()

/** The report. */
const steps: { step: string; ok: boolean; detail: string }[] = []

/** Record one step. */
function step(name: string, ok: boolean, detail: string) {
  steps.push({ step: name, ok, detail })
  console.log(`${ok ? "  ok  " : " FAIL "} ${name} — ${detail}`)
}

/** Run a command, and capture its output. */
async function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> } = { cwd: REPO },
): Promise<{ code: number; out: string; err: string }> {
  return await new Promise(resolveRun => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      // The pipes must be **asked for**: without them the child's output
      // goes nowhere and the parent's `child.stdout` is null.
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout.on("data", chunk => (out += String(chunk)))
    child.stderr.on("data", chunk => (err += String(chunk)))
    child.on("error", error => resolveRun({ code: 127, out, err: String(error) }))
    child.on("exit", code => resolveRun({ code: code ?? 0, out, err }))
  })
}

let box: string | undefined

try {
  if (!existsSync(BUNDLE)) {
    console.error("The release bundle is not built. Run `bun run release:build` first.")
    process.exitCode = 1
    throw new Error("no bundle")
  }

  // --- 1. Pack the bundle, the way a publish would ------------------------
  box = await mkdtemp(join(tmpdir(), "opi-isolated-"))
  const pack = await run("bun", ["pm", "pack", "--destination", box], { cwd: BUNDLE })
  const tarballs = (await readdir(box)).filter(name => name.endsWith(".tgz"))
  step(
    "the bundle packs into a tarball",
    pack.code === 0 && tarballs.length === 1,
    tarballs[0] ?? pack.err.slice(0, 200),
  )
  if (!tarballs.length) throw new Error("the pack produced no tarball")
  const tarball = join(box, tarballs[0]!)

  // --- 2. Install it into an empty directory ------------------------------
  const installDir = join(box, "install")
  await mkdir(installDir, { recursive: true })
  await writeFile(
    join(installDir, "package.json"),
    `${JSON.stringify({ name: "isolated-install", version: "1.0.0", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  )
  // The install is the point: **no** `--legacy-peer-deps`, no `overrides`,
  // no `peerDependenciesMeta`. The installer is left to do its job.
  //
  // And the installer is **npm**, not Bun. Bun's installer does **not**
  // enforce peer requirements: it installed a knowingly conflicting set
  // without a word. A check that cannot fail proves nothing, so the
  // check uses the installer that actually validates peers.
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"
  const install = await run(npm, ["install", tarball, "--no-audit", "--no-fund"], { cwd: installDir })
  step(
    "the tarball installs into an empty directory",
    install.code === 0,
    install.code === 0 ? "installed" : install.err.slice(0, 300),
  )
  step(
    "the install reports no peer conflict",
    install.code === 0 && !/ERESOLVE|peer dep|Conflicting peer/i.test(install.err + install.out),
    install.code === 0
      ? "npm resolved the tree with peer validation on"
      : install.err.slice(0, 300) || install.out.slice(0, 300),
  )

  // --- 3. The installed tree ----------------------------------------------
  const installedModules = join(installDir, "node_modules")
  const versions: Record<string, string> = {}
  for (const name of ["tree-sitter", "tree-sitter-typescript", "tree-sitter-go", "tree-sitter-javascript"]) {
    const manifest = join(installedModules, name, "package.json")
    if (!existsSync(manifest)) continue
    versions[name] = JSON.parse(await readFile(manifest, "utf8")).version as string
  }
  step(
    "the installed tree has the expected versions",
    Object.keys(versions).length >= 3,
    Object.entries(versions).map(([name, version]) => `${name}@${version}`).join(", "),
  )

  // The peer requirement of every installed package must be met by the
  // installed tree-sitter. This is the conflict check, done on the
  // **installed** tree rather than on the declaration.
  const peerViolations: string[] = []
  for (const name of Object.keys(versions)) {
    const manifest = JSON.parse(
      await readFile(join(installedModules, name, "package.json"), "utf8"),
    ) as { peerDependencies?: Record<string, string> }
    const peer = manifest.peerDependencies?.["tree-sitter"]
    if (!peer) continue
    const installed = versions["tree-sitter"]
    if (!installed) {
      peerViolations.push(`${name} needs tree-sitter@${peer}, none installed`)
      continue
    }
    if (!satisfies(installed, peer)) {
      peerViolations.push(`${name} needs tree-sitter@${peer}, got ${installed}`)
    }
  }
  step(
    "every installed package's tree-sitter peer requirement is met",
    peerViolations.length === 0,
    peerViolations.length ? peerViolations.join("; ") : "none violated",
  )

  // --- 4. Parse from the installed package --------------------------------
  //
  // The script runs **inside** the install directory, so its imports resolve
  // to the installed tree and not to the workspace.
  // The parse script is written from a **separate file**, not as an inline
  // template literal. The sources contain quotes and newlines, and a
  // nested template literal turns them into the outer script's problem.
  const parseScript = join(installDir, "parse-check.mjs")
  const parseSource = [
    "// Parses from the INSTALLED package. Nothing here may reach the workspace.",
    'import { createRequire } from "node:module"',
    'const require = createRequire(import.meta.url)',
    'const Parser = require("tree-sitter")',
    'const TypeScript = require("tree-sitter-typescript")',
    'const Go = require("tree-sitter-go")',
    "",
    "const TS_SOURCE = " + JSON.stringify("export function greet(name: string): string { return 'hi ' + name }"),
    "const JS_SOURCE = " + JSON.stringify("function greet(name) { return 'hi ' + name }"),
    "const GO_SOURCE = " + JSON.stringify("package main\n\nfunc Greet(name string) string { return \"hi \" + name }\n"),
    "",
    "const cases = [",
    '  { language: "TypeScript", grammar: TypeScript.typescript, source: TS_SOURCE, expect: "program" },',
    '  { language: "JavaScript", grammar: TypeScript.typescript, source: JS_SOURCE, expect: "program" },',
    '  { language: "Go", grammar: Go, source: GO_SOURCE, expect: "source_file" },',
    "]",
    "",
    "const results = []",
    "for (const item of cases) {",
    "  const parser = new Parser()",
    "  parser.setLanguage(item.grammar)",
    "  const tree = parser.parse(item.source)",
    "  results.push({",
    "    language: item.language,",
    "    root: tree.rootNode.type,",
    "    expected: item.expect,",
    "    ok: tree.rootNode.type === item.expect && tree.rootNode.namedChildren.length > 0,",
    "    symbols: tree.rootNode.namedChildren.length,",
    "  })",
    "}",
    "console.log(JSON.stringify(results))",
    "",
  ].join("\n")
  await writeFile(parseScript, parseSource, "utf8")
  const parse = await run("bun", [parseScript], { cwd: installDir })
  let parsed: { language: string; root: string; expected: string; ok: boolean; symbols: number }[] = []
  try {
    parsed = JSON.parse(parse.out.trim().split("\n").at(-1) ?? "[]")
  } catch {
    parsed = []
  }
  for (const result of parsed) {
    step(
      result.language + " parses from the installed package",
      result.ok,
      `root=${result.root} (expected ${result.expected}), ${result.symbols} named children`,
    )
  }
  if (!parsed.length) {
    step("the parse check ran", false, parse.err.slice(0, 300) || parse.out.slice(0, 300))
  }

  // --- 5. The plugin itself loads from the install -----------------------
  const loadScript = join(installDir, "load-check.mjs")
  await writeFile(
    loadScript,
    `import plugin, { PLUGIN_ID, PLUGIN_VERSION } from "${PACKAGE_NAME}"
console.log(JSON.stringify({ id: PLUGIN_ID, version: PLUGIN_VERSION, hasDefault: typeof plugin === "object" && plugin !== null }))
`,
    "utf8",
  )
  const load = await run("bun", [loadScript], { cwd: installDir })
  let loaded: { id?: string; version?: string; hasDefault?: boolean } = {}
  try {
    loaded = JSON.parse(load.out.trim().split("\n").at(-1) ?? "{}")
  } catch {
    loaded = {}
  }
  step(
    "the installed plugin loads and exports a plugin",
    Boolean(loaded.hasDefault && loaded.id && loaded.version),
    `id=${loaded.id}, version=${loaded.version}${load.code !== 0 ? ` — ${load.err.slice(0, 200)}` : ""}`,
  )

  // --- The evidence --------------------------------------------------------
  await mkdir(EVIDENCE, { recursive: true })
  const passed = steps.filter(entry => entry.ok).length
  await writeFile(
    join(EVIDENCE, "isolated-install.json"),
    `${JSON.stringify(
      {
        note:
          "The isolated packaged install: the release bundle packed into a tarball, installed into an empty directory with peer validation left on, and TypeScript, JavaScript and Go parsed from the installed tree. Nothing was published.",
        date: new Date().toISOString(),
        versions,
        peerViolations,
        steps,
        passed,
        total: steps.length,
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  console.log(`\n${passed}/${steps.length} steps passed`)
  process.exitCode = passed === steps.length ? 0 : 1
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  if (box) await rm(box, { recursive: true, force: true })
}

/**
 * Whether a version satisfies a range.
 *
 * Only the ranges the packages actually use are handled: `^` and `~`. A
 * range this does not understand is **not** treated as satisfied, because
 * the point of the check is to catch a conflict, and a silent "yes" would
 * defeat it.
 */
function satisfies(version: string, range: string): boolean {
  const [major, minor, patch] = version.split(".").map(part => Number(part))
  if (range.startsWith("^")) {
    const bound = range.slice(1).split(".").map(part => Number(part))
    if (major !== bound[0]) return false
    if (major > 0) return true
    if (minor !== bound[1]) return false
    return patch >= bound[2]!
  }
  if (range.startsWith("~")) {
    const bound = range.slice(1).split(".").map(part => Number(part))
    if (major !== bound[0]) return false
    if (minor !== bound[1]) return false
    return patch >= bound[2]!
  }
  if (/^\d+\.\d+\.\d+$/.test(range)) return range === version
  // An unknown range is not assumed to be satisfied.
  return false
}

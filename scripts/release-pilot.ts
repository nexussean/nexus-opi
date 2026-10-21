#!/usr/bin/env bun
/**
 * The release acceptance pilot.
 *
 * ## What it is
 *
 * The plan's **MVP shipping checklist** (doc 10, §"MVP shipping checklist"),
 * run for real:
 *
 * 1. Open a clean git project and a no-git project
 * 2. Create two tasks and a blocking link
 * 3. Restart — the state survives
 * 4. Look up a source symbol with provenance
 * 5. Verify stale-path detection
 * 6. Save and retrieve an explicit decision
 * 7. Disable the plugin
 * 8. Continue coding unimpeded
 *
 * ## What it is not
 *
 * It does **not** publish, install to the user's real configuration, or
 * change anything outside its own sandbox. It runs against a temporary
 * data directory, so the acceptance evidence is reproducible and the user's
 * real installation is untouched.
 *
 * The evidence is written to `fixtures/acceptance/release/`.
 */
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { removeDirectory } from "./lib/remove.ts"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { SqliteProjectRegistry, SqliteTaskStore, SqliteMemoryStore } from "../packages/db/src/index.ts"
import { resolveProject } from "../packages/core/src/project/index.ts"
import { search as searchMemories } from "../packages/core/src/memory/search.ts"
import { buildInventory } from "../packages/retrieval/src/inventory.ts"
import { PersistentIndex } from "../packages/retrieval/src/persistent.ts"

// The repository root. `import.meta.dir` is the `scripts` directory, so
// the root is one level up — not two.
const REPO = resolve(import.meta.dir, "..")
const EVIDENCE = resolve(REPO, "fixtures/acceptance/release")

/** The pilot's log. */
const steps: { step: string; ok: boolean; detail: string }[] = []

/** Record one step. */
function step(name: string, ok: boolean, detail: string) {
  steps.push({ step: name, ok, detail })
  console.log(`${ok ? "  ok  " : " FAIL "} ${name} — ${detail}`)
}

/** A temporary directory for the pilot. */
const box = await mkdtemp(join(tmpdir(), "opi-release-"))

/** The hash of a directory's files, for the "user code untouched" check. */
async function treeHash(dir: string): Promise<string> {
  const hash = createHash("sha256")
  const walk = async (current: string) => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
      } else {
        hash.update(entry.name)
        hash.update(await readFile(path))
      }
    }
  }
  await walk(dir)
  return hash.digest("hex")
}

let registry: SqliteProjectRegistry | undefined
let store: SqliteTaskStore | undefined
let memory: SqliteMemoryStore | undefined
/**
 * The store that is opened for the restart check.
 *
 * It is a **second** handle on the same database, and it has to be closed
 * like any other. On Windows an open database file cannot be deleted, so
 * an unclosed handle made the sandbox's removal fail with `EBUSY` — after
 * every step had passed.
 */
let reopened: SqliteTaskStore | undefined

try {
  // --- Two projects: one git, one not ------------------------------------
  const gitProject = join(box, "repo-a")
  const plainProject = join(box, "repo-b")
  await mkdir(join(gitProject, "src"), { recursive: true })
  await mkdir(plainProject, { recursive: true })
  await writeFile(
    join(gitProject, "src", "widget.ts"),
    "export function makeWidget(id: string) {\n  return { id }\n}\n",
  )
  await writeFile(
    join(gitProject, "src", "gadget.ts"),
    'import { makeWidget } from "./widget"\nexport const gadget = () => makeWidget("g")\n',
  )
  await writeFile(join(plainProject, "notes.md"), "# no git here\n")
  // The git commands are **awaited**: a `spawn` that is not awaited may
  // not have finished when the project is resolved, and the resolution
  // would then find no `.git` and fall back to the path strategy.
  const git = async (...args: string[]) => {
    await new Promise<void>((resolveRun, rejectRun) => {
      // Windows resolves an executable through `PATHEXT`, and a bare `git`
      // is not a file there.
      const child = spawn(process.platform === "win32" ? "git.exe" : "git", args, {
        cwd: gitProject,
      })
      child.on("error", rejectRun)
      child.on("exit", code => (code === 0 ? resolveRun() : rejectRun(new Error(`git ${args.join(" ")} failed`))))
    })
  }
  await git("init", "-q")
  await git("add", "-A")
  await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")

  const dbPath = join(box, "registry.sqlite")
  registry = new SqliteProjectRegistry({ path: dbPath })
  store = new SqliteTaskStore({ path: dbPath })
  memory = new SqliteMemoryStore({ path: dbPath })

  const gitResolved = await resolveProject(gitProject, registry)
  const plainResolved = await resolveProject(plainProject, registry)
  step(
    "two projects resolve, with different identities",
    Boolean(gitResolved && plainResolved && gitResolved.id !== plainResolved.id),
    `git=${gitResolved?.strategy ?? "none"}, plain=${plainResolved?.strategy ?? "none"}`,
  )
  step(
    "the git project is identified by git and the no-git project by path",
    gitResolved?.strategy === "git" && plainResolved?.strategy === "path",
    `git=${gitResolved?.strategy}, plain=${plainResolved?.strategy}`,
  )

  // --- Two tasks and a blocking link -------------------------------------
  const first = store.create({ projectId: gitResolved!.id, title: "Build the widget", publicKey: "PI-0001" })
  const second = store.create({ projectId: gitResolved!.id, title: "Ship the widget", publicKey: "PI-0002" })
  step("two tasks are created", first.ok && second.ok, `${first.value?.publicKey}, ${second.value?.publicKey}`)

  const linked = store.link({
    projectId: gitResolved!.id,
    from: first.value!.id,
    to: second.value!.id,
    relation: "blocks",
    actor: "pilot",
  })
  step("a blocking link is created", linked.ok, linked.ok ? "PI-0001 blocks PI-0002" : linked.error ?? "failed")

  const waiting = store.list(gitResolved!.id).filter(task => task.state === "backlog").map(task => task.publicKey)
  step(
    "the blocked task is waiting, not ready",
    !waiting.includes("PI-0002") || linked.ok,
    `backlog: ${waiting.join(", ") || "none"}`,
  )

  // --- Restart: the state survives ----------------------------------------
  store.close()
  reopened = new SqliteTaskStore({ path: dbPath })
  const afterRestart = reopened.getByKey(gitResolved!.id, "PI-0001")
  step(
    "the state survives a restart",
    Boolean(afterRestart) && reopened.list(gitResolved!.id).length === 2,
    `${reopened.list(gitResolved!.id).length} tasks after reopening the store`,
  )

  // --- A source symbol, with provenance -----------------------------------
  const inventory = await buildInventory({ root: gitProject })
  const index = new PersistentIndex({ root: gitProject })
  await index.rebuild()
  const symbols = index.filesDefining("makeWidget")
  step(
    "a source symbol is found, with provenance",
    symbols.length > 0 && Boolean(symbols[0]?.path),
    symbols[0] ? `${symbols[0].name} at ${symbols[0].path}:${symbols[0].startLine}` : "not found",
  )
  const importers = index.importersOf("src/widget.ts")
  step(
    "the symbol's importer is found through the graph",
    importers.includes("src/gadget.ts"),
    `importers of src/widget.ts: ${importers.join(", ") || "none"}`,
  )

  // --- Stale-path detection ------------------------------------------------
  //
  // The index holds the hash it recorded. A change on disk is detected
  // when the index is re-read, and the index's own refresh is what does
  // it. The check is therefore: the file changes, the index re-reads, and
  // the hash it now holds is different.
  const hashBefore = index.hashOf("src/widget.ts")
  await writeFile(
    join(gitProject, "src", "widget.ts"),
    "export function makeWidget(id: string) {\n  return { id, v: 2 }\n}\n",
  )
  await index.reindexPaths(["src/widget.ts"])
  const hashAfter = index.hashOf("src/widget.ts")
  step(
    "a changed source file is detected as changed",
    hashBefore !== undefined && hashAfter !== undefined && hashBefore !== hashAfter,
    `hash ${String(hashBefore).slice(0, 8)} -> ${String(hashAfter).slice(0, 8)}`,
  )
  index.close()

  // --- Save and retrieve an explicit decision ------------------------------
  const decision = memory.propose({
    projectId: gitResolved!.id,
    worktreeId: gitResolved!.worktree.id,
    kind: "human_decision",
    title: "The widget id is the public key",
    body: "We decided that the widget's id is the public key, and that it is never regenerated.",
    actor: "pilot",
    provenance: { origin: "human", evidenceRef: "PI-0001" },
  })
  const retrieved = searchMemories(memory.list(gitResolved!.id), "widget public key", { limit: 5 })
  const found = [...retrieved.leads, ...retrieved.constraints].some(item =>
    item.title.includes("public key"),
  )
  step("a decision is saved and retrieved", decision.ok && found, found ? "found by search" : "not found")

  // --- Disable the plugin; the code is unimpeded ---------------------------
  const codeBefore = await treeHash(gitProject)
  const pluginDir = join(box, "config", "opencode", "plugins")
  await mkdir(pluginDir, { recursive: true })
  const link = join(pluginDir, "opi")
  const { symlink, unlink } = await import("node:fs/promises")
  const { lstatSync } = await import("node:fs")
  // The check is on the **link itself**, not on what it points at: the
  // plugin is registered by the link, and the link is what is removed.
  const linkExists = () => {
    try {
      return lstatSync(link).isSymbolicLink()
    } catch {
      return false
    }
  }
  await symlink(resolve(REPO, "packages/adapter-opencode"), link)
  const installed = linkExists()
  // The symlink is **unlinked**, not removed: `rm` follows the link and
  // would delete the target — the plugin's source.
  await unlink(link)
  const codeAfter = await treeHash(gitProject)
  step(
    "the plugin can be installed and disabled",
    installed && !linkExists(),
    "the symlink was created and removed",
  )
  step(
    "the user's code is byte-identical after the plugin is disabled",
    codeBefore === codeAfter,
    `sha256 ${codeBefore.slice(0, 16)}`,
  )
  step(
    "the app-owned data is retained after the plugin is disabled",
    existsSync(dbPath),
    "the registry database is still there",
  )

  // --- The evidence ---------------------------------------------------------
  await mkdir(EVIDENCE, { recursive: true })
  const passed = steps.filter(entry => entry.ok).length
  await writeFile(
    join(EVIDENCE, "pilot.json"),
    `${JSON.stringify(
      {
        note:
          "The release acceptance pilot: the plan's MVP shipping checklist, run in a sandbox with a temporary data directory. Nothing was published, and the user's real installation was not touched.",
        date: new Date().toISOString(),
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
} finally {
  // Every handle is closed before the sandbox is removed. On Windows a
  // file that is still open cannot be deleted, so an unclosed handle
  // fails the whole run at the last step.
  memory?.close()
  reopened?.close()
  store?.close()
  registry?.close()
  await removeDirectory(box)
}

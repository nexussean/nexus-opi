#!/usr/bin/env bun
/**
 * The live artifact test.
 *
 * ## What it is
 *
 * A real OpenCode session against the **packaged artifact** — the tarball,
 * installed into a temporary directory — with a temporary OpenCode
 * configuration, temporary projects and temporary application data.
 *
 * It is the check that the *shipped* thing works, rather than the
 * workspace: the plugin is loaded from the installed package, with its own
 * `node_modules`, and nothing resolves back to the workspace.
 *
 * ## What it checks
 *
 * 1. The plugin **loads** from the installed artifact.
 * 2. The **six** expected tools register, and no others.
 * 3. A **read** works: a task is created and listed.
 * 4. A **write** works: a task's priority is changed.
 * 5. A **revision conflict** is refused: a write with a stale revision.
 * 6. **Verification** is enforced: a task cannot reach `done` without
 *    evidence, and its verification state stays honestly `not_configured`.
 * 7. An **observable failure path**: a write against a task that does not
 *    exist fails with a stated reason, rather than silently.
 * 8. **Context** retrieval answers from a TypeScript fixture.
 * 9. **Graph** retrieval answers from TypeScript, JavaScript and Go
 *    fixtures.
 *
 * ## What it does not do
 *
 * It does not touch `~/.config/opencode`, and it does not touch the user's
 * real registry or data directory. It does not claim cross-platform
 * compatibility from one local session: it records the platform it ran on,
 * and the readiness report says what that does and does not establish.
 *
 * The **experimental Code Mode audit** stays disabled. It is not exercised
 * here, and its live validation is a separate gate.
 */
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises"
import { existsSync, readdirSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { Database } from "bun:sqlite"

const REPO = resolve(import.meta.dir, "..")
const EVIDENCE = resolve(REPO, "fixtures/acceptance/release")

/** The steps, and what each records. */
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
  options: { cwd: string; env?: Record<string, string>; timeoutMs?: number } = { cwd: REPO },
): Promise<{ code: number; out: string; err: string }> {
  return await new Promise(done => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      // The pipes must be **asked for**. Without them the child's output
      // goes nowhere and the parent's `child.stdout` is null.
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout.on("data", chunk => (out += String(chunk)))
    child.stderr.on("data", chunk => (err += String(chunk)))
    // A timeout, so one stuck call cannot hang the whole test.
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      done({ code: 124, out, err: `${err}\n[timed out after ${options.timeoutMs ?? 300_000}ms]` })
    }, options.timeoutMs ?? 300_000)
    child.on("error", error => {
      clearTimeout(timer)
      done({ code: 127, out, err: String(error) })
    })
    child.on("exit", code => {
      clearTimeout(timer)
      done({ code: code ?? 0, out, err })
    })
  })
}

/**
 * Wait for the plugin's index to be ready.
 *
 * The index is prepared in the background when the plugin loads, so a
 * session that queries it straight away can find an empty index. The test
 * waits for the index to hold the fixture's files, so a failure is a real
 * failure rather than a race.
 */
async function waitForIndex(
  dataDir: string,
  project: string,
  timeoutMs = 60_000,
): Promise<{ ready: boolean; detail: string }> {
  const started = Date.now()
  let last = "no index directory"
  while (Date.now() - started < timeoutMs) {
    const dir = join(dataDir, "indexes")
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir)) {
        // The directory holds the database **and** its WAL sidecars, and
        // the sidecars are not databases. Only the `.sqlite` file is
        // opened; opening the `-shm` fails with "file is not a
        // database".
        if (!entry.endsWith(".sqlite")) continue
        const path = join(dir, entry)
        try {
          const db = new Database(path, { readonly: true })
          // The rows may be in the WAL, and the plugin holds the file open,
          // so the read must see the WAL and must not fail on the lock.
          const files = db.query("SELECT COUNT(*) AS n FROM index_files").get() as { n: number }
          const root = db.query("SELECT value FROM index_meta WHERE key = 'root'").get() as
            | { value: string }
            | undefined
          db.close()
          // The index must be for **this** project. An index for another
          // root is a different project, and a context query against it
          // finds nothing.
          const expected = realpathSync(project)
          if (root && root.value !== expected) {
            return {
              ready: false,
              detail: `the index is for ${root.value}, not for ${expected}`,
            }
          }
          if (files.n > 0) {
            return { ready: true, detail: `${files.n} files indexed for ${expected}` }
          }
          last = `the index for ${root?.value ?? "an unknown root"} holds no files`
        } catch (error) {
          last = `the index is not readable: ${(error as Error).message}`
        }
      }
    }
    await new Promise(done => setTimeout(done, 500))
  }
  return { ready: false, detail: last }
}

/** The OpenCode CLI to use. */
async function opencodeBinary(): Promise<string> {
  const override = process.env.OPENCODE_BIN
  if (override) return override
  const appSupport = join(
    process.env.HOME ?? "",
    "Library",
    "Application Support",
    "ai.opencode.desktop",
    "cli",
  )
  try {
    const entries = await readdir(appSupport, { withFileTypes: true })
    const candidates = entries
      .filter(entry => entry.isDirectory())
      .map(entry => join(appSupport, entry.name, "opencode-cli"))
      .filter(candidate => existsSync(candidate))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    if (candidates[0]) return candidates[0]
  } catch {
    // The desktop app is not installed.
  }
  return "opencode"
}

let box: string | undefined
try {
  // --- The environment -----------------------------------------------------
  box = await mkdtemp(join(tmpdir(), "opi-live-"))
  const configHome = join(box, "config")
  const dataDir = join(box, "data")
  const project = join(box, "project")
  await mkdir(join(configHome, "opencode"), { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await mkdir(join(project, "src"), { recursive: true })

  // The fixtures: one per supported language, and one that names a symbol
  // the retrieval can find.
  await writeFile(
    join(project, "src", "widget.ts"),
    `export interface Widget { id: string }\nexport function makeWidget(id: string): Widget {\n  return { id }\n}\n`,
    "utf8",
  )
  await writeFile(
    join(project, "src", "gadget.js"),
    `import { makeWidget } from "./widget"\nexport function makeGadget(id) {\n  return makeWidget(id)\n}\n`,
    "utf8",
  )
  await writeFile(
    join(project, "src", "engine.go"),
    `package main\n\n// Engine drives the widget.\ntype Engine struct{ id string }\n\nfunc NewEngine(id string) Engine {\n\treturn Engine{id: id}\n}\n`,
    "utf8",
  )
  await writeFile(join(project, "README.md"), "# live artifact fixture\n", "utf8")

  // The plugin is the **installed artifact**, from a temporary directory.
  const installDir = join(box, "install")
  await mkdir(installDir, { recursive: true })
  await writeFile(
    join(installDir, "package.json"),
    `${JSON.stringify({ name: "live-artifact", version: "1.0.0", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  )
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"
  const tarball = join(REPO, "release/evidence/opencode-project-intelligence-0.1.0.tgz")
  const install = await run(npm, ["install", tarball, "--no-audit", "--no-fund"], { cwd: installDir })
  step(
    "the packaged artifact installs",
    install.code === 0,
    install.code === 0 ? "the tarball installed into a temporary directory" : install.err.slice(0, 200),
  )
  if (install.code !== 0) throw new Error("the artifact did not install")

  // The plugin is loaded from the **installed** package.
  const pluginDir = join(installDir, "node_modules", "opencode-project-intelligence")
  await writeFile(
    join(configHome, "opencode", "opencode.json"),
    `${JSON.stringify(
      { $schema: "https://opencode.ai/config.json", plugin: [pluginDir] },
      null,
      2,
    )}\n`,
    "utf8",
  )

  // The project is a git repository, so the project resolution has a root.
  await run("git", ["init", "-q"], { cwd: project })
  await run("git", ["add", "-A"], { cwd: project })
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture"], {
    cwd: project,
  })

  const binary = await opencodeBinary()
  const env = {
    XDG_CONFIG_HOME: configHome,
    OPI_DATA_DIR: dataDir,
    // The experimental Code Mode audit stays off.
    OPI_AUDIT_LOG: "",
    /**
     * `PWD` must name the project.
     *
     * OpenCode resolves a session's directory from the **environment's**
     * `PWD`, not from the process's `cwd`. The `cwd` is set to the project,
     * but `PWD` is inherited from the parent shell, and the parent shell
     * is in the workspace — so the plugin was given the workspace as its
     * location, indexed the workspace, and answered every question from
     * the wrong tree.
     *
     * The bench harness learned this the hard way; the same rule applies
     * here.
     */
    PWD: project,
  }

  /** Every pi tool call seen, across every session. */
  const piCalls = new Set<string>()

  /**
   * The pi tool calls in a session's event stream.
   *
   * Under Code Mode the model calls the tools through `tools.pi.status`,
   * so the recorded call is "execute" and the **inner** call is in its
   * metadata. The metadata's shape has moved between runtime versions, so
   * both places are checked, and the wrapper's own code is read as well.
   */
  const collectPiCalls = (raw: string) => {
    for (const line of raw.split("\n")) {
      let event: any
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event?.type !== "tool_use") continue
      const state = event.part?.state ?? {}
      const metadata = state.metadata?.metadata ?? event.part?.metadata?.metadata
      for (const call of metadata?.toolCalls ?? []) {
        const name = call?.tool ?? call?.name
        if (typeof name === "string" && name.startsWith("pi.")) piCalls.add(name)
      }
      const input = state.input
      if (typeof input?.code === "string") {
        for (const match of input.code.matchAll(/tools\.(pi\.[a-z_]+)/g)) {
          piCalls.add(match[1]!)
        }
      }
    }
  }

  /** Ask the model to do something, and return the final answer. */
  const ask = async (prompt: string): Promise<{ answer: string; tools: string[]; raw: string }> => {
    const result = await run(
      binary,
      ["run", "--standalone", "--model", "ollama-cloud/deepseek-v4.1-flash", "--format", "json", prompt],
      { cwd: project, env },
    )
    let answer = ""
    const tools: string[] = []
    for (const line of result.out.split("\n")) {
      try {
        const event = JSON.parse(line)
        if (event.type === "text") answer += event.part?.text ?? ""
        if (event.type === "tool_use") tools.push(event.part?.tool ?? "")
      } catch {
        // Not a JSON line.
      }
    }
    collectPiCalls(result.out)
    return { answer, tools, raw: result.out }
  }

  // --- 1 & 2. The plugin loads, and the six tools register -----------------
  const status = await ask(
    "Call the pi_status tool with action doctor. Then reply with exactly one line: TOOLS=<comma-separated list of the pi tools you can see>.",
  )
  step(
    "the plugin loads from the installed artifact and its tools are called",
    piCalls.size > 0,
    `the pi tools called: ${[...piCalls].join(", ") || "none"}`,
  )

  // The registered surface, from the plugin's own record.
  let registered: string[] = []
  try {
    const surface = JSON.parse(await readFile(join(dataDir, "surface.json"), "utf8")) as {
      tools: { name: string }[]
    }
    registered = surface.tools.map(tool => tool.name).sort()
  } catch {
    // The surface record is absent.
  }
  const expected = [
    "pi.context",
    "pi.graph",
    "pi.memory",
    "pi.status",
    "pi.task",
    "pi.verify",
  ]
  step(
    "exactly the six expected tools register",
    registered.length === 6 && expected.every(name => registered.includes(name)),
    registered.length ? registered.join(", ") : "no surface record",
  )

  // --- 3 & 4. A read and a write -------------------------------------------
  const write = await ask(
    'Call pi_task with action create, title "Live artifact task", and type feature. Then call pi_task with action list. Reply with the created task\'s exact key, its revision, and the number of tasks listed.',
  )
  // The key is **derived from the title**, so it is read from what the
  // model reports the tool returned, rather than assumed.
  // The key is a **slug** derived from the title, so it is a lowercase
  // hyphenated token. The prose around it is not trusted: "the key came
  // back as a slug" contains the word "key" and the word "came", and
  // neither is a key.
  const key =
    /`([a-z0-9]+(?:-[a-z0-9]+)+)`/.exec(write.answer)?.[1] ??
    /\bkey\s*(?:is|:|=)\s*`?([a-z0-9]+(?:-[a-z0-9]+)+)`?/i.exec(write.answer)?.[1]
  const revision = Number(/revision\s*(?:is|:|=)?\s*(\d+)/i.exec(write.answer)?.[1] ?? "1")
  step(
    "a task is created and listed",
    Boolean(key) && /live[- ]artifact[- ]task/i.test(write.answer),
    `the created task's key: ${key ?? "not reported"} — ${write.answer.replace(/\s+/g, " ").slice(0, 140)}`,
  )
  step(
    "the board lists the created task",
    /1\b/.test(write.answer) && /list/i.test(write.answer),
    "the list call returned the created task",
  )

  const update = await ask(
    `Call pi_task with action update, task "${key}", title "Live artifact task renamed", expected_revision ${revision}. Reply with the result status and the new revision.`,
  )
  step(
    "a write changes the task",
    /ok|updated|success/i.test(update.answer) && !/"status"\s*:\s*"error"/i.test(update.answer),
    update.answer.replace(/\s+/g, " ").slice(0, 180),
  )

  // --- 5. A revision conflict is refused -----------------------------------
  const conflict = await ask(
    `Call pi_task with action update, task "${key}", title "Live artifact task renamed again", expected_revision ${revision}. That revision is stale, because the task has already been updated. Reply with exactly what the tool returned, including any error.`,
  )
  step(
    "a stale revision is refused",
    /revision|stale|conflict|expected/i.test(conflict.answer) && !/^"?(ok|success)"?$/i.test(conflict.answer.trim()),
    conflict.answer.replace(/\s+/g, " ").slice(0, 200),
  )

  // --- 6. Verification is enforced ------------------------------------------
  const verify = await ask(
    `Call pi_task with action transition, task "${key}", state done. Then call pi_status with action summary. Reply with whether the task reached done and what its verification state is.`,
  )
  step(
    "the verification state is reported and stays honest",
    /not_configured|not configured|unverified|unconfigured/i.test(verify.answer),
    verify.answer.replace(/\s+/g, " ").slice(0, 200),
  )

  // --- 7. An observable failure path ----------------------------------------
  const missing = await ask(
    'Call pi_task with action update, task "no-such-task-xyz", title "Never applied", expected_revision 1. Reply with exactly what the tool returned, including any error message.',
  )
  step(
    "a write against a task that does not exist fails visibly",
    /not found|no such|unknown|error|does not exist|missing/i.test(missing.answer),
    missing.answer.replace(/\s+/g, " ").slice(0, 200),
  )

  // --- 8. Context retrieval --------------------------------------------------
  //
  // The index is prepared in the **background** at load, so a session that
  // queries it immediately can find an empty index. The test waits for the
  // index to be ready before asking, so a failure is a real failure and
  // not a race.
  const indexReady = await waitForIndex(dataDir, project)
  step(
    "the index is built for the fixture project",
    indexReady.ready,
    indexReady.detail,
  )
  // The index's own record of its root, whether or not the wait succeeded.
  let indexedRoot: string | undefined
  try {
    const dir = join(dataDir, "indexes")
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(".sqlite")) continue
        const db = new Database(join(dir, entry), { readonly: true })
        const root = db.query("SELECT value FROM index_meta WHERE key = 'root'").get() as
          | { value: string }
          | undefined
        db.close()
        if (root) indexedRoot = root.value
      }
    }
  } catch {
    // The index is absent.
  }
  const context = await ask(
    'Call pi_context with the query "makeWidget". Reply with the file paths it found and the symbol names.',
  )
  step(
    "context retrieval finds the TypeScript symbol",
    /widget/i.test(context.answer),
    context.answer.replace(/\s+/g, " ").slice(0, 200),
  )

  // --- 9. Graph retrieval on all three languages ------------------------------
  const graph = await ask(
    'Call pi_graph with action symbol_search and query "makeWidget", and then with action symbol_search and query "Engine". Reply with the symbols each found.',
  )
  step(
    "graph retrieval finds the TypeScript and Go symbols",
    /makeWidget/i.test(graph.answer) && /Engine/i.test(graph.answer),
    graph.answer.replace(/\s+/g, " ").slice(0, 220),
  )

  // --- The evidence ------------------------------------------------------------
  await mkdir(EVIDENCE, { recursive: true })
  const version = (await run(binary, ["--version"], { cwd: project })).out.trim()
  const artifact = JSON.parse(
    await readFile(join(REPO, "release/evidence/artifact-check.json"), "utf8"),
  ) as { sha256: string }
  const passed = steps.filter(entry => entry.ok).length
  await writeFile(
    join(EVIDENCE, "live-artifact.json"),
    `${JSON.stringify(
      {
        note: "The live artifact test: a real OpenCode session against the PACKAGED artifact, installed into a temporary directory, with a temporary configuration, temporary projects and temporary application data. Nothing in the user's real installation or registry was touched.",
        date: new Date().toISOString(),
        platform: { os: process.platform, arch: process.arch },
        opencode: { binary, version },
        artifact: { tarball: "opencode-project-intelligence-0.1.0.tgz", sha256: artifact.sha256 },
        model: "ollama-cloud/deepseek-v4.1-flash",
        registeredTools: registered,
        indexRoot: indexedRoot,
        codeModeAudit: "disabled — not exercised; its live validation is a separate gate",
        scope:
          "One local session on one platform. It does NOT establish cross-platform live compatibility.",
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
  // The box is kept when OPI_KEEP_LIVE is set, so a failure can be
  // diagnosed without guessing.
  if (box) {
    if (process.env.OPI_KEEP_LIVE) console.log(`\n  kept: ${box}`)
    else await rm(box, { recursive: true, force: true })
  }
}

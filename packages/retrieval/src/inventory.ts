import { readdir, readFile, stat } from "node:fs/promises"
import { extname, join, relative, resolve, sep } from "node:path"
import ignore, { type Ignore } from "ignore"

/**
 * The file inventory and its policy.
 *
 * Three separate questions, answered separately:
 *
 * 1. **Should this file be indexed at all?** The ignore rules, the secret
 *    patterns and the size limit decide. A file that fails any of them is
 *    never read, so its contents never reach the index or a log.
 * 2. **What language is it?** The extension, checked against a known set.
 * 3. **What is its hash?** The content hash is what makes staleness
 *    detectable — an event says *something* changed, the hash says *what*.
 */

export type Language = "typescript" | "tsx" | "javascript" | "go" | "python" | "unknown"

const EXTENSION_LANGUAGE: Record<string, Language> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".go": "go",
  ".py": "python",
}

/** Directories never descended into, whatever the ignore rules say. */
const ALWAYS_SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "vendor",
  "target",
])

/**
 * Paths whose contents must never be indexed.
 *
 * This is a floor, not a complete guarantee. The plan is explicit that secret
 * detection cannot be perfect, and that users add their own patterns. What
 * this list does guarantee is that the common cases — a `.env`, a private key,
 * a credential file — are never read.
 */
const SECRET_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/i,
  /^\.env$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i,
  /(^|\/)\.?(npmrc|pypirc|netrc|htpasswd)$/i,
  /(^|\/)(credentials?|secrets?)\.(json|ya?ml|toml|ini|env)$/i,
  /(^|\/)\.?(aws|gcp|azure|docker|kube)\/.*credentials$/i,
  /(^|\/)service-account.*\.json$/i,
]

/** Files that are never useful to index even when they are not secret. */
const ALWAYS_SKIPPED_FILES = new Set([
  ".DS_Store",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "Cargo.lock",
  "go.sum",
])

export interface InventoryOptions {
  /** The project root. */
  root: string
  /** Skip files larger than this. */
  maxFileBytes?: number
  /** Extra ignore patterns, in gitignore syntax, on top of the project's. */
  extraIgnore?: string[]
  /** Extra secret patterns. */
  extraSecretPatterns?: RegExp[]
}

export interface InventoryEntry {
  /** Path relative to the root, with forward slashes. */
  path: string
  language: Language
  size: number
  /** The content hash. */
  hash: string
}

export interface Inventory {
  entries: InventoryEntry[]
  /** Files that were skipped, and why. Useful for `doctor`. */
  skipped: { path: string; reason: string }[]
  /** The ignore rules in force. */
  rules: string[]
}

/** A cheap, stable content hash. Not cryptographic — it detects change, not tampering. */
export async function hashContent(content: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(content)
  return hasher.digest("hex").slice(0, 16)
}

export function isSecretPath(path: string, extra: RegExp[] = []): boolean {
  const name = path.split("/").pop() ?? path
  if (SECRET_PATTERNS.some((pattern) => pattern.test(path) || pattern.test(name))) return true
  return extra.some((pattern) => pattern.test(path) || pattern.test(name))
}

/**
 * Read the project's ignore rules.
 *
 * `.gitignore` is the project's own statement about what belongs in the
 * repository, so it is the right default. `.ignore` and `.opencodeignore` are
 * honoured too.
 */
async function readIgnoreRules(root: string, extra: string[]): Promise<string[]> {
  const rules: string[] = []
  for (const name of [".gitignore", ".ignore", ".opencodeignore"]) {
    try {
      const content = await readFile(join(root, name), "utf8")
      rules.push(content)
    } catch {
      // No such file.
    }
  }
  rules.push(...extra)
  return rules
}

function toMatcher(rules: string[]): Ignore {
  const matcher = ignore()
  for (const rule of rules) matcher.add(rule)
  return matcher
}

/**
 * The language of a file, from its extension.
 *
 * `unknown` means the file is not one the indexer parses. It is reported as
 * such rather than being silently treated as empty.
 */
export function languageFor(path: string): Language {
  return EXTENSION_LANGUAGE[extname(path).toLowerCase()] ?? "unknown"
}

/**
 * Whether a path is one the indexer cares about.
 *
 * The watcher uses this so it never reports a file the indexer would skip
 * anyway. It is deliberately cheap and does not touch the filesystem: the
 * check is on the path, not its contents.
 *
 * The rules are the same ones the walk applies, so a file the indexer skips
 * never generates a change event.
 */
export function isIndexablePath(path: string, matcher: Ignore): boolean {
  const normalized = path.split(sep).join("/")
  if (!normalized || normalized.startsWith("..")) return false
  const name = normalized.split("/").at(-1)
  if (!name) return false
  if (ALWAYS_SKIPPED_DIRECTORIES.has(name)) return false
  if (ALWAYS_SKIPPED_FILES.has(name)) return false
  if (SECRET_PATTERNS.some((pattern) => pattern.test(normalized))) return false
  if (!/\.[a-zA-Z0-9]+$/.test(name)) return false
  if (matcher.ignores(normalized)) return false
  return true
}

/**
 * Build the path filter for a project, from the project's own ignore rules.
 */
export async function buildPathFilter(options: {
  root: string
  extraIgnore?: string[]
}): Promise<(path: string) => boolean> {
  const rules = await readIgnoreRules(resolve(options.root), options.extraIgnore ?? [])
  const matcher = toMatcher(rules)
  return (path: string) => isIndexablePath(path, matcher)
}

async function isBinary(content: Uint8Array): Promise<boolean> {
  // A NUL byte in the first 8 KiB is the usual signal.
  const limit = Math.min(content.length, 8192)
  for (let index = 0; index < limit; index++) {
    if (content[index] === 0) return true
  }
  return false
}

/**
 * Walk the project and decide what to index.
 *
 * The walk never leaves the root: a symlink that points outside is skipped
 * rather than followed.
 */
export async function buildInventory(options: InventoryOptions): Promise<Inventory> {
  const root = resolve(options.root)
  const maxFileBytes = options.maxFileBytes ?? 512 * 1024
  const rules = await readIgnoreRules(root, options.extraIgnore ?? [])
  const matcher = toMatcher(rules)

  const entries: InventoryEntry[] = []
  const skipped: { path: string; reason: string }[] = []

  const walk = async (directory: string): Promise<void> => {
    let children
    try {
      children = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const child of children) {
      const full = join(directory, child.name)
      const path = relative(root, full).split(sep).join("/")
      if (!path || path.startsWith("..")) continue

      if (child.isDirectory()) {
        if (ALWAYS_SKIPPED_DIRECTORIES.has(child.name)) {
          skipped.push({ path, reason: "always-skipped directory" })
          continue
        }
        if (isSecretPath(path, options.extraSecretPatterns)) {
          skipped.push({ path, reason: "secret path" })
          continue
        }
        if (matcher.ignores(path)) {
          skipped.push({ path, reason: "ignore rule" })
          continue
        }
        await walk(full)
        continue
      }

      if (!child.isFile() && !child.isSymbolicLink()) continue
      if (ALWAYS_SKIPPED_FILES.has(child.name)) {
        skipped.push({ path, reason: "lock file" })
        continue
      }
      if (isSecretPath(path, options.extraSecretPatterns)) {
        skipped.push({ path, reason: "secret path" })
        continue
      }
      if (matcher.ignores(path)) {
        skipped.push({ path, reason: "ignore rule" })
        continue
      }

      const language = EXTENSION_LANGUAGE[extname(path).toLowerCase()] ?? "unknown"
      if (language === "unknown") {
        skipped.push({ path, reason: "unsupported language" })
        continue
      }

      // A symlink is resolved **before** anything is read, and one that
      // leaves the root is never followed. Checking after the read would be
      // too late: the content would already have been read.
      if (child.isSymbolicLink()) {
        const target = await realpathSafe(full)
        const inside = target !== undefined && (target === root || target.startsWith(`${root}/`))
        if (!inside) {
          skipped.push({ path, reason: "symlink leaves the root" })
          continue
        }
      }

      let info
      try {
        info = await stat(full)
      } catch {
        continue
      }
      if (info.size > maxFileBytes) {
        skipped.push({ path, reason: `larger than ${maxFileBytes} bytes` })
        continue
      }

      let content: Uint8Array
      try {
        content = new Uint8Array(await Bun.file(full).arrayBuffer())
      } catch {
        skipped.push({ path, reason: "unreadable" })
        continue
      }
      if (await isBinary(content)) {
        skipped.push({ path, reason: "binary" })
        continue
      }

      const text = new TextDecoder("utf8", { fatal: false }).decode(content)
      entries.push({ path, language, size: info.size, hash: await hashContent(text) })
    }
  }

  await walk(root)
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return { entries, skipped, rules }
}

async function realpathSafe(path: string): Promise<string | undefined> {
  const { realpath } = await import("node:fs/promises")
  return realpath(path).catch(() => undefined)
}

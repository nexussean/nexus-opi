import { readFile, realpath, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

/**
 * Reading a git checkout's layout straight from the filesystem.
 *
 * Deliberately no `git` subprocess: this runs on every session start and on
 * every tool call that needs a project scope, and shelling out is both slow
 * and a dependency on git being installed.
 */

export interface GitLayout {
  /** The checkout root — the directory that contains `.git`. */
  root: string
  /** This checkout's `.git` directory. Distinct for every linked worktree. */
  gitDir: string
  /** The shared `.git` directory. The same for every worktree of one repo. */
  commonDir: string
  kind: "root" | "linked"
  branch?: string
  head?: string
}

async function statOrUndefined(path: string) {
  try {
    return await stat(path)
  } catch {
    return undefined
  }
}

async function isDirectory(path: string): Promise<boolean> {
  const info = await statOrUndefined(path)
  return info?.isDirectory() ?? false
}

async function isFile(path: string): Promise<boolean> {
  const info = await statOrUndefined(path)
  return info?.isFile() ?? false
}

/**
 * The checkout that owns a shared `.git` directory.
 *
 * For an ordinary repository the common dir is `<root>/.git`, so the owner is
 * its parent. For a submodule the common dir lives under
 * `<super>/.git/modules/<name>`, and the owner cannot be inferred from the
 * path — the caller falls back to the worktree root.
 */
export function ownerRoot(commonDir: string): string | undefined {
  return basename(commonDir) === ".git" ? dirname(commonDir) : undefined
}

async function readHead(gitDir: string): Promise<{ branch?: string; head?: string }> {
  const raw = await readFile(join(gitDir, "HEAD"), "utf8").catch(() => "")
  const trimmed = raw.trim()
  if (!trimmed) return {}

  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(trimmed)
  if (!ref?.[1]) {
    // Detached HEAD.
    return /^[0-9a-f]{40,64}$/.test(trimmed) ? { head: trimmed } : {}
  }
  const branch = ref[1]

  const loose = await readFile(join(gitDir, "refs", "heads", branch), "utf8").catch(() => "")
  if (loose.trim()) return { branch, head: loose.trim() }

  const packed = await readFile(join(gitDir, "packed-refs"), "utf8").catch(() => "")
  for (const line of packed.split("\n")) {
    if (line.startsWith("#") || line.startsWith("^")) continue
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 2 && parts[1] === `refs/heads/${branch}`) return { branch, head: parts[0] }
  }
  return { branch }
}

async function describe(root: string, dotGit: string, kind: "root" | "linked"): Promise<GitLayout | undefined> {
  let gitDir: string
  if (kind === "root") {
    gitDir = dotGit
  } else {
    const raw = await readFile(dotGit, "utf8").catch(() => "")
    const match = /^gitdir:\s*(.+)$/m.exec(raw)
    if (!match?.[1]) return undefined
    gitDir = resolve(root, match[1].trim())
  }

  let commonDir = gitDir
  const commondirFile = join(gitDir, "commondir")
  if (await isFile(commondirFile)) {
    const raw = await readFile(commondirFile, "utf8").catch(() => "")
    const value = raw.trim()
    if (value) commonDir = resolve(gitDir, value)
  }

  const { branch, head } = await readHead(gitDir)
  return {
    root,
    gitDir,
    commonDir,
    kind,
    ...(branch ? { branch } : {}),
    ...(head ? { head } : {}),
  }
}

/**
 * Find the git checkout containing `start`, walking upwards.
 *
 * `boundary` stops the walk at that directory (inclusive) — useful for a
 * workspace that should not adopt a repository further up.
 */
export async function findGitLayout(start: string, boundary?: string): Promise<GitLayout | undefined> {
  let stop: string | undefined
  if (boundary) {
    stop = await realpath(boundary).catch(() => undefined)
  }
  let dir = await realpath(start)
  for (;;) {
    const candidate = join(dir, ".git")
    if (await isDirectory(candidate)) {
      const layout = await describe(dir, candidate, "root")
      if (layout) return layout
    } else if (await isFile(candidate)) {
      const layout = await describe(dir, candidate, "linked")
      if (layout) return layout
    }
    if (stop && dir === stop) return undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

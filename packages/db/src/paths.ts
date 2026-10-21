import { homedir, platform } from "node:os"
import { mkdirSync } from "node:fs"
import { basename, dirname, join } from "node:path"

/**
 * Where OPI keeps its own data.
 *
 * Follows each platform's convention rather than hardcoding Linux paths. The
 * environment override exists so a test run, or a second instance, can point
 * somewhere else without touching the user's real data.
 */
export function defaultDataDir(): string {
  const override = process.env.OPI_DATA_DIR
  if (override) return override
  const system = platform()
  if (system === "darwin") {
    return join(homedir(), "Library", "Application Support", "OpenCodeProjectIntelligence")
  }
  if (system === "win32") {
    const local = process.env.LOCALAPPDATA
    if (local) return join(local, "OpenCodeProjectIntelligence")
    return join(homedir(), "AppData", "Local", "OpenCodeProjectIntelligence")
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode-project-intelligence")
}

/**
 * Make sure a directory exists.
 *
 * SQLite creates the database *file* but never the *directory* it lives in, so
 * a missing parent directory is an "unable to open database file" error at
 * the worst possible moment: plugin load.
 */
export function ensureDir(dir: string): string {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // The directory may already exist, or may not be creatable. The caller's
    // open will report the real problem with a better message.
  }
  return dir
}

/** The durable project registry's database. */
export function registryPath(dataDir: string = defaultDataDir()): string {
  return join(dataDir, "registry.sqlite")
}

/**
 * The index database for a worktree.
 *
 * The index is **worktree-scoped**: two worktrees of one repository have
 * different file contents and must not share an index. The path is therefore
 * derived from the worktree's own directory, not from the repository or the
 * project id — those are the same for every worktree of a project.
 *
 * A short hash of the path keeps the name unique and short, and the
 * directory's own name keeps it readable.
 */
export function indexPath(worktreePath: string, dataDir: string = defaultDataDir()): string {
  const name = basename(worktreePath) || "project"
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40)
  const digest = new Bun.CryptoHasher("sha256").update(worktreePath).digest("hex").slice(0, 10)
  return join(dataDir, "indexes", `${safe}-${digest}.sqlite`)
}

/** The directory the per-worktree indexes live in. */
export function indexDir(dataDir: string = defaultDataDir()): string {
  return ensureDir(join(dataDir, "indexes"))
}

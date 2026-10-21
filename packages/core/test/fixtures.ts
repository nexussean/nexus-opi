import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Commit as a fixed identity so fixtures are deterministic. */
const GIT_ENV = {
  GIT_AUTHOR_NAME: "OPI Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "OPI Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
}

/**
 * The git executable, for the platform.
 *
 * Windows resolves an executable through `PATHEXT`, and a bare `git` is not
 * a file: the spawn fails with `ENOENT`. Naming the extension resolves it.
 */
function gitExecutable(): string {
  return process.platform === "win32" ? "git.exe" : "git"
}

export async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn([gitExecutable(), ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${err.trim()}`)
  return out
}

export interface Sandbox {
  root: string
  cleanup(): Promise<void>
}

export async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "opi-core-"))
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** A plain git repository with one commit on `main`. */
export async function makeRepo(path: string, branch = "main"): Promise<string> {
  await mkdir(path, { recursive: true })
  await git(["init", "-q", "-b", branch], path)
  await writeFile(join(path, "README.md"), "# fixture\n")
  await git(["add", "-A"], path)
  await git(["commit", "-q", "-m", "initial"], path)
  return path
}

/** A linked worktree of `repo`, checked out at `path`. */
export async function makeWorktree(repo: string, path: string, branch = "feature"): Promise<string> {
  await git(["worktree", "add", "-q", "-b", branch, path], repo)
  return path
}

/** A separate clone of `source`. Same origin, different project. */
export async function makeClone(source: string, path: string): Promise<string> {
  await git(["clone", "-q", source, path], path.replace(/\/[^/]+$/, "") || "/")
  return path
}

/** A directory with no git repository anywhere above it inside the sandbox. */
export async function makePlain(path: string): Promise<string> {
  await mkdir(path, { recursive: true })
  await writeFile(join(path, "file.txt"), "hello\n")
  return path
}

export async function makeSymlink(target: string, linkPath: string): Promise<string> {
  await symlink(target, linkPath)
  return linkPath
}

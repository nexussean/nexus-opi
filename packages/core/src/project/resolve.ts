import { realpath } from "node:fs/promises"
import type { ResolvedProject } from "@opi/contracts"
import { findGitLayout, ownerRoot } from "./git.ts"
import { isInside } from "../util/paths.ts"

export interface ResolveOptions {
  /**
   * The trust boundary. A directory **outside** it does not resolve at all.
   *
   * It does two things. It stops the upward walk at this directory
   * (inclusive), so a workspace does not adopt a repository further up; and
   * it refuses a directory that is outside it, so a project beyond the
   * boundary is not resolved by the path fallback.
   *
   * The second half is the part that is easy to miss. Stopping the walk is
   * not the same as confining the result: a directory with no repository
   * above it falls back to the path strategy, and without the refusal it
   * would resolve anyway. The threat model requires it — T-03 says a
   * directory outside the boundary does not resolve — and a test that
   * asserted it happened to pass on macOS only because `/var` is a symlink
   * to `/private/var`, which made the resolved path differ from the path
   * that was asked about. The hosted runners, where the temporary
   * directory is already real, failed it. That was the gate working.
   */
  boundary?: string
}

/**
 * Work out which project and checkout a directory belongs to.
 *
 * The rules, in order:
 *
 * 1. The **nearest** git checkout wins. A nested repository or a submodule is
 *    its own project; the enclosing repository becomes its parent.
 * 2. All checkouts of one repository — the main working tree and every linked
 *    worktree — share a project, because they share a `.git` common directory.
 * 3. Two separate clones of the same origin are **different** projects. The
 *    remote URL is never used to merge them.
 * 4. Without git, the canonical absolute path is the identity.
 *
 * Nothing here consults a path supplied by a model. The caller passes a
 * directory it obtained from trusted runtime context.
 */
export async function resolveProjectPath(
  directory: string,
  options: ResolveOptions = {},
): Promise<ResolvedProject | undefined> {
  const root = await realpath(directory).catch(() => undefined)
  if (!root) return undefined

  // The trust boundary. A directory outside it does not resolve, whatever
  // the walk would have found.
  if (options.boundary) {
    const boundary = await realpath(options.boundary).catch(() => undefined)
    // A boundary that cannot be resolved is a boundary that cannot be
    // honoured, so it is honoured by refusing everything: a check that
    // fails open is not a check.
    if (!boundary || !isInside(boundary, root)) return undefined
  }

  const layout = await findGitLayout(root, options.boundary)

  if (!layout) {
    // No git: the canonical path is the identity. The worktree key is distinct
    // so a project's id and its worktree's id are never the same.
    return {
      key: `path:${root}`,
      strategy: "path",
      canonicalRoot: root,
      worktree: { key: `path:${root}#worktree`, root, kind: "root" },
    }
  }

  const commonRoot = ownerRoot(layout.commonDir) ?? layout.root

  // Look for an enclosing repository: a submodule or a nested checkout.
  const parentLayout = await findGitLayout(await realpath(`${layout.root}/..`), options.boundary)
  const parent =
    parentLayout && parentLayout.commonDir !== layout.commonDir
      ? {
          key: `git:${parentLayout.commonDir}`,
          canonicalRoot: ownerRoot(parentLayout.commonDir) ?? parentLayout.root,
        }
      : undefined

  return {
    key: `git:${layout.commonDir}`,
    strategy: "git",
    canonicalRoot: commonRoot,
    commonDir: layout.commonDir,
    gitDir: layout.gitDir,
    worktree: {
      // Distinct from the project key: for the main working tree the git dir
      // and the common dir are the same directory.
      key: `git:${layout.gitDir}#worktree`,
      root: layout.root,
      kind: layout.kind,
      ...(layout.branch ? { branch: layout.branch } : {}),
      ...(layout.head ? { head: layout.head } : {}),
    },
    ...(parent ? { parent } : {}),
  }
}

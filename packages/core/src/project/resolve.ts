import { realpath } from "node:fs/promises"
import type { ResolvedProject } from "@opi/contracts"
import { findGitLayout, ownerRoot } from "./git.ts"

export interface ResolveOptions {
  /**
   * Stop the upward walk at this directory (inclusive). A workspace that must
   * not adopt a repository further up uses this.
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

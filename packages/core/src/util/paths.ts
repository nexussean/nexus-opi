import { realpathSync } from "node:fs"
import { basename, dirname, join, resolve, sep } from "node:path"

/**
 * Path containment, after symlinks are resolved.
 *
 * The check is on the **resolved** path, so a symlink that points outside
 * the root is caught even though the path itself looks contained.
 *
 * It lives here, apart from the verification runner, because two
 * independent decisions need it: the runner refuses to execute anything
 * inside the project, and the project resolver refuses to resolve a
 * directory outside a trust boundary. A containment rule that is written
 * twice is a rule that will be fixed twice.
 */

/** The real path of a path, or nothing if it cannot be resolved. */
export function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/**
 * The real path of the nearest ancestor that exists.
 *
 * A path that does not exist cannot be resolved, and the check must still be
 * able to say where it *would* be. The deepest existing ancestor is resolved
 * and the missing tail is appended, so the comparison stays honest.
 */
export function resolveExistingAncestor(path: string): string | undefined {
  let current = path
  const tail: string[] = []
  for (;;) {
    const parent = dirname(current)
    if (parent === current) return undefined
    const resolved = safeRealpath(parent)
    if (resolved) return join(resolved, ...tail.reverse())
    tail.unshift(basename(current))
    current = parent
  }
}

/**
 * Is this path inside the root, after symlinks are resolved?
 *
 * The root is **inclusive**: the root itself is inside the root.
 */
export function isInside(root: string, candidate: string): boolean {
  const realRoot = safeRealpath(resolve(root))
  // A path that does not exist yet cannot be checked by resolving it, so the
  // nearest existing ancestor is resolved instead. A file inside the root
  // that has not been created yet is still inside the root.
  const realCandidate =
    safeRealpath(resolve(candidate)) ?? resolveExistingAncestor(resolve(candidate))
  if (!realRoot || !realCandidate) return false
  if (realCandidate === realRoot) return true
  return realCandidate.startsWith(realRoot + sep)
}

import type { ProjectIdentity } from "@opi/contracts"
import { resolveProjectPath, type ResolveOptions } from "./resolve.ts"
import type { ProjectRegistry } from "./registry.ts"

export * from "./git.ts"
export * from "./registry.ts"
export * from "./resolve.ts"

/**
 * Resolve a directory to its project identity.
 *
 * The directory must come from trusted runtime context — the session's
 * location, or a worktree the user picked. Never from a model.
 */
export async function resolveProject(
  directory: string,
  registry: ProjectRegistry,
  options: ResolveOptions = {},
): Promise<ProjectIdentity | undefined> {
  const resolved = await resolveProjectPath(directory, options)
  if (!resolved) return undefined
  return registry.resolve(resolved)
}

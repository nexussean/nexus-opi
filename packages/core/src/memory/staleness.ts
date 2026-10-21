import { readFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import type { Memory } from "./types.ts"

/**
 * Memory staleness.
 *
 * A source-linked memory is a statement about a **specific version of a
 * file**. When that file changes, the statement may no longer be true — but
 * it is not wrong, it is *out of date*, and the difference matters: a stale
 * fact is surfaced with its staleness stated, and it cannot satisfy a
 * completion requirement.
 *
 * This is the same rule the verification service uses for a gate run, and
 * deliberately so. One notion of "this evidence is about code that no
 * longer exists" is better than two.
 */

/**
 * The hash of a file's content.
 *
 * The same short, non-cryptographic hash the index uses. It detects change,
 * which is all that is needed.
 */
export function hashContent(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(content)
  return hasher.digest("hex").slice(0, 16)
}

/**
 * The hash of a source file, or undefined when it cannot be read.
 */
export function sourceHash(root: string, source: string): string | undefined {
  try {
    const path = resolve(root, source)
    // A source outside the project is not this project's fact.
    if (!path.startsWith(resolve(root) + sep) && path !== resolve(root)) return undefined
    return hashContent(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

/**
 * Is this memory stale?
 *
 * A memory is stale when it has a source, it was verified against a hash,
 * and that hash no longer matches. A memory with no source is not stale —
 * it is a decision, and a decision is until changed.
 */
export function isStale(memory: Memory, root: string): boolean {
  const { source, sourceHash: recorded } = memory.provenance
  if (!source || !recorded) return false
  const current = sourceHash(root, source)
  // A source that has been deleted is not stale: it is gone, and the
  // memory's claim about it can no longer be checked either way.
  if (current === undefined) return false
  return current !== recorded
}

/**
 * The stale state of every memory in a list.
 *
 * The staleness is recomputed rather than stored, because a file can change
 * without anything telling OPI about it. A stored flag would be a claim
 * about the world that goes out of date on its own.
 */
export function withStaleness(memories: readonly Memory[], root: string): Memory[] {
  return memories.map((memory) => ({ ...memory, stale: isStale(memory, root) }))
}

/**
 * Has this memory expired?
 *
 * Nothing sets an expiry by default — a decision is until changed — but
 * the column is there, and a memory with an expiry in the past is no
 * longer usable.
 */
export function isExpired(memory: Memory, now = Date.now()): boolean {
  return memory.expiresAt !== undefined && memory.expiresAt <= now
}

/**
 * Is this memory usable as a fact right now?
 *
 * A stale or expired memory may still be *read* — knowing what was decided
 * is useful — but it may not be *acted on*. The two are different, and the
 * difference is what a stale marker is for.
 */
export function isUsable(memory: Memory, now = Date.now()): boolean {
  return !memory.stale && !isExpired(memory, now)
}

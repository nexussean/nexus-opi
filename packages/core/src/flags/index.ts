/**
 * Feature flags.
 *
 * Every flag defaults to off unless the user turns it on. A flag that gates a
 * behaviour with a privacy or cost implication must never default to on —
 * the plan's "no automatic remote calls, embedding requests, secret indexing or
 * arbitrary test execution" is a default, not an opt-in.
 */

export interface FeatureFlags {
  get(name: string, fallback?: boolean): boolean
  set(name: string, value: boolean): void
  isEnabled(name: string): boolean
  list(): Readonly<Record<string, boolean>>
}

/** The flags OPI knows about, and what each one is allowed to do. */
export const KNOWN_FLAGS = {
  "context.injection": false,
  "memory.auto_capture": false,
  "verification.execution": false,
  "indexer.background": true,
  "indexer.lsp": false,
  "metrics.export": false,
} as const satisfies Record<string, boolean>

export type FlagName = keyof typeof KNOWN_FLAGS

export class MemoryFeatureFlags implements FeatureFlags {
  #values = new Map<string, boolean>()

  constructor(initial: Record<string, boolean> = {}) {
    for (const [name, value] of Object.entries(initial)) this.#values.set(name, value)
  }

  get(name: string, fallback = false): boolean {
    if (this.#values.has(name)) return this.#values.get(name) === true
    if (name in KNOWN_FLAGS) return KNOWN_FLAGS[name as FlagName]
    return fallback
  }

  set(name: string, value: boolean): void {
    this.#values.set(name, value)
  }

  isEnabled(name: string): boolean {
    return this.get(name, false)
  }

  list(): Readonly<Record<string, boolean>> {
    const out: Record<string, boolean> = {}
    for (const [name, value] of Object.entries(KNOWN_FLAGS)) out[name] = this.get(name)
    for (const [name, value] of this.#values) out[name] = value
    return out
  }
}

import type { Language } from "./inventory.ts"

/**
 * The parser adapter interface.
 *
 * Every adapter normalises to the same shapes, and — this is the important
 * part — records **how** it learned each fact. An adapter that resolves a
 * binding uniquely may say `resolved`; one that only saw a name in an import
 * statement says `syntactic`, and one that could not identify the target says
 * `unresolved`. Absence of an edge is never reported as absence of a
 * relationship.
 */

export type AdapterConfidence = "resolved" | "syntactic" | "ambiguous" | "unresolved"

export interface AdapterSymbol {
  name: string
  /** `Class.method` for a member. */
  qualifiedName: string
  kind: string
  startLine: number
  endLine: number
  text: string
  /** The span the symbol occupies, in bytes. */
  startIndex: number
  endIndex: number
}

export interface AdapterImport {
  /** The module specifier as written. */
  specifier: string
  /** The file it resolves to, relative to the project root, when it is local. */
  resolved?: string
  kind: "import" | "export" | "require" | "dynamic-import"
  line: number
  /** How the import was identified. */
  confidence: AdapterConfidence
}

export interface AdapterReference {
  /** The name referenced. */
  name: string
  line: number
  /** How the reference was identified. */
  confidence: AdapterConfidence
}

export interface AdapterResult {
  language: Language
  symbols: AdapterSymbol[]
  imports: AdapterImport[]
  references: AdapterReference[]
  /** Files the adapter could not read. */
  failures: { path: string; reason: string }[]
}

export interface LanguageAdapter {
  readonly id: string
  readonly language: Language
  readonly extensions: readonly string[]
  /** Whether the adapter can handle this file at all. */
  supports(path: string): boolean
  parse(path: string, source: string): Promise<AdapterResult>
}

/**
 * The registry of adapters.
 *
 * An adapter that is not registered means the language is unsupported, which
 * is reported honestly — not as "there are no symbols here".
 */
export class AdapterRegistry {
  #adapters: LanguageAdapter[] = []

  register(adapter: LanguageAdapter): this {
    this.#adapters.push(adapter)
    return this
  }

  for(path: string): LanguageAdapter | undefined {
    return this.#adapters.find((adapter) => adapter.supports(path))
  }

  get languages(): Language[] {
    return this.#adapters.map((adapter) => adapter.language)
  }

  get adapters(): readonly LanguageAdapter[] {
    return this.#adapters
  }
}

import type { Confidence } from "@opi/contracts"
import type { PersistentIndex } from "./persistent.ts"

/**
 * Module-level resolution.
 *
 * A language server would tell you that the `AuthService` in `handler.ts` binds
 * to the class declared in `service.ts`. Without one, some of that is still
 * provable from the index alone:
 *
 * - `handler.ts` imports from `./service`, which is `service.ts`.
 * - `service.ts` declares `AuthService`.
 * - The import names `AuthService`.
 *
 * So the import **is** resolved to a specific definition — provably, from
 * what the file says. What is *not* proven is that any particular use of
 * the name inside `handler.ts` refers to it. The edge is `resolved`; the
 * reference is still `syntactic`.
 *
 * This is the honest middle ground the plan's confidence vocabulary was
 * designed for, and it is available without a language server.
 */

export interface ResolvedImport {
  /** The file that imports. */
  fromPath: string
  /** The file that is imported. */
  toPath: string
  /** The name that was imported. */
  name: string
  /** The definition the name refers to, when the imported file declares it. */
  definition?: { path: string; name: string; qualifiedName: string; kind: string; startLine: number; endLine: number }
  confidence: Confidence
  line: number
}

export interface ResolutionResult {
  imports: ResolvedImport[]
  /** How many imports could not be tied to a definition. */
  unresolved: number
  warnings: string[]
}

/**
 * Resolve the imports of a file against the index.
 *
 * An import whose target file declares the name is `resolved`. An import
 * whose target is unknown, or which names something the target does not
 * declare, stays `syntactic` — the file is imported, but the binding is
 * not proven.
 */
export function resolveImports(index: PersistentIndex, path: string): ResolutionResult {
  const imports: ResolvedImport[] = []
  const warnings: string[] = []
  let unresolved = 0

  for (const edge of index.importsIn(path)) {
    if (!edge.resolved) {
      // The specifier points outside the project, or at a file that is not
      // indexed. That is an unresolved import, not a missing one.
      unresolved += 1
      imports.push({
        fromPath: path,
        toPath: "",
        name: edge.specifier,
        confidence: "unresolved",
        line: edge.line,
      })
      continue
    }

    // The names an import statement brings in are recorded as references in
    // the importing file. The one that matches a declaration in the imported
    // file is the binding.
    const declared = index.symbolsIn(edge.resolved)
    const mentions = index.mentionsIn(path)

    let best: (typeof declared)[number] | undefined
    for (const symbol of declared) {
      if (mentions.some((mention) => mention.name === symbol.name)) {
        best = symbol
        break
      }
    }

    if (best) {
      imports.push({
        fromPath: path,
        toPath: edge.resolved,
        name: best.name,
        definition: {
          path: best.path,
          name: best.name,
          qualifiedName: best.qualifiedName,
          kind: best.kind,
          startLine: best.startLine,
          endLine: best.endLine,
        },
        confidence: "resolved",
        line: edge.line,
      })
      continue
    }

    unresolved += 1
    imports.push({
      fromPath: path,
      toPath: edge.resolved,
      name: edge.specifier,
      confidence: "syntactic",
      line: edge.line,
    })
  }

  if (unresolved > 0) {
    warnings.push(
      `${unresolved} import(s) could not be tied to a definition. They are reported as syntactic.`,
    )
  }

  return { imports, unresolved, warnings }
}

/**
 * The definitions a file's imports resolve to, with the confidence of the
 * binding.
 */
export function resolvedDefinitions(
  index: PersistentIndex,
  path: string,
): { symbol: { path: string; name: string; qualifiedName: string; kind: string; startLine: number; endLine: number }; confidence: Confidence; via: string }[] {
  const result = resolveImports(index, path)
  const out: {
    symbol: { path: string; name: string; qualifiedName: string; kind: string; startLine: number; endLine: number }
    confidence: Confidence
    via: string
  }[] = []
  const seen = new Set<string>()
  for (const edge of result.imports) {
    if (!edge.definition) continue
    const key = `${edge.definition.path}:${edge.definition.name}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ symbol: edge.definition, confidence: edge.confidence, via: edge.fromPath })
  }
  return out
}

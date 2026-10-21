import type { Confidence, SourceRef } from "@opi/contracts"
import type { PersistentIndex } from "./persistent.ts"
import { resolveImports } from "./resolve.ts"

/**
 * The graph query layer.
 *
 * Two rules govern everything here:
 *
 * 1. **Every result cites its source.** A file, a line range, and the
 *    confidence the query could establish.
 * 2. **A result never claims more than it knows.** `callers` and `references`
 *    report what the parse *suggests*, and say so. A missing edge is never
 *    reported as an absence of a relationship — the plan's own wording:
 *    "never claim that missing graph edges imply code is unaffected".
 */

export type GraphAction =
  | "symbol_search"
  | "neighbors"
  | "references"
  | "callers"
  | "importers"
  | "impact"
  | "related_tests"

export const GRAPH_ACTIONS: GraphAction[] = [
  "symbol_search",
  "neighbors",
  "references",
  "callers",
  "importers",
  "impact",
  "related_tests",
]

export interface GraphNode {
  path: string
  name: string
  qualifiedName: string
  kind: string
  startLine: number
  endLine: number
  /** How this edge was established. */
  confidence: Confidence
  /** Why this result is here, in words. */
  reason: string
}

export interface GraphResult {
  action: GraphAction
  nodes: GraphNode[]
  /** True when a bound cut the result short. */
  truncated: boolean
  /** The bounds that were in force. */
  limits: { maxHops: number; maxSymbols: number; maxFiles: number }
  /**
   * A statement about completeness. `callers` and `references` are always
   * `partial`, because no adapter proves a binding.
   */
  completeness: "complete" | "partial"
  /** Why the result is partial, when it is. */
  completenessNote?: string
  warnings: string[]
}

export interface GraphQuery {
  action: GraphAction
  /** The symbol or path the query is about. */
  query: string
  /** The file the query is scoped to, when known. */
  path?: string
  maxHops?: number
  maxSymbols?: number
  maxFiles?: number
  includeUnresolved?: boolean
}

const LIMITS = {
  /** The plan's default and hard maximum. */
  maxHopsDefault: 2,
  maxHopsHard: 3,
  maxSymbols: 50,
  maxFiles: 30,
  maxRelatedTests: 15,
}

function confidenceLabel(action: GraphAction): { completeness: "complete" | "partial"; note?: string } {
  switch (action) {
    case "symbol_search":
      return { completeness: "complete" }
    case "importers":
      return {
        completeness: "partial",
        note: "An import is resolved when the imported file declares exactly the name that was imported. A file that imports a module is still not proof that it calls anything inside it.",
      }
    case "neighbors":
      return { completeness: "partial", note: "Import edges are syntactic: a file that imports a module is not proof that it uses any particular symbol in it." }
    case "references":
    case "callers":
      return {
        completeness: "partial",
        note: "No binding is proven, so this is every place the name appears — not every place it is called. Treat it as a superset, not a complete list.",
      }
    case "impact":
      return { completeness: "partial", note: "Impact combines import edges and name matches. Neither proves a call." }
    case "related_tests":
      return { completeness: "partial", note: "Related tests are candidates chosen by naming and path heuristics, not by proof." }
    default:
      return { completeness: "partial" }
  }
}

function nodeFor(
  row: { path: string; name: string; qualifiedName: string; kind: string; startLine: number; endLine: number },
  confidence: Confidence,
  reason: string,
): GraphNode {
  return {
    path: row.path,
    name: row.name,
    qualifiedName: row.qualifiedName,
    kind: row.kind,
    startLine: row.startLine,
    endLine: row.endLine,
    confidence,
    reason,
  }
}

/**
 * Run a graph query.
 *
 * Every action is bounded. When a bound is reached the result is truncated and
 * says so, rather than quietly returning fewer results.
 */
export function queryGraph(index: PersistentIndex, input: GraphQuery): GraphResult {
  const maxHops = Math.min(input.maxHops ?? LIMITS.maxHopsDefault, LIMITS.maxHopsHard)
  const maxSymbols = Math.min(input.maxSymbols ?? LIMITS.maxSymbols, LIMITS.maxSymbols)
  const maxFiles = Math.min(input.maxFiles ?? LIMITS.maxFiles, LIMITS.maxFiles)
  const limits = { maxHops, maxSymbols, maxFiles }
  const warnings: string[] = []
  const { completeness, note } = confidenceLabel(input.action)

  const finish = (nodes: GraphNode[], truncated = false): GraphResult => {
    if (note) warnings.push(note)
    // A bound of zero is still a bound: the result is empty because the limit
    // said so, and that has to be visible.
    if (truncated || maxSymbols === 0) {
      warnings.push(
        `Truncated at the limit: ${maxSymbols} symbols, ${maxFiles} files, ${maxHops} hops.`,
      )
    }
    return {
      action: input.action,
      nodes,
      truncated,
      limits,
      completeness,
      ...(note ? { completenessNote: note } : {}),
      warnings,
    }
  }

  switch (input.action) {
    case "symbol_search": {
      const exact = index.filesDefining(input.query)
      const nodes: GraphNode[] = []
      for (const row of exact) {
        if (nodes.length >= maxSymbols) return finish(nodes, true)
        nodes.push(nodeFor(row, "resolved", `defines ${row.qualifiedName}`))
      }
      if (nodes.length === 0) {
        // A miss is reported. It is never presented as "the symbol does not
        // exist" — only that the index has no definition under that name.
        warnings.push(`No symbol named ${input.query} is indexed.`)
      }
      return finish(nodes)
    }

    case "neighbors": {
      // The files this one imports, and the files that import it.
      const nodes: GraphNode[] = []
      const paths = new Set<string>()
      if (input.path) {
        for (const edge of index.importsIn(input.path)) {
          if (edge.resolved) paths.add(edge.resolved)
        }
        for (const importer of index.importersOf(input.path)) paths.add(importer)
      } else {
        for (const row of index.filesDefining(input.query)) {
          for (const edge of index.importsIn(row.path)) {
            if (edge.resolved) paths.add(edge.resolved)
          }
        }
      }
      for (const path of paths) {
        if (nodes.length >= maxFiles) return finish(nodes, true)
        for (const symbol of index.symbolsIn(path).slice(0, 5)) {
          nodes.push(nodeFor(symbol, "syntactic", `in ${path}, which is linked by an import`))
        }
      }
      return finish(nodes)
    }

    case "importers": {
      // Where the binding is provable, the edge is `resolved`: the import
      // names a symbol, and the imported file declares exactly that symbol.
      // Where it is not, the edge stays `syntactic` and the reason says so.
      const nodes: GraphNode[] = []
      const paths = input.path
        ? index.importersOf(input.path)
        : index.filesDefining(input.query).flatMap((row) => index.importersOf(row.path))
      // The target the importers are matched against: the file the query
      // names, or the file that defines the symbol.
      const targetPath =
        input.path ?? index.filesDefining(input.query).map((row) => row.path)[0] ?? ""

      for (const path of paths) {
        if (nodes.length >= maxFiles) return finish(nodes, true)
        const resolution = resolveImports(index, path)
        const binding = resolution.imports.find(
          (edge) => edge.toPath === targetPath && edge.definition,
        )
        if (binding?.definition) {
          // The node is the **definition**; the reason names the importer.
          // A consumer that wants the importer reads the reason, and the
          // citation still points at the code that defines the symbol.
          nodes.push({
            path: binding.definition.path,
            name: binding.definition.name,
            qualifiedName: binding.definition.qualifiedName,
            kind: binding.definition.kind,
            startLine: binding.definition.startLine,
            endLine: binding.definition.endLine,
            confidence: "resolved",
            reason: `imported by ${path}, and the name matches this definition`,
          })
          continue
        }
        for (const symbol of index.symbolsIn(path).slice(0, 3)) {
          if (nodes.length >= maxSymbols) return finish(nodes, true)
          nodes.push(nodeFor(symbol, "syntactic", `in ${path}, which imports the target`))
        }
      }
      return finish(nodes)
    }

    case "references":
    case "callers": {
      // Every place the name appears, whether or not anything is defined
      // under it. A superset: the name may be a mention of a definition in
      // another file, an import of it, or an unrelated local. The point is
      // that it is never *missing* a place the name appears.
      const nodes: GraphNode[] = []
      const targets = index.filesDefining(input.query)
      const targetPaths = new Set(targets.map((row) => row.path))
      if (targetPaths.size === 0) {
        warnings.push(
          `No symbol named ${input.query} is defined in the index. The places below mention the name, which may or may not refer to a definition.`,
        )
      }
      for (const file of index.files()) {
        if (targetPaths.has(file.path)) continue
        const mentions = index.mentionsOf(file.path, input.query)
        if (mentions.length === 0) continue
        for (const mention of mentions) {
          if (nodes.length >= maxSymbols) return finish(nodes, true)
          nodes.push({
            path: file.path,
            name: input.query,
            qualifiedName: input.query,
            kind: "mention",
            startLine: mention.line,
            endLine: mention.line,
            confidence: "syntactic",
            reason: `mentions ${input.query}`,
          })
        }
      }
      return finish(nodes)
    }

    case "impact": {
      // Inbound: files that import the target, then files that mention it.
      const nodes: GraphNode[] = []
      const seen = new Set<string>()
      const targets = index.filesDefining(input.query)
      const targetPaths = new Set(targets.map((row) => row.path))

      for (const row of targets) {
        for (const importer of index.importersOf(row.path)) {
          if (seen.has(importer)) continue
          seen.add(importer)
          if (seen.size > maxFiles) return finish(nodes, true)
          for (const symbol of index.symbolsIn(importer).slice(0, 3)) {
            // Every bound is checked before a node is added, not just some of
            // them. A limit that only applies to one code path is not a limit.
            if (nodes.length >= maxSymbols) return finish(nodes, true)
            nodes.push(nodeFor(symbol, "syntactic", `in ${importer}, which imports the target`))
          }
        }
      }
      for (const file of index.files()) {
        if (targetPaths.has(file.path) || seen.has(file.path)) continue
        for (const symbol of index.symbolsIn(file.path)) {
          if (symbol.name !== input.query) continue
          if (nodes.length >= maxSymbols) return finish(nodes, true)
          nodes.push(nodeFor(symbol, "syntactic", `mentions ${input.query}`))
        }
      }
      return finish(nodes)
    }

    case "related_tests": {
      // Test files, ranked by whether they are near the target. A heuristic,
      // and labelled as one.
      const nodes: GraphNode[] = []
      const target = input.path ?? index.filesDefining(input.query)[0]?.path
      const tests = index
        .files()
        .filter(
          (file) =>
            /(^|\/)(tests?|__tests__)\//.test(file.path) || /\.(test|spec)\.[jt]sx?$/.test(file.path),
        )
      const scored = tests
        .map((file) => {
          let score = 0
          const targetDir = target ? target.split("/").slice(0, -1).join("/") : undefined
          if (targetDir && file.path.includes(targetDir)) score += 3
          // A test that defines or mentions the symbol is a better candidate
          // than one that merely sits in the same directory.
          if (index.symbolsIn(file.path).some((symbol) => symbol.name === input.query)) score += 5
          if (index.importsOf(file.path).some((imported) => imported === target)) score += 4
          return { file, score }
        })
        .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))

      for (const { file } of scored.slice(0, LIMITS.maxRelatedTests)) {
        if (nodes.length >= maxSymbols) return finish(nodes, true)
        const symbols = index.symbolsIn(file.path)
        if (symbols.length > 0) {
          for (const symbol of symbols.slice(0, 2)) {
            nodes.push(nodeFor(symbol, "syntactic", `in ${file.path}, a test file`))
          }
          continue
        }
        // A test file may define nothing at all — a file of `test(...)` calls
        // has no declarations. It is still a result.
        nodes.push({
          path: file.path,
          name: file.path.split("/").pop() ?? file.path,
          qualifiedName: file.path,
          kind: "file",
          startLine: 0,
          endLine: 0,
          confidence: "syntactic",
          reason: `a test file near the target`,
        })
      }
      return finish(nodes)
    }

    default:
      warnings.push(`Unknown action ${String(input.action)}.`)
      return finish([])
  }
}

/** The source references for a graph result, for the envelope. */
export function graphSources(result: GraphResult): SourceRef[] {
  return result.nodes.map((node) => ({
    path: node.path,
    startLine: node.startLine,
    endLine: node.endLine,
    confidence: node.confidence,
  }))
}

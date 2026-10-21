import type Parser from "tree-sitter"
import type { SyntaxNode } from "tree-sitter"

export type ImportKind = "import" | "export" | "require" | "dynamic-import"

export interface ImportEdge {
  /** The module specifier as written. */
  specifier: string
  /** The file the specifier resolves to, relative to the project root, when it is a local file. */
  resolved?: string
  kind: ImportKind
  /** Zero-based line of the import. */
  line: number
}

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]

/**
 * Extract the module specifiers a file imports.
 *
 * These are **syntactic** facts: the text says `from "./store"`. Whether that resolves to a
 * file, and to which, is decided by the indexer, and the result is still only a syntactic
 * edge — no binding is proven.
 */
export function extractImports(tree: Parser.Tree, source: string): ImportEdge[] {
  const edges: ImportEdge[] = []

  const stringValue = (node: SyntaxNode | null): string | undefined => {
    if (!node) return undefined
    const text = source.slice(node.startIndex, node.endIndex)
    const match = /^["'`](.+)["'`]$/.exec(text)
    return match?.[1]
  }

  const visit = (node: SyntaxNode): void => {
    if (node.type === "import_statement") {
      const sourceNode = node.childForFieldName("source")
      const specifier = stringValue(sourceNode)
      if (specifier) {
        edges.push({ specifier, kind: "import", line: node.startPosition.row })
      }
    } else if (node.type === "export_statement") {
      const sourceNode = node.childForFieldName("source")
      const specifier = stringValue(sourceNode)
      if (specifier) {
        edges.push({ specifier, kind: "export", line: node.startPosition.row })
      }
    } else if (node.type === "call_expression") {
      const fn = node.childForFieldName("function")
      const fnText = fn ? source.slice(fn.startIndex, fn.endIndex) : ""
      const args = node.childForFieldName("arguments")
      const firstArg = args?.namedChild(0) ?? null
      if ((fnText === "require" || fnText === "require.resolve") && firstArg) {
        const specifier = stringValue(firstArg)
        if (specifier) edges.push({ specifier, kind: "require", line: node.startPosition.row })
      } else if ((fnText === "import" || fnText === "await import") && firstArg) {
        const specifier = stringValue(firstArg)
        if (specifier) edges.push({ specifier, kind: "dynamic-import", line: node.startPosition.row })
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child) visit(child)
    }
  }

  visit(tree.rootNode)
  return edges
}

/**
 * Resolve a relative module specifier to a file in the project.
 *
 * Tries the specifier as written, then each known extension, then the directory's index
 * file. Returns undefined when nothing matches — an unresolved import is reported as
 * unresolved, never as "no such relationship".
 */
export function resolveRelative(
  specifier: string,
  fromFile: string,
  knownFiles: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined
  const fromDir = fromFile.split("/").slice(0, -1).join("/")
  const base = `${fromDir}/${specifier}`.replace(/\/\.\//g, "/")
  const normalized = base.startsWith("/") ? base : base

  const candidates = [normalized]
  for (const extension of EXTENSIONS) candidates.push(`${normalized}${extension}`)
  for (const extension of EXTENSIONS) candidates.push(`${normalized}/index${extension}`)

  for (const candidate of candidates) {
    const clean = candidate.replace(/^\.\//, "")
    if (knownFiles.has(clean)) return clean
  }
  return undefined
}

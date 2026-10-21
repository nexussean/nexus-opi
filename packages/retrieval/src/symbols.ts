import type Parser from "tree-sitter"
import type { SyntaxNode } from "tree-sitter"

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "variable"

export interface Symbol {
  /** The name as written, e.g. `resolveProject` or `BoardStore`. */
  name: string
  /** `Class.method` when the symbol is a member of a class. */
  qualifiedName: string
  kind: SymbolKind
  /** Zero-based line of the definition. */
  startLine: number
  /** Zero-based line of the last line of the definition. */
  endLine: number
  /** The source text of the definition, trimmed. */
  text: string
}

const DEFINITION_KINDS: Record<string, SymbolKind> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  class_declaration: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
  method_definition: "method",
  method_signature: "method",
  abstract_method_signature: "method",
  public_field_definition: "const",
  property_signature: "const",
}

function nodeText(node: SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex)
}

function nameOf(node: SyntaxNode, source: string): string | undefined {
  const nameNode = node.childForFieldName("name")
  if (nameNode) return nodeText(nameNode, source)
  // A variable declarator's name is a child, not a field, in some grammars.
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (child && (child.type === "identifier" || child.type === "type_identifier" || child.type === "property_identifier")) {
      return nodeText(child, source)
    }
  }
  return undefined
}

/**
 * Extract the definitions in a file.
 *
 * Only syntactic facts are reported. Whether a symbol *resolves* to another symbol is a
 * separate question that this spike deliberately does not answer — the retrieval layer marks
 * such relationships `syntactic`, never `resolved`.
 */
export function extractSymbols(tree: Parser.Tree, source: string): Symbol[] {
  const symbols: Symbol[] = []
  const classStack: string[] = []

  const visit = (node: SyntaxNode): void => {
    const kind = DEFINITION_KINDS[node.type]
    if (kind) {
      const name = nameOf(node, source)
      if (name) {
        const isMember = kind === "method" || kind === "const"
        const qualifiedName = isMember && classStack.length ? `${classStack[classStack.length - 1]}.${name}` : name
        symbols.push({
          name,
          qualifiedName,
          kind,
          startLine: node.startPosition.row,
          endLine: node.endPosition.row,
          text: nodeText(node, source).trim().slice(0, 2000),
        })
      }
    }

    // Track class nesting so methods get a qualified name.
    const isClass = node.type === "class_declaration"
    const className = isClass ? nameOf(node, source) : undefined
    if (className) classStack.push(className)

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child) visit(child)
    }

    if (className) classStack.pop()
  }

  visit(tree.rootNode)
  return symbols
}

/** Top-level and nested `const`/`let`/`var` declarations that hold a value. */
export function extractVariables(tree: Parser.Tree, source: string): Symbol[] {
  const symbols: Symbol[] = []
  const visit = (node: SyntaxNode): void => {
    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i)
        if (!child || child.type !== "variable_declarator") continue
        const name = nameOf(child, source)
        if (!name) continue
        symbols.push({
          name,
          qualifiedName: name,
          kind: "variable",
          startLine: child.startPosition.row,
          endLine: child.endPosition.row,
          text: nodeText(child, source).trim().slice(0, 2000),
        })
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child) visit(child)
    }
  }
  visit(tree.rootNode)
  return symbols
}

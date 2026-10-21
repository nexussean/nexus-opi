import Parser from "tree-sitter"
import TypeScript from "tree-sitter-typescript"
import type {
  AdapterConfidence,
  AdapterImport,
  AdapterResult,
  AdapterSymbol,
  LanguageAdapter,
} from "../adapter.ts"
import type { Language } from "../inventory.ts"

let parser: Parser | undefined

function getParser(grammar: "typescript" | "tsx" | "javascript"): Parser {
  if (!parser) parser = new Parser()
  // tree-sitter-typescript ships no separate JavaScript grammar; the
  // TypeScript grammar parses JavaScript correctly for what we extract.
  parser.setLanguage(grammar === "tsx" ? TypeScript.tsx : TypeScript.typescript)
  return parser
}

const DEFINITION_KINDS: Record<string, string> = {
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
  function_signature: "function",
}

/**
 * The TypeScript/JavaScript adapter.
 *
 * Every fact it reports is **syntactic**: the parse says a function is
 * declared here, or that a module is imported here. Nothing here proves that
 * an imported name *binds* to a particular definition. That is what makes
 * `resolved` a claim the spike does not make.
 */
export const typescriptAdapter: LanguageAdapter = {
  id: "typescript",
  language: "typescript",
  extensions: [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"],

  supports(path: string): boolean {
    return /\.(m|c)?[jt]sx?$/.test(path)
  },

  async parse(path: string, source: string): Promise<AdapterResult> {
    const symbols: AdapterSymbol[] = []
    const imports: AdapterImport[] = []
    const references: AdapterResult["references"] = []
    const failures: AdapterResult["failures"] = []

    const grammar: "typescript" | "tsx" | "javascript" = path.endsWith(".tsx") || path.endsWith(".jsx")
      ? "tsx"
      : /\.[cm]?js$/.test(path)
        ? "javascript"
        : "typescript"

    let tree
    try {
      tree = getParser(grammar).parse(source)
    } catch (error) {
      failures.push({ path, reason: (error as Error).message })
      return { language: grammar === "tsx" ? "tsx" : grammar === "javascript" ? "javascript" : "typescript", symbols, imports, references, failures }
    }

    const text = (node: Parser.SyntaxNode) => source.slice(node.startIndex, node.endIndex)

    const nameOf = (node: Parser.SyntaxNode): string | undefined => {
      const nameNode = node.childForFieldName("name")
      if (nameNode) return text(nameNode)
      for (let index = 0; index < node.namedChildCount; index++) {
        const child = node.namedChild(index)
        if (child && ["identifier", "type_identifier", "property_identifier"].includes(child.type)) {
          return text(child)
        }
      }
      return undefined
    }

    const classStack: string[] = []

    const visit = (node: Parser.SyntaxNode): void => {
      const kind = DEFINITION_KINDS[node.type]
      if (kind) {
        const name = nameOf(node)
        if (name) {
          const isMember = kind === "method" || kind === "const"
          const owner = isMember ? classStack[classStack.length - 1] : undefined
          symbols.push({
            name,
            qualifiedName: owner ? `${owner}.${name}` : name,
            kind,
            startLine: node.startPosition.row,
            endLine: node.endPosition.row,
            text: text(node).trim().slice(0, 2000),
            startIndex: node.startIndex,
            endIndex: node.endIndex,
          })
        }
      }

      if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
        for (let index = 0; index < node.namedChildCount; index++) {
          const child = node.namedChild(index)
          if (!child || child.type !== "variable_declarator") continue
          const name = nameOf(child)
          if (!name) continue
          symbols.push({
            name,
            qualifiedName: name,
            kind: "variable",
            startLine: child.startPosition.row,
            endLine: child.endPosition.row,
            text: text(child).trim().slice(0, 2000),
            startIndex: child.startIndex,
            endIndex: child.endIndex,
          })
        }
      }

      const stringValue = (node: Parser.SyntaxNode | null): string | undefined => {
        if (!node) return undefined
        const raw = text(node)
        const match = /^["'`](.+)["'`]$/.exec(raw)
        return match?.[1]
      }

      if (node.type === "import_statement" || node.type === "export_statement") {
        const specifier = stringValue(node.childForFieldName("source"))
        if (specifier) {
          imports.push({
            specifier,
            kind: node.type === "import_statement" ? "import" : "export",
            line: node.startPosition.row,
            confidence: "syntactic",
          })
        }
      }

      if (node.type === "call_expression") {
        const fn = node.childForFieldName("function")
        const fnText = fn ? text(fn) : ""
        const args = node.childForFieldName("arguments")
        const firstArg = args?.namedChild(0) ?? null
        if ((fnText === "require" || fnText === "require.resolve") && firstArg) {
          const specifier = stringValue(firstArg)
          if (specifier) {
            imports.push({ specifier, kind: "require", line: node.startPosition.row, confidence: "syntactic" })
          }
        } else if ((fnText === "import" || fnText === "await import") && firstArg) {
          const specifier = stringValue(firstArg)
          if (specifier) {
            imports.push({
              specifier,
              kind: "dynamic-import",
              line: node.startPosition.row,
              confidence: "syntactic",
            })
          }
        }
      }

      const isClass = node.type === "class_declaration"
      const className = isClass ? nameOf(node) : undefined
      if (className) classStack.push(className)

      for (let index = 0; index < node.childCount; index++) {
        const child = node.child(index)
        if (child) visit(child)
      }

      if (className) classStack.pop()
    }

    // Identifiers used in the file, minus the ones that define something.
    // These are the *candidates* for a reference: a name that appears here
    // and is defined elsewhere may be a reference to it, but the parse does
    // not prove the binding.
    const defined = new Set(symbols.map((symbol) => symbol.name))
    const used = new Map<string, number>()
    const collectIdentifiers = (node: Parser.SyntaxNode): void => {
      if (node.type === "identifier") {
        const name = text(node)
        if (!defined.has(name)) {
          const line = node.startPosition.row
          if (!used.has(name)) used.set(name, line)
        }
      }
      for (let index = 0; index < node.namedChildCount; index++) {
        const child = node.namedChild(index)
        if (child) collectIdentifiers(child)
      }
    }
    collectIdentifiers(tree.rootNode)
    for (const [name, line] of used) {
      references.push({ name, line, confidence: "syntactic" })
    }

    visit(tree.rootNode)

    return {
      language: grammar === "tsx" ? "tsx" : grammar === "javascript" ? "javascript" : "typescript",
      symbols,
      imports,
      references,
      failures,
    }
  },
}


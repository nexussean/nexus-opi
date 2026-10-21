import Parser from "tree-sitter"
import Go from "tree-sitter-go"
import type {
  AdapterConfidence,
  AdapterImport,
  AdapterResult,
  AdapterSymbol,
  LanguageAdapter,
} from "../adapter.ts"
import type { Language } from "../inventory.ts"

let parser: Parser | undefined

function getParser(): Parser {
  if (!parser) {
    parser = new Parser()
    parser.setLanguage(Go)
  }
  return parser
}

/**
 * The Go adapter.
 *
 * Go's grammar names things plainly: a `function_declaration` is a function, a
 * `method_declaration` is a method on a receiver, a `type_declaration` is a
 * type. A method's receiver gives it a qualified name, the same way a class
 * gives its methods one in TypeScript.
 */
export const goAdapter: LanguageAdapter = {
  id: "go",
  language: "go",
  extensions: [".go"],

  supports(path: string): boolean {
    return path.endsWith(".go")
  },

  async parse(path: string, source: string): Promise<AdapterResult> {
    const symbols: AdapterSymbol[] = []
    const imports: AdapterImport[] = []
    const references: AdapterResult["references"] = []
    const failures: AdapterResult["failures"] = []

    let tree
    try {
      tree = getParser().parse(source)
    } catch (error) {
      failures.push({ path, reason: (error as Error).message })
      return { language: "go", symbols, imports, references, failures }
    }

    const text = (node: Parser.SyntaxNode) => source.slice(node.startIndex, node.endIndex)

    const visit = (node: Parser.SyntaxNode, receiver?: string): void => {
      const add = (kind: string, name: string | undefined, qualified: string | undefined) => {
        if (!name) return
        symbols.push({
          name,
          qualifiedName: qualified ?? name,
          kind,
          startLine: node.startPosition.row,
          endLine: node.endPosition.row,
          text: text(node).trim().slice(0, 2000),
          startIndex: node.startIndex,
          endIndex: node.endIndex,
        })
      }

      switch (node.type) {
        case "function_declaration": {
          const nameNode = node.childForFieldName("name")
          add("function", nameNode ? text(nameNode) : undefined, undefined)
          break
        }
        case "method_declaration": {
          const nameNode = node.childForFieldName("name")
          const receiverNode = node.childForFieldName("receiver")
          // The receiver's type is the thing the method belongs to. The
          // grammar nests it: `parameter_list > parameter_declaration >
          // pointer_type > type_identifier`.
          let owner = receiver
          if (receiverNode) {
            const declaration = receiverNode.namedChildren.find((child) => child.type === "parameter_declaration")
            const typeNode = declaration?.childForFieldName("type")
            const identifier =
              typeNode?.type === "pointer_type" || typeNode?.type === "generic_type"
                ? typeNode.namedChildren.find((child) => child.type === "type_identifier")
                : typeNode?.type === "type_identifier"
                  ? typeNode
                  : undefined
            if (identifier) owner = text(identifier)
          }
          add("method", nameNode ? text(nameNode) : undefined, owner ? `${owner}.${text(nameNode ?? node)}` : undefined)
          break
        }
        case "type_declaration": {
          for (const spec of node.namedChildren) {
            if (spec.type !== "type_spec") continue
            const nameNode = spec.childForFieldName("name")
            add("type", nameNode ? text(nameNode) : undefined, undefined)
          }
          break
        }
        case "const_declaration":
        case "var_declaration": {
          for (const spec of node.namedChildren) {
            if (spec.type !== "const_spec" && spec.type !== "var_spec") continue
            const nameNode = spec.childForFieldName("name")
            add("const", nameNode ? text(nameNode) : undefined, undefined)
          }
          break
        }
        case "import_spec": {
          const pathNode = node.childForFieldName("path")
          const specifier = pathNode ? text(pathNode).replace(/^["`]|["`]$/g, "") : undefined
          if (specifier) {
            imports.push({
              specifier,
              kind: "import",
              line: node.startPosition.row,
              // A Go import path is not resolved to a file here; only a local
              // relative path could be, and Go does not use those.
              confidence: "syntactic",
            })
          }
          break
        }
        default:
          break
      }

      for (let index = 0; index < node.namedChildCount; index++) {
        const child = node.namedChild(index)
        if (child) visit(child, receiver)
      }
    }

    // Identifiers used in the file, minus the ones that define something.
    // The parse shows the name; it does not prove which definition it binds
    // to, so these are candidates and stay `syntactic`.
    const defined = new Set(symbols.map((symbol) => symbol.name))
    const used = new Map<string, number>()
    const collectIdentifiers = (node: Parser.SyntaxNode): void => {
      if (node.type === "identifier" && node.parent?.type !== "selector_expression") {
        const name = text(node)
        if (!defined.has(name) && !used.has(name)) used.set(name, node.startPosition.row)
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

    return { language: "go", symbols, imports, references, failures }
  },
}


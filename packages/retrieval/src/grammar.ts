import Parser from "tree-sitter"
import TypeScript from "tree-sitter-typescript"

export type GrammarKind = "typescript" | "tsx" | "javascript"

let parser: Parser | undefined

/** One parser, three grammars. */
export function getParser(): Parser {
  if (!parser) {
    parser = new Parser()
    parser.setLanguage(TypeScript.typescript)
  }
  return parser
}

export function setGrammar(kind: GrammarKind): void {
  const p = getParser()
  // tree-sitter-typescript ships no separate JavaScript grammar; the TypeScript
  // grammar parses JavaScript source correctly for the constructs we extract.
  if (kind === "tsx") p.setLanguage(TypeScript.tsx)
  else p.setLanguage(TypeScript.typescript)
}

export interface ParsedFile {
  tree: Parser.Tree
  source: string
}

export function parse(source: string, kind: GrammarKind): ParsedFile {
  setGrammar(kind)
  const p = getParser()
  return { tree: p.parse(source), source }
}

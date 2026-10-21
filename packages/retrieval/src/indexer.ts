import { Database } from "bun:sqlite"
import { readdir, readFile, stat } from "node:fs/promises"
import { extname, join, relative, resolve } from "node:path"
import { conceptFile, type ConceptFile } from "./concept.ts"
import { parse, type GrammarKind } from "./grammar.ts"
import { extractImports, resolveRelative, type ImportEdge } from "./imports.ts"
import { extractSymbols, extractVariables, type Symbol } from "./symbols.ts"

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "vendor",
  "__pycache__",
  ".venv",
])

const IGNORED_FILES = new Set([".DS_Store"])

export interface IndexedFile {
  /** Path relative to the project root, with forward slashes. */
  path: string
  language: string
  size: number
  symbols: Symbol[]
  imports: ImportEdge[]
  /** The file's own vocabulary, for the concept layer. */
  concept: ConceptFile
}

export interface IndexOptions {
  /** Project root. */
  root: string
  /** Skip files larger than this. */
  maxFileBytes?: number
}

function grammarFor(path: string): GrammarKind {
  const extension = extname(path)
  if (extension === ".tsx" || extension === ".jsx") return "tsx"
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "javascript"
  return "typescript"
}

async function walk(root: string, current: string, out: string[], maxFileBytes: number): Promise<void> {
  let entries
  try {
    entries = await readdir(current, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".opencode") continue
    const full = join(current, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue
      await walk(root, full, out, maxFileBytes)
      continue
    }
    if (!entry.isFile()) continue
    if (IGNORED_FILES.has(entry.name)) continue
    if (!SOURCE_EXTENSIONS.has(extname(entry.name))) continue
    try {
      const info = await stat(full)
      if (info.size > maxFileBytes) continue
    } catch {
      continue
    }
    out.push(full)
  }
}

/**
 * A one-shot index of a project.
 *
 * The spike deliberately has no incremental behaviour: every run rebuilds from scratch.
 * That is the cheapest version of the thesis, and it is what the kill criterion is about.
 */
export class CodeIndex {
  readonly root: string
  readonly files = new Map<string, IndexedFile>()
  readonly symbols = new Map<string, { file: string; symbol: Symbol }[]>()
  /**
   * Symbol names with their separators removed and lower-cased:
   * `defaultDataDir` becomes `defaultdatadir`.
   *
   * A question's words are joined the same way, so "data directory" becomes
   * `datadir` and can be found inside `defaultdatadir`. This is what lets
   * "where is the data directory chosen" find `defaultDataDir`.
   */
  readonly joinedSymbols = new Map<string, { file: string; symbol: Symbol }[]>()
  /** file -> files it imports. */
  readonly imports = new Map<string, Set<string>>()
  /** file -> files that import it. */
  readonly importedBy = new Map<string, Set<string>>()
  #db: Database

  constructor(root: string) {
    this.root = resolve(root)
    this.#db = new Database(":memory:")
    this.#db.exec(`
      CREATE VIRTUAL TABLE search USING fts5(
        symbol_name,
        qualified_name,
        file_path,
        body
      );
    `)
  }

  get fileCount(): number {
    return this.files.size
  }

  get symbolCount(): number {
    return this.symbols.size
  }

  async build(options: { maxFileBytes?: number } = {}): Promise<this> {
    const maxFileBytes = options.maxFileBytes ?? 512 * 1024
    const paths: string[] = []
    await walk(this.root, this.root, paths, maxFileBytes)

    const relativePaths = new Set(paths.map((path) => relative(this.root, path).split("\\").join("/")))
    const knownFiles = new Set(relativePaths)

    const insert = this.#db
      .query("INSERT INTO search (symbol_name, qualified_name, file_path, body) VALUES (?, ?, ?, ?)")
    const insertImport = this.#db
      .query("INSERT INTO search (symbol_name, qualified_name, file_path, body) VALUES (?, '', ?, '')")

    for (const absolute of paths) {
      const path = relative(this.root, absolute).split("\\").join("/")
      let source: string
      try {
        source = await readFile(absolute, "utf8")
      } catch {
        continue
      }
      const kind = grammarFor(path)
      let symbols: Symbol[] = []
      let imports: ImportEdge[] = []
      try {
        const { tree } = parse(source, kind)
        symbols = [...extractSymbols(tree, source), ...extractVariables(tree, source)]
        imports = extractImports(tree, source)
      } catch {
        // A file the grammar cannot read contributes nothing, but must not
        // stop the index.
        continue
      }

      const file: IndexedFile = {
        path,
        language: kind,
        size: source.length,
        symbols,
        imports,
        concept: conceptFile(
          symbols.map((symbol) => ({ name: symbol.qualifiedName, kind: symbol.kind })),
          path,
          source,
        ),
      }
      this.files.set(path, file)

      for (const symbol of symbols) {
        const list = this.symbols.get(symbol.name) ?? []
        list.push({ file: path, symbol })
        this.symbols.set(symbol.name, list)

        const joined = symbol.qualifiedName.toLowerCase().replace(/[^a-z0-9]/g, "")
        const joinedList = this.joinedSymbols.get(joined) ?? []
        joinedList.push({ file: path, symbol })
        this.joinedSymbols.set(joined, joinedList)

        insert.run(symbol.name, symbol.qualifiedName, path, symbol.text)
      }
      if (symbols.length === 0) insertImport.run("", path)
    }

    // Resolve the import edges now that every file is known.
    for (const file of this.files.values()) {
      const targets = new Set<string>()
      for (const edge of file.imports) {
        const resolved = resolveRelative(edge.specifier, file.path, knownFiles)
        if (!resolved) continue
        edge.resolved = resolved
        targets.add(resolved)
      }
      this.imports.set(file.path, targets)
      for (const target of targets) {
        const set = this.importedBy.get(target) ?? new Set<string>()
        set.add(file.path)
        this.importedBy.set(target, set)
      }
    }

    return this
  }

  /** Files that import the given file, one hop. */
  importersOf(path: string): string[] {
    return [...(this.importedBy.get(path) ?? [])]
  }

  /** Files the given file imports, one hop. */
  importsOf(path: string): string[] {
    return [...(this.imports.get(path) ?? [])]
  }

  /**
   * Lexical search over one column group.
   *
   * `columns` selects which FTS columns participate, so a hit in the body is never
   * reported as a hit on a symbol name.
   */
  search(
    term: string,
    columns: "names" | "paths" | "body" = "names",
    limit = 20,
  ): { symbol: string; qualified: string; path: string; snippet?: string }[] {
    const cleaned = term.replace(/["*]/g, " ").trim()
    if (!cleaned) return []
    const filter = columns === "names" ? "{symbol_name qualified_name}" : columns === "paths" ? "{file_path}" : "{body}"
    const prefix = `"${cleaned.split(/\s+/).join(" ")}"*`
    try {
      // `snippet()` is not used: Bun's SQLite build ships it with a different
      // arity, and the whole query would fail. The body is fetched and
      // truncated here instead.
      //
      // The path search asks for **distinct** paths. The table holds one row
      // per symbol, so a plain LIMIT is consumed by a single file's symbols and
      // other files never reach the results at all.
      const sql =
        columns === "paths"
          ? "SELECT DISTINCT file_path, '' AS symbol_name, '' AS qualified_name, '' AS body FROM search WHERE search MATCH ? LIMIT ?"
          : "SELECT symbol_name, qualified_name, file_path, body FROM search WHERE search MATCH ? LIMIT ?"
      const rows = this.#db.query(sql).all(`${filter} : ${prefix}`, limit) as {
        symbol_name: string
        qualified_name: string
        file_path: string
        body: string | null
      }[]
      return rows.map((row) => ({
        symbol: row.symbol_name,
        qualified: row.qualified_name,
        path: row.file_path,
        ...(row.body ? { snippet: row.body.slice(0, 240) } : {}),
      }))
    } catch {
      // A malformed FTS query is not a crash; it is no results.
      return []
    }
  }

  close() {
    this.#db.close()
  }
}

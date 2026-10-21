import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import {
  AdapterRegistry,
  type AdapterImport,
  type AdapterReference,
  type AdapterSymbol,
  type LanguageAdapter,
} from "./adapter.ts"
import { goAdapter } from "./adapters/go.ts"
import { typescriptAdapter } from "./adapters/typescript.ts"
import { conceptFile, type ConceptFile } from "./concept.ts"
import { buildInventory, hashContent, isSecretPath, languageFor, type Inventory, type Language } from "./inventory.ts"

export const INDEX_SCHEMA_VERSION = 1

export interface IndexFileRow {
  path: string
  language: Language
  size: number
  hash: string
  epoch: number
  indexedAt: number
  /** The file's own vocabulary, for the concept layer. */
  concept: ConceptFile
}

export interface IndexSymbolRow {
  path: string
  name: string
  qualifiedName: string
  kind: string
  startLine: number
  endLine: number
  startIndex: number
  endIndex: number
}

export interface IndexImportRow {
  path: string
  specifier: string
  resolved: string | null
  kind: string
  line: number
  confidence: string
}

const IMPORT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]

/**
 * Resolve a relative module specifier to a file in the project.
 *
 * A specifier that does not resolve stays unresolved. It is never reported
 * as "there is no such import" — an unresolved import is an unresolved
 * import, which is a different statement.
 */
export function resolveLocalSpecifier(
  specifier: string,
  fromPath: string,
  knownFiles: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined
  const fromDir = fromPath.split("/").slice(0, -1).join("/")
  const base = `${fromDir}/${specifier}`.replace(/\/\.\//g, "/")
  const candidates = [base]
  for (const extension of IMPORT_EXTENSIONS) candidates.push(`${base}${extension}`)
  for (const extension of IMPORT_EXTENSIONS) candidates.push(`${base}/index${extension}`)
  for (const candidate of candidates) {
    const clean = candidate.replace(/^\.\//, "").replace(/^\/\//, "")
    if (knownFiles.has(clean)) return clean
  }
  return undefined
}

/**
 * SQLite returns the column names as they are declared — `qualified_name` — so
 * the rows are mapped rather than cast. A cast would silently produce
 * `undefined` for every field the casing did not match.
 */
function toSymbolRow(row: Record<string, unknown>): IndexSymbolRow {
  return {
    path: String(row.path),
    name: String(row.name),
    qualifiedName: String(row.qualified_name),
    kind: String(row.kind),
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    startIndex: Number(row.start_index),
    endIndex: Number(row.end_index),
  }
}

export interface IndexStats {
  epoch: number
  files: number
  symbols: number
  imports: number
  languages: string[]
  /** Files that could not be parsed. */
  failures: { path: string; reason: string }[]
}

export interface PersistentIndexOptions {
  root: string
  /** Where the index lives. Defaults to an in-memory database. */
  path?: string
  adapters?: LanguageAdapter[]
  extraIgnore?: string[]
  maxFileBytes?: number
}

/**
 * The persistent, incrementally-maintained index.
 *
 * The shape is the plan's: an **epoch** is a consistent snapshot. A rebuild
 * writes into a new epoch and only then makes it visible, so a reader never
 * sees half an index. An index that failed to build leaves the previous epoch
 * in place, marked stale.
 *
 * The index is **derived data**. Nothing here is authoritative; the source
 * tree is. A rebuild must never lose a task or a decision.
 */
export class PersistentIndex {
  readonly root: string
  #db: Database
  #registry: AdapterRegistry
  #options: PersistentIndexOptions
  #epoch = 0
  #open = false
  /** The vocabulary of each indexed file, for the concept layer. */
  readonly #concepts = new Map<string, ConceptFile>()

  constructor(options: PersistentIndexOptions) {
    this.root = resolve(options.root)
    this.#options = options
    this.#registry = new AdapterRegistry()
    for (const adapter of options.adapters ?? [typescriptAdapter, goAdapter]) {
      this.#registry.register(adapter)
    }
    if (options.path) {
      // SQLite creates the file but not the directory it lives in. A missing
      // parent directory is an "unable to open database file" error, and the
      // index is opened during plugin setup — the worst possible moment.
      try {
        mkdirSync(dirname(options.path), { recursive: true })
      } catch {
        // The open below reports the real problem with a better message.
      }
    }
    this.#db = new Database(options.path ?? ":memory:", { create: true })
    this.#migrate()
    // The stored root is checked after the schema exists, so the value can
    // actually be read. An index built for one tree must not be used for
    // another: the rows would be wrong in a way nothing downstream could see.
    if (options.path) {
      const stored = this.#db.query("SELECT value FROM index_meta WHERE key = 'root'").get() as
        | { value: string }
        | undefined
      if (stored && stored.value !== this.root) {
        this.#db.close()
        throw new Error(
          `The index at ${options.path} was built for ${stored.value}, not ${this.root}.`,
        )
      }
    }
    // The concept layer is loaded from the database, so a persisted index
    // answers natural-language questions exactly as an in-memory one does.
    this.#loadConcepts()
  }

  #migrate() {
    // The FTS table stores its columns directly. A contentless table
    // (content='') holds no retrievable columns, so every column comes back
    // null and no search ever matches.
    this.#db.exec("PRAGMA journal_mode = WAL")
    this.#db.exec("PRAGMA foreign_keys = ON")
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS index_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS index_files (
        path       TEXT PRIMARY KEY,
        language   TEXT NOT NULL,
        size       INTEGER NOT NULL,
        hash       TEXT NOT NULL,
        epoch      INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS index_symbols (
        path           TEXT NOT NULL,
        name           TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        kind           TEXT NOT NULL,
        start_line     INTEGER NOT NULL,
        end_line       INTEGER NOT NULL,
        start_index    INTEGER NOT NULL,
        end_index      INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS index_imports (
        path       TEXT NOT NULL,
        specifier  TEXT NOT NULL,
        resolved   TEXT,
        kind       TEXT NOT NULL,
        line       INTEGER NOT NULL,
        confidence TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS index_symbols_name ON index_symbols(name);
      CREATE INDEX IF NOT EXISTS index_symbols_path ON index_symbols(path);
      CREATE INDEX IF NOT EXISTS index_imports_path ON index_imports(path);
      CREATE INDEX IF NOT EXISTS index_files_epoch ON index_files(epoch);
      CREATE TABLE IF NOT EXISTS index_references (
        path       TEXT NOT NULL,
        name       TEXT NOT NULL,
        line       INTEGER NOT NULL,
        confidence TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS index_references_name ON index_references(name);
      CREATE VIRTUAL TABLE IF NOT EXISTS index_fts USING fts5(
        symbol_name,
        qualified_name,
        file_path,
        body
      );
      CREATE TABLE IF NOT EXISTS index_failures (
        path   TEXT PRIMARY KEY,
        reason TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS index_concepts (
        path          TEXT PRIMARY KEY,
        symbol_tokens TEXT NOT NULL,
        per_symbol    TEXT NOT NULL,
        per_symbol_all TEXT NOT NULL,
        path_tokens   TEXT NOT NULL,
        body_tokens   TEXT NOT NULL
      );
    `)
    // `CREATE TABLE IF NOT EXISTS` does not add a column to a table that
    // already exists, so an index written before `per_symbol_all` existed
    // needs the column added. SQLite has no `ADD COLUMN IF NOT EXISTS`, so
    // the check is done by reading the table's own columns.
    const conceptColumns = (
      this.#db.query("PRAGMA table_info(index_concepts)").all() as { name: string }[]
    ).map((column) => column.name)
    if (conceptColumns.length > 0 && !conceptColumns.includes("per_symbol_all")) {
      this.#db.exec("ALTER TABLE index_concepts ADD COLUMN per_symbol_all TEXT NOT NULL DEFAULT '[]'")
    }
    const row = this.#db.query("SELECT value FROM index_meta WHERE key = 'epoch'").get() as
      | { value: string }
      | undefined
    this.#epoch = row ? Number(row.value) : 0
    // The root is recorded so an index cannot be opened against a different
    // project by mistake. It is written only when absent: an existing value
    // belongs to the index that is already there, and the constructor checks
    // it. Overwriting it here would erase the evidence of a mismatch.
    this.#db
      .query("INSERT OR IGNORE INTO index_meta (key, value) VALUES ('root', ?)")
      .run(this.root)
    this.#open = true
  }

  get epoch(): number {
    return this.#epoch
  }

  /**
   * Load the concept layer from the database.
   *
   * The concept data is what lets a question that names no symbol find an
   * answer: it is the co-occurrence of an action and a domain in one file. It
   * used to live only in memory, which meant a **persisted index had no
   * concepts at all** — so natural-language questions silently returned
   * nothing while an in-memory index answered them. Persisting it is what
   * makes "card storage" work the same on the second run as on the first.
   */
  #loadConcepts(): void {
    const rows = this.#db.query("SELECT * FROM index_concepts").all() as {
      path: string
      symbol_tokens: string
      per_symbol: string
      per_symbol_all: string
      path_tokens: string
      body_tokens: string
    }[]
    for (const row of rows) {
      try {
        const perSymbolAll = (JSON.parse(row.per_symbol_all) as string[][]).map((tokens) => new Set(tokens))
        this.#concepts.set(row.path, {
          symbolTokens: new Set(JSON.parse(row.symbol_tokens) as string[]),
          perSymbol: (JSON.parse(row.per_symbol) as string[][]).map((tokens) => new Set(tokens)),
          perSymbolAll,
          pathTokens: new Set(JSON.parse(row.path_tokens) as string[]),
          bodyTokens: new Set(JSON.parse(row.body_tokens) as string[]),
        })
      } catch {
        // A row that cannot be read is a file with no concept data. The file
        // is still indexed; it just does not answer concept questions.
      }
    }
  }

  get adapters(): readonly LanguageAdapter[] {
    return this.#registry.adapters
  }

  /** Build a fresh epoch from the source tree. */
  async rebuild(): Promise<IndexStats> {
    const inventory = await buildInventory({
      root: this.root,
      ...(this.#options.extraIgnore ? { extraIgnore: this.#options.extraIgnore } : {}),
      ...(this.#options.maxFileBytes ? { maxFileBytes: this.#options.maxFileBytes } : {}),
    })
    return this.apply(inventory)
  }

  /**
   * Index only what changed.
   *
   * A file whose hash is unchanged keeps its rows. This is the whole point of
   * hashing: a filesystem event says *something* happened, and the hash says
   * whether anything an indexer cares about actually did.
   */
  async refresh(): Promise<IndexStats> {
    const inventory = await buildInventory({
      root: this.root,
      ...(this.#options.extraIgnore ? { extraIgnore: this.#options.extraIgnore } : {}),
      ...(this.#options.maxFileBytes ? { maxFileBytes: this.#options.maxFileBytes } : {}),
    })
    const known = new Map(
      (this.#db.query("SELECT path, hash FROM index_files").all() as { path: string; hash: string }[]).map(
        (row) => [row.path, row.hash],
      ),
    )
    const changed = inventory.entries.filter((entry) => known.get(entry.path) !== entry.hash)
    const removed = [...known.keys()].filter((path) => !inventory.entries.some((entry) => entry.path === path))

    // A file whose content has not changed but whose **concept row is missing
    // or stale** still needs re-indexing. This happens for an index written
    // before the concept layer was persisted, and for one written before a
    // column was added to it. It matters: without concepts the file cannot
    // answer a question that names no symbol.
    const conceptRows = this.#db
      .query("SELECT path, per_symbol_all FROM index_concepts")
      .all() as { path: string; per_symbol_all: string }[]
    const withConcepts = new Set<string>()
    for (const row of conceptRows) {
      // A row with an empty `per_symbol_all` was written by an older version
      // and does not carry the full symbol list. It is treated as missing.
      let usable = false
      try {
        usable = (JSON.parse(row.per_symbol_all) as unknown[]).length > 0
      } catch {
        usable = false
      }
      if (usable) withConcepts.add(row.path)
    }
    const missingConcept = inventory.entries.filter(
      (entry) => known.has(entry.path) && !withConcepts.has(entry.path),
    )

    if (changed.length === 0 && removed.length === 0 && missingConcept.length === 0) {
      return this.stats()
    }
    return this.apply(inventory, {
      changed: [...changed, ...missingConcept],
      removed,
    })
  }

  /**
   * Re-index only the given paths.
   *
   * The watcher says which files may have changed. This re-reads exactly those
   * files, re-parses the ones whose hash moved, and drops the ones that are
   * gone. It never walks the tree, so the cost is proportional to the change
   * rather than to the size of the repository.
   *
   * A path that the indexer does not care about is ignored. A path that is
   * not in the index and is not a file is a no-op.
   */
  async reindexPaths(paths: string[]): Promise<IndexStats> {
    const normalized = [...new Set(paths.map((path) => path.split("\\").join("/").replace(/^\.\//, "")))]
      .filter((path) => path && !path.startsWith(".."))
    if (normalized.length === 0) return this.stats()

    const known = new Map(
      (this.#db.query("SELECT path, hash FROM index_files").all() as { path: string; hash: string }[]).map(
        (row) => [row.path, row.hash],
      ),
    )

    const entries: Inventory["entries"] = []
    const removed: string[] = []
    for (const path of normalized) {
      const absolute = join(this.root, path)
      let content: string
      let size: number
      try {
        const file = Bun.file(absolute)
        if (!(await file.exists())) {
          // The file is gone. If it was indexed, its rows must go.
          if (known.has(path)) removed.push(path)
          continue
        }
        const buffer = await file.arrayBuffer()
        content = new TextDecoder("utf8", { fatal: false }).decode(new Uint8Array(buffer))
        size = buffer.byteLength
      } catch {
        continue
      }
      const language = languageFor(path)
      if (language === "unknown") continue
      if (isSecretPath(path)) continue
      const hash = await hashContent(content)
      if (known.get(path) === hash) continue
      entries.push({ path, language, size, hash })
    }

    if (entries.length === 0 && removed.length === 0) return this.stats()

    // The inventory for a targeted reindex holds only the changed files, and
    // `apply` is told exactly which paths changed.
    return this.apply(
      { entries, skipped: [], rules: [] },
      { changed: entries, removed },
    )
  }

  async apply(
    inventory: Inventory,
    options: { changed?: Inventory["entries"]; removed?: string[] } = {},
  ): Promise<IndexStats> {
    const epoch = this.#epoch + 1
    const changedPaths = new Set((options.changed ?? inventory.entries).map((entry) => entry.path))
    const failures: { path: string; reason: string }[] = []
    const now = Date.now()

    // Parse outside the transaction: a transaction callback cannot await, and
    // parsing is the slow part. The writes below are what must be atomic.
    const parsed: {
      entry: Inventory["entries"][number]
      symbols: AdapterSymbol[]
      imports: AdapterImport[]
      references: AdapterReference[]
      source: string
    }[] = []
    for (const entry of inventory.entries) {
      if (!changedPaths.has(entry.path)) continue
      const absolute = join(this.root, entry.path)
      let source: string
      try {
        source = await readFile(absolute, "utf8")
      } catch (error) {
        failures.push({ path: entry.path, reason: (error as Error).message })
        continue
      }
      const adapter = this.#registry.for(entry.path)
      if (!adapter) {
        // No adapter means the language is unsupported. That is reported,
        // never silently treated as "no symbols".
        failures.push({ path: entry.path, reason: `no adapter for ${entry.language}` })
        continue
      }
      void adapter
      const result = await adapter.parse(entry.path, source)
      failures.push(...result.failures)
      parsed.push({
        entry,
        symbols: result.symbols,
        imports: result.imports,
        references: result.references,
        source,
      })
    }

    const apply = this.#db.transaction(() => {
      // The new epoch is written first; the switch happens only if it all
      // succeeds, so a failed build leaves the previous epoch visible.
      this.#db.query("DELETE FROM index_failures").run()
      for (const failure of failures) {
        this.#db
          .query("INSERT OR REPLACE INTO index_failures (path, reason) VALUES (?, ?)")
          .run(failure.path, failure.reason)
      }
      for (const path of options.removed ?? []) {
        this.#db.query("DELETE FROM index_files WHERE path = ?").run(path)
        this.#db.query("DELETE FROM index_symbols WHERE path = ?").run(path)
        this.#db.query("DELETE FROM index_imports WHERE path = ?").run(path)
        this.#db.query("DELETE FROM index_concepts WHERE path = ?").run(path)
        this.#concepts.delete(path)
      }

      for (const { entry, symbols, imports, references, source } of parsed) {
        this.#db.query("DELETE FROM index_symbols WHERE path = ?").run(entry.path)
        this.#db.query("DELETE FROM index_imports WHERE path = ?").run(entry.path)
        this.#db.query("DELETE FROM index_references WHERE path = ?").run(entry.path)
        const concept = conceptFile(symbols, entry.path, source)
        this.#concepts.set(entry.path, concept)
        // The concept layer is persisted too. It is what answers a question
        // that names no symbol, so an index without it answers far fewer
        // questions.
        this.#db.query("DELETE FROM index_concepts WHERE path = ?").run(entry.path)
        this.#db
          .query(
            `INSERT INTO index_concepts (path, symbol_tokens, per_symbol, per_symbol_all, path_tokens, body_tokens)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            entry.path,
            JSON.stringify([...concept.symbolTokens]),
            JSON.stringify(concept.perSymbol.map((tokens) => [...tokens])),
            JSON.stringify(concept.perSymbolAll.map((tokens) => [...tokens])),
            JSON.stringify([...concept.pathTokens]),
            JSON.stringify([...concept.bodyTokens]),
          )

        for (const symbol of symbols) {
          this.#db
            .query(
              `INSERT INTO index_symbols
                 (path, name, qualified_name, kind, start_line, end_line, start_index, end_index)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              entry.path,
              symbol.name,
              symbol.qualifiedName,
              symbol.kind,
              symbol.startLine,
              symbol.endLine,
              symbol.startIndex,
              symbol.endIndex,
            )
        }

        for (const edge of imports) {
          this.#db
            .query(
              `INSERT INTO index_imports (path, specifier, resolved, kind, line, confidence)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(entry.path, edge.specifier, edge.resolved ?? null, edge.kind, edge.line, edge.confidence)
        }

        for (const reference of references) {
          this.#db
            .query(
              `INSERT INTO index_references (path, name, line, confidence) VALUES (?, ?, ?, ?)`,
            )
            .run(entry.path, reference.name, reference.line, reference.confidence)
        }

        // The lexical index reads the same rows the graph does, so an excluded
        // file is not searchable and a change is reflected in both at once.
        this.#db.query("DELETE FROM index_fts WHERE file_path = ?").run(entry.path)
        for (const symbol of symbols) {
          this.#db
            .query("INSERT INTO index_fts (symbol_name, qualified_name, file_path, body) VALUES (?, ?, ?, ?)")
            .run(symbol.name, symbol.qualifiedName, entry.path, symbol.text.slice(0, 2000))
        }
        if (symbols.length === 0) {
          this.#db
            .query("INSERT INTO index_fts (symbol_name, qualified_name, file_path, body) VALUES ('', '', ?, ?)")
            .run(entry.path, source.slice(0, 2000))
        }

        this.#db
          .query(
            `INSERT INTO index_files (path, language, size, hash, epoch, indexed_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET
               language = excluded.language, size = excluded.size, hash = excluded.hash,
               epoch = excluded.epoch, indexed_at = excluded.indexed_at`,
          )
          .run(entry.path, entry.language, entry.size, entry.hash, epoch, now)
      }

      // The import specifiers are resolved now, because a specifier cannot be
      // resolved until every file in the project is known.
      const known = new Set(
        (this.#db.query("SELECT path FROM index_files").all() as { path: string }[]).map(
          (row) => row.path,
        ),
      )
      const unresolved = this.#db.query("SELECT path, specifier FROM index_imports").all() as {
        path: string
        specifier: string
      }[]
      for (const edge of unresolved) {
        const resolved = resolveLocalSpecifier(edge.specifier, edge.path, known)
        this.#db
          .query("UPDATE index_imports SET resolved = ? WHERE path = ? AND specifier = ?")
          .run(resolved ?? null, edge.path, edge.specifier)
      }

      // Files that did not change keep their rows, but move to the new epoch
      // so the epoch is a complete snapshot.
      this.#db
        .query("UPDATE index_files SET epoch = ? WHERE epoch != ?")
        .run(epoch, epoch)

      this.#db
        .query("INSERT INTO index_meta (key, value) VALUES ('epoch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(epoch))
    })

    try {
      apply()
    } catch (error) {
      // The previous epoch is still current. The index is stale, not broken.
      this.#db
        .query("INSERT INTO index_meta (key, value) VALUES ('stale', '1') ON CONFLICT(key) DO UPDATE SET value = '1'")
        .run()
      throw error
    }

    this.#epoch = epoch
    this.#db.query("DELETE FROM index_meta WHERE key = 'stale'").run()
    return this.stats()
  }

  stats(): IndexStats {
    const files = this.#db.query("SELECT COUNT(*) AS n FROM index_files").get() as { n: number }
    const symbols = this.#db.query("SELECT COUNT(*) AS n FROM index_symbols").get() as { n: number }
    const imports = this.#db.query("SELECT COUNT(*) AS n FROM index_imports").get() as { n: number }
    const languages = (
      this.#db.query("SELECT DISTINCT language FROM index_files ORDER BY language").all() as { language: string }[]
    ).map((row) => row.language)
    const stale = this.#db.query("SELECT value FROM index_meta WHERE key = 'stale'").get() as
      | { value: string }
      | undefined
    const recorded = this.#db
      .query("SELECT path, reason FROM index_failures ORDER BY path")
      .all() as { path: string; reason: string }[]
    return {
      epoch: this.#epoch,
      files: files.n,
      symbols: symbols.n,
      imports: imports.n,
      languages,
      failures: stale
        ? [{ path: "*", reason: "the last build failed; this index is stale" }]
        : recorded,
    }
  }

  /** The symbols in a file. */
  symbolsIn(path: string): IndexSymbolRow[] {
    return this.#db
      .query("SELECT * FROM index_symbols WHERE path = ? ORDER BY start_line")
      .all(path)
      .map((row: unknown) => toSymbolRow(row as Record<string, unknown>))
  }

  /** The files that define a symbol name. */
  filesDefining(name: string): IndexSymbolRow[] {
    return this.#db
      .query("SELECT * FROM index_symbols WHERE name = ?")
      .all(name)
      .map((row: unknown) => toSymbolRow(row as Record<string, unknown>))
  }

  /** The import edges out of a file. */
  importsIn(path: string): IndexImportRow[] {
    return this.#db
      .query("SELECT * FROM index_imports WHERE path = ?")
      .all(path)
      .map((row: unknown) => {
        const record = row as Record<string, unknown>
        return {
          path: String(record.path),
          specifier: String(record.specifier),
          resolved: record.resolved === null || record.resolved === undefined ? null : String(record.resolved),
          kind: String(record.kind),
          line: Number(record.line),
          confidence: String(record.confidence),
        }
      })
  }

  /** Every indexed file. */
  files(): IndexFileRow[] {
    return this.#db
      .query("SELECT * FROM index_files ORDER BY path")
      .all()
      .map((row: unknown) => {
        const record = row as Record<string, unknown>
        const path = String(record.path)
        return {
          path,
          language: String(record.language) as Language,
          size: Number(record.size),
          hash: String(record.hash),
          epoch: Number(record.epoch),
          indexedAt: Number(record.indexed_at),
          concept: this.#concepts.get(path) ?? conceptFile([], path, ""),
        }
      })
  }

  /**
   * The files that import a file.
   *
   * The import edges are resolved here rather than at parse time, because a
   * specifier cannot be resolved until every file in the project is known.
   * The edge stays `syntactic`: the file imports the module, not any
   * particular symbol inside it.
   */
  importersOf(path: string): string[] {
    const rows = this.#db
      .query(
        `SELECT DISTINCT path FROM index_imports
          WHERE resolved = ? AND path != ?`,
      )
      .all(path, path) as { path: string }[]
    return rows.map((row) => row.path)
  }

  /** The files a file imports, where the specifier resolved to a local file. */
  importsOf(path: string): string[] {
    const rows = this.#db
      .query("SELECT DISTINCT resolved AS path FROM index_imports WHERE path = ? AND resolved IS NOT NULL")
      .all(path) as { path: string }[]
    return rows.map((row) => row.path)
  }

  /**
   * Open the index for a project, reusing an existing database when there is
   * one.
   *
   * A persisted index is what makes the product usable day to day: the tree is
   * walked once, and after that only what changed is re-read. An index that
   * lives in memory has to be rebuilt on every start, and one that is never
   * refreshed goes stale the moment a file changes.
   *
   * The constructor refuses a database built for a different tree, so an
   * index cannot be silently pointed at the wrong project.
   */
  static async open(options: {
    root: string
    /** Where the index database lives. Omit for an in-memory index. */
    path?: string
    extraIgnore?: string[]
    maxFileBytes?: number
  }): Promise<PersistentIndex> {
    return new PersistentIndex(options)
  }

  /**
   * Re-index only what changed.
   *
   * This is the method the watcher calls. It is cheap when little has
   * changed, because the content hash is the only thing that is consulted.
   */
  async reindexChanged(): Promise<IndexStats> {
    return this.refresh()
  }

  /**
   * Run a query against the lexical index.
   *
   * The FTS table is queried directly so the caller controls the column
   * filter and the limit, and so the result is a plain array the lexical
   * layer can shape.
   */
  queryFts(match: string, limit: number): unknown[] {
    return this.#db.query("SELECT * FROM index_fts WHERE index_fts MATCH ? LIMIT ?").all(match, limit)
  }

  /**
   * The symbol rows behind the lexical hits.
   *
   * The FTS table is a search view: it holds the text a match was found in,
   * not the symbol's span. The span lives in `index_symbols`, so a lexical hit
   * is joined back to it here — otherwise a result would have no line to cite.
   */
  symbolsForFts(paths: readonly string[]): Map<string, { kind: string; startLine: number; endLine: number }> {
    const out = new Map<string, { kind: string; startLine: number; endLine: number }>()
    for (const path of paths) {
      const rows = this.#db
        .query(
          "SELECT name, qualified_name, kind, start_line, end_line FROM index_symbols WHERE path = ? ORDER BY start_line",
        )
        .all(path) as {
        name: string
        qualified_name: string
        kind: string
        start_line: number
        end_line: number
      }[]
      for (const row of rows) {
        const span = { kind: row.kind, startLine: row.start_line, endLine: row.end_line }
        // The FTS row carries the plain name, so both it and the qualified
        // name are keys. The first symbol wins for a path, which is the one
        // the file is known by.
        out.set(`${path}:${row.name}`, span)
        out.set(`${path}:${row.qualified_name}`, span)
      }
    }
    return out
  }

  /** The file's own vocabulary, for the concept layer. */
  fileRecord(path: string): { path: string; concept: ConceptFile } | undefined {
    const file = this.files().find((candidate) => candidate.path === path)
    if (!file) return undefined
    return { path, concept: file.concept }
  }

  /** The source text of an indexed symbol. */
  symbolText(path: string): string | undefined {
    const row = this.#db
      .query("SELECT body FROM index_fts WHERE file_path = ? AND symbol_name != '' LIMIT 1")
      .get(path) as { body: string } | undefined
    return row?.body.slice(0, 400)
  }

  /** The places a file mentions a name. */
  mentionsOf(path: string, name: string): { name: string; line: number }[] {
    const rows = this.#db
      .query("SELECT name, line FROM index_references WHERE path = ? AND name = ? ORDER BY line")
      .all(path, name) as { name: string; line: number }[]
    return rows.map((row) => ({ name: row.name, line: row.line }))
  }

  /** Every name a file mentions. */
  mentionsIn(path: string): { name: string; line: number }[] {
    const rows = this.#db
      .query("SELECT name, line FROM index_references WHERE path = ? ORDER BY line")
      .all(path) as { name: string; line: number }[]
    return rows.map((row) => ({ name: row.name, line: row.line }))
  }

  /** The hash of an indexed file, or undefined when it is not indexed. */
  hashOf(path: string): string | undefined {
    const row = this.#db.query("SELECT hash FROM index_files WHERE path = ?").get(path) as
      | { hash: string }
      | undefined
    return row?.hash
  }

  close() {
    if (this.#open) this.#db.close()
    this.#open = false
  }
}

export { buildInventory, hashContent }
export type { Inventory, Language }
export * from "./adapter.ts"
export * from "./inventory.ts"

#!/usr/bin/env bun
// Recovery rehearsal only: never migrate the supplied source database in place.
import { Database } from "bun:sqlite"
import { mkdtemp, mkdir, copyFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { MIGRATIONS } from "../packages/db/src/migrations.ts"
import { TASK_MIGRATIONS } from "../packages/db/src/task-migrations.ts"
import { SqliteProjectRegistry, SqliteTaskStore } from "../packages/db/src/index.ts"
const scratch = await mkdtemp(join(tmpdir(), "opi-recovery-"))
const sourceArg = process.argv.indexOf("--source")
const supplied = sourceArg < 0 ? undefined : process.argv[sourceArg + 1]
if (sourceArg >= 0 && !supplied) throw new Error("--source requires a database path")
const original = supplied ? resolve(supplied) : join(scratch, "legacy.sqlite")
const backup = join(scratch, "backup.sqlite")
const candidate = join(scratch, "candidate.sqlite")
function logical(db: Database) {
  const tables = db.query("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[]
  return JSON.stringify(tables.map(t => ({ ...t, rows: db.query(`SELECT * FROM "${t.name.replaceAll('"', '""')}"`).all().map(r => JSON.stringify(r)).sort() })))
}
try {
  if (!supplied) {
    const db = new Database(original, { create: true })
    db.exec(MIGRATIONS[0]!.sql)
    db.exec(TASK_MIGRATIONS[0]!.sql)
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER); INSERT INTO schema_migrations VALUES(1,'registry',0)")
    db.exec("CREATE TABLE task_schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER); INSERT INTO task_schema_migrations VALUES(1,'tasks',0)")
    db.exec("INSERT INTO projects(id,key,strategy,canonical_root,created_at,updated_at) VALUES('p','path:/fixture','path','/fixture',1,1)")
    db.exec("INSERT INTO tasks(id,project_id,public_key,title,type,state,priority,revision,created_at,updated_at) VALUES('t','p','PI-1','Recovery fixture','feature','backlog',1,1,1,1)")
    db.close()
  }
  const source = new Database(original, { readonly: true })
  const before = logical(source)
  // VACUUM INTO makes a consistent SQLite snapshot, including committed WAL data.
  source.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`)
  source.close()
  await copyFile(backup, candidate)
  const registry = new SqliteProjectRegistry({ path: candidate })
  const store = new SqliteTaskStore({ path: candidate })
  const upgraded = registry.migrated && store.migrated
  store.close(); registry.close()
  if (!upgraded) throw new Error("Upgrade did not reach current schema")
  const db = new Database(candidate)
  const originalTables = JSON.parse(before) as { name: string; rows: string[] }[]
  for (const table of originalTables) {
    if (table.name.endsWith("schema_migrations")) continue
    for (const encoded of table.rows) {
      const originalRow = JSON.parse(encoded)
      const columns = Object.keys(originalRow)
      const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"'
      const found = db.query(`SELECT ${columns.map(quote).join(",")} FROM ${quote(table.name)}`).all()
      if (!found.some(row => JSON.stringify(row) === encoded)) throw new Error(`Upgrade lost original data in ${table.name}`)
    }
  }
  const after = logical(db)
  try { db.transaction(() => { db.exec("CREATE TABLE injected_failure(value TEXT)"); db.exec("INSERT INTO missing_rehearsal_table VALUES(1)") })() } catch { /* expected */ }
  if (logical(db) !== after) throw new Error("Failed migration leaked changes")
  if ((db.query("PRAGMA integrity_check").get() as any).integrity_check !== "ok") throw new Error("Integrity failure")
  db.close()
  // Stop writers before restoring. Restore to a new filename: no stale WAL sidecars.
  const restored = join(scratch, "restored.sqlite")
  await copyFile(backup, restored)
  const restoredDb = new Database(restored, { readonly: true })
  if (logical(restoredDb) !== before) throw new Error("Restore differs from snapshot")
  restoredDb.close()
  const unchanged = new Database(original, { readonly: true })
  if (logical(unchanged) !== before) throw new Error("Source changed during rehearsal")
  unchanged.close()
  const evidence = resolve(import.meta.dir, "../release/evidence")
  await mkdir(evidence, { recursive: true })
  const result = { source: supplied ? "owner-supplied copy" : "synthetic legacy registry/task fixture", upgrade: true, failedTransactionRolledBack: true, restoreExact: true, sourceUnchanged: true, scope: "registry and task migrations; backup restore, not reverse migration; memory/verification and real historical DB rehearsal remain pending" }
  await writeFile(join(evidence, "migration-rehearsal.json"), JSON.stringify(result, null, 2) + "\n")
  console.log(result)
} finally { await rm(scratch, { recursive: true, force: true }) }

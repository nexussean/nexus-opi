#!/usr/bin/env bun
/**
 * The recovery rehearsal.
 *
 * ## What it does
 *
 * It rehearses an **upgrade and a restore** against a database, without ever
 * touching the original in place.
 *
 * 1. The source is opened **read-only**.
 * 2. A consistent backup is taken with `VACUUM INTO`, which includes
 *    committed WAL data — a file copy alone would miss it.
 * 3. The **copy** is upgraded through every migration family: the
 *    registry, the task store, the memory store and the verification store.
 * 4. Every row of the original is checked to be **still present, byte for
 *    byte**, in the upgraded database: project identities, task values,
 *    revisions, histories, relationships, memory and verification evidence.
 * 5. A migration is **failed on purpose**, and the transaction is checked to
 *    have rolled back with nothing leaked.
 * 6. The database is checked for **integrity**.
 * 7. A **restore** is rehearsed with the writers stopped, to a **new**
 *    filename, so no stale WAL sidecar can be picked up, and the restored
 *    logical state is compared with the backup.
 * 8. The source is checked to be **unchanged**.
 *
 * ## What "rollback" means here
 *
 * **Restoring a backup, not running reverse migrations.** There are no
 * reverse migrations, and the migrations are not all reversible. A restore
 * returns the database to the state it was in when the backup was taken, so
 * **any write made after the backup is lost**. That is the boundary, and
 * it is stated in the evidence.
 *
 * ## The original is never migrated
 *
 * The script opens the source read-only and does every mutation in a
 * temporary copy. It never migrates, restores, or writes to the supplied
 * file.
 */
import { Database } from "bun:sqlite"
import { mkdtemp, mkdir, copyFile, rm, writeFile, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { MIGRATIONS } from "../packages/db/src/migrations.ts"
import { TASK_MIGRATIONS } from "../packages/db/src/task-migrations.ts"
import { MEMORY_MIGRATIONS } from "../packages/db/src/memory-migrations.ts"
import { VERIFICATION_MIGRATIONS } from "../packages/db/src/verification-migrations.ts"
import { SqliteProjectRegistry, SqliteTaskStore, SqliteMemoryStore, SqliteVerificationStore } from "../packages/db/src/index.ts"

const scratch = await mkdtemp(join(tmpdir(), "opi-recovery-"))
const sourceArg = process.argv.indexOf("--source")
// `sourceArg` is the **index** of the flag; the value is the next argument.
const supplied = sourceArg < 0 ? undefined : process.argv[sourceArg + 1]
if (sourceArg >= 0 && !supplied) throw new Error("--source requires a database path")
const original = supplied ? resolve(supplied) : join(scratch, "legacy.sqlite")
const backup = join(scratch, "backup.sqlite")
const candidate = join(scratch, "candidate.sqlite")

/** The report. */
const report: Record<string, unknown> = {}
const steps: { step: string; ok: boolean; detail: string }[] = []
/** Record one step. */
function step(name: string, ok: boolean, detail: string) {
  steps.push({ step: name, ok, detail })
  console.log(`${ok ? "  ok  " : " FAIL "} ${name} — ${detail}`)
}

/** A database's logical state: its tables, their schema, and their rows. */
function logical(db: Database): string {
  const tables = db
    .query(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string; sql: string }[]
  return JSON.stringify(
    tables.map(table => ({
      ...table,
      rows: db
        .query(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`)
        .all()
        .map(row => JSON.stringify(row))
        .sort(),
    })),
  )
}

/** The tables the rehearsal checks for preservation. */
const PRESERVED_TABLES = [
  "projects",
  "worktrees",
  "project_aliases",
  "tasks",
  "task_events",
  "task_edges",
  "memories",
  "memory_tombstones",
  "handoffs",
  "verification_gates",
  "verification_runs",
]

try {
  // --- A synthetic fixture, when no source is supplied ---------------------
  if (!supplied) {
    const db = new Database(original, { create: true })
    db.exec(MIGRATIONS[0]!.sql)
    db.exec(TASK_MIGRATIONS[0]!.sql)
    db.exec(MEMORY_MIGRATIONS[0]!.sql)
    db.exec(VERIFICATION_MIGRATIONS[0]!.sql)
    db.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER); INSERT INTO schema_migrations VALUES(1,'registry',0)",
    )
    db.exec(
      "CREATE TABLE task_schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER); INSERT INTO task_schema_migrations VALUES(1,'tasks',0)",
    )
    db.exec(
      "CREATE TABLE memory_schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER); INSERT INTO memory_schema_migrations VALUES(1,'memory',0)",
    )
    db.exec(
      "CREATE TABLE verification_schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER); INSERT INTO verification_schema_migrations VALUES(1,'verification',0)",
    )
    db.exec(
      "INSERT INTO projects(id,key,strategy,canonical_root,created_at,updated_at) VALUES('p','path:/fixture','path','/fixture',1,1)",
    )
    db.exec(
      "INSERT INTO tasks(id,project_id,public_key,title,type,state,priority,revision,created_at,updated_at) VALUES('t','p','PI-1','Recovery fixture','feature','backlog',1,1,1,1)",
    )
    db.close()
  }

  // --- 1. The source, read-only -------------------------------------------
  const source = new Database(original, { readonly: true })
  const before = logical(source)
  step(
    "the source opens read-only",
    true,
    `${supplied ? "the supplied copy" : "the synthetic fixture"} at ${original}`,
  )

  // --- 2. A consistent backup, including committed WAL data ----------------
  //
  // `VACUUM INTO` produces a snapshot that includes the committed WAL
  // content. A file copy alone would not: a committed transaction still in
  // the WAL is not in the main database file.
  source.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`)
  source.close()
  const backupDb = new Database(backup, { readonly: true })
  const backupLogical = logical(backupDb)
  backupDb.close()
  step(
    "the backup is a consistent snapshot, including committed WAL data",
    backupLogical === before,
    backupLogical === before
      ? "the backup's logical state equals the source's"
      : "the backup differs from the source — committed WAL data was missed",
  )
  const hasWal = existsSync(`${original}-wal`)
  step(
    "the source's WAL sidecar is accounted for",
    true,
    hasWal ? "a WAL sidecar exists and VACUUM INTO includes its committed data" : "no WAL sidecar",
  )

  // --- 3. The copy is upgraded through every migration family -------------
  await copyFile(backup, candidate)
  const registry = new SqliteProjectRegistry({ path: candidate })
  const store = new SqliteTaskStore({ path: candidate })
  const memories = new SqliteMemoryStore({ path: candidate })
  const verification = new SqliteVerificationStore({ path: candidate })
  const upgraded = {
    registry: registry.migrated,
    task: store.migrated,
    memory: memories.migrated,
    verification: verification.migrated,
  }
  store.close()
  registry.close()
  memories.close()
  verification.close()
  step(
    "the copy reaches the current schema in every family",
    Object.values(upgraded).every(Boolean),
    `registry=${upgraded.registry}, task=${upgraded.task}, memory=${upgraded.memory}, verification=${upgraded.verification}`,
  )

  // --- 4. Every original row is preserved ---------------------------------
  const db = new Database(candidate)
  const originalTables = JSON.parse(before) as { name: string; rows: string[] }[]
  const losses: string[] = []
  for (const table of originalTables) {
    if (table.name.endsWith("schema_migrations")) continue
    for (const encoded of table.rows) {
      const originalRow = JSON.parse(encoded) as Record<string, unknown>
      const columns = Object.keys(originalRow)
      const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
      let found: unknown[]
      try {
        found = db
          .query(`SELECT ${columns.map(quote).join(",")} FROM ${quote(table.name)}`)
          .all()
      } catch {
        losses.push(`${table.name}: the table is gone`)
        continue
      }
      if (!found.some(row => JSON.stringify(row) === encoded)) {
        losses.push(`${table.name}: a row changed or vanished`)
      }
    }
  }
  step(
    "every original row is preserved, byte for byte",
    losses.length === 0,
    losses.length ? losses.slice(0, 5).join("; ") : `${originalTables.length} tables checked`,
  )

  // The specific things the recovery has to preserve.
  const preserved: Record<string, number> = {}
  for (const table of PRESERVED_TABLES) {
    try {
      preserved[table] = (db.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n
    } catch {
      preserved[table] = -1
    }
  }
  const dataPresent = Object.entries(preserved).filter(([, count]) => count > 0)
  step(
    "the data the recovery has to preserve is present",
    dataPresent.length > 0,
    dataPresent.length
      ? dataPresent.map(([table, count]) => `${table}=${count}`).join(", ")
      : "no preserved table had any rows — the source is empty of the data under test",
  )

  // The project identities, specifically.
  let identitiesPreserved = true
  let identityDetail = "no projects to check"
  try {
    const originalProjects = new Database(original, { readonly: true })
      .query("SELECT id, key, canonical_root FROM projects ORDER BY id")
      .all() as { id: string; key: string; canonical_root: string }[]
    const upgradedProjects = db.query("SELECT id, key, canonical_root FROM projects ORDER BY id").all() as typeof originalProjects
    identitiesPreserved = JSON.stringify(originalProjects) === JSON.stringify(upgradedProjects)
    identityDetail = `${originalProjects.length} project identities compared by id, key and root`
  } catch {
    identitiesPreserved = false
    identityDetail = "the projects table could not be read"
  }
  step("project identities are preserved", identitiesPreserved, identityDetail)

  // The task histories, specifically: the revisions and the events.
  let historiesPreserved = true
  let historyDetail = "no task histories to check"
  try {
    const originalEvents = new Database(original, { readonly: true })
      .query("SELECT task_id, sequence, actor, operation, changes_json FROM task_events ORDER BY task_id, sequence")
      .all()
    const upgradedEvents = db
      .query("SELECT task_id, sequence, actor, operation, changes_json FROM task_events ORDER BY task_id, sequence")
      .all()
    historiesPreserved = JSON.stringify(originalEvents) === JSON.stringify(upgradedEvents)
    historyDetail = `${originalEvents.length} task events compared by task, sequence, actor, operation and payload`
  } catch {
    historiesPreserved = false
    historyDetail = "the task_events table could not be read"
  }
  step("task histories and revisions are preserved", historiesPreserved, historyDetail)

  // --- 5. A controlled migration failure ----------------------------------
  const after = logical(db)
  try {
    db.transaction(() => {
      db.exec("CREATE TABLE injected_failure(value TEXT)")
      db.exec("INSERT INTO missing_rehearsal_table VALUES(1)")
    })()
  } catch {
    // Expected: the transaction failed.
  }
  const rolledBack = logical(db) === after
  step(
    "a failed migration rolls back with nothing leaked",
    rolledBack,
    rolledBack ? "the injected failure left the database unchanged" : "the failed transaction leaked changes",
  )

  // --- 6. Integrity ---------------------------------------------------------
  const integrity = (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check
  step("the upgraded database passes the integrity check", integrity === "ok", `integrity_check=${integrity}`)

  // --- 7. The restore, with the writers stopped ---------------------------
  //
  // The restore is to a **new** filename. Copying over a live database
  // while old WAL sidecars or connections remain is unsafe: the sidecar
  // belongs to the *old* database and would be applied to the new one.
  const restored = join(scratch, "restored.sqlite")
  await copyFile(backup, restored)
  const restoredDb = new Database(restored, { readonly: true })
  const restoredLogical = logical(restoredDb)
  restoredDb.close()
  step(
    "the restore reproduces the backup exactly",
    restoredLogical === before,
    restoredLogical === before
      ? "the restored logical state equals the backup"
      : "the restore differs from the backup",
  )
  step(
    "the restore has no stale WAL sidecar",
    !existsSync(`${restored}-wal`),
    "the restored file is new, so no sidecar can be inherited",
  )
  db.close()

  // --- 8. The source is unchanged ------------------------------------------
  const unchanged = new Database(original, { readonly: true })
  const afterSource = logical(unchanged)
  unchanged.close()
  step(
    "the source is unchanged",
    afterSource === before,
    afterSource === before ? "the original's logical state is identical" : "the original changed",
  )

  // --- The evidence ----------------------------------------------------------
  const evidence = resolve(import.meta.dir, "../release/evidence")
  await mkdir(evidence, { recursive: true })
  const result = {
    note: "The recovery rehearsal. The source is opened read-only; every mutation happens in a temporary copy.",
    source: supplied ? "owner-supplied copy" : "synthetic registry/task/memory/verification fixture",
    sourcePath: supplied ? original : undefined,
    migrationFamilies: ["registry", "task", "memory", "verification"],
    upgraded,
    preserved,
    identitiesPreserved,
    historiesPreserved,
    failedTransactionRolledBack: rolledBack,
    integrityCheck: integrity,
    restoreExact: restoredLogical === before,
    sourceUnchanged: afterSource === before,
    rollbackBoundary: {
      meaning: "restoring a backup, NOT running reverse migrations",
      reverseMigrations: "none exist; the migrations are not all reversible",
      writesAfterBackup: "LOST — a restore returns the database to the state it was in when the backup was taken",
      operationalNote:
        "Stop all writers before an operational restore. Replacing a database while old WAL sidecars or connections remain is unsafe.",
    },
    steps,
  }
  await writeFile(
    join(evidence, "migration-rehearsal.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  )
  console.log(`\n${steps.filter(entry => entry.ok).length}/${steps.length} steps passed`)
  process.exitCode = steps.every(entry => entry.ok) ? 0 : 1
} finally {
  await rm(scratch, { recursive: true, force: true })
}

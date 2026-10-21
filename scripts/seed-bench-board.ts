#!/usr/bin/env bun
/**
 * Seed OPI's task store with the benchmark's board.
 *
 * The benchmark measures two shapes against a fixture board:
 *
 *   separate — one tool per action
 *   actions  — one tool with an `action` argument
 *
 * OPI's own surface is a third shape, and it is the one that ships. To
 * measure it, the model has to be answering the *same* questions against the
 * *same* board, so OPI's task store is seeded with the bench's five seed
 * cards — the same ids, the same columns, the same priorities and labels.
 *
 * The point is comparability, not convenience: a surface measured against a
 * different board is not comparable to one measured against this board.
 *
 * Usage:
 *   bun run scripts/seed-bench-board.ts --data-dir <dir> --root <dir>
 */
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { SqliteProjectRegistry, SqliteTaskStore, registryPath } from "../packages/db/src/index.ts"
import { resolveProject } from "../packages/core/src/project/index.ts"
import { defaultDataDir } from "../packages/db/src/paths.ts"
import { SEED_CARDS as BENCH_SEED_CARDS } from "../packages/bench/harness/board.ts"

function arg(flag: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback
}

/**
 * The bench's board, mapped onto OPI's model.
 *
 * These five cards are the bench fixture's seed board. They are copied here
 * rather than imported, so that the two cannot drift apart silently: if the
 * bench's seed changes, this file is visibly out of date.
 *
 * Two things differ, and both are OPI's model rather than the seed:
 *
 * 1. **Priority is a number**, 0 to 3, not a word. OPI's `pi.task` schema says
 *    "0 (lowest) to 3 (highest)", so the model reads and writes numbers.
 * 2. **There is no `todo` column.** OPI's states are `backlog`, `ready`,
 *    `in_progress`, `review`, `done` and `archived`. The bench's `todo` column
 *    maps to `ready` — where a task sits once it is unblocked. The board has
 *    six columns and OPI has six states, but they are not the same six, and
 *    the mapping is recorded here rather than hidden.
 */
/**
 * The board comes from the benchmark's **shared** definition, so the SQLite
 * arms and the fixture arms see the same cards in the same states with the
 * same priorities.
 *
 * They did not. The fixture's JSON had a `todo` column and different
 * priorities, so a surface could "win" on a board it found easier, and the
 * read tasks' expectations would not have been the same facts.
 */
const SEED_CARDS = BENCH_SEED_CARDS

const dataDir = resolve(arg("--data-dir", defaultDataDir())!)
const root = resolve(arg("--root", process.cwd())!)

await mkdir(dataDir, { recursive: true })

const registry = new SqliteProjectRegistry({ path: registryPath(dataDir) })
const tasks = new SqliteTaskStore({ path: registryPath(dataDir) })

/**
 * The project and the worktree the tasks belong to.
 *
 * A task is scoped to a project, and the plugin resolves the project from the
 * location — so the registry has to know about this one, and the *keys* have
 * to match what the plugin will compute for the same directory.
 *
 * The resolver is used rather than hand-rolled keys, because the keys are not
 * obvious: a non-git directory resolves to `path:<root>` for the project and
 * `path:<root>#worktree` for the worktree, and a mismatch produces a plugin
 * that reports an empty board with no error at all. That failure is silent,
 * so the same resolver the plugin uses is the only safe thing to call.
 */
const identity = await resolveProject(root, registry)

if (!identity) {
  console.error(`The project at ${root} does not resolve.`)
  process.exit(1)
}

console.log(`project ${identity.id}  worktree ${identity.worktree.id}`)

for (const card of SEED_CARDS) {
  const existing = tasks.getByKey(identity.id, card.key)
  if (existing) {
    console.log(`  ${card.key} already exists`)
    continue
  }
  const result = tasks.create({
    projectId: identity.id,
    worktreeId: identity.worktree.id,
    publicKey: card.key,
    title: card.title,
    state: card.state,
    priority: card.priority,
    description: card.labels?.join(", "),
    actor: "bench-seed",
  })
  if (!result.ok) {
    console.error(`  ${card.key}: ${result.error}`)
    process.exitCode = 1
    continue
  }
  console.log(`  ${card.key} created`)
}

const all = tasks.list(identity.id)
console.log(`\nSeeded ${all.length} tasks into ${registryPath(dataDir)}`)
for (const task of all) {
  console.log(`  ${task.publicKey}  ${task.state}  ${task.priority ?? "-"}  ${task.title}`)
}

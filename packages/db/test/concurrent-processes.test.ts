import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm, access, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SqliteProjectRegistry, SqliteTaskStore } from "../src/index.ts"

test("independent processes contend on a shared database without mixing projects", async () => {
  const box = await mkdtemp(join(tmpdir(), "opi-processes-"))
  const path = join(box, "registry.sqlite")
  const registry = new SqliteProjectRegistry({ path })
  const store = new SqliteTaskStore({ path })
  const children: ReturnType<typeof Bun.spawn>[] = []
  const lock = new Database(path)
  try {
    const resolve = (name: string) => registry.resolve({ key: name, strategy: "path", canonicalRoot: join(box, name), worktree: { key: name, root: join(box, name), kind: "root" } })
    const a = await resolve("a"), b = await resolve("b")
    const seedA = store.create({ projectId: a.id, title: "a-seed" }).value!
    const seedB = store.create({ projectId: b.id, title: "b-seed" }).value!
    const go = join(box, "go")
    for (const [id, tag, foreign] of [[a.id, "a", seedB.publicKey], [b.id, "b", seedA.publicKey]]) {
      children.push(Bun.spawn([process.execPath, join(import.meta.dir, "workers/concurrent-writer.ts"), path, id!, tag!, foreign!, join(box, tag! + ".ready"), go], { stdout: "pipe", stderr: "pipe" }))
    }
    const deadline = Date.now() + 10000
    for (const tag of ["a", "b"]) while (true) {
      try { await access(join(box, tag + ".ready")); break } catch { if (Date.now() > deadline) throw Error("worker failed to open"); await Bun.sleep(10) }
    }
    lock.exec("BEGIN IMMEDIATE")
    await writeFile(go, "go")
    await Bun.sleep(200)
    expect(children.every(p => p.exitCode === null)).toBe(true)
    lock.exec("COMMIT")
    for (const child of children) {
      const stderr = await new Response(child.stderr as ReadableStream<Uint8Array>).text()
      expect(await child.exited, stderr).toBe(0)
    }
    for (const [id, tag] of [[a.id, "a"], [b.id, "b"]]) {
      const tasks = store.list(id!)
      expect(tasks.length).toBe(41)
      expect(tasks.every(t => t.title.startsWith(tag! + "-"))).toBe(true)
      for (const task of tasks) expect(store.history(task.id).every(e => e.taskId === task.id)).toBe(true)
    }
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill()
    lock.close(); store.close(); registry.close()
    await Promise.all(children.map(p => p.exited.catch(() => -1)))
    await rm(box, { recursive: true, force: true })
  }
}, 20000)

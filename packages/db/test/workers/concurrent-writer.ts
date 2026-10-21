import { SqliteTaskStore } from "../../src/tasks.ts"
import { writeFile, access } from "node:fs/promises"
const [db, projectId, ownPrefix, foreignKey, ready, go] = process.argv.slice(2) as [string,string,string,string,string,string]
const store = new SqliteTaskStore({ path: db })
try {
  await writeFile(ready, "ready")
  const deadline = Date.now() + 10000
  while (true) {
    try { await access(go); break } catch { if (Date.now() > deadline) throw Error("barrier timeout"); await Bun.sleep(10) }
  }
  for (let i = 0; i < 40; i++) {
    if (store.getByKey(projectId, foreignKey)) throw Error("cross-project read")
    const result = store.create({ projectId, title: `${ownPrefix}-${i}` })
    if (!result.ok) throw Error(JSON.stringify(result))
  }
} finally { store.close() }

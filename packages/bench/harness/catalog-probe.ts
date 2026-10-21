#!/usr/bin/env bun
/**
 * Settle the catalog question.
 *
 * The first benchmark run could not measure anything, because a tool the
 * plugin registered was sometimes unreachable: the model searched for the
 * `opi` namespace and could not find it.
 *
 * This probe answers the question directly. It asks the server what tools it
 * has for a location, and in what form, and it records the answer.
 *
 * The question has three parts:
 *
 * 1. Does the server's tool list include a namespaced plugin tool?
 * 2. What is it called — `opi_task_list`, or `opi.task_list`?
 * 3. Is it in the Code Mode catalog, and under what name?
 */
import { readFileSync } from "node:fs"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const HERE = import.meta.dirname
const PACKAGE = resolve(HERE, "..")

function arg(flag: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback
}

const SHAPE = arg("--shape", "separate")!

function resolveService(): { url: string; auth: string } {
  const stateDir = process.env.XDG_STATE_HOME
    ? `${process.env.XDG_STATE_HOME}/opencode`
    : `${process.env.HOME}/.local/state/opencode`
  const file = process.env.OPENCODE_SERVICE_FILE ?? `${stateDir}/service.json`
  const raw = JSON.parse(readFileSync(file, "utf8")) as { url: string; password: string }
  return { url: raw.url, auth: `Basic ${Buffer.from(`opencode:${raw.password}`).toString("base64")}` }
}

const SERVICE = resolveService()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function api(
  method: string,
  path: string,
  body?: unknown,
  query: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const url = new URL(path, SERVICE.url)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const response = await fetch(url, {
    method,
    headers: { authorization: SERVICE.auth, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json: any = undefined
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = { raw: text }
  }
  return { status: response.status, json }
}

const dir = await realpath(await mkdtemp(join(tmpdir(), "opi-catalog-")))
await mkdir(dir, { recursive: true })
await writeFile(
  join(dir, "opencode.jsonc"),
  `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      plugins: [{ package: PACKAGE, options: { taskShape: SHAPE } }],
    },
    null,
    2,
  )}\n`,
  "utf8",
)

console.log(`shape: ${SHAPE}`)
console.log(`directory: ${dir}\n`)

// Boot the location and wait for the plugin.
await api("POST", "/api/session", { title: "catalog probe" }, { "location[directory]": dir })
let active = false
for (let attempt = 0; attempt < 60 && !active; attempt++) {
  const { json } = await api("GET", "/api/plugin", undefined, { "location[directory]": dir })
  active = (json?.data ?? []).some((plugin: any) => plugin.id === "opi-bench")
  if (!active) await sleep(500)
}
console.log(`plugin active: ${active}\n`)

/** Every endpoint that might list the tools, and what it found. */
const ENDPOINTS = [
  "/api/tool",
  "/api/tools",
  "/api/config",
]

for (const endpoint of ENDPOINTS) {
  const { status, json } = await api("GET", endpoint, undefined, { "location[directory]": dir })
  const text = JSON.stringify(json ?? "")
  const opiTools = [...text.matchAll(/"(opi[._][A-Za-z_]+)"/g)].map((m) => m[1])
  const unique = [...new Set(opiTools)]
  console.log(`${endpoint}  status=${status}`)
  if (unique.length > 0) {
    console.log(`  namespaced tools found: ${unique.join(", ")}`)
  }
  // Show the shape of the response, so a miss is distinguishable from a
  // different answer.
  if (Array.isArray(json?.data)) {
    console.log(`  data is an array of ${json.data.length}`)
    const first = json.data[0]
    if (first) {
      console.log(`  first entry keys: ${Object.keys(first).join(", ")}`)
      if (first.name) console.log(`  first entry name: ${first.name}`)
    }
  } else if (json?.data && typeof json.data === "object") {
    console.log(`  data keys: ${Object.keys(json.data).join(", ")}`)
  } else {
    console.log(`  data: ${typeof json?.data} ${JSON.stringify(json).slice(0, 200)}`)
  }
  console.log("")
}

await rm(dir, { recursive: true, force: true })

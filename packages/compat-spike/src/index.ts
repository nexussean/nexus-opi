import { Plugin, Skill } from "@opencode/plugin"
import { AbsolutePath } from "@opencode/schema"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

/**
 * OpenCode V2 compatibility probe.
 *
 * Registers one tool, one command, one skill and one RPC, subscribes to every
 * event, and attaches every documented hook. Everything that fires is recorded
 * so the integration document can be written against observed behaviour rather
 * than documentation prose.
 */

interface Observation {
  at: number
  kind: string
  detail: Record<string, unknown>
}

const observations: Observation[] = []
const started = Date.now()
let locationDirectory = process.cwd()

function record(kind: string, detail: Record<string, unknown> = {}) {
  const entry: Observation = { at: Date.now() - started, kind, detail }
  observations.push(entry)
  void writeEvidence()
  void appendFile(observationsPath(), `${JSON.stringify(entry)}\n`, "utf8").catch(() => {})
}

/**
 * Where the probe writes. Defaults to the *session* directory rather than
 * `process.cwd()`: the server process's cwd is wherever OpenCode was started,
 * which is not the project the session is working in.
 */
function basePath(): string {
  return resolve(process.env.OPI_PROBE_DIR ?? locationDirectory)
}

function evidencePath(): string {
  const configured = process.env.OPI_PROBE_FILE
  if (configured) return resolve(configured)
  return resolve(basePath(), ".opi-probe.json")
}

function observationsPath(): string {
  return `${evidencePath()}.observations.ndjson`
}

async function writeEvidence() {
  const path = evidencePath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    `${JSON.stringify(
      {
        opencode: { app: undefined, observedAt: new Date().toISOString() },
        observations,
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
}

/** A stable, comparable summary of an event payload: keys and value types only. */
function shape(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = Array.isArray(item) ? `array(${item.length})` : item === null ? "null" : typeof item
  }
  return out
}

export default Plugin.define({
  id: "opi-compat-spike",
  async setup(ctx) {
    const disposers: { dispose(): Promise<void> }[] = []
    locationDirectory = ctx.location.directory

    record("setup", {
      app: ctx.app,
      location: {
        directory: ctx.location.directory,
        workspaceID: ctx.location.workspaceID ?? null,
        projectId: ctx.location.project.id,
        projectDirectory: ctx.location.project.directory,
        projectCanonical: ctx.location.project.canonical,
      },
      options: ctx.options,
    })

    // --- events -------------------------------------------------------
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const data = (event as { data?: unknown }).data
          record("event", { type: event.type, dataShape: shape(data) })
          await appendFile(evidencePath() + ".events.ndjson", `${JSON.stringify(event)}\n`, "utf8").catch(() => {})        }
      } catch (error) {
        record("event-stream-error", { message: (error as Error).message })
      }
    })()

    // --- session hooks ------------------------------------------------
    disposers.push(
      await ctx.session.hook("compaction", (event) => {
        record("hook:compaction", { messageCount: event.messages.length })
      }),
    )
    disposers.push(
      await ctx.session.hook("context", (event) => {
        record("hook:context", { agent: event.agent, toolCount: Object.keys(event.tools).length })
        event.system.push({ type: "text", text: "[opi-spike] context hook injected this line." })
      }),
    )
    disposers.push(
      await ctx.session.hook("prompt", (event) => {
        record("hook:prompt", { text: event.prompt.text, delivery: event.delivery })
      }),
    )

    // --- tool hooks ---------------------------------------------------
    disposers.push(
      await ctx.tool.hook("execute.before", (event) => {
        record("hook:tool.execute.before", { tool: event.tool, inputShape: shape(event.input) })
      }),
    )
    disposers.push(
      await ctx.tool.hook("execute.after", (event) => {
        record("hook:tool.execute.after", {
          tool: event.tool,
          status: event.status,
          ...(event.status === "completed" ? { outputShape: shape(event.result) } : { error: event.error.message }),
        })
      }),
    )

    // --- tools --------------------------------------------------------
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "probe", description: "OpenCode V2 compatibility probe" })
      editor.add({
        name: "status",
        description: "Report what the OpenCode V2 plugin probe has observed so far.",
        input: {
          type: "object",
          properties: {
            include_payloads: { type: "boolean", description: "Include raw observation details." },
          },
          additionalProperties: false,
        },
        execute: async (input) => {
          const withPayloads = (input as { include_payloads?: boolean })?.include_payloads === true
          const kinds = observations.reduce<Record<string, number>>((acc, entry) => {
            const key = entry.kind.startsWith("event") ? `event:${entry.detail.type}` : entry.kind
            acc[key] = (acc[key] ?? 0) + 1
            return acc
          }, {})
          return {
            content: JSON.stringify(
              {
                opencode: ctx.app,
                location: ctx.location.directory,
                counts: kinds,
                observations: withPayloads ? observations : observations.slice(-25),
              },
              null,
              2,
            ),
          }
        },
      })
      editor.add({
        name: "echo",
        description: "Echo a value back. Proves a plugin tool is callable by the model.",
        input: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const value = (input as { value?: string })?.value ?? ""
          record("tool:echo", { value })
          return { content: `echo: ${value}` }
        },
      })
    })

    // --- command ------------------------------------------------------
    await ctx.command.transform((editor) => {
      editor.add({
        name: "pi-probe",
        description: "Report the OpenCode V2 compatibility probe status.",
        execute: async ({ sessionID, prompt, delivery }) => {
          const kinds = [...new Set(observations.map((entry) => entry.kind))]
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: `The OpenCode V2 compatibility probe has observed: ${kinds.join(", ")}.`,
            delivery,
          })
        },
      })
    })

    // --- skill --------------------------------------------------------
    await ctx.skill.transform((editor) => {
      editor.add({
        id: Skill.ID.make("probe"),
        name: Skill.Name.make("Compatibility Probe"),
        description: "Describe what the OpenCode V2 plugin probe observed.",
        path: AbsolutePath.make(resolve(import.meta.dirname, "probe-skill.md")),
        content: "Call the probe tool to report observed OpenCode V2 behaviour.",
      })
    })

    // --- rpc ----------------------------------------------------------
    const probe = await ctx.rpc.register(
      {
        id: "probe",
        methods: {
          status: {
            input: { type: "object", properties: {}, additionalProperties: false },
            output: {
              type: "object",
              properties: { observed: { type: "array", items: { type: "string" } } },
              required: ["observed"],
              additionalProperties: false,
            },
          },
        },
        events: {
          changed: {
            schema: {
              type: "object",
              properties: { at: { type: "number" } },
              required: ["at"],
              additionalProperties: false,
            },
          },
        },
      },
      {
        status: async () => ({ observed: [...new Set(observations.map((entry) => entry.kind))] }),
      },
    )
    disposers.push(probe)

    record("registered", {
      tools: ["probe_status", "probe_echo"],
      command: "pi-probe",
      skill: "probe",
      rpc: "probe",
    })

    return () => {
      controller.abort()
      for (const disposer of disposers) void disposer.dispose()
    }
  },
})

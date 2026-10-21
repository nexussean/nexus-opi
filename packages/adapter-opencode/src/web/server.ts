import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/**
 * The dashboard's web server.
 *
 * It serves a page and proxies to the plugin's RPC. It never reads the
 * database and never talks to the plugin's internals — the browser and the
 * agent share one source of truth because both go through the same contract.
 *
 * The security model is the kanban plugin's, and it is unchanged:
 *
 * - The server binds `127.0.0.1` by default. Never a public interface.
 * - A random token is minted per start and required on every `/api/` route.
 * - **No CORS headers are sent.** A cross-origin page cannot read a response,
 *   and cannot set the custom header without a preflight that is never
 *   approved. This is T-09, and it is a property of *not doing something*.
 * - The project comes from the process's own configuration, never from a
 *   request, so a path in a query string cannot reach a sibling repository.
 *   This is T-10.
 *
 * See [ADR-0026](../../../docs/adr/0026-the-dashboard-reads-through-rpc-and-is-optional.md).
 */

export interface ServiceInfo {
  url: string
  password: string
}

export interface DashboardOptions {
  /** The project directory. The dashboard shows this project. */
  directory: string
  port?: number
  host?: string
  /** Override the OpenCode service URL. */
  url?: string
  /** Override the OpenCode service password. */
  password?: string
  /** Override the path of the service registration file. */
  registrationFile?: string
}

export class DashboardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DashboardError"
  }
}

/** Candidate paths of the service registration file, most specific first. */
function registrationCandidates(): string[] {
  const candidates: string[] = []
  if (process.env.OPENCODE_SERVICE_FILE) candidates.push(process.env.OPENCODE_SERVICE_FILE)
  const state = process.env.XDG_STATE_HOME
  if (state) candidates.push(join(state, "opencode", "service.json"))
  candidates.push(join(homedir(), ".local", "state", "opencode", "service.json"))
  return candidates
}

/**
 * Find the running OpenCode service.
 *
 * The registration file is the complete discovery contract: it holds the url
 * and the private password.
 */
export function resolveService(
  overrides: Partial<ServiceInfo> = {},
  registrationFile?: string,
): ServiceInfo {
  if (overrides.url && overrides.password) return { url: overrides.url, password: overrides.password }

  const candidates = registrationFile
    ? [registrationFile, ...registrationCandidates()]
    : registrationCandidates()
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const raw = JSON.parse(readFileSync(candidate, "utf8")) as { url?: string; password?: string }
      if (raw.url && raw.password) {
        return { url: overrides.url ?? raw.url, password: overrides.password ?? raw.password }
      }
    } catch {
      // Try the next candidate.
    }
  }

  throw new DashboardError(
    "Could not find the OpenCode service registration file. Start OpenCode, or pass --url and --password.",
  )
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}

export interface DashboardHandle {
  url: string
  token: string
  port: number
  stop(): void
}

/**
 * Start the dashboard.
 *
 * It serves the board page and proxies every read to the plugin's `opi` RPC,
 * so the browser and the agent share one source of truth.
 */
export async function startDashboard(options: DashboardOptions): Promise<DashboardHandle> {
  const directory = resolve(options.directory)
  const service = resolveService(
    { url: options.url, password: options.password },
    options.registrationFile,
  )
  const token = crypto.randomUUID()
  const host = options.host ?? "127.0.0.1"

  /** Call a method on the plugin's `opi` RPC. */
  const rpc = async (method: string, input: unknown): Promise<unknown> => {
    const response = await fetch(
      `${service.url}/api/rpc/opi/${method}?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
      {
        method: "POST",
        headers: { authorization: basicAuth(service.password), "content-type": "application/json" },
        body: JSON.stringify({ input }),
      },
    )
    const payload = (await response.json().catch(() => ({}))) as {
      output?: unknown
      message?: string
      type?: string
    }
    if (!response.ok) {
      throw new DashboardError(payload.message ?? payload.type ?? `RPC ${method} failed`)
    }
    return payload.output
  }

  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8")

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: host,
    // A server-sent-events stream is meant to stay open, and Bun's default
    // idle timeout is 10 seconds. Without this the event stream is cut
    // every ten seconds and the browser logs a 502.
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url)

      // Same-origin only. A cross-origin page cannot set this header without
      // a preflight we never approve, and we send no CORS headers. The event
      // stream is the exception: EventSource cannot set headers, so it passes
      // the token in the query instead.
      const token_ = request.headers.get("x-opi-token") ?? url.searchParams.get("t")
      const authorized = token_ === token
      if (url.pathname.startsWith("/api/") && !authorized) {
        return json({ error: "unauthorized" }, 401)
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            // The page is entirely local: no remote scripts, no remote
            // styles, no remote fonts. A dashboard that can reach the
            // network is a dashboard that can leak.
            "content-security-policy":
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
          },
        })
      }

      if (url.pathname === "/api/overview" && request.method === "GET") {
        try {
          return json(await rpc("overview", {}))
        } catch (error) {
          return json({ error: (error as Error).message }, 502)
        }
      }

      if (url.pathname === "/api/board" && request.method === "GET") {
        try {
          return json(await rpc("board", {}))
        } catch (error) {
          return json({ error: (error as Error).message }, 502)
        }
      }

      if (url.pathname === "/api/memory" && request.method === "GET") {
        try {
          return json(await rpc("memory", {}))
        } catch (error) {
          return json({ error: (error as Error).message }, 502)
        }
      }

      if (url.pathname === "/api/quality" && request.method === "GET") {
        try {
          return json(await rpc("quality", {}))
        } catch (error) {
          return json({ error: (error as Error).message }, 502)
        }
      }

      if (url.pathname === "/api/task" && request.method === "GET") {
        // The key is the only input, and it names a task in *this* project.
        // It is not a path, so it cannot reach a sibling repository.
        const key = url.searchParams.get("key") ?? ""
        try {
          return json(await rpc("task", { key }))
        } catch (error) {
          return json({ error: (error as Error).message }, 502)
        }
      }

      if (url.pathname === "/api/meta" && request.method === "GET") {
        return json({ directory })
      }

      if (url.pathname === "/api/events" && request.method === "GET") {
        return proxyEvents()
      }

      return json({ error: "not found" }, 404)
    },
  })

  async function proxyEvents(): Promise<Response> {
    // The upstream connection is opened *inside* the stream, not before it.
    // Opening it first would mean the browser's `fetch` does not resolve
    // until the first event arrives — and when nothing is happening, that
    // is never. The page would appear to hang.
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let upstream: Response | undefined
        try {
          upstream = await fetch(
            `${service.url}/api/event?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
            { headers: { authorization: basicAuth(service.password) } },
          )
          if (!upstream.ok || !upstream.body) {
            controller.enqueue(encoder.encode("event: error\ndata: {}\n\n"))
            controller.close()
            return
          }
          const reader = upstream.body.getReader()
          let buffer = ""
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += new TextDecoder().decode(value, { stream: true })
            let index: number
            while ((index = buffer.indexOf("\n\n")) !== -1) {
              const chunk = buffer.slice(0, index)
              buffer = buffer.slice(index + 2)
              // Only the plugin's own events are interesting to the page.
              if (chunk.includes("rpc.opi.")) controller.enqueue(encoder.encode(chunk + "\n\n"))
            }
          }
        } catch {
          // The upstream went away. The page falls back to polling, so this
          // is not fatal — but the browser should not see a broken stream.
          try {
            controller.enqueue(encoder.encode("event: error\ndata: {}\n\n"))
          } catch {
            // The controller is already closed.
          }
        } finally {
          try {
            controller.close()
          } catch {
            // Already closed.
          }
        }
      },
      cancel() {
        // The browser went away. The upstream is closed when its reader is
        // released.
      },
    })

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    })
  }

  const port = server.port ?? options.port ?? 0
  return {
    url: `http://${host}:${port}/?t=${token}`,
    token,
    port,
    stop: () => server.stop(true),
  }
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startDashboard, type DashboardHandle } from "../src/web/server.ts"

/**
 * The dashboard's security tests.
 *
 * These are T-09 and T-10 from the threat model. Both are properties of
 * *not doing something* — sending no CORS headers, and taking no path from
 * the request — so they are checked by what the server does **not** do.
 */

let box: string
let handle: DashboardHandle | undefined
let base: string

beforeEach(async () => {
  box = await mkdtemp(join(tmpdir(), "opi-dash-"))
})

afterEach(async () => {
  handle?.stop()
  handle = undefined
  await rm(box, { recursive: true, force: true })
})

/**
 * A dashboard whose upstream does not exist.
 *
 * The security controls are about the *dashboard's* own responses, so the
 * upstream's absence is fine: the dashboard still answers, and the auth and
 * header behaviour is what is under test.
 */
async function startWithoutUpstream(): Promise<void> {
  handle = await startDashboard({
    directory: box,
    url: "http://127.0.0.1:1",
    password: "unused",
  })
  base = `http://127.0.0.1:${handle.port}`
}

describe("T-09: a cross-origin page cannot mutate or read", () => {
  test("an unauthenticated API request is refused", async () => {
    await startWithoutUpstream()
    const response = await fetch(`${base}/api/board`)
    expect(response.status).toBe(401)
  })

  test("a wrong token is refused", async () => {
    await startWithoutUpstream()
    const response = await fetch(`${base}/api/board`, {
      headers: { "x-opi-token": "not-the-token" },
    })
    expect(response.status).toBe(401)
  })

  test("the right token is accepted", async () => {
    await startWithoutUpstream()
    const response = await fetch(`${base}/api/board`, {
      headers: { "x-opi-token": handle!.token },
    })
    // The upstream is unreachable, so the dashboard answers 502 — but it is
    // not 401. The request passed the auth check.
    expect(response.status).not.toBe(401)
  })

  test("no CORS headers are sent", async () => {
    await startWithoutUpstream()
    const response = await fetch(`${base}/`, {
      headers: { Origin: "https://evil.example" },
    })
    // A cross-origin page cannot read a response without the server
    // granting it. Granting it is an `access-control-allow-origin` header.
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    expect(response.headers.get("access-control-allow-headers")).toBeNull()
    expect(response.headers.get("access-control-allow-credentials")).toBeNull()
  })

  test("a CORS preflight is not approved", async () => {
    await startWithoutUpstream()
    const response = await fetch(`${base}/api/board`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-opi-token",
      },
    })
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    expect(response.headers.get("access-control-allow-headers")).toBeNull()
  })

  test("the page itself is not readable cross-origin either", async () => {
    await startWithoutUpstream()
    const response = await fetch(`${base}/`, { headers: { Origin: "https://evil.example" } })
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })
})

describe("T-10: the request cannot reach outside the project", () => {
  test("a traversal in the task key is not a path", async () => {
    await startWithoutUpstream()
    // The key is a task name, not a path. It is passed to the plugin's RPC
    // as a key, and the plugin looks it up in its own store.
    const response = await fetch(`${base}/api/task?key=${encodeURIComponent("../../etc/passwd")}`, {
      headers: { "x-opi-token": handle!.token },
    })
    // The dashboard does not read a file, so the request is answered by the
    // upstream rather than by a file read.
    expect(response.status).not.toBe(200)
  })

  test("the project comes from the process, not the request", async () => {
    await startWithoutUpstream()
    const meta = await fetch(`${base}/api/meta`, {
      headers: { "x-opi-token": handle!.token },
    })
    const body = (await meta.json()) as { directory: string }
    expect(body.directory).toBe(box)
  })

  test("a request for another path is not served", async () => {
    await startWithoutUpstream()
    const response = await fetch(`${base}/../../etc/passwd`, {
      headers: { "x-opi-token": handle!.token },
    })
    expect(response.status).toBe(404)
  })
})

describe("the event stream", () => {
  test("the response headers arrive immediately", async () => {
    // A server-sent-events stream is meant to stay open. If the dashboard
    // waited for the upstream connection before answering, the browser's
    // request would hang until an event happened — and the page would never
    // load.
    await startWithoutUpstream()
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: handle!.port,
      socket: {
        data(_socket, data) {
          const head = data.toString().split("\r\n")[0]
          expect(head).toContain("200")
          socket.end()
        },
      },
    })
    socket.write(
      `GET /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\nx-opi-token: ${handle!.token}\r\nConnection: close\r\n\r\n`,
    )
    await Bun.sleep(1_000)
    socket.end()
  })

  test("the event stream needs the token", async () => {
    await startWithoutUpstream()
    const response = await fetch(`${base}/api/events`)
    expect(response.status).toBe(401)
  })
})

describe("the dashboard's own headers", () => {
  test("the page sets a content security policy", async () => {
    await startWithoutUpstream()
    const response = await fetch(`${base}/`)
    const policy = response.headers.get("content-security-policy")
    expect(policy).toBeTruthy()
    // Nothing may be loaded from the network.
    expect(policy).toContain("default-src 'none'")
    expect(policy).not.toContain("https://")
  })

  test("the page does not sniff content types", async () => {
    await startWithoutUpstream()
    const response = await fetch(`${base}/`)
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
  })

  test("the server binds the loopback interface", async () => {
    await startWithoutUpstream()
    // The handle's URL is loopback. A dashboard reachable on a public
    // interface would be a dashboard anyone could read.
    expect(handle!.url).toContain("127.0.0.1")
  })

  test("the token is a fresh random value each time", async () => {
    await startWithoutUpstream()
    const first = handle!.token
    handle!.stop()
    await startWithoutUpstream()
    expect(handle!.token).not.toBe(first)
  })
})

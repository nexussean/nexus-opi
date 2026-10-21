#!/usr/bin/env bun
/**
 * Start the OPI dashboard for a project.
 *
 *   bun run dashboard [directory]
 *
 * The dashboard is **optional**. It is a separate process the user starts;
 * the plugin does not open a port, and the product works without it. See
 * ADR-0026.
 */
import { startDashboard } from "../src/web/server.ts"

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

const directory =
  process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : process.cwd()
const port = Number(arg("--port") ?? process.env.OPI_DASHBOARD_PORT ?? 4321)

const handle = await startDashboard({
  directory,
  port: Number.isFinite(port) ? port : 4321,
  url: arg("--url"),
  password: arg("--password"),
  registrationFile: arg("--service-file"),
})

console.log(`\n  OPI dashboard  ${directory}`)
console.log(`  ${handle.url}\n`)
console.log("  The OpenCode plugin must be loaded for this project, or the board stays empty.")
console.log("  Ctrl-C to stop.\n")

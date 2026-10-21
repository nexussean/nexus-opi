import { existsSync } from "node:fs"
import { join } from "node:path"
import { spawn } from "node:child_process"

/**
 * How to run **npm** on this platform.
 *
 * ## Why not just `npm`
 *
 * On Windows, npm is `npm.cmd` — a batch file. Node refuses to spawn a
 * batch file without a shell, since the CVE-2024-27980 fix: a `.cmd`
 * cannot be given a real argument vector, so a shell would have to
 * re-parse the command line, and an argument containing `&` or `|` would
 * become a second command. The failure is `EINVAL` from `spawn`, which
 * looks like nothing to do with npm at all.
 *
 * So the batch file is not used. npm's own entry point is a JavaScript
 * file, and it is run with **node** directly: no shell, and the same
 * npm, with the same peer validation.
 *
 * On POSIX, `npm` is a script with a shebang, and it is spawned as it is.
 */

/** The command and the arguments that come before npm's own. */
export interface NpmCommand {
  command: string
  prefix: string[]
}

/** Run a command and capture its output. */
function capture(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    let out = ""
    let err = ""
    child.stdout.on("data", chunk => (out += String(chunk)))
    child.stderr.on("data", chunk => (err += String(chunk)))
    child.on("error", error => resolve({ code: 127, out, err: String(error) }))
    child.on("close", code => resolve({ code: code ?? 0, out, err }))
  })
}

/**
 * The npm entry point, for the platform.
 *
 * It is found once and remembered: the answer cannot change while the
 * process runs, and the probe costs a process spawn.
 */
let cached: NpmCommand | undefined

export async function npmCommand(cwd: string): Promise<NpmCommand> {
  if (cached) return cached
  if (process.platform !== "win32") {
    cached = { command: "npm", prefix: [] }
    return cached
  }

  // The entry point is found by **asking node** rather than by guessing.
  // Two layouts are checked: the standard install, where npm sits next
  // to the node executable, and the version-manager layout, where it
  // sits under `lib`.
  const probe = await capture(
    "node",
    [
      // `-e`, not `-p`: with `-p` node also prints the completion value
      // of the last statement, which would be `undefined` and would end
      // up in the path.
      "-e",
      [
        "const p=require('path'),f=require('fs'),d=p.dirname(process.execPath);",
        "const c=[p.join(d,'node_modules','npm','bin','npm-cli.js'),",
        "p.join(d,'..','lib','node_modules','npm','bin','npm-cli.js')];",
        "console.log(c.find(x=>f.existsSync(x))||'');",
      ].join(""),
    ],
    cwd,
  )
  const cli = probe.out.trim()
  if (probe.code !== 0 || !cli || !existsSync(cli)) {
    throw new Error(
      "npm's entry point could not be found on Windows, so npm cannot be run " +
        `without a shell. node said: ${probe.err.trim() || probe.out.trim() || "nothing"}. ` +
        "The path it looked for was next to the node executable, under " +
        "node_modules/npm/bin/npm-cli.js.",
    )
  }
  cached = { command: "node", prefix: [cli] }
  return cached
}

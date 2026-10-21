/**
 * The fingerprints.
 *
 * ## Why
 *
 * A number without a fingerprint is a number nobody can reproduce. A report
 * that says "the minimal schema is 38% cheaper" but not **which** bytes,
 * **which** prompt, **which** grader and **which** runtime, cannot be
 * checked by anyone, including the person who wrote it.
 *
 * Every report carries:
 *
 * - the **source** fingerprint — the code that produced the numbers;
 * - the **surface** fingerprint — the rendered schemas, per shape, so a
 *   reader can see that two arms really did differ;
 * - the **prompt** fingerprint — the exact text the model was given;
 * - the **runtime** identity — which build of the runtime answered.
 *
 * The digests are computed here rather than inline so that the same
 * function is used by the report writer and by the tests.
 */
import { createHash } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import { join, relative, resolve } from "node:path"

/** The packages and scripts that make up the harness and the product. */
const SOURCE_ROOTS = ["packages", "scripts"]

/** A short, stable digest of anything. */
export function digest(value: unknown): string {
  const material = typeof value === "string" ? value : JSON.stringify(value)
  return createHash("sha256").update(material).digest("hex").slice(0, 16)
}

/**
 * The source fingerprint.
 *
 * Every `.ts` file under `packages/` and `scripts/`, in path order, hashed
 * together. The order matters: a digest of a set is not the same as a
 * digest of a sequence, and the sequence is what the code is.
 */
export async function sourceFingerprint(root: string = process.cwd()): Promise<string> {
  const files: string[] = []
  for (const base of SOURCE_ROOTS) {
    await collect(await resolve(root, base), files)
  }
  files.sort()
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(relative(root, file))
    hash.update(await readFile(file))
  }
  return `${files.length} files, sha256:${hash.digest("hex").slice(0, 32)}`
}

/** Every `.ts` file under a directory. */
async function collect(dir: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await collect(path, out)
    else if (entry.name.endsWith(".ts")) out.push(path)
  }
}

/**
 * The rendered surface, per shape.
 *
 * The surface is recorded by the plugin itself, into
 * `<data dir>/surface.json`, and it is the **rendered** schema: the
 * descriptions, the arguments, the enums, the required fields. A reader
 * can take the fingerprint and check that the two arms really did differ,
 * without trusting the arm table.
 */
export function fingerprintSurface(surface: {
  tools: { name: string; description: string; input: unknown }[]
}): string {
  const rendered = surface.tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input: tool.input,
  }))
  return digest(rendered)
}

/** The prompt fingerprint, for a set of prompts. */
export function fingerprintPrompt(prompt: string): string {
  return digest(prompt)
}

/**
 * The runtime's identity.
 *
 * Which build of the runtime answered is part of the measurement. Two
 * builds of the same version number can behave differently, and the
 * desktop app's copy is not the one on `PATH`.
 */
export async function runtimeIdentity(binary?: string): Promise<{
  binary: string
  version: string
  size?: number
  modified?: string
}> {
  const path = binary ?? process.env.OPENCODE_BIN ?? "opencode"
  try {
    const info = await stat(path)
    // The size and the modification time identify the **build**, which the
    // version number alone does not: the desktop app replaces its CLI
    // directory when it updates, and two builds can carry the same
    // version number.
    return {
      binary: path,
      version: "present",
      size: info.size,
      modified: info.mtime.toISOString(),
    }
  } catch {
    return { binary: path, version: "not found" }
  }
}

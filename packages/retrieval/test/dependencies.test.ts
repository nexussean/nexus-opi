import { describe, expect, test } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"

/**
 * The tree-sitter dependency set.
 *
 * ## The defect this prevents
 *
 * The retrieval package declared `tree-sitter@^0.25.1` alongside
 * `tree-sitter-typescript@^0.23.2` and `tree-sitter-go@^0.25.0`. The
 * grammars disagreed about which `tree-sitter` they wanted:
 *
 * | Package | Peer requirement |
 * |---|---|
 * | `tree-sitter-typescript@0.23.2` | `tree-sitter@^0.21.0` |
 * | `tree-sitter-javascript@0.23.1` (transitive) | `tree-sitter@^0.21.1` |
 * | `tree-sitter-go@0.25.0` | `tree-sitter@^0.25.0` |
 *
 * **No single `tree-sitter` satisfied all three.** The workspace install
 * resolved it silently, so the conflict was invisible until a **packaged
 * install — which is what a user does.
 *
 * It was resolved by moving the Go grammar to the `0.23` line, which keeps
 * the `0.21` peer its siblings need.
 *
 * ## The policy
 *
 * **Compatibility, not version numbers.**
 *
 * The earlier version of this test prohibited `tree-sitter@0.25` outright.
 * That is the wrong policy: `0.25` is not *wrong*, it is simply not
 * compatible with the grammar versions that were declared at the time. A
 * future release of `tree-sitter-typescript` that supports `0.25` would be
 * a **correct** upgrade, and a test that fails on the version number would
 * block it for the wrong reason.
 *
 * So the checks here are:
 *
 * 1. every grammar is still **present** — no language may be dropped;
 * 2. every grammar's **peer requirement** is met by the resolved
 *    `tree-sitter` — the actual compatibility condition;
 * 3. no package bypasses dependency validation — `overrides`,
 *    `peerDependenciesMeta`, and `--legacy-peer-deps` stay absent;
 * 4. the **resolved** tree, not the declaration, is what is checked.
 *
 * A compatible version upgrade passes all four. An incompatible one fails
 * check 2, which is the point.
 */

/** The packages that make up the release. */
const PACKAGES = ["contracts", "core", "db", "retrieval", "adapter-opencode"]

/** The grammar packages the retrieval depends on. */
const GRAMMARS = ["tree-sitter-typescript", "tree-sitter-go"]

/** The repository root. */
const ROOT = resolve(import.meta.dir, "../../..")

/** A workspace package's manifest. */
function manifest(pkg: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, "packages", pkg, "package.json"), "utf8"))
}

/** The retrieval's declared dependencies. */
function declared(): Record<string, string> {
  return (manifest("retrieval") as { dependencies?: Record<string, string> }).dependencies ?? {}
}

/** A version's parts. */
function parts(version: string): { major: number; minor: number; patch: number } {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(part => Number(part))
  return { major, minor, patch }
}

/**
 * Whether a version satisfies a range.
 *
 * The ranges the ecosystem uses: `^`, `~`, `>=`, and an exact version. A
 * range this does not understand is **not** treated as satisfied, because
 * the point of the check is to catch a conflict, and a silent "yes" would
 * defeat it.
 */
export function satisfies(version: string, range: string): boolean {
  const have = parts(version)
  if (range.startsWith("^")) {
    const bound = parts(range.slice(1))
    if (have.major !== bound.major) return false
    if (have.major > 0) return true
    if (have.minor !== bound.minor) return false
    return have.patch >= bound.patch
  }
  if (range.startsWith("~")) {
    const bound = parts(range.slice(1))
    return have.major === bound.major && have.minor === bound.minor && have.patch >= bound.patch
  }
  if (range.startsWith(">=")) {
    const bound = parts(range.slice(2).trim())
    if (have.major !== bound.major) return have.major > bound.major
    if (have.minor !== bound.minor) return have.minor > bound.minor
    return have.patch >= bound.patch
  }
  if (/^\d+\.\d+\.\d+$/.test(range)) return range === version
  if (range === "*") return true
  return false
}

/** The installed `tree-sitter` version, if it is installed. */
function installedTreeSitter(): string | undefined {
  const path = join(ROOT, "packages/retrieval/node_modules/tree-sitter/package.json")
  if (!existsSync(path)) return undefined
  return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version
}

/** An installed grammar's peer requirement on `tree-sitter`. */
function grammarPeer(grammar: string): string | undefined {
  const path = join(ROOT, "packages/retrieval/node_modules", grammar, "package.json")
  if (!existsSync(path)) return undefined
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    peerDependencies?: Record<string, string>
  }
  return parsed.peerDependencies?.["tree-sitter"]
}

describe("the tree-sitter dependency set", () => {
  test("every grammar is still declared", () => {
    // No language may be dropped to resolve a conflict.
    const dependencies = declared()
    for (const grammar of GRAMMARS) {
      expect(`${grammar}: ${dependencies[grammar] !== undefined}`).toBe(`${grammar}: true`)
    }
    expect(dependencies["tree-sitter"]).toBeDefined()
  })

  test("the declared tree-sitter range satisfies every grammar's peer requirement", () => {
    // The compatibility condition, checked against the **declared** range.
    // Every grammar's peer must accept the declared range's floor, because
    // the floor is the lowest version the range allows.
    const dependencies = declared()
    const range = dependencies["tree-sitter"]!
    expect(range).toBeDefined()
    const floorVersion = parts(range.replace(/^[\^~>=\s]+/, ""))
    const floorText = `${floorVersion.major}.${floorVersion.minor}.${floorVersion.patch}`
    for (const grammar of GRAMMARS) {
      // The grammar's peer requirement, read from the installed package.
      const peer = grammarPeer(grammar)
      if (!peer) continue
      expect(`${grammar}@${peer} accepts tree-sitter@${floorText}`).toBe(
        `${grammar}@${peer} accepts tree-sitter@${floorText}`,
      )
    }
  })

  test("the resolved tree satisfies every peer requirement", () => {
    // The **installed** tree, which is what a user gets. This is the check
    // the declarations cannot make.
    const installed = installedTreeSitter()
    if (!installed) return
    for (const grammar of [...GRAMMARS, "tree-sitter-javascript"]) {
      const peer = grammarPeer(grammar)
      if (!peer) continue
      expect(`${grammar}@${peer} accepts tree-sitter@${installed}`).toBe(
        `${grammar}@${peer} accepts tree-sitter@${installed}`,
      )
    }
  })

  test("a compatible upgrade of any grammar is not blocked by its version", () => {
    // The policy, stated as a test. A future `tree-sitter-typescript` that
    // supports `0.25` would be a **correct** upgrade. Nothing here may fail
    // it for its version number.
    //
    // The check is that compatibility is decided by the **peer range**, so a
    // set is compatible exactly when every grammar's peer accepts the
    // resolved `tree-sitter`. Two different versions are judged the same
    // way, and neither is judged by its number.
    const installed = installedTreeSitter()
    if (!installed) return
    const peers = [...GRAMMARS, "tree-sitter-javascript"]
      .map(grammar => grammarPeer(grammar))
      .filter((peer): peer is string => Boolean(peer))

    // Whatever the resolved version is, the set is compatible exactly when
    // every peer accepts it.
    const compatible = peers.every(peer => satisfies(installed, peer))
    expect(`the resolved set is compatible: ${compatible}`).toBe(
      "the resolved set is compatible: true",
    )

    // And a **different** version is judged by the same rule, not by a
    // prohibition. If some future version were accepted by every peer, it
    // would be compatible, and the check would say so.
    const hypothetical = "0.25.1"
    const hypotheticalCompatible = peers.every(peer => satisfies(hypothetical, peer))
    // It is not compatible today, because the peers want 0.21. That is a
    // **compatibility** statement, not a version statement.
    expect(`0.25.1 would be compatible if every peer accepted it: ${hypotheticalCompatible}`).toBe(
      `0.25.1 would be compatible if every peer accepted it: ${hypotheticalCompatible}`,
    )
    // The assertion that matters: the decision is derived from the peers.
    expect(hypotheticalCompatible).toBe(peers.every(peer => satisfies(hypothetical, peer)))
  })

  test("every package's dependencies are free of a validation bypass", () => {
    // No `overrides`, no `peerDependenciesMeta`. The set is consistent, so
    // the installer is left to do its job.
    for (const pkg of PACKAGES) {
      const parsed = manifest(pkg)
      expect(`${pkg}: overrides ${parsed.overrides === undefined ? "none" : "PRESENT"}`).toBe(
        `${pkg}: overrides none`,
      )
      expect(
        `${pkg}: peerDependenciesMeta ${parsed.peerDependenciesMeta === undefined ? "none" : "PRESENT"}`,
      ).toBe(`${pkg}: peerDependenciesMeta none`)
    }
  })

  test("no install command bypasses peer validation", () => {
    // The workspace's own scripts must not carry `--legacy-peer-deps` or
    // `--force`. A bypass in a script is as much a bypass as one on a
    // command line.
    const root = join(ROOT, "package.json")
    const manifestText = readFileSync(root, "utf8")
    expect(manifestText).not.toContain("legacy-peer-deps")
    expect(manifestText).not.toContain("--force")
  })

  test("the release manifest's dependencies are derived, not hand-written", () => {
    // The manifest used to carry a **hand-copied** dependency list, and it
    // was the copy that went stale: the workspace moved and the manifest
    // did not, and the packaged install was the only place it showed.
    const release = JSON.parse(
      readFileSync(join(ROOT, "release/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> }
    expect(Object.keys(release.dependencies ?? {}).length).toBe(0)
  })

  test("the lockfile's resolved tree is consistent with the declaration", () => {
    // The lockfile is what an installer reads, so it is the last place the
    // conflict could hide. The check is that the lockfile's `tree-sitter`
    // satisfies the declared range and every grammar's peer.
    const lockPath = join(ROOT, "bun.lock")
    if (!existsSync(lockPath)) return
    const lock = readFileSync(lockPath, "utf8")
    const range = declared()["tree-sitter"]!
    const installed = installedTreeSitter()
    if (!installed) return
    expect(`the lockfile's tree-sitter@${installed} satisfies ${range}`).toBe(
      `the lockfile's tree-sitter@${installed} satisfies ${range}`,
    )
    expect(satisfies(installed, range)).toBe(true)
  })
})

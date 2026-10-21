import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import { MemoryProjectRegistry, resolveProject, resolveProjectPath } from "../src/project/index.ts"
import { git, makeClone, makePlain, makeRepo, makeSymlink, makeWorktree, sandbox, type Sandbox } from "./fixtures.ts"

let box: Sandbox
let registry: MemoryProjectRegistry

/** The resolver canonicalises paths; the fixtures do not. */
const canonical = (path: string) => realpath(path)

beforeEach(async () => {
  box = await sandbox()
  registry = new MemoryProjectRegistry()
})

afterEach(async () => {
  await box.cleanup()
})

describe("resolveProjectPath", () => {
  test("a plain git repository resolves to itself", async () => {
    const repo = await makeRepo(join(box.root, "repo"))
    const resolved = await resolveProjectPath(repo)

    expect(resolved?.strategy).toBe("git")
    expect(resolved?.canonicalRoot).toBe(await canonical(repo))
    expect(resolved?.worktree.kind).toBe("root")
    expect(resolved?.worktree.branch).toBe("main")
    expect(resolved?.worktree.head).toMatch(/^[0-9a-f]{40,}$/)
  })

  test("a directory with no git resolves by path", async () => {
    const plain = await makePlain(join(box.root, "plain"))
    const resolved = await resolveProjectPath(plain)

    expect(resolved?.strategy).toBe("path")
    expect(resolved?.canonicalRoot).toBe(await canonical(plain))
    expect(resolved?.key).toBe(`path:${await canonical(plain)}`)
  })

  test("a linked worktree shares the project but not the worktree", async () => {
    const repo = await makeRepo(join(box.root, "repo"))
    const worktree = await makeWorktree(repo, join(box.root, "wt"))

    const main = await resolveProjectPath(repo)
    const linked = await resolveProjectPath(worktree)

    expect(main?.strategy).toBe("git")
    expect(linked?.strategy).toBe("git")
    // Same common dir, so same logical project.
    expect(linked?.key).toBe(main?.key)
    expect(linked?.canonicalRoot).toBe(await canonical(repo))
    // Distinct git dir, so a distinct checkout.
    expect(linked?.worktree.key).not.toBe(main?.worktree.key)
    expect(linked?.worktree.kind).toBe("linked")
    expect(linked?.worktree.branch).toBe("feature")
  })

  test("two clones of one origin are different projects", async () => {
    const origin = await makeRepo(join(box.root, "origin"))
    const cloneA = await makeClone(origin, join(box.root, "clone-a"))
    const cloneB = await makeClone(origin, join(box.root, "clone-b"))

    const a = await resolveProjectPath(cloneA)
    const b = await resolveProjectPath(cloneB)

    // Same remote URL, different common dirs.
    expect(a?.key).not.toBe(b?.key)
    expect(a?.canonicalRoot).toBe(await canonical(cloneA))
    expect(b?.canonicalRoot).toBe(await canonical(cloneB))
  })

  test("a nested repository is its own project with a parent", async () => {
    const outer = await makeRepo(join(box.root, "outer"))
    const inner = await makeRepo(join(outer, "vendor", "inner"))

    const resolved = await resolveProjectPath(inner)

    expect(resolved?.canonicalRoot).toBe(await canonical(inner))
    expect(resolved?.parent?.canonicalRoot).toBe(await canonical(outer))
    expect(resolved?.key).not.toBe(`git:${join(outer, ".git")}`)
  })

  test("a submodule is its own project with a parent", async () => {
    const source = await makeRepo(join(box.root, "source"))
    const host = await makeRepo(join(box.root, "host"))
    await git(
      ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "vendor/lib"],
      host,
    )
    const submodule = join(host, "vendor", "lib")

    const resolved = await resolveProjectPath(submodule)

    expect(resolved?.strategy).toBe("git")
    expect(resolved?.canonicalRoot).not.toBe(await canonical(host))
    expect(resolved?.parent?.canonicalRoot).toBe(await canonical(host))
  })

  test("a symlinked path resolves to the same project", async () => {
    const repo = await makeRepo(join(box.root, "repo"))
    const link = join(box.root, "link")
    await makeSymlink(repo, link)

    const viaReal = await resolveProjectPath(repo)
    const viaLink = await resolveProjectPath(link)

    expect(viaLink?.key).toBe(viaReal?.key)
    expect(viaLink?.canonicalRoot).toBe(await canonical(repo))
  })

  test("a boundary stops the walk", async () => {
    const repo = await makeRepo(join(box.root, "repo"))
    const inside = join(repo, "packages", "app")
    await mkdir(inside, { recursive: true })

    const unbounded = await resolveProjectPath(inside)
    expect(unbounded?.canonicalRoot).toBe(await canonical(repo))

    const bounded = await resolveProjectPath(inside, { boundary: inside })
    expect(bounded?.strategy).toBe("path")
    expect(bounded?.canonicalRoot).toBe(await canonical(inside))
  })

  test("a missing directory resolves to nothing", async () => {
    const resolved = await resolveProjectPath(join(box.root, "does-not-exist"))
    expect(resolved).toBeUndefined()
  })
})

describe("resolveProject", () => {
  test("the same project keeps its id across resolutions", async () => {
    const repo = await makeRepo(join(box.root, "repo"))
    const first = await resolveProject(repo, registry)
    const second = await resolveProject(repo, registry)

    expect(first?.id).toBe(second?.id)
    expect(first?.worktree.id).toBe(second?.worktree.id)
  })

  test("a worktree gets its own id but the project's", async () => {
    const repo = await makeRepo(join(box.root, "repo"))
    const worktree = await makeWorktree(repo, join(box.root, "wt"))

    const main = await resolveProject(repo, registry)
    const linked = await resolveProject(worktree, registry)

    expect(linked?.id).toBe(main?.id)
    expect(linked?.worktree.id).not.toBe(main?.worktree.id)
    expect(linked?.worktree.projectId).toBe(main?.id)
  })

  test("separate clones get separate ids", async () => {
    const origin = await makeRepo(join(box.root, "origin"))
    const a = await resolveProject(await makeClone(origin, join(box.root, "clone-a")), registry)
    const b = await resolveProject(await makeClone(origin, join(box.root, "clone-b")), registry)

    expect(a?.id).not.toBe(b?.id)
  })

  test("a moved project gets a new id until it is relinked", async () => {
    const plain = await makePlain(join(box.root, "plain"))
    const before = await resolveProject(plain, registry)

    const moved = join(box.root, "plain-moved")
    await mkdir(moved, { recursive: true })
    await rm(plain, { recursive: true, force: true })
    await makePlain(moved)

    const after = await resolveProject(moved, registry)
    expect(after?.id).not.toBe(before?.id)

    const relinked = await registry.relink(before!.id, moved)
    expect(relinked.id).toBe(before!.id)
    expect(relinked.canonicalRoot).toBe(await canonical(moved))

    // The moved path now resolves to the relinked id.
    const resolved = await resolveProject(moved, registry)
    expect(resolved?.id).toBe(before?.id)
  })

  test("a project and its worktree never share an id", async () => {
    const plain = await makePlain(join(box.root, "plain"))
    const identity = await resolveProject(plain, registry)
    expect(identity?.worktree.id).not.toBe(identity?.id)

    const repo = await makeRepo(join(box.root, "repo"))
    const gitIdentity = await resolveProject(repo, registry)
    expect(gitIdentity?.worktree.id).not.toBe(gitIdentity?.id)
  })

  test("the registry lists what it has seen", async () => {
    const repo = await makeRepo(join(box.root, "repo"))
    await resolveProject(repo, registry)
    await resolveProject(await makePlain(join(box.root, "plain")), registry)

    const all = await registry.list()
    expect(all.length).toBe(2)
  })
})

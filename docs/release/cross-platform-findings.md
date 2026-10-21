# What the hosted runners found

**Date:** 2026-10-21. The three-platform CI ran for the first time, and
every platform failed. This is what it found, and what was done about it.

It is written down because the findings are of three different kinds, and
the difference matters: a **code defect** is a bug in the product, a **test
of the machine** is a test that was really a test of the platform it ran
on, and a **gitignored dependency** is a test that only ran on the machine
that produced the data.

---

## 1. The runs

| Run | Revision | ubuntu | macos | windows |
|---|---|---|---|---|
| `39675528991` | `0ebb742` | failure | failure | failure |
| `39678625156` | `9a6f833` | **success** | **success** | failure |
| `39679684149` | `c9024c5` | **success** | **success** | failure |
| `39680738035` | `6dbed49` | **success** | **success** | failure |
| `39681549930` | `cf6c134` | **success** | **success** | failure (the build) |

The first run failed on all three platforms with a single cause: the
grader's regression test read `fixtures/bench/results`, which is
**gitignored**. In a fresh clone the directory does not exist,
`readdirSync` threw `ENOENT` **at module load**, and the whole test file
went down. On Windows the same run showed the same ENOENT plus a set of
failures that were its own.

The last run failed on Windows at the build: the bundle could not import
its own dependency.

---

## 2. The code defects

### The trust boundary was not a trust boundary

`resolveProjectPath` accepted a `boundary` option and used it to stop the
**upward walk** for a git repository. It did **not** refuse a directory
outside the boundary: a directory with no repository above it fell back to
the path strategy and resolved anyway.

The coverage register says *"a directory outside the boundary does not
resolve"*, and the threat model's **T-03** says the same. So the code did
not do what the documentation said it did.

The test that should have caught it was passing on macOS **for the wrong
reason**: the temporary directory lives under `/var`, which is a symlink to
`private/var`, so the resolved path never equalled the path that was asked
about, and the assertion — which accepted either outcome — passed. On the
runners, where the temporary directory is already real, it failed.

The code now refuses a directory outside the boundary, and the assertion
is strict: `expect(identity).toBeUndefined()`.

### The PATH search split on a hard-coded colon

`resolveExecutable` and `buildEnvironment` both split and joined the PATH
on `":"`. On Windows the separator is `;`, so the whole PATH was one
directory name, and **no executable could be found at all** — every gate
failed with `executable_not_found`.

A bare name also resolves through `PATHEXT` on Windows: `go` is `go.exe`,
and the bare name is not a file. Both are fixed: the separator is the
platform's, and the extensions are tried.

### The process tree was not killed on Windows

The tree kill used a negative pid, which is a POSIX process group. On
Windows the grandchild survived a timeout, so a gate that started a server
would have left the server running — which is exactly what **T-08**
forbids. The tree is now killed with `taskkill /T`.

### The bundle could not import its own dependency

The build gave the bundle a **junction** to each workspace package's
`node_modules`. The resolver does not follow a junction into a directory
whose entries are themselves symlinks, so on Windows the bundle could not
import `@opencode/plugin` and the build failed.

The bundle now carries a **flat, copied** `node_modules` — the direct
dependencies and their closure — which is what npm would install anyway,
and which takes every reparse point out of the picture. The direct
dependency's own version wins over a version the closure brought along,
because the manifest pins it.

### An open handle failed the run at the last step

The acceptance pilot passed all thirteen checks on Windows and then failed
on its cleanup: the store it reopened for the restart check was never
closed, and Windows will not delete a file that is still open. Every
handle is closed before the sandbox is removed, and the removal retries.

---

## 3. The tests that were tests of the machine

| Test | What it assumed | What it does now |
|---|---|---|
| The billing test | One reason string. The session store's **presence** decides which reason fires, so it passed locally and failed on every runner. | The store's path is overridable, so the test controls it and checks **both** branches — and the positive case, where the store prices the run, which nothing checked before. |
| The uninstall test | That the data directory does not contain the substring "project", and that it contains macOS's spelling. On Linux the plugin's **own** name contains "project", so it failed there. It had been passing on macOS only because macOS spells it with a capital P. | The assertion states the property: the directory is named for the plugin, and it is not inside the project the plugin is running in. |
| The verification tests | `/bin/echo`, `/bin/sh`, `sleep`, `yes`, `touch`. | The runtime itself, which exists on all three platforms. |
| The benchmark's fake CLI | A shebang script, which is not an executable on Windows. | A bun program plus a batch file, and the harness runs a batch file the way Windows requires. |
| The clone fixture | A POSIX-only regular expression for a path's parent. On Windows it matched nothing, so the **whole path** was the working directory — one that did not exist yet — and the spawn failed with `ENOENT`, which reads exactly like a missing executable. | `dirname`. |

The benchmark's fake CLI also imported a module by the **pathname** of a
file URL. On Windows that pathname is `/D:/a/...`, with a leading slash
before the drive letter, and it is not a path the runtime can import — so
the fake died before it printed anything and the run was ungradable.
`fileURLToPath` gives a real path.

---

## 4. The gitignored dependency

The grader's regression test read `fixtures/bench/results/` — the
benchmark's own output directory, which is **gitignored** because it holds
11 MB of historical reports that must not be rewritten.

So the test ran only on the machine that produced the reports, and in a
fresh clone it took the whole file down. The regression corpus is now
extracted and **versioned** (`fixtures/bench/retained/content-answers.json`),
carrying the answers, the grade the old grader gave them, the error that
made a run invalid, and the regrade's own summary. The same answers are
now checked on every machine and every platform. The reports stay
untracked and unmodified.

A file-watcher test also raced: it waited for "any batch" while the
watcher may report the directory before the file. It now waits for what it
asserts.

The suite passes with the gitignored data absent, which is what a fresh
clone looks like. That is now checked on every run.

---

## 5. What the gate is now

- `fail-fast: false`, so one platform's failure does not cancel the
  others' evidence.
- Every gate runs on all three platforms: the typecheck, the suite, the
  pilot, the recovery rehearsal, the build, the isolated install with the
  installed parsers, the dependency audit and the SBOM, the artifact
  check, and the candidate manifest.
- The runtime versions, the revision and the dependency information are
  recorded, and the per-platform evidence is uploaded **whatever
  happened**.
- `permissions: contents: read` and **no publication job**.

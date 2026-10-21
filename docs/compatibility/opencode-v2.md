# OpenCode V2 plugin surface — verified

**Status:** Phase 0 evidence. Supersedes the hook matrix and tool API in `03-opencode-integration-and-api.md`.
**Pinned target:** OpenCode `2.0.28` (channel `latest`, app `desktop`), plugin API `@opencode/plugin@2.0.32`.
**Verified:** 2026-10-19, macOS.

The planning package was written against the **V1** plugin API. Every row below was checked
against the installed binary and the shipped `@opencode/plugin` / `@opencode/schema` types, then
confirmed by running the probe in `packages/compat-spike` against a live server.

Raw evidence: `fixtures/compat-evidence/run-2026-10-19/`.

---

## 1. Reproducing

```bash
cd packages/compat-spike && bun install
ln -sfn "$PWD" ~/.config/opencode/plugins/opi-compat-spike   # global install
mkdir -p /tmp/probe-run && cd /tmp/probe-run
opencode run --model deepseek/deepseek-flash \
  "Use the echo tool with value hello. Then use the edit tool to append a line to README.md. \
   Then call the status tool with include_payloads true."
```

The probe writes `.opi-probe.json` (summary), `.observations.ndjson` (every hook and
registration) and `.events.ndjson` (the raw server event stream) into the **session** directory.

---

## 2. The V1 → V2 deltas that matter

| Plan (V1) | OpenCode 2.0.28 | Verified by |
|---|---|---|
| `@opencode-ai/plugin` | `@opencode/plugin` | typecheck against installed package |
| `export const X = async ({ client }) => ({ hooks })` | `export default Plugin.define({ id, async setup(ctx) {} })` | probe loads |
| `tool()` helper, plugin `tool` map | `await ctx.tool.transform(editor => editor.add({...}))` | probe registers `echo`/`status` |
| `event` hook map (`session.created`, `file.edited`) | `ctx.event.subscribe({ signal })` | probe captures 188 events |
| `tool.execute.after` | `await ctx.tool.hook("execute.after", cb)` | probe captures 10 |
| `experimental.session.compacting` | `await ctx.session.hook("compaction", cb)` | hook registers; not exercised yet |
| config key `plugin` | config key `plugins` | live load |
| `@opencode-ai/plugin` `tool.schema.string()` | JSON Schema object, or a Standard Schema | typecheck |

---

## 3. Hook matrix — corrected

| Hook | API | Fires? | Notes |
|---|---|---|---|
| Session prompt admission | `ctx.session.hook("prompt", cb)` | **yes** | `event.prompt.text`, `event.delivery`. Runs once per admission, before attachment resolution. |
| Agent-loop model request | `ctx.session.hook("context", cb)` | **yes** | Fires **once per model call** (8× in the probe run). `event.system.push({type:"text", text})` injects context. This is the "routine prompt injection" risk: ADR 011 must cap it. |
| Compaction | `ctx.session.hook("compaction", cb)` | registers | V1's `experimental.session.compacting` is now `ctx.session.hook("compaction", ...)`. Not yet exercised — needs a forced compaction. |
| Title generation | `ctx.session.hook("title", cb)` | registers | Can set `event.result` to supply the title. |
| Tool input | `ctx.tool.hook("execute.before", cb)` | **yes** | `event.tool`, `event.input`. See §5 for the Code Mode caveat. |
| Tool result | `ctx.tool.hook("execute.after", cb)` | **yes** | `event.tool`, `event.status`, `event.result` / `event.error`. |
| Shell request | `ctx.shell.hook("create.before", cb)` | registers | Mutates command, cwd, timeout, env. |
| Permission evaluation | `ctx.permission.hook("evaluate", cb)` | registers | Can change `event.effect` to allow/ask/deny. |
| Retry policy | `ctx.session.hook("retry", cb)` | registers | Can veto a retry or change its delay. |

Every hook returns a `Registration` with `dispose()`. All must be disposed on plugin unload.

---

## 4. Event reality

The probe subscribed with `ctx.event.subscribe()` and recorded **every** event the server
published during a full agent session, plus all events from other live locations on the same
server.

### 4.1 The event stream is NOT location-scoped

One plugin instance received events for **seven** directories:

```
/private/var/.../opi-probe-run2        1666 events   (the session's own project)
/Users/nexussean/.../opencode-plugins/kanban   1626 events   (another session, same server)
/Users/nexussean/Documents/Coding/xreal        1180 events   (an unrelated project)
```

`ctx.event.subscribe()` is a **server-wide** stream. Every event carries
`event.location.directory`, so a plugin **must** filter on it.

> This is the single most important isolation finding. The planning package's NFR-03
> ("project namespace always derives from trusted adapter context") and risk R05 (cross-project
> data leakage, Critical) are satisfied only if every consumer filters by `ctx.location`.
> See [ADR-0014](../adr/0014-event-streams-are-not-location-scoped.md).

### 4.2 Events that fired during a full agent session

| Event | Fired | Use |
|---|---|---|
| `session.created` | yes | session lifecycle |
| `session.renamed`, `session.metadata.updated`, `session.instructions.updated` | yes | session metadata changes |
| `session.inbox.enqueued` / `.delivered` | yes | prompt admission and delivery |
| `session.step.started` / `.ended` / `.streamed` | yes | per-step progress |
| `session.text.*`, `session.reasoning.*` | yes | streaming output (high volume — 1 212 text deltas in one run) |
| `session.tool.*` (`called`, `input.started/ended`, `progress`, `success`) | yes | per-tool-call detail, including the raw input |
| `shell.created` / `.exited` / `.deleted` | yes | background shells |
| `session.usage.updated` | yes | token usage per step |
| `session.execution.succeeded` / `.failed` | yes (desktop session) | **durable** server-side completion signal |
| `session.idle` | **no** | *ephemeral*; client-side. Did not fire in a headless `opencode run`. |
| `file.edited` | **no** | Defined in the schema with `data.file`, but **did not fire** for a tool-driven edit. See §6. |
| `session.updated` | **does not exist** | Replaced by the `session.*` variants above. |
| `file.watcher.updated` | **does not exist** | Never existed in V2. |

**Conclusion for the hook matrix:** the plan's `session.created/updated/idle` triple must become
`session.created` + `session.execution.succeeded`/`failed` (durable, server-side). `session.idle`
is ephemeral and client-driven; do not depend on it.

---

## 5. Tool observation: hooks see the wrapper, events see the calls

`ctx.tool.hook("execute.before"/"execute.after")` fired with these tool names and input shapes:

| Tool | Observed input shape |
|---|---|
| `execute` | `{ code: string }` |
| `shell` | `{ command: string }` |
| `read` | `{ path: string }` |
| `edit` | `{ path: string, oldString: string, newString: string }` |
| `echo` (plugin tool) | `{ value: string }` |

> **The hooks are blind to Code Mode's inner calls.** `execute` is the **Code Mode** wrapper.
> When a model reaches tools through Code Mode, the hook sees one `execute` call with a
> `code` string; the individual inner tool calls are not observable *through the hooks*.

> **The event stream is not blind.** `session.tool.success` carries `metadata.toolCalls`, which
> lists every inner call with its name, input and status — including calls rejected by schema
> validation. From the tool-failure probe:
>
> ```json
> "metadata": { "toolCalls": [
>   { "tool": "echo", "status": "error", "input": { "value": 42 } },
>   { "tool": "echo", "status": "error" },
>   { "tool": "echo", "status": "completed", "input": { "value": "ok" } }
> ], "truncated": false }
> ```
>
> So: **hooks see the wrapper, events see the calls.** Prefer the event stream whenever you
> need to know what the agent actually did. Note `truncated: true` on large batches — a
> truncated list is not a complete one.

`execute.after` gives `event.result` (shape `{ output: object, content: array(n), metadata: object }`)
or `event.error.message` on failure. `event.status` is `"completed"` or `"error"`.

**Schema validation is client-side.** Invalid arguments are rejected before the tool body
runs, and the error reaches the model as a thrown exception it must catch:

```
Invalid arguments for tool "echo":
- value: Expected string
Arguments provided: { "value": 42 }
```

The rejected call still appears in `metadata.toolCalls` with `status: "error"`, which is what
makes the malformed-call metric measurable
(see [ADR-0018](../adr/0018-tool-surface-decided-by-measurement.md)).

---

## 6. File-change detection

`file.edited` is in the V2 event schema (`data: { file: string }`) but **did not fire** in
either probe session in which the agent used the `edit` tool to modify a file (verified: the
file changed on disk; zero `file.*` events in 1 666 captured events).

The tool event stream *does* reveal the `edit` call and its path. But it covers only
**model-initiated** edits, and a call is a request rather than a completed change. It misses
user edits in the editor, `git checkout`, formatters, codegen and any other writer.

So OPI's incremental indexer **cannot depend** on `file.edited` or on tool events alone:

1. A plugin-owned filesystem watcher (Bun `watch`) over the resolved project root, with hash
   reconciliation to catch missed events — the plan's "filesystem watcher/hash reconciliation
   fallback", promoted to primary.
2. The tool event stream as a fast path, to re-hash a path sooner than the watcher would.
3. Content hashes as the authority for freshness.

See [ADR-0015](../adr/0015-file-change-detection-uses-our-own-watcher.md).


## 7. Registration APIs

All four registration surfaces were exercised and work.

| Surface | API | Result |
|---|---|---|
| Tools | `ctx.tool.transform(editor => { editor.namespace({...}); editor.add({...}) })` | registers |
| Command | `ctx.command.transform(editor => editor.add({ name, description, execute }))` | registers; appears in `/` completion |
| Skill | `ctx.skill.transform(editor => editor.add({ id, name, description, path, content }))` | registers; appears in the skill list |
| RPC | `ctx.rpc.register(definition, handlers)` | registers; callable via `ctx.rpc(definition)` and over HTTP |

**Tool namespacing is subtle.** `editor.namespace({ name: "probe" })` alone does **not**
namespace the tools — the probe's tools were exposed to the model as `echo` and `status`. A tool
is namespaced only when its own definition carries `options: { namespace: "probe" }`. The
kanban plugin gets this right (`options.namespace`); the probe did not, which is how the
difference was found.

**Branded types.** `Skill.Info.id` / `.name` / `.path` are branded strings
(`Skill.ID.make(...)`, `Skill.Name.make(...)`, `AbsolutePath.make(...)` from
`@opencode/schema`). A plain `string` does not typecheck.

---

## 8. Location and identity

`ctx.location` at plugin setup:

```json
{
  "directory": "/private/var/.../opi-probe-run2",
  "workspaceID": null,
  "project": {
    "id": "dfcf94dfed85614d44c352e23c6ec62d65d86812",
    "directory": "/private/var/.../opi-probe-run2",
    "canonical": "/private/var/.../opi-probe-run2"
  }
}
```

- `ctx.location.project.id` is a stable project identifier; `directory` and `canonical` are
  paths. This is the trusted namespace source for NFR-03.
- **`process.cwd()` is the server's cwd, not the session's directory.** The probe's first
  version wrote its evidence to `/Users/nexussean` while working in a temp project. Always use
  `ctx.location.directory`.
- The plugin **instance** is per location: a global plugin is loaded once per project directory
  the server has booted.

---

## 9. Local directory plugins resolve entrypoints by path

`Host.resolve({ directory })` looks for `<dir>/index.ts`, `<dir>/tui.tsx` and `<dir>/rpc.ts` by
**path**. It does not consult the package's `exports` map for a directory target.

The first attempt at this probe put the implementation in `src/index.ts` and the plugin loaded
**silently and never** — no error in the log. Root-level re-export shims fixed it.

A package resolved by **name** (npm) does use the `exports` map. See
[ADR-0016](../adr/0016-directory-plugins-resolve-entrypoints-by-path.md).

---

## 10. There is a TUI plugin API, and the desktop app does not implement it

OpenCode 2.0.28 has a full terminal-UI plugin API: `@opencode/plugin/tui` with routes, session
panels, sidebar slots, keymap layers, dialogs, toasts and markdown renderers.

- `packages/tui/` implements it.
- `packages/app/` (the desktop and web UI) has **zero** references to it.
- The desktop app therefore never loads a plugin's TUI entrypoint, and a plugin's route, panel,
  keymap and slash command are all invisible there.

Server-side plugin behaviour (tools, skills, commands, RPC) works everywhere.

**ADR-006 stands** — the dashboard is a local web app — but for a sharper reason than the plan
gives: not "TUI customization is unsupported", but "the product's primary client does not
implement the plugin UI API at all".

---

## 11. Tool surface — the open question

The plan's ADR 009 chooses 7 namespaced tools with an `action` argument. The kanban prototype
uses 5 separate tools per action. Neither has been measured.

`ctx.tool.hook("execute.before")` gives the *effective* tool name and input shape, so a
harness can count malformed calls for both shapes against the same task set. That is OPI-004
work and the decision should wait for it.

---

## 12. Three more findings from building the benchmark

These surfaced while building `packages/bench`, and each one changes how a plugin must be
built or measured.

### 12.1 Plugin activation races the session's first model call

A plugin's `setup` is asynchronous and runs **after** the location boots. A session whose
first model call begins before `setup` finishes sees **no tools at all** — the model then
wanders off and answers from the filesystem instead. Observed repeatedly: the same task
sometimes called `opi_task_list` and sometimes reported "the board tools aren't exposed in
this session".

Waiting for the plugin to appear in `GET /api/plugin` before prompting removes the
flakiness entirely. **Any harness, integration test, or "resume" flow that assumes a
plugin's tools are present in the first turn is wrong.** The plan's compatibility fixture
(doc 03, "Version-compatibility tests") must cover this.

### 12.2 `codemode: false` removes a tool from Code Mode's catalog

`Tool.Options.codemode` is not "list this tool directly". It is "is this tool available in
Code Mode". Setting `codemode: false` **excludes** the tool from the Code Mode catalog —
and the default `build` agent reaches tools through Code Mode, so the tool becomes
unreachable in practice.

A plugin tool that should be usable everywhere must leave `codemode` **unset**, which
makes it available in the Code Mode catalog. To reach it, the model calls `search()` first.
That discovery step is part of the real cost of a tool surface, and a benchmark that
measures it measures the truth.

### 12.3 A non-interactive `opencode run` does not load project-config plugins

Against the **shared** background service, `opencode run` with a non-TTY stdin does not
activate the plugins configured in the *project's* `opencode.jsonc`. The same run with
`--standalone` (its own server, started in that directory) loads them. Plugins installed
**globally** in `~/.config/opencode/plugins/` load either way.

Isolated test runs therefore need `--standalone`, or a global install.

### 12.4 `metadata.toolCalls` only appears for Code Mode calls

`session.tool.success.metadata.toolCalls` lists the inner calls of a Code Mode `execute`
wrapper, with each call's name, input and status. A **direct** tool call has no
`toolCalls` array — its metadata carries only the tool's own result. So:

- Code Mode sessions: `metadata.toolCalls` is the complete inner-call list.
- Direct-call sessions: the tool name is not in the event payload.

Use the event stream for Code Mode sessions, and the plugin's own tool hooks for direct
sessions. Neither alone covers both.

### 12.6 A namespaced plugin tool appears in the catalog as `namespace.tool`

With `options: { namespace: "pi" }` and a tool named `status`, the model sees the tool
as **`pi.status`** — dotted, not underscored. The plugin's own `editor.namespace({ name })`
call does not namespace the tool; only the tool's own `options.namespace` does.

This is the *only* reliable way to read the catalog: a tool that is registered but never
called does not appear in the event stream at all, and there is no endpoint that lists a
location's tools.

### 12.7 A globally-installed plugin is set up once per server, not once per location

A plugin in `~/.config/opencode/plugins/` is loaded **once**, for the server, and its
`setup` runs against whichever location the server happened to start in. Two consequences,
both of which cost a benchmark run:

- Its **namespace is fixed** for the server's life. A namespace that varies per location
  does not work: the model keeps calling the namespace the tools were first registered
  under.
- Its **output paths are fixed** too. A plugin that writes a log to
  `<location>/.bench` writes it to the *server's* location — the one the session happened
  to be in — and not to the location the caller is interested in.

A plugin that has to serve several locations needs its paths and its namespace in its
**options**, configured once, and its per-location state read from the location itself.

### 12.8 A plugin registered twice loses its namespace to one of them

A plugin installed in `~/.config/opencode/plugins/` **and** configured in a project's
`opencode.jsonc` is registered twice. Both instances claim the same namespace, the
catalog carries both sets of tools under it, and the model's calls go to whichever
instance won — whose log is in a different directory. The first benchmark run made 435
calls to a tool and recorded **none** of them, for exactly this reason.

Register a plugin **once**. If it has to be globally available, put it in the global
config rather than in both places.

### 12.9 `Bun.spawn`'s `cwd` does not set `PWD`

A child spawned with `Bun.spawn({ cwd })` starts in that directory, but `PWD` still
points at the parent. OpenCode resolves the **project** configuration from `PWD`, so the
child finds no plugin configuration, loads nothing, and the model answers from the
filesystem. It looks exactly like a run that did nothing, and it is not.

Set `PWD` explicitly in the child's environment. A shell inherits `PWD` from the
directory it was started in, which is why the same command works from a terminal and
fails from `Bun.spawn`.

### 12.10 There are two OpenCode builds, and the plugin is loaded into one of them

On this machine:

| Build | Version | Role |
|---|---|---|
| `~/.opencode/bin/opencode` (on `PATH`) | 2.0.28 | the CLI |
| `~/Library/Application Support/ai.opencode.desktop/cli/2.1.0-arm64/opencode-cli` | 2.1.0 | the desktop app, and the service the plugin is loaded into |

They are separate binaries, they can run at the same time, and a `opencode service
restart` affects only the desktop app's. This document's findings are against **2.0.28**,
which is the pinned target; the running service is **2.1.0**.

A benchmark that spawns the `PATH` CLI while the plugin is loaded into the desktop
app's service measures a surface nobody uses. The benchmark now uses the desktop
app's own copy, so the thing measured is the thing that ships.

### 12.11 A plugin's tool surface can be recorded, and it is worth recording

`ctx.tool.transform`'s callback receives an editor whose `add` method registers a tool.
Wrapping that method records the plugin's **own** declared surface — every tool's
description and schema — which is the thing the model has to read on every request.

Three things are worth knowing:

1. **The callback may be `async`**, and a tool is not registered until the callback
   resolves. A surface recorded *after* the transform, in the setup function, is empty.
   It has to be recorded **inside** the callback, after the last `editor.add`.
2. **The transform runs once per location**, so the same tool is added more than once.
   The recorded surface is a **set** keyed by the tool's name.
3. **The file format is a choice.** Writing the surface in the same format the benchmark
   reads makes the two directly comparable, which is the point: a fixture's surface and
   the product's surface, measured the same way.

This is how OPI's own surface — 10,017 bytes, 5.1× the largest shape the benchmark
measured — was established as a number rather than an estimate.

---

### 12.5 Editing a plugin's dependency does not reload it

Adding an export to a workspace package a plugin imports, and then editing the plugin to use
it, fails with:

```
failed to load plugin ... SyntaxError: Export named 'SqliteJobQueue' not found
```

The plugin's *entrypoint* is re-read on change, but the modules it imports are cached by path
for the lifetime of the server process. The dependency is never re-evaluated, so the new
export does not exist.

**Restart the service after changing anything a plugin imports:**

```sh
opencode service restart
```

Editing the plugin's own entrypoint does hot-reload correctly. This only bites when the
*dependency* changes, which is exactly the case a workspace monorepo makes routine.

### 12.6 There is no LSP in OpenCode V2

Checked against the OpenCode source at `dev` and against the published packages:

| Surface | LSP present? |
|---|---|
| `@opencode/plugin` (the plugin API) | **No.** No `lsp` symbol in the published package. |
| `@opencode/client` | **No.** |
| `@opencode/schema` | An `lsp.updated` event and a `LspEvent.Definitions` inventory exist. |
| `packages/core/src` | **No implementation.** There is no `lsp.ts`, no `LanguageClient`, and no `textDocument/definition` call anywhere. |

The `lsp.updated` event is **declared and never produced**. The docs describe configuring
`lsp` servers and the config schema accepts the setting, but no code acts on it.

A plugin therefore cannot ask OpenCode for definitions or references, because there is nothing
to ask. See [ADR-0020](../adr/0020-the-plans-lsp-dependency-does-not-exist.md).

---

## 13. Blockers and gaps

| # | Blocker | Impact | Resolution |
|---|---|---|---|
| B1 | `file.edited` never fires | P3 indexer invalidation | Plugin-owned watcher (ADR-0015) |
| B2 | Event stream is server-wide | Cross-project leakage risk (R05) | Filter by `ctx.location` (ADR-0014) |
| B3 | Code Mode hides inner tool calls | Tool-based change detection unreliable | Same as B1 |
| B4 | `session.idle` is ephemeral and client-side | Unreliable "session finished" signal | Use `session.execution.succeeded/failed` |
| B5 | `session.updated` / `file.watcher.updated` do not exist | Plan's hook matrix references them | Matrix corrected in §4 |
| B6 | Compaction hook not yet exercised | ADR 031 (compaction context) unproven | Force a compaction in a fixture session |
| B7 | Plan's docs reference V1 URLs and types | Every integration ticket inherits the error | This document; update doc 03/10/12 to point here |
| B8 | Plugin activation races the session's first model call | A first turn may see no tools | Wait for the plugin to be active before prompting |
| B9 | `codemode: false` excludes a tool from Code Mode | Tool becomes unreachable for the default agent | Leave `codemode` unset |
| B10 | Non-interactive `opencode run` skips project plugins | Isolated test runs load nothing | Use `--standalone`, or install globally |
| B11 | Editing a plugin's dependency does not reload it | Confusing `Export named ... not found` | `opencode service restart` after changing a dependency |
| B12 | OpenCode has no LSP implementation | Call edges cannot be proven `resolved` | Module-level resolution (ADR-0020); a language server is a separate feature, not a spike |
| B13 | A plugin that throws during `setup` loses its **entire** tool surface | Every tool disappears, with only a WARN in the log | The index must degrade to empty rather than prevent load. Any `setup` failure is total, so no setup step may be allowed to throw |
| B14 | `ctx.tool.transform`'s callback may be `async`, but a tool added in it is not registered until the callback resolves | A surface recorded after the callback is empty | Record the surface **inside** the callback, after the last `editor.add` |
| B15 | A tool registered in the transform is registered **once per location** | A surface recorded naively counts each tool once per location | The recorded surface is a **set** keyed by tool name |
| B16 | A benchmark whose corpus is the working repository measures a moving target | A code change looks like a result change | Re-run the gate after any change to the repo; never quote it as a fixed number |

Nothing here blocks P0–P2. B1–B3 shape P3 and are the reason the indexer design must change.

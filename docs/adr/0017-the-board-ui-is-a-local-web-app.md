# ADR-0017: The board UI is a local web app, not a terminal panel

- **Status:** Accepted
- **Date:** 2026-10-19
- **Extends:** ADR-006
- **Evidence:** `docs/compatibility/opencode-v2.md` §10

## Context

ADR-006 chose a separate local dashboard API because "no unsupported OpenCode TUI
customisation" was available. That was true for V1 and is still true, but the reason is sharper
in V2:

OpenCode 2.0.28 **does** have a full terminal-UI plugin API (`@opencode/plugin/tui`) with
routes, session panels, sidebar slots, keymap layers and dialogs. It is implemented in
`packages/tui/` — and **not** in `packages/app/`, which backs the desktop and web clients.

So:

- The terminal TUI can render a board, and a working prototype exists.
- The **desktop app never loads a plugin's TUI entrypoint.** A plugin's route, panel, keymap and
  slash command are all invisible there.

The planning package's product intent is a dashboard for people (W7, FR-13). The product's
primary client cannot host plugin UI at all.

## Decision

The board is a **local web application** served by a loopback-only HTTP API, separate from the
plugin's process, and reached through the user's browser.

- All reads and writes go through the core service. The frontend holds no authoritative state
  and never transitions a task itself — it asks, and rolls back on conflict.
- The API binds `127.0.0.1`, requires a per-run token, sends no CORS headers, and derives the
  project scope from the server-side resolver rather than a client-supplied path.
- A terminal board may exist as a **secondary** surface for quick reference inside the terminal
  TUI. It is never the product surface.

## Consequences

- The dashboard works in every client, including the desktop app's browser pane.
- The frontend can be any stack. The prototype is dependency-free vanilla JS; the plan calls
  for SvelteKit with a graph explorer. Either satisfies this ADR — the ADR constrains the
  *architecture*, not the framework.
- Two deployments exist (plugin for the agent, local service for the UI). The installer must
  make starting the dashboard discoverable (`/pi-dashboard`), and the dashboard must degrade
  cleanly when the service is not running.
- Because the dashboard runs outside the plugin process, it needs its own auth story, which is
  already specified in doc 06 and OPI-039.

## Alternatives

- **Terminal-only board.** Rejected: unusable in the desktop app, and cramped — a five-column
  board in a terminal truncates every title.
- **A native webview inside the desktop app.** Rejected for v1: the only route is the `.ocdx`
  extension format, whose SDK is `private: true` and unpublished, whose renderer bundles are
  not implemented, and whose documentation says the format is incomplete. Revisit if OpenCode
  ships a supported desktop extension API.
- **Fork OpenCode's TUI.** Rejected by the plan's own "custom OpenCode UI fork" row.

## Revisit condition

OpenCode ships a supported, public extension API for the desktop or web client.

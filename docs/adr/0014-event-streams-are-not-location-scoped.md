# ADR-0014: Event streams are not location-scoped, so every consumer filters by `ctx.location`

- **Status:** Accepted
- **Date:** 2026-10-19
- **Evidence:** `docs/compatibility/opencode-v2.md` §4.1
- **Addresses:** NFR-03 (Isolation), R05 (cross-project data leakage, Critical)

## Context

`ctx.event.subscribe()` yields the **server-wide** event stream. One probe plugin instance
received events for seven directories during a single session, including an unrelated project
(`~/Documents/Coding/xreal`, 1 180 events) and another live session.

The planning package's threat model treats cross-project leakage as *Critical*, and its rule
is "project namespace always derives from trusted adapter context, not user/model-supplied
paths". A naive consumer of the event stream violates that rule by construction.

## Decision

Every event consumer filters on `event.location.directory` (and `workspaceID` when present)
before acting. The filter compares against the **trusted** `ctx.location` captured at plugin
setup — never a path from the model or from event payload contents.

The adapter owns this filter. Services below the adapter receive already-scoped events and are
not given a location argument they could be tricked into.

## Consequences

- The event handler must not assume it is running in the plugin's own project.
- Cross-location events are cheap to receive but must be discarded cheaply too: filter before
  deserialising or recording.
- A "did another project touch my code?" question is not answerable from the event stream and
  must not be attempted.

## Alternatives

- **Ask OpenCode to scope the stream.** No such option exists in V2.
- **Subscribe per location via the HTTP API.** The `/api/event` endpoint takes a `location`
  parameter, but the plugin's own `ctx.event.subscribe()` does not. Filtering in-process is the
  only portable option, and the HTTP path must be filtered the same way.

## Revisit condition

OpenCode exposes a location-scoped subscription API.

# Changelog

## 0.1.0 — unreleased

Initial release candidate: six domain tools for project context, graph navigation,
tasks, memory, verification, and status; SQLite-backed task state and audit history;
local dashboard; TypeScript/JavaScript and Go indexing.

The full tool descriptions remain the default. Minimal descriptions are experimental.
Code Mode event auditing is experimental, disabled by default, and not a release
security guarantee. Rust/Python indexing is not included.

Only `release/bundle` is distributed. Private `@opi/*` workspace packages are
internal build inputs, retain `0.0.0`, and are not independently published.
The release version is taken from the adapter's `PLUGIN_VERSION`.

Cross-platform support is pending macOS, Linux, and Windows CI evidence. This
candidate has not been published. Repository target: nexussean/nexus-opi. Registry name/scope is unconfirmed.
Licensing is undecided; the unpublished bundle is private and marked UNLICENSED
until the owner chooses terms. This is packaging metadata, not a legal conclusion.

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
candidate has not been published to npm.

## 0.1.0 — identity and licence

- The package is `@nexussean/opencode-project-intelligence`.
- The licence is the **GNU Affero General Public License, version 3 or later**.
  The full text is in `LICENSE`; the notices are in `LICENSE-NOTICE.md`.
- The repository is <https://github.com/nexussean/nexus-opi>.
- The **runtime** identifier is unchanged: the plugin id, the skill id and the
  data directory remain `opencode-project-intelligence`, so an existing
  installation's registry, projects and tasks are not orphaned by the rename.
- The dashboard carries the AGPL's Appropriate Legal Notices and a **Source**
  link, which is how a modified instance offers its Corresponding Source to
  the people using it over a network (AGPL section 13).
- The licence now travels inside the tarball, and the artifact check fails if
  it is missing.

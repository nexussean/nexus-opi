# OPI-009 acceptance evidence

The plugin was installed globally with a symlink:

    ln -sfn <repo>/packages/adapter-opencode ~/.config/opencode/plugins/opi

**Loads across two repos.** Two independent git repositories, each with a session:

| Project | Reported |
|---|---|
| `opi-repo-a` | `9a5e0fc7-79e9-4dc0-8c64-294051836a2e`, strategy `git` |
| `opi-repo-b` | `a40e1b97-8c7b-4325-8893-d27f5742c522`, strategy `git` |
| `opencode-plugins/kanban` (not a git repo) | `674a550c-…`, strategy `path` |

Different ids, and the non-git project is correctly identified as `path`.

**The registry** (`~/Library/Application Support/OpenCodeProjectIntelligence/registry.sqlite`)
held all three projects and three worktrees.

**Scoped status.** `pi_status` with `action: doctor` returned the project, the worktree, the
resolved registry path, the plugin version and the enabled flags — and reported the index as
**absent** rather than implying it was fresh. See `status-doctor.json`.

**Uninstall smoke test.** After removing the symlink:

- the user repository's files were byte-identical (sha256 before and after),
- the app-owned database was retained,
- the plugin disappeared from `GET /api/plugin`,
- and the `pi` tool namespace disappeared from the session's tool list.

# Experimental Code Mode audit policy

This capability is disabled by default and is not a release security guarantee.
T-13 remains pending a live runtime compatibility test. Unit tests alone do not
establish completeness of the runtime event stream.

Enabling requires both `OPI_EXPERIMENTAL_AUDIT=1` and `OPI_AUDIT_LOG`.
The consumer accepts only top-level runtime location metadata and requires exact
directory and workspace-ID agreement with the plugin context. Missing directory
metadata is rejected. It never searches the payload for attribution. The trust
assumption is that the runtime, not a tool or model, sets that envelope; verify
this against the exact runtime before enabling. Equal absent workspace IDs are
accepted for a runtime context without a workspace ID.

Commands are withheld by default. `OPI_AUDIT_INCLUDE_COMMANDS=1` explicitly opts
into retaining raw commands, which may contain passwords, tokens, personal data,
and file contents. No regex-based secret removal can make arbitrary commands safe.
Do not enable raw command retention for shared or production environments until
an owner approves that policy. Withheld commands do not satisfy T-13's command
capture requirement; this is deliberately reported as incomplete coverage.

New directories use mode 0700 and files 0600. On POSIX, existing files with group
or other access are refused; symlink following is refused where O_NOFOLLOW is
supported. Windows ACL enforcement is not yet validated and remains a live
platform audit prerequisite. Logs do not expire automatically. The user owns
retention and deletion; archive or remove them while the audit is stopped.
The writer refuses a batch that would exceed 8 MiB based on the observed size;
this is not a transactional quota across multiple audit writers.

A failed write emits a warning without command content. A truncated batch with
zero visible calls emits a marker rather than disappearing. Loss of the stream,
unsupported payload shapes, or application termination can still leave missing
records: the audit must not be advertised as a complete security ledger.

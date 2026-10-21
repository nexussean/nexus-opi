# Outcome validation contract

The harness uses report format 4 and oracle `structured-sqlite-v1`. These runs are a
new experiment version: structured read-answer instructions are appended identically
to every shape. Do not pool their results with older free-text runs.

## Final answer extraction

The harness groups completed text parts by session/message ID, keeps only the last
model step, joins distinct parts, and replaces repeated snapshots of the same part.
Reasoning and tool output are never graded as answers. A later tool call, model step,
truncated JSON event, incomplete text part, error event or mixed session trace prevents
an earlier message from masquerading as the final answer. Process failure and timeout
remain ungradable regardless of apparent answer/state success.

The retained CLI event fixture in `fixtures/bench/events/` demonstrates a completed
final text without a final usage event. Extraction therefore does not require final
`step_finish` when the process succeeds and the text part has an end marker. The
fixture is a shortened retained local benchmark trace with IDs anonymized; its exact
binary version was not captured, so it does not certify a runtime version. Synthetic
tests cover multi-part answers, duplicate snapshots, truncation and session mixing.

## Read tasks

Before launch, the harness takes a read-only transaction snapshot of the authoritative
SQLite board. Expected cards and values come from that snapshot, not from the static
`SEED_FACTS` copy. For legacy fixture shapes, expectations come from the initial JSON
fixture; those remain a separate experiment with weaker storage parity.

The final answer must be one JSON object with `cards` and integer `count`:

```json
{"cards":[{"key":"kb-seed03","title":"Existing card three","state":"in_progress","priority":2}],"count":1}
```

- `list-all`: exactly the seeded keys and their count.
- `list-column`: exactly the keys whose pre-run state is `in_progress` and their count.
- `get-one`: exactly `kb-seed03`, its title, state, priority, and count 1.

Extra/duplicate keys, wrong counts or wrong supplied facts fail. `high` and `2`/`"2"`
are equivalent priorities; spaces/hyphens in `in_progress` are accepted. Prose, markdown
fences, an `unable` response, malformed objects and unrecognized fields are ungradable,
with explicit reasons. Such runs remain in the attempt denominator. This avoids trying
to infer truth from negated or speculative prose. SQLite read runs also fail if they
change authoritative rows/history/policy.

The old lexical helpers are retained for historical tests; they no longer grade runs.

## Supported SQLite writes

| Task | Required authoritative result |
|---|---|
| `update-priority-change` | `kb-seed01` changes from low to medium, with revision and matching update event. |
| `move-card` | `kb-seed01` changes from backlog to `in_progress`, with matching transition history. |
| `error-missing-arg` | All card priorities are urgent; each changed card has revision/audit evidence. An already-urgent card can stay unchanged. |
| `complete-card` | `kb-seed04` changes from review to done, with matching transition history and honest `not_configured` verification. |

The last two newly added fixtures avoid the old `update-priority` no-op: `kb-seed02`
was already medium. A pre-existing target value alone is never evidence that a write
was performed. The existing `kb-seed05` done row must remain unchanged except for its
explicitly requested priority during the bulk operation.

Checks preserve task identities, prior event history, unrelated fields/tasks, dependency
edges and verification policy/runs. Revision increments must match added, contiguous,
attributed events with appropriate payloads. Direct row edits without a valid history
fail. These tests assess data/history consistency, not cryptographic proof of who
executed a write; a local process with arbitrary DB access can fabricate consistent rows.

These fixtures deliberately have no configured verification gates. The oracle rejects
fabricated passing/waived evidence and does not claim to validate configured-gate success.
Unsupported label/`todo` semantics, creation/deletion/multi-step tasks, legacy in-memory
fixture writes, and nonempty verification policies remain explicitly ungradable rather
than silently approximated. Further write families need their own acceptance contracts.

## Reproducibility and accounting

Each raw report includes the pre/post snapshots, extracted answer, extraction reason,
verdict, oracle version, and exact effective-prompt hash. With `--keep`, `before.json`
and `outcome.json` also remain beside the raw trace outside the project. No oracle
expectations are given to the model as project artifacts.

`successRate` uses every attempted run; `gradedSuccessRate` is conditional accuracy.
`totalSpend` is the recorded spend across all attempts. `measuredCostPerSuccessfulTask`
is that recorded spend divided by successes, a lower bound when usage is incomplete.
`costPerSuccessfulTask` is null unless there is at least one success and every attempt
has complete usage. `incompleteUsageRuns` makes that limitation explicit. Complete
usage requires a priced finish for every observed model message, including the last.

Example small product-availability run (provider calls may incur charges):

```sh
bun run packages/bench/harness/run.ts --shapes opi,none-opi \
  --tasks list-all,list-column,get-one,update-priority-change,move-card,complete-card,error-missing-arg \
  --repeats 1 --keep
```

This implementation was validated with actual SQLite stores, retained CLI event data,
and a fake CLI subprocess. No new provider-backed comparison or cost win is claimed.
A stable runtime/source manifest, randomized scheduling, additional write contracts,
and a live pilot remain follow-up work under OPI-N02.

# Repair plan — the OPI benchmark

Recorded 2026-10-21, before any change was made. The source fingerprint and the runtime
version are recorded here so that every result produced after this point can be tied to
the code that produced it.

## The baseline

| | |
|---|---|
| Source fingerprint (131 `.ts` files under `packages/` and `scripts/`) | `sha256:2c2c41b1b4ff4d3fb32f47e8f9cd74145f225be1be3078c1c1f734deab4ae77b` |
| `packages/adapter-opencode/src` | `sha256:e6ce329e602b9a64…` (13 files) |
| `packages/bench/harness` | `sha256:7bb5f3f42b31f42f…` (4 files) |
| Runtime (`opencode --version`) | 2.0.28 on `PATH`; the desktop app's own copy is **2.1.1-arm64** and is what the harness spawns |
| Provider | `ollama-cloud` |

## The findings, and what each one turned out to be

| # | Finding | Status | Evidence |
|---|---|---|---|
| 1 | `descriptionFor()` returns the same minimal text regardless of the wording variant | **Confirmed** | `descriptions.ts:270-273` — the `size === "minimal"` branch returns `MINIMAL_DESCRIPTIONS[tool]` before the variant is consulted |
| 2 | The tool-count check does not recognise `opi-minimal-split` | **Confirmed** | `run.ts:868-870` tests `shape === "opi-split"` only. The retained report `report-2026-10-21T13-33-45-207Z.json` shows `opi-minimal-split`: **18 attempted, 0 completed, 18 invalid**, all "Unexpected registered tool count" |
| 3 | `hasCompleteUsage()` exempts the final answer, and the cost total sums only `step_finish` | **Confirmed, and the cause is found** | The CLI's `--format json` emits **no** `step_finish` for a text-only final answer. The server's store (`~/.local/share/opencode/opencode.db`, table `session_message`) **does** hold it, with `cost` and `tokens`. Three real bench runs recover 24–58% more spend than the harness recorded |
| 4 | The split branch uses fixed descriptions and arguments | **Confirmed** | `task-tool.ts:186-198` — `ACTION_PROPERTIES` and `ACTION_DESCRIPTIONS`, which bypass both the wording variant and the minimal arguments |
| 5 | Runs are scheduled in arm blocks | **Confirmed** | `run.ts:1182-1191` — the schedule is model → shape → task → repeat |
| 6 | The ADR overstates the evidence | **Confirmed** | ADR-0027 says the ungradable run "moving between tasks" is "the signature of run-to-run format noise". That is an inference, not an observation, and it is not supported without a randomisation or a repeat study. Separately, the minimal descriptions change **instructional content**, not only byte count, so it is not a pure size intervention |

### Two things that are not defects but are uncertainties

- **The "minimal" arm is not a pure size intervention.** It shortens the prose *and*
  removes the "when is this required" guidance from the arguments. That is a real
  behavioural difference, and the ADR must describe it as *shorter descriptions*, not as
  *schema size*.
- **The re-measurement's reversal is unexplained, not explained.** Moving ungradable runs
  between tasks is *consistent with* format noise, and also *consistent with* a lever
  working. The current data cannot tell them apart.

## What will be changed

### Phase 2 — the treatments

1. `descriptionFor()` takes the wording variant into account for the minimal size. The
   minimal schema gets **two** wordings, so the wording comparison survives on the minimal
   surface. Where a distinction cannot be preserved, the comparison is removed rather
   than reported as if it existed.
2. The split branch takes its descriptions and argument descriptions from the same
   variants, so the structure arm varies **only** the structure.
3. The expected tool count is **derived from the structure**, not from the arm's name.
4. Integration tests render the surface and assert the treatments differ and the
   unrelated dimensions do not.

### Phase 3 — billing

5. The cost is recovered from the server's session store, keyed by session and message
   identity, with duplicates removed. A missing usage event is **never** treated as zero
   cost.
6. Three things are reported separately: **execution completed**, **answer correct**,
   **billing complete**. Where billing is incomplete, the measured partial spend is
   reported and the complete cost-per-success is withheld.

### Phase 4 — grading

7. A versioned, content-aware grader that grades the final answer's **facts** against the
   run's own seeded snapshot, and keeps **format compliance** as a separate metric.
8. Retained answers are regraded into **new** reports that link to the originals. The
   historical verdicts are not overwritten.

### Phase 5 — measurement

9. A randomised, seeded, interleaved schedule, persisted with the report.
10. Fingerprints for the source, the rendered surface, the prompt and the grader version
    are recorded in every report.
11. The task set, repetitions, metrics and run budget are declared before the run.

### Phase 6 — decisions

12. ADR-0027 is corrected: the arithmetic, the causal language, and the claim about
    format noise. The six-tool interface is retained provisionally.

## What will not be done

- **The shipping default will not be changed.** The minimal descriptions are not shipped
  on the strength of this session's results; the question is answered by the re-measurement
  in Phase 5, not decided here.
- **Historical reports will not be modified.** The regrading writes new files that link to
  the originals.

# The repaired harness

Recorded 2026-10-21. This is the guide to the modules the repair added, and
to what each one is for. It is the companion to [the repair
plan](repair-plan.md) (what was wrong) and [the regrade
findings](regrade-findings.md) (what the repair revealed).

## The modules

| Module | For |
|---|---|
| `packages/bench/harness/content-grader.ts` | Grading the final answer's **content**, and reporting the format beside it |
| `packages/bench/harness/billing.ts` | The **authoritative** cost of a run, recovered from the runtime's session store |
| `packages/bench/harness/fingerprints.ts` | The source, surface, prompt and runtime **fingerprints** |
| `packages/bench/harness/schedule.ts` | The seeded random number generator, shared by the schedule and the bootstrap |
| `packages/bench/harness/uncertainty.ts` | The **bootstrap interval** for the cost per successful task |
| `packages/bench/harness/regrade.ts` | Regrading the retained answers into a **new** report |
| `packages/bench/harness/regraded-comparison.ts` | The per-arm comparison, under both graders |
| `packages/bench/harness/decision.ts` | Applying the **pre-registered** decision rule |

## The content grader

`content-v1`, fingerprinted `content-v1-f08e5508`. Fifteen frozen rules, in
`GRADER_RULES`.

**It grades the content.** The old grader required a bare JSON object and
reported everything else as "ungradable", and the arms differed in how often
they produced JSON — so format compliance substantially determined the old
success rate. The content grader decides; the format is reported beside it,
in `format` and `formatCompliant`.

The old grader was not content-blind — it checked the card set, the count and
each card's fields, and the new grader agrees with every one of its passes.
What changed is the **denominator and the selection**, not the correctness
of the passes.

**It has to work out what a claim is.** The hard parts, each of which was a
real defect found by regrading the retained answers:

- A card key in the text is **not** a claim that the card is in the answer's
  set. "The other four cards are in `backlog` (kb-seed01, kb-seed02),
  `review` (kb-seed04), and `done` (kb-seed05)" **excludes** those cards.
- A value belongs to the card it is nearest to, **in the same sentence**, and
  a value inside a parenthetical group is shared by the cards in that group.
- A value cannot reach back across a sentence boundary to a card in an
  earlier sentence.
- A card named in an excluded group governs no value.
- Two candidates that disagree are **ungradable**, never a pass.
- A hedged claim ("probably kb-seed02") is **ungradable**.
- A refusal is **ungradable** — never a pass and never a failure.
- The expectations are **per task**: a listing asks for a set, a column for
  a subset, a single card for that card's fields.

**It never passes an answer because the expected token appears somewhere.**
Every claim is checked against the run's own pre-run snapshot.

### The regression that protects it

`packages/bench/test/content-grader-retained.test.ts` checks every retained
answer, and the test that matters is:

> **No answer the old grader passed may now fail.**

The old grader was strict about the truth, so its passes are a sound floor.
The grader cannot get looser without the test failing.

### The execution validity, and the four metrics

A run that did not complete — a timeout, a launch failure, an invalidated
surface — is **not an experimental observation**, whatever its answer
contains. The regrade records such a run's content grade, and excludes it
from the **content accuracy**. The first version of the regrade counted a
correct answer from a timed-out run as a success; the correction reduced
the recovered format failures from 65 to 48. The rule is pinned by
`packages/bench/test/regrade-validity.test.ts`.

**But the invalid runs are not excluded from every denominator.** That was
a second over-correction, and it is the one that would have made an
unreliable arm look successful. The four metrics answer four different
questions:

| Metric | Numerator | Denominator |
|---|---|---|
| **Content accuracy** | correct answers | the runs that **executed** |
| **End-to-end success** | correct completions | every run **attempted** |
| **Execution failure rate** | the runs that did not execute | every run **attempted** |
| **Cost per successful task** | the spend of **every** attempt | the correct completions |

A run that timed out has no answer to be right or wrong about, so it is
not in the content accuracy. But the user asked for an answer and did not
get one, so it **is** in the end-to-end rate and in the execution failure
rate. And the money it spent is in the numerator of the cost.

**What the difference shows.** The `opi-minimal-split` arm has a **100%
content accuracy** and a **5.3% end-to-end success** — 18 of its 19 runs
never executed. Excluding the invalid runs from every denominator would
have made it look perfect, and it is the worst arm in the file.

The metrics are in `summariseOutcomes`, and the separation is pinned by
`packages/bench/test/metrics.test.ts`.

**The timed-out run's spend is recovered.** A run that was cut off still
spent money, and the money is in the runtime's session store if the run got
far enough to be billed. The harness consults the store on the timeout path
too, and marks the figure incomplete — a run cut off mid-flight may have
been billed for work the trace never showed. Recording it as $0 would make
a failing arm look cheap.

## The billing

The CLI's `--format json` prices every **step**. The **final answer** is not
a step: the trace ends with a `text` event and no closing `step_finish`. The
harness used to sum the `step_finish` events, so it recorded **$0** for a run
that cost $0.00071.

The runtime's session store has it: `~/.local/share/opencode/opencode.db`,
table `session_message`, one row per message with the assistant message's
`cost` and `tokens`.

`billing.ts` recovers it by **session and message identity**, with
duplicates removed, and the store is opened **read-only** — the benchmark
must never write the database it is measuring against.

Three things are reported **separately**, and never added together:

| | |
|---|---|
| **Execution** | did the run complete? |
| **Answer** | was the answer correct? |
| **Billing** | is the recorded spend the whole cost? |

A missing usage event is **unknown**, never zero. The complete
cost-per-success is **withheld** for any cell whose billing is incomplete,
and the measured lower bound is reported in its place, labelled as one.

## The fingerprints

Every report carries:

- the **source** — every `.ts` file under `packages/` and `scripts/`, hashed
  in path order;
- the **surface** — the **rendered** schemas, per shape, from the plugin's own
  `surface.json`. A reader can check that two arms really did differ without
  trusting the arm table;
- the **prompt** — the exact text the model was given, per task;
- the **runtime** — which build of the runtime answered, by path, size and
  modification time.

The surface fingerprint is what makes "the arms differ" checkable. It
changes when a description changes, when a tool is added, and when an
argument's description changes.

## The schedule

The runs used to be scheduled in **arm blocks**: every run of one arm, then
the next. That correlates the arm with the provider's cache state, its rate
limit and its own load at that moment.

The schedule is now a **seeded randomisation in blocks**. The seed is
persisted in the report, so the same seed gives the same schedule and a run
can be repeated exactly. Each block holds one run per cell per repeat, so the
arms are **balanced within every block**: a provider hiccup that hits one
block hits every arm in it.

The measured difference: a blocked schedule puts **33 of 35** runs next to a
run of the same arm; the randomised one puts **4 to 9**.

## The uncertainty

The comparison is a comparison of **intervals**, not of point estimates. The
cost per successful task is resampled with a **bootstrap** — 10 000
resamples over the arm's runs — and the two arms' 95% intervals are
compared.

- The numerator is the resampled runs' total spend, **including** the runs
  that failed, because the spend happened.
- A resample with no successes has **no** ratio. It is not a zero, and the
  count of usable resamples is reported.

**Overlapping intervals mean the difference is not resolved.** That is the
pre-declared bar, and it is the reason the schema-size question is not
settled by a point estimate.

**What the bootstrap does not do.** It does not correct for a systematic
difference between the arms — a provider that was slower during one arm's
runs. That is what the randomised schedule is for.

## The scripts

```sh
# Regrade the retained answers into a new report. The historical verdicts
# are not modified.
bun run packages/bench/harness/regrade.ts

# The per-arm comparison, under both graders.
bun run packages/bench/harness/regraded-comparison.ts

# Apply the pre-registered decision rule to a run's report.
bun run packages/bench/harness/decision.ts fixtures/bench/results/latest.json
```

The regrade writes `fixtures/bench/results/regrade-*.json`; the comparison
writes `regraded-comparison-*.json`. Both are **new** files, and both name
the source reports they came from.

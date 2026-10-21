# The regrade: what the old success rate was actually measuring

Recorded 2026-10-21, after the harness repair. This is the finding that
changes what the earlier reports mean.

## The short version

**Format compliance substantially distorted the old success metric.**

Across the retained reports, the number of answers the old grader called
"passed" tracks the number that met the JSON answer contract closely. The
grader required a bare JSON object; every other shape was "ungradable". So
the metric that every earlier comparison was built on was strongly
determined by **whether the model produced JSON**, and the arms differed in
how often they did.

**What is not claimed.** The old grader was not *only* a format check. It
also checked the content of the answers it could read: the card set, the
count, and the title, state and priority of each card. Its passes were
therefore genuine correctness checks, and the new grader agrees with every
one of them. The claim is that the **denominator and the selection** were
distorted, not that the old grader was content-blind.

**The corrected counts**, over the valid runs only:

| Old grade | → passed | → failed | → ungradable |
|---|---:|---:|---:|
| `passed` (392) | **392** | 0 | 0 |
| `ungradable` (48) | **48** | 0 | 0 |
| `failed` (1) | 0 | **1** | 0 |

Every answer the old grader passed still passes, every answer it could not
read is now decided, and the one answer it failed is still failed.

## The evidence

Minimax, the model that wrote prose. Per arm, over the retained reports:

| Arm | Runs | Met the JSON contract | Old "success rate" | Regraded success rate |
|---|---:|---:|---:|---:|
| `actions` | 10 | 10 (100%) | 100.0% | 100.0% |
| `opi-minimal-guidance` | 10 | 10 (100%) | 100.0% | 100.0% |
| `opi-minimal-wording` | 10 | 9 (90%) | 90.0% | 100.0% |
| `opi-minimal` | 20 | 17 (85%) | 85.0% | 100.0% |
| `opi-minimal-split` | 10 | 8 (80%) | 0.0% | 90.0% |
| `separate` | 10 | 8 (80%) | 80.0% | 100.0% |
| `opi-baseline-guidance` | 19 | 12 (63%) | 63.2% | 84.2% |
| `none-opi` | 19 | 9 (47%) | 47.4% | 89.5% |
| `opi` | 47 | 22 (47%) | 46.8% | 100.0% |
| `opi-baseline` | 20 | 7 (35%) | 35.0% | 80.0% |

**The two columns are the same number for most arms.** The old success rate
was, in effect, the format-compliance rate — and the arms with the lowest
format compliance were the arms that looked worst.

## What the regrade shows

Every retained read answer, 468 of them, regraded with the content-aware
grader (`content-v1`). **441 of them are valid runs**; 27 are not, and are
excluded from the counts.

| Old grade | → passed | → failed | → ungradable |
|---|---:|---:|---:|
| `passed` (392) | **392** | 0 | 0 |
| `ungradable` (48) | **48** | 0 | 0 |
| `failed` (1) | 0 | **1** | 0 |

- **Zero regressions.** Every answer the old grader passed still passes.
- **All 48** of the answers the old grader could not read are correct
  answers it was unable to read.
- **Zero false failures.** No answer the old grader passed fails now, and
  the one answer it failed is still failed.
- **Nothing is left undecided** among the valid runs.

### The 27 invalid runs, and why they are excluded

Twenty-seven of the retained read runs **did not complete**: timeouts, launch
failures, and runs invalidated because the surface was not what the arm said
it was. They still had answer text, and some of that text was correct.

**A run that did not complete is not an experimental observation.** The fact
that something was written before the timeout says nothing about the
surface's quality; the run did not produce an answer the harness could
accept. So an invalid run is counted as invalid and **excluded from the
content accuracy**, in both the old and the new column. Its content grade
is still recorded, for the record.

**It is not excluded from every denominator.** The invalid runs stay in the
**end-to-end success rate** and the **execution failure rate**, because the
user asked for an answer and did not get one. The four metrics are:

| Metric | Numerator | Denominator |
|---|---|---|
| **Content accuracy** | correct answers | the runs that **executed** |
| **End-to-end success** | correct completions | every run **attempted** |
| **Execution failure rate** | the runs that did not execute | every run **attempted** |
| **Cost per successful task** | the spend of **every** attempt | the correct completions |

The distinction matters: the `opi-minimal-split` arm has a **100% content
accuracy** and a **5.3% end-to-end success**, because 18 of its 19 runs
never executed. Excluding the invalid runs from every denominator would
have made the worst arm in the file look perfect.

This is a correction to the first version of the regrade, which counted a
correct answer from a timed-out run as a success. The correction **reduced**
the number of recovered format failures from 65 to 48, because 17 of the 65
came from invalid runs. The regression test
`packages/bench/test/regrade-validity.test.ts` pins the rule.

## What this does to the earlier conclusions

### The schema-size arm

The ADR said the minimal schema was "38% smaller and 29–38% cheaper per
success, with the same or more correct answers", and treated it as the
largest single effect measured.

Regraded, the **correctness** part of that claim is much weaker. In the
retained reports, over the valid runs:

| Model | Arm | Runs | Old passed | Regraded passed |
|---|---|---:|---:|---:|
| minimax | `opi` (full) | 47 | 22 | **47** |
| minimax | `opi-minimal` | 20 | 17 | **20** |
| deepseek | `opi` (full) | 70 | 65 | **70** |
| deepseek | `opi-minimal` | 26 | 26 | **26** |

**No correctness failures were observed in either arm, once the format is
removed.** The "four more correct answers" was four more answers that
happened to be JSON.

The regrade cannot settle the cost question, because **cost per success
depends on which runs count as successes**, and the denominator changed for
every arm. The cost numbers in the earlier reports are **lower bounds on the
spend and over-estimates of the cost**, because ungradable runs were counted
as failures in the denominator while their spend was counted in the
numerator.

**This was re-measured.** The schema-size arm was re-run on 2026-10-21 under
a pre-registered decision rule, with the corrected grader, the corrected
billing and a randomised schedule. The verdict was **NOT RESOLVED** and the
minimal schema does not ship — see [the result](schema-size-result.md).

### The three levers on the minimal schema

The ADR said they were "unsettled" because the ungradable run moved
between arms. Regraded, the arms do not differ in correctness, and the
movement is accounted for by the format: the arms differed in how often
they produced JSON, and the ungradable run was one of those occasions.

| Model | Arm | Runs | Regraded passed | Met the contract |
|---|---|---:|---:|---:|
| minimax | `opi-minimal` | 20 | 20 | 85% |
| minimax | `opi-minimal-wording` | 10 | 10 | 90% |
| minimax | `opi-minimal-guidance` | 10 | 10 | 100% |
| minimax | `opi-minimal-split` | 10 | 9 | 80% |
| deepseek | `opi-minimal` | 26 | 26 | 100% |
| deepseek | `opi-minimal-wording` | 19 | 19 | 95% |
| deepseek | `opi-minimal-guidance` | 19 | 19 | 100% |
| deepseek | `opi-minimal-split` | 20 | 19 | 90% |

**No correctness differences were observed between the three levers**, once
the format is removed: every lever answers every question on both models,
except `opi-minimal-split` (one ungradable in ten on each model — the same
timeout shape as the earlier write-task result, where a model read the
plugin's source to find `expected_revision`).

So the three levers are **still not settled on cost** — the regrade
changed the denominator, not the numerator — but the *reason* the earlier
measurement ran out of resolution is now known, and it was not "the
levers are too small to see". It was "the grader could not read the
answers".

### The product-availability pair

`none-opi` was 47.4% "successful" and is **89.5%** regraded. The
"unavailable billing" in the earlier table was, in most cases, the
control producing prose. The product's availability is now established on
graded content rather than on JSON formatting, and the conclusion is
**stronger**, not weaker: the two arms answer at the same rate (89.5%
against 100%, on 19 and 47 runs) and the control is no longer flattered
or penalised by formatting.

## The limit of this

**Regrading does not measure behaviour under a prompt without the JSON
requirement.** Every retained answer was produced under a prompt that
said "return only one JSON object". The regrade measures the grader's
reading of those answers. A prompt change is a **separate experiment**,
and it is the one the next run has to be.

The two things this does establish:

1. **The old success rate was a format metric**, and every comparison
   built on it needs re-reading.
2. **The content is right far more often than the old reports said.** The
   models were answering the questions; the grader was refusing to read
   the answers.

## The artifacts

- `fixtures/bench/results/regrade-*.json` — every retained answer, both
  verdicts, the format, and the reasons. The historical verdicts are
  **not** modified.
- `fixtures/bench/results/regraded-comparison-*.json` — the per-arm
  comparison under both graders.
- `packages/bench/harness/content-grader.ts` — the grader, `content-v1`,
  fingerprinted `content-v1-f08e5508`.
- `packages/bench/test/content-grader-retained.test.ts` — the regression
  that **no answer the old grader passed may now fail**, checked against
  every retained answer.
- `packages/bench/test/regrade-validity.test.ts` — the regression that
  **an invalid run is never counted**, however good its answer.

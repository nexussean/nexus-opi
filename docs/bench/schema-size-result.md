# The schema-size measurement: the result

The pre-registered run of 2026-10-21. The rule was written **before** the
run, in [the pre-registration](preregistration-schema-size.md), and it is
applied mechanically by `packages/bench/harness/decision.ts`.

**The verdict: NOT RESOLVED. The minimal schema does not ship on this
evidence.**

## The run

| | |
|---|---|
| Report | [`report-2026-10-21T15-00-33-241Z.json`](../../fixtures/bench/results/report-2026-10-21T15-00-33-241Z.json) |
| Grader | `content-v1-f08e5508` |
| Seed | 20261021, block 2 |
| Source | 146 files, `sha256:b946846524ae807c1e1ecb26bf67f569` |
| Runs | **108**, of which **108 completed** and **0 were invalid** |
| Billing | **complete for all 108 runs** — no lower bounds, no withheld figures |

The arms: `opi` (the shipping surface), `opi-minimal` (the same tools,
arguments, enums and behaviour, with shorter descriptions), and `none-opi`
(the matched control, reported separately — it is a different experiment).

The task set: the three read tasks, `list-all`, `list-column` and `get-one`.
Six repeats per cell.

The schedule was randomised: 38 adjacent-same-arm pairs out of 107, against
the ~105 a blocked schedule gives. The two arms' **rendered** surfaces have
different fingerprints (`5449fcf5ce623d2f` against `7ab2bb24105b68e8`), so
they really did differ.

## The result

| Model | Arm | Correct | End-to-end | Exec-fail | Spend | Cost per success | 95% interval |
|---|---|---:|---:|---:|---:|---:|---|
| minimax | `opi` (full) | 18/18 | 100% | 0% | $0.133847 | $0.007436 | [$0.005230, $0.009937] |
| minimax | `opi-minimal` | 18/18 | 100% | 0% | $0.078920 | $0.004384 | [$0.003197, $0.005795] |
| deepseek | `opi` (full) | 18/18 | 100% | 0% | $0.035474 | $0.001971 | [$0.001634, $0.002347] |
| deepseek | `opi-minimal` | 18/18 | 100% | 0% | $0.037914 | $0.002106 | [$0.001795, $0.002427] |

**No correctness failures were observed in the tested cases**: 18 of 18 in
every cell, on both arms and both models. The pre-registered condition (a)
is met. **This supports the tested workload — three read tasks, one board,
six repeats — and does not establish general correctness.** It is not a
claim that the surface is correct in general, or on the write tasks, or on
any board but this one.

**Every run in this measurement executed**: 108 of 108 completed, 0 were
invalid, and the billing was complete for every one. So the **content
accuracy**, the **end-to-end success rate** and the **execution failure
rate** are all the same number here — 100%, 100% and 0% — and the two
denominators do not differ. The separation matters on other data, not on
this one.

**Cost does not resolve.** On minimax the minimal schema is **41% cheaper**;
on deepseek it is **7% more expensive**. The bootstrap intervals overlap on
both models, so by the pre-registered bar the difference is **not
resolved** on either.

## The rule, applied

```
  deepseek-v4.1-flash
    (b) FAILS: the two intervals overlap
      ([$0.001795, $0.002427] against [$0.001634, $0.002347])
    correctness ok: true   cost ok: false   invalid share: 0.0%

  minimax-m3.1-flash
    (b) FAILS: the two intervals overlap
      ([$0.003197, $0.005795] against [$0.005230, $0.009937])
    correctness ok: true   cost ok: false   invalid share: 0.0%

NOT RESOLVED — the cost difference is inside the spread.
The minimal schema does not ship on this evidence.
```

The models **disagree in direction**, which is the pre-registered **split**
case. The rule as written returns `not-resolved` because both models failed
condition (b) for the same reason — overlapping intervals — rather than one
passing and one failing. Either way the outcome is the same: **the minimal
schema does not ship.**

## The additional analysis, and its limits

The pre-registered bar is conservative. The following was computed **after**
the result was seen, and it does **not** change the verdict. It is reported
because a reader is entitled to know what the data says beyond the bar.

| Model | Mean spend, minimal vs full | Permutation test on the difference | P(minimal cheaper) |
|---|---:|---:|---:|
| minimax | **41.0% less** | p = 0.0355 | 0.988 |
| deepseek | 6.9% more | p = 0.5906 | 0.283 |

**An exploratory analysis suggests a minimax cost reduction.** The
permutation test on the mean spend gives p = 0.036, and the bootstrap puts
the probability that the minimal schema is cheaper at 98.8%. On deepseek
there is no detectable difference: p = 0.59.

**What this does not establish.**

- It is **exploratory**. The statistic was not named in the pre-registration,
  and it was computed after the result was seen. A post-hoc test does not
  override a pre-registered decision rule, and it does not get to.
- **Overlapping individual confidence intervals are not a test of the
  difference between the arms.** The pre-registered bar used them, and they
  are a conservative proxy. They are not a direct test, and the
  permutation test is a different and sharper question. The two are not
  interchangeable, and neither is a substitute for a pre-registered
  comparison.
- **The two models' results do not establish an interaction.** Opposite point
  estimates, and significance for one model but not the other, are consistent
  with a model-by-treatment interaction — and equally consistent with two
  noisy estimates of the same effect, or with the conservative bar
  interacting with the different spreads. Testing the interaction directly
  needs a test designed for it, run on more models, and it has not been run.

**So the honest reading is:** there is an exploratory signal of a minimax
cost reduction, and no signal on deepseek. The pre-registered rule asked
for a result on **both** models, and there is not one. Shipping the minimal
schema on minimax's signal alone would be shipping a change whose benefit
is unestablished on the other model tested.

## An observed difference in the diagnostics, and a hypothesis

The difference is visible in the format compliance and the tool calls:

| Model | Arm | Met the JSON contract | Tool calls |
|---|---|---:|---:|
| minimax | `opi` (full) | 10/18 | 57 |
| minimax | `opi-minimal` | **14/18** | **43** |
| deepseek | `opi` (full) | 18/18 | 33 |
| deepseek | `opi-minimal` | 18/18 | 33 |

On minimax the shorter descriptions were accompanied by JSON being produced
more often and by **25% fewer tool calls**. On deepseek JSON was produced
every time either way and the tool-call counts were the same, so there was
nothing to save.

**A hypothesis, not a finding:** the shorter descriptions may have reduced
the work the model had to do to reach an answerable format, and that work
may be worth money to a model that struggles with the format. This would
explain the pattern.

**It is not established.** The data are two models, opposite point estimates,
and a difference that is significant for one and not the other. That is
consistent with a model-by-treatment interaction, and equally consistent
with two noisy estimates of a single effect, or with the conservative bar
behaving differently against the two arms' different spreads. Distinguishing
those needs a test built for the interaction, run over more models.

**The earlier claim that "the benefit is a property of the model, not of the
surface" is withdrawn.** It was not supported by the evidence, and it was
the load-bearing claim for the decision. The decision rests on the
pre-registered rule, and it does not need a mechanism.

## What this does to the earlier claim

The earlier claim was that the minimal schema was "38% smaller and 29–38%
cheaper per success, with the same or more correct answers", and that was the
largest single effect measured.

- The **correctness** part is now confirmed and was never the issue: both
  arms answer every question, on both models, 18 of 18.
- The **cost** part is **model-dependent**. 41% cheaper on minimax with
  p = 0.036; no difference on deepseek with p = 0.59.
- The **"29–38%"** figure is not reproduced on deepseek, which is the model
  the earlier measurement found 29% cheaper on. The corrected harness, the
  corrected grader and the corrected billing all changed.

The claim as written — that a smaller surface costs less — is **not
supported as a general property**. What the data supports is narrower:

> In these 18 runs per cell, on minimax the shorter descriptions were
> associated with a lower spend (an exploratory signal, p = 0.036), and on
> deepseek they were not (p = 0.59). No correctness failures were observed
> in either arm.

**What the data does not support**, and what is withdrawn:

- that shorter descriptions **generally** cost less;
- that the benefit is **a property of the model rather than the surface** —
  that was the load-bearing claim for the decision and it is not supported;
- that the mechanism is the number of steps needed to reach an answerable
  format — that is a hypothesis.

## The recommendation

**Do not ship the minimal schema as the default on this evidence.**

The pre-registered rule says so, and the reason is not that the effect is
absent — on minimax there is an exploratory signal — but that the rule
required a result on **both** models, and there is not one.

Three things would change the answer, and none of them is "run it again on
the same two models":

1. **More models.** Any generalisation needs to know how widely the effect
   holds. Two models, one with an exploratory signal and one without, is not
   enough to change a default.
2. **A prompt without the JSON requirement.** The mechanism is the number of
   steps needed to reach an answerable format, and the prompt *requires* a
   format. Removing the requirement may remove the mechanism, and that is a
   separate experiment — see [the regrade findings](regrade-findings.md) for
   why the two must not be confused.
3. **The write tasks.** The read tasks are the only ones measured. The
   write tasks have their own failure mode — a model reading the plugin's
   source to find `expected_revision` — and shorter descriptions could help
   or hurt there.

**What does not need re-measuring:** the correctness result. Both arms answer
every question on both models, 18 of 18, and the format compliance is
reported beside it. That part is settled.

**The shipping default has not been changed.** `packages/adapter-opencode/src/schema-size.ts`
keeps `full` as the default, and the minimal variant stays an arm.

## The artifacts

- The report: [`report-2026-10-21T15-00-33-241Z.json`](../../fixtures/bench/results/report-2026-10-21T15-00-33-241Z.json)
- The pre-registration: [preregistration-schema-size.md](preregistration-schema-size.md)
- The decision: `bun run packages/bench/harness/decision.ts <report>`
- The additional analysis: `bun run packages/bench/harness/posthoc.ts <report>`
- The repair's documents: [the repair plan](repair-plan.md), [the regrade
  findings](regrade-findings.md), [the repaired harness](repaired-harness.md)
- The decision: [ADR-0027](../adr/0027-the-tool-surface-is-grouped-by-domain.md)

# ADR-0027: Retain domain grouping provisionally; measure successful task completion

- **Status:** Accepted, revised 2026-10-20; **revised again 2026-10-21** after the
  benchmark repair. The performance rationale is provisional and its *success
  metric* has been withdrawn; see [the regrade findings](../bench/regrade-findings.md).
- **Date:** 2026-10-20, revised 2026-10-21
- **Extends:** ADR-0009, ADR-0018
- **Evidence:** [tool-surface results](../bench/tool-surface-results.md),
  [regrade findings](../bench/regrade-findings.md),
  [repair plan](../bench/repair-plan.md)

## Context

The initial fixture comparison favored a single action tool over six tools. It did not
isolate schema size, did not validate task outcomes, and did not measure OPI's full
surface. Subsequent product runs show expensive non-surface activity, but their JSON
control and SQLite product store are not equivalent. These results cannot establish
that schema size is second-order, that discovery alone causes the cost, or that OPI
is worse than having no tool for successfully completing board work.

The fixture also has different capabilities: `todo`, labels, deletion, and unrestricted
moves are not interchangeable with OPI's task states, descriptions, and guarded
transitions. A successful tool invocation does not establish task success.

## The correction of 2026-10-21

**Format compliance substantially distorted every success rate in this
file.** The grader required a bare JSON object with a fixed shape and
reported every other answer as "ungradable". Across the retained reports the
number of answers the grader called "passed" is very close to the number
that met the JSON contract, arm by arm, and the arms with the lowest format
compliance were the arms that looked worst.

**What is not claimed.** The old grader was not content-blind: it also
checked the card set, the count, and each card's title, state and priority.
Its passes were genuine correctness checks, and the new grader agrees with
every one of them. The distortion is in the **denominator and the
selection**, not in the correctness of the passes.

Regrading the retained read answers with a content-aware grader
(`content-v1`), over the **valid** runs only:

| Old grade | → passed | → failed | → ungradable |
|---|---:|---:|---:|
| `passed` (392) | **392** | 0 | 0 |
| `ungradable` (48) | **48** | 0 | 0 |
| `failed` (1) | 0 | **1** | 0 |

There are **no false failures**: every answer the old grader passed still
passes, and the one it failed is still failed. Nothing is left undecided.

**The 27 invalid runs are excluded.** Twenty-seven of the retained read runs
did not complete — timeouts, launch failures, runs invalidated because the
surface was not what the arm said it was. A run that did not complete is not
an experimental observation, whatever its answer contains, so it is excluded
from every rate. The first version of the regrade counted them, and the
correction **reduced** the recovered format failures from 65 to 48.

**What this changes.** The claims below about *cost per success* are **not
withdrawn** — the spend was measured — but their denominator was wrong, and
every comparison between two arms has to be re-read with the format removed. The
claims about *correctness* are substantially withdrawn: the "four more correct
answers" for the minimal schema were four more answers that happened to be JSON.
**Both arms answer every question correctly once the format is removed.**

The full analysis, with the per-arm table, is in
[the regrade findings](../bench/regrade-findings.md).

## The matched measurement

36 runs on the read tasks: 2 models × 2 arms × 3 tasks × 3 repeats. Both arms get the
same SQLite store, the same locator, no JSON fallback, and the same success oracle.

| Model | Arm | Answers | Ungradable | Cost per success |
|---|---|---:|---:|---:|
| `minimax-m3.1-flash` | `opi` | 5 | 4 | $0.010439 |
| `minimax-m3.1-flash` | `none-opi` | 5 | 4 | unavailable (incomplete billing) |
| `deepseek-v4.1-flash` | `opi` | 9 | 0 | $0.002339 |
| `deepseek-v4.1-flash` | `none-opi` | 9 | 0 | $0.002677 |

**Every graded answer was correct** — 28 of 28, in both arms. The two arms produced the
same number of correct answers on both models, and `opi` cost 0.87× the control per
success on deepseek.

**The product is available.** With `pi.task` the model reaches the board as readily as
it does by reading the database, and no more expensively. The earlier claim that OPI's
surface was more expensive than no tool does not survive a matched comparison with a
success oracle.

## The surface-shape measurement

A separate experiment: **same backend, same behaviour, different tool interfaces**. The
fixture plugin's in-memory board, the same six operations, the same board, the same
prompts, the same success oracle. Only the interface differs.

| Model | Shape | Answers | Ungradable | Cost per success |
|---|---|---:|---:|---:|
| `minimax-m3.1-flash` | `separate` (6 tools) | 8 | 1 | $0.001083 |
| `minimax-m3.1-flash` | `actions` (1 tool) | **9** | 0 | **$0.000893** |
| `deepseek-v4.1-flash` | `separate` (6 tools) | 9 | 0 | $0.000801 |
| `deepseek-v4.1-flash` | `actions` (1 tool) | 9 | 0 | **$0.000774** |

**Every graded answer was correct** — 35 of 35. The single tool is cheaper on both
models: 1.21× cheaper per success on minimax, 1.03× on deepseek.

**The mechanism is visible in the call counts.** Totals over each cell's 9 runs:

| Model | Shape | Tool calls | Steps | Non-surface calls |
|---|---|---:|---:|---:|
| `minimax` | `separate` | **49** | 24 | 0 |
| `minimax` | `actions` | **23** | 21 | 3 |
| `deepseek` | `separate` | 10 | 10 | 0 |
| `deepseek` | `actions` | 10 | 10 | 0 |

With six separate tools, minimax called `task_list` **10, 15 and 10 times** for one
question. With one tool it made three calls per run. The six tools each advertise
themselves separately, and the model kept re-selecting one. This is the discovery cost,
isolated — the earlier `discoveryCalls` metric could not attribute a cause because it
counted real shell work too.

## The wording ablation

The description change of October 2026 was made on the strength of a catalog probe,
not a measurement. This measures it: the control arm is the same product with the
pre-change wording — same schema, same backend, same board, same tasks, same model.
Both wordings are kept in `packages/adapter-opencode/src/descriptions.ts`.

| Model | Arm | Answers | Ungradable | Cost per success |
|---|---|---:|---:|---:|
| `minimax-m3.1-flash` | control | 3 | 6 | $0.017119 |
| `minimax-m3.1-flash` | revised | **4** | 5 | **$0.014191** |
| `deepseek-v4.1-flash` | control | 9 | 0 | $0.002490 |
| `deepseek-v4.1-flash` | revised | 9 | 0 | **$0.002313** |

On deepseek — where both arms answered everything — the revised wording is **7%
cheaper**, with 6% fewer steps and **12% fewer non-surface calls**. On minimax it
produced one more correct answer and was 17% cheaper per success, but minimax's
per-task numbers go both ways.

**The change is worth something, and it is small.** It is consistently in the right
direction, and it is in the single digits on the model that was already perfect.

## The write measurement: the product's own surface, two shapes

The fixture cannot answer the write questions — no revision, no audit history, no
guarded transitions — so the **product's** task tool was given two shapes over the
**same** SQLite store, with the same guard and the same implementation
(`packages/adapter-opencode/src/task-tool.ts`).

48 runs: 2 models × 2 shapes × 4 write fixtures × 3 repeats.

| Model | Shape | Answers | Failed | Ungradable |
|---|---|---:|---:|---:|
| `minimax-m3.1-flash` | `opi` (one tool) | **12** | 0 | 0 |
| `minimax-m3.1-flash` | `opi-split` (nine tools) | 10 | 0 | 2 |
| `deepseek-v4.1-flash` | `opi` (one tool) | **12** | 0 | 0 |
| `deepseek-v4.1-flash` | `opi-split` (nine tools) | **12** | 0 | 0 |

**No graded write was wrong.** The product's invariants held under test: revision
increments matched the audit events, the audit payloads matched the mutations, prior
history was not rewritten, no unrelated card changed, and verification stayed honestly
`not_configured`.

The two ungradable runs are timeouts, and the traces show the cause: with the split
shape, a model could not work out that `expected_revision` was required, so it **read
the plugin's source code** to find out — 38 tool calls for one update, against 10 for
the single tool. The write itself succeeded; the run then timed out still exploring.

**This is the same mechanism as the read tasks**, and it is now measured on the
product's own store and the product's own write semantics: a wider surface gives a model
more to choose from and more to misunderstand. The split shape's argument lists are
*narrower*, and the model still got stuck — a narrow list is only as good as the
model's reading of it.

## The schema-size measurement: the plan's premise, tested

ADR-009 proposed a **small** tool surface, on the reason that a smaller surface costs
less. That reason had never been tested, because every measurement so far changed the
surface's **structure**, and a structural change moves the size and the shape together.

This arm isolates size: the same six tools, the same arguments, the same enums, the same
behaviour, with only the prose shortened. The surface shrank from 9,653 bytes to 5,993.

| Model | Shape | Answers | Ungradable | Cost per success |
|---|---|---:|---:|---:|
| `minimax-m3.1-flash` | full | 10 | 5 | $0.011459 |
| `minimax-m3.1-flash` | minimal | **14** | 1 | **$0.004407** |
| `deepseek-v4.1-flash` | full | 15 | 0 | $0.002152 |
| `deepseek-v4.1-flash` | minimal | 15 | 0 | **$0.001528** |

**The smaller schema measured better on both models**: 38% cheaper per success on
minimax with **four more correct answers**, and 29% cheaper on deepseek with the same
answers.

> **Corrected 2026-10-21.** The "four more correct answers" were four more answers
> that met the JSON contract. Regraded for content, **both arms answer every
> question correctly on both models** (minimax `opi` 47/47, `opi-minimal` 20/20;
> deepseek `opi` 70/70, `opi-minimal` 26/26). The cost-per-success figures have to be
> re-taken with the corrected grader, because the denominator changed. The **size**
> measurement and the **mechanism** survive: the minimal schema made minimax meet
> the JSON contract 85% of the time against 47% on the full schema, and a model that
> has to re-try an answer pays for the retry.

The mechanism is the same as everywhere else in this file — **less exploration**. On
minimax's read tasks the non-surface calls went from 31, 48 and 22 to **0, 2 and 12**.

**ADR-009's premise was right and its conclusion was wrong.** A small surface does
cost less, but not because of the bytes on the request — the money was going on the
model's *searching*, and the smaller schema searched less. And seven tools with action
arguments is not how to get a small surface: one tool per domain with short
descriptions is smaller, and smaller *and* easier to find.

**This is not a pure size intervention.** The minimal descriptions also move the
"when is this required" guidance from the arguments to the tool's description, so
the instructional content changes along with the byte count. Any claim about this
arm is a claim about **shorter descriptions**.

## The three arms, re-taken on the minimal schema

The wording, guidance and structure arms were all measured against the **full**
schema. Re-taken on the minimal one, 72 runs:

| Model | Arm | Answers | Ungradable | Cost per success |
|---|---|---:|---:|---:|
| `minimax` | minimal baseline | 7 | 2 | $0.001903 |
| `minimax` | baseline wording | 8 | 1 | $0.001751 |
| `minimax` | baseline guidance | **9** | 0 | **$0.001204** |
| `deepseek` | minimal baseline | 9 | 0 | $0.000783 |
| `deepseek` | baseline wording | 9 | 0 | $0.000743 |
| `deepseek` | baseline guidance | 9 | 0 | $0.000822 |

**The result reversed**, and the reason matters more than the number. Every ungradable
run is *"final answer does not follow the JSON answer contract"* — minimax writing prose
where a JSON object was asked for. The ungradable run **moves between tasks from arm to
arm**.

> **Corrected 2026-10-21.** The original text called that movement "the signature of
> run-to-run format noise, not of a lever working". That was an **inference, not an
> observation**: nothing in the data distinguished format noise from a lever working.
> It is now **explained**, by the regrade. The movement was format noise, and the
> arms did not differ in correctness at all. The three levers are still unsettled on
> **cost**, and the cost comparison has to be re-taken.

**So the three levers are not settled on the minimal schema, and must not be reported
as settled.** The signal they used to be visible against — a discovery cost that was
81% of minimax's steps on the full schema — is 16 calls out of 35 steps on the minimal
one, and a single ungraded run swamps it.

This is a measurement that ran out of resolution, not a null result about the levers.

## Decision

0. **The success metric in this file is withdrawn and replaced.** "Cost per success"
   used a denominator that counted a format failure as a failure, and the arms
   differed in format compliance. The corrected metric grades the final answer's
   **content** against the run's own seeded snapshot, and reports format compliance
   **beside** it, never inside it. Every cost comparison in this file has to be
   re-taken with the corrected grader; the spend figures stand, the denominators
   do not.

1. Keep the six domain tools (`pi.status`, `pi.task`, `pi.verify`, `pi.memory`,
   `pi.graph`, `pi.context`). The measurement supports **availability**; it does not
   yet support any claim about the surface's **shape**. Regraded, the availability
   conclusion is **stronger**: `none-opi` goes from 47.4% to 89.5% "successful", and
   the two arms answer at the same rate.
2. **One tool per action is a worse interface than one tool with an action argument.**
   Measured twice, on two backends: the fixture's read tasks and the product's own
   write tasks over the same SQLite store. It costs more, never less, and its
   advantage — a schema per action — bought nothing measurable: zero malformed calls
   either way, and the same answers. OPI already has one tool per *domain*, not one per
   action, and that is the better half of the two results.

   The mechanism is the same in both: a wider surface gives a model more to choose from
   and more to misunderstand. With six read tools a model called the same tool 10, 15
   and 10 times for one question; with nine write tools a model read the plugin's
   **source code** to learn an argument the single tool's schema already stated.
3. **The size of the difference is small** and must not be overstated: 3% on deepseek,
   21% on minimax, and on deepseek both shapes answered every question correctly. The
   earlier 6.7× figure came from an unequal comparison and does not survive.
4. **Keep the revised descriptions**, which are 7% cheaper and 12% fewer non-surface
   calls than the control, with a preserved control arm so the change can be re-measured.
   The two wordings live side by side in
   `packages/adapter-opencode/src/descriptions.ts`; the control is not in version
   control, because a control that has to be reconstructed is a control that can drift.
5. **Do not ship the minimal schema as the default. The effect is real on one
   model and absent on the other, and a default cannot depend on which model
   reads it.**

   A minimal schema — the same tools, arguments and enums, with one-line
   descriptions and argument descriptions that say what the argument *is* rather
   than when it is required — is 38% smaller. It was measured as 29–38% cheaper
   per success, and that was the largest single effect measured in this file.

   That measurement was **re-taken** on 2026-10-21, with the corrected grader,
   the corrected billing, a randomised schedule and a **pre-registered** decision
   rule ([the pre-registration](../bench/preregistration-schema-size.md),
   [the result](../bench/schema-size-result.md)). 108 runs, 108 completed, 0
   invalid, billing complete for every one.

   | Model | Arm | Correct | Cost per success | 95% interval |
   |---|---|---:|---:|---|
   | minimax | `opi` (full) | 18/18 | $0.007436 | [$0.005230, $0.009937] |
   | minimax | `opi-minimal` | 18/18 | $0.004384 | [$0.003197, $0.005795] |
   | deepseek | `opi` (full) | 18/18 | $0.001971 | [$0.001634, $0.002347] |
   | deepseek | `opi-minimal` | 18/18 | $0.002106 | [$0.001795, $0.002427] |

   **No correctness failures were observed in the tested cases**: 18 of 18 in
   every cell. This supports the tested workload — three read tasks, one
   board, six repeats — and does not establish general correctness. The
   earlier "four more correct answers" were answers that happened to be JSON.

   **Cost is not resolved**: 41% cheaper on minimax, 6.9% *more expensive* on
   deepseek, with the bootstrap intervals overlapping on both. The
   pre-registered rule returns **NOT RESOLVED**, and the minimal schema
   **does not ship**.

   The additional analysis, run after the result was seen and reported because
   the pre-registered bar is conservative, **suggests a minimax cost
   reduction**: a permutation test on the mean spend gives p = 0.036, and the
   bootstrap puts the probability that the minimal schema is cheaper at
   98.8%. On deepseek there is no detectable difference (p = 0.59). It is
   **exploratory** — the statistic was not named in the pre-registration — and
   a post-hoc result does not override a pre-registered rule.

   **The earlier claim that "the benefit is a property of the model, not of
   the surface" is withdrawn.** It was not supported: opposite point
   estimates, and significance for one model but not the other, do not
   establish a model-by-treatment interaction. The hypothesis that shorter
   descriptions reduce the work needed to reach an answerable format — and
   that this work is worth money to a model that struggles with the format —
   is consistent with the diagnostics (minimax's format compliance went from
   10/18 to 14/18 and its tool calls from 57 to 43; deepseek's were unchanged),
   but it is **not established**. The decision rests on the pre-registered
   rule and does not need a mechanism.

   The intervention is **shorter descriptions**, not schema size in isolation:
   the minimal descriptions also move the "when is this required" guidance from
   the arguments to the tool's description, so the instructional content changes
   too. The ADR must not call it a pure size effect.

   The arm is preserved as `packages/adapter-opencode/src/schema-size.ts`, with
   **two wordings** of its own, so the wording comparison survives on the
   minimal surface. It did not before: the minimal branch returned one fixed
   description regardless of the wording variant, so the "baseline wording" arm
   rendered exactly the same text as the "revised" one and the comparison was
   between two identical surfaces. Every other arm has a minimal-schema
   counterpart (`packages/bench/harness/run.ts`, `ARM_LEVERS`).

   **What would change the answer:** more models, because any
   generalisation needs to know how widely the effect holds; a prompt without
   the JSON requirement, because the arms' format compliance differs and the
   prompt requires a format; and the write tasks, which have their own
   failure mode.

6. **The wording, guidance and structure levers are unsettled on cost, and their
   apparent correctness differences were format differences.** Regraded, every lever
   answers every question on both models, except `opi-minimal-split` (one
   ungradable in ten on each model — the same shape as the write-task result, where
   a model read the plugin's source to find `expected_revision`).

   The earlier statement that the ungradable run "moving between tasks from arm to
   arm" was "the signature of run-to-run format noise" was an **inference, not an
   observation**, and it is now **explained**: it was format noise. That is a
   different claim from "the levers are too small to see". The levers still have to
   be settled on cost, and the cost comparison has to be re-taken with the corrected
   grader.
2. Optimize cost and latency **at comparable task-success rates**, per model and task.
   Report failure and timeout rates alongside completed-run cost. Tool-call counts
   and declared schema bytes are diagnostics, not success criteria.
3. Use `opi` versus `none-opi` to compare product availability on the same SQLite seed,
   with identical board-location hints and no JSON fallback. Keep the old JSON fixture
   experiment separate. OPI initialization still adds indexes and runtime behavior;
   this pair measures the product's availability, not just schema text.
4. Treat the legacy `discoveryCalls` metric as non-surface activity. It includes actual
   shell work and verification, and its wrapper heuristic is imperfect. Do not use it
   to assign causality to naming or schema size.
5. Test descriptions, direct-tool guidance, schema reduction, and competing catalogs
   as separate interventions on a fixed backend and task set. Version each intervention
   and use interleaved repeats. A rerun of changed code without a preserved old-description
   arm does not measure the description change's causal effect.
6. Keep verification and state-transition requirements intact. Do not make benchmark
   tasks succeed by bypassing product rules. Separate unsupported tasks from failed tasks.

## Consequences

The previous claims that schema size is second-order, that having tools accounts for
95% of the benefit, and that domain grouping is proven by the fixture are withdrawn.
A larger declared schema does not prove schema overhead causes higher cost either:
Code Mode can load schemas on demand, and declared bytes are not measured input tokens.

**What the matched pair does establish:** the six-tool surface is not a cost problem.
The model reaches `pi.task` as readily as it reaches `sqlite3`, answers at the same
success rate, and costs the same or less. The cost that earlier appeared to be the
surface's was the cost of runs that **never answered** — and that cost is the same in
both arms.

Regraded, this is **stronger** rather than weaker. The control's "success rate" was
47.4% because it wrote prose; it is **89.5%** on content, against the product's
100%. The two arms answer at the same rate, and neither is flattered or penalised by
formatting.

**What it does not establish:** anything about the surface's shape. `opi` versus
`none-opi` changes the backend as well as the interface, so it measures product
availability. "Is six tools better than one?" needs the fixture arms on the shared
board, and the fixture's board and the store's board had drifted apart — one board is
now defined once, in `packages/bench/harness/board.ts`.

The standalone kanban plugin's ownership remains a product decision. The isolated
benchmark excludes global plugins, so catalog competition must be tested explicitly
in a separate condition before drawing deployment conclusions.

## What the repair changed

The 2026-10-21 repair of the benchmark ([the repair plan](../bench/repair-plan.md))
changed the following, and the earlier results have to be read through them:

| Defect | Effect on the earlier results | Fixed |
|---|---|---|
| The grader reported a **format** failure as a content failure | Format compliance substantially determined every success rate | Yes — `content-v1`, and the regrade is in [the findings](../bench/regrade-findings.md) |
| The cost total summed only the CLI's priced **steps** | Every run's spend was missing its own final answer — 24–58% on three real runs | Yes — the authoritative cost is recovered from the runtime's session store |
| The expected tool count was checked against the **arm's name** | The `opi-minimal-split` arm's 18 runs were all invalidated; it produced no data | Yes — the count is derived from the structure |
| The minimal schema returned one fixed description | The "baseline wording" arm rendered identically to the "revised" one | Yes — the minimal schema has its own two wordings |
| The split branch used fixed descriptions and arguments | The structure arm also changed the wording and the size | Yes — the split branch uses the same variants |
| The runs were scheduled in **arm blocks** | The arm and the provider's state at that moment were correlated | Yes — a seeded, randomised, blocked schedule, persisted in the report |

**The spend figures in this file are lower bounds** on what was actually spent, and
the **cost-per-success figures are over-estimates**, because ungradable runs counted
as failures in the denominator while their spend counted in the numerator. The
corrected denominator is different, and the corrected spend is higher.

## Revisit condition

Choose a surface after task-output and authoritative-store checks establish correctness,
and matched per-model experiments measure cost, latency, timeouts, and tool reachability.
Read tasks need answer validation; writes need final-state and relevant invariant checks.
Neither process completion nor a successful call is sufficient.

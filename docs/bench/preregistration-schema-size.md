# The pre-registered measurement: does the minimal schema ship?

Recorded 2026-10-21, **before** the run. Thresholds, arms, metrics and the run
budget are fixed here so that the result cannot be read to fit an outcome.

## Why this run exists

The schema-size arm is the largest effect the benchmark has measured, and it
is the one that would change what ships. Two things about it are now unclear:

1. **The success metric was wrong.** The old grader reported a format failure as
   a content failure, so "38% cheaper per success with four more correct
   answers" was partly a statement about JSON formatting. Regraded, both arms
   answer every question. The **cost per success** therefore has to be
   re-measured with a denominator that is the same for both arms.
2. **The earlier cost figures were lower bounds.** The harness summed only the
   CLI's priced steps and never priced the final answer, so every run's spend
   was missing 24–58% of its real cost. The corrected harness recovers the
   whole cost from the runtime's session store.

## The question

**Does the minimal schema cost less per successful task, at equal correctness,
than the full schema?**

## The arms

Two arms, one lever, everything else held:

| Arm | Wording | Guidance | Structure | Size |
|---|---|---|---|---|
| `opi` | revised | direct | action | **full** |
| `opi-minimal` | revised | direct | action | **minimal** |

One lever: the size of the descriptions. The tools, the arguments, the enums,
the required fields, the behaviour, the backend, the board, the prompts, the
model and the tasks are all the same.

**Not varied**: the wording, the guidance, the structure. The minimal schema
carries the revised wording, so the arms differ in the size of the prose and
in nothing else that the arm table names.

The two arms are **not** a pure byte-count intervention: the minimal
descriptions also move the "when is this required" guidance from the arguments
to the tool's description. The claim under test is therefore about **shorter
descriptions**, and the report says so.

## The controls

- `none-opi` — the product's availability, measured over the same store. It is
  a **different experiment** and is reported separately, never mixed into the
  size comparison.

## The tasks

The three read tasks: `list-all`, `list-column`, `get-one`. They are the tasks
the earlier arms used, and they are the ones the grader can grade on content.

**The write tasks are not in this run.** Their grading is against the
authoritative store, which the repair did not change, and the size arm was
never measured on them. Including them would add runs that answer a different
question.

## The metrics

Declared in advance, and all of them reported whether or not they favour a
result:

1. **Correctness** — the content grade: `passed` / `failed` / `ungradable`,
   from the final user-visible answer, against the run's own pre-run snapshot.
   The primary metric.
2. **Format compliance** — whether the answer met the JSON answer contract.
   Reported **beside** the grade, never inside it.
3. **Total spend** — the authoritative cost, from the runtime's session store,
   summed over **every attempt** in the cell, including the failed and the
   timed-out ones.
4. **Cost per successful task** — total spend ÷ successful answers. Withheld
   for any cell whose billing is not complete; the measured lower bound is
   reported in its place.
5. **Non-surface calls** — the model's work outside the surface. A diagnostic,
   not a success criterion.
6. **Billing completeness** — how many runs' cost was fully recovered.

## The pre-declared decision rule

Written before the run, and not to be changed afterwards.

**Ship the minimal schema as the default** if and only if, on **both** models:

- (a) the content success rate of `opi-minimal` is **not lower** than
  `opi`'s; and
- (b) the cost per successful task of `opi-minimal` is **lower** than `opi`'s.

If (a) fails, the minimal schema does not ship, whatever the cost.

If (a) holds and (b) holds for both models, the minimal schema ships as the
default.

If the two models **disagree** — one says cheaper, the other does not — the
minimal schema does **not** ship on this evidence, and the result is reported
as split.

If the difference in (b) is smaller than the **spread within** either arm, the
result is reported as **not resolved**, and the minimal schema does not ship on
this evidence.

**The bar for "not resolved" is set in advance**: the cost per successful task
of an arm is compared by its **bootstrap 95% interval**, resampled 10,000
times over the arm's runs. Two arms' intervals overlap → not resolved.

## The run budget

- **Models:** `ollama-cloud/minimax-m3.1-flash`, `ollama-cloud/deepseek-v4.1-flash`
- **Arms:** `opi`, `opi-minimal`, `none-opi`
- **Tasks:** `list-all`, `list-column`, `get-one`
- **Repeats:** 6
- **Total runs:** 2 models × 3 arms × 3 tasks × 6 repeats = **108 runs**
- **Seed:** 20261021, block 2, concurrency 4
- **Hard stop:** the matrix ends at 108 runs. It is not extended because a
  result looks favourable, and it is not stopped early because a result does
  not.

108 runs at the observed rate (roughly 9 minutes per 60 runs at concurrency 4)
is about 20 minutes.

## The kill criteria

- A provider balance error (`402`) aborts the run. The partial result is
  reported as partial, and the matrix is not silently restarted.
- If more than 10% of the runs in a cell are invalid (the run did not
  complete), that cell's comparison is reported as **not usable**, and the
  result is not drawn from it.

## What this run cannot settle

- **The wording, guidance and structure levers.** They are separate
  experiments, they need their own pre-registration, and they are not
  re-measured here.
- **Behaviour under a prompt without the JSON requirement.** The prompt still
  requires the JSON contract, so the format-compliance rate stays in the
  report. Removing the requirement is a separate experiment, and the
  [regrade findings](regrade-findings.md) explain why the two must not be
  confused.
- **The write tasks.**

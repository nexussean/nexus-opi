# Tool-surface measurement: evidence and corrected experiment

Updated 2026-10-20; **corrected 2026-10-21** after the benchmark repair.

> **The most important correction, from 2026-10-21: format compliance
> substantially distorted every "success rate" in this file.** The grader
> required a bare JSON object and reported every other answer as
> "ungradable", and the arms differed in how often they produced JSON, so the
> arms with the lowest format compliance looked the worst. Regrading the
> retained read answers for **content** (`content-v1`) changes every
> correctness claim in this file. The old grader was not content-blind — it
> checked the card set, the count and each card's fields, and every one of
> its passes is still a pass.
>
> The full analysis, with the per-arm table and what it does to each conclusion, is
> in [the regrade findings](regrade-findings.md). The repair itself is in
> [the repair plan](repair-plan.md), and the corrected decision is in
> [ADR-0027](../adr/0027-the-tool-surface-is-grouped-by-domain.md).

Historical report files remain unchanged.

## The repair's documents

- [The repair plan](repair-plan.md) — what was wrong, and what was changed.
- [The regrade findings](regrade-findings.md) — **the important one**: format
  compliance substantially distorted the old success rate, and what that does
  to every conclusion below.
- [The repaired harness](repaired-harness.md) — the modules the repair added,
  and what each is for.
- [The pre-registration](preregistration-schema-size.md) — the schema-size
  decision rule, written **before** the run that applies it.
- [The schema-size result](schema-size-result.md) — **the shipping decision**:
  the pre-registered run of 2026-10-21, 108 runs, and the verdict.
  **NOT RESOLVED — the minimal schema does not ship.**
- [The repaired harness](repaired-harness.md) — the modules the repair added.

## What the saved reports show

The brief's costs are **totals over 30 runs per shape**, not median costs per run.
The matching [DeepSeek report](../../fixtures/bench/results/report-2026-10-20T21-46-27-744Z.json)
contains:

| Shape | Runs reaching surface | Non-surface calls, median | Cost total | Cost/run, median |
|---|---:|---:|---:|---:|
| actions | 30/30 | 0 | $0.026872 | $0.000905 |
| separate | 30/30 | 0 | $0.027904 | $0.000894 |
| none | 0/30 | 12 | $0.122902 | $0.002384 |
| opi | 23/30 | 9 | $0.179697 | $0.003090 |

OPI's aggregate cost is 6.69× actions and 1.46× the JSON control in this experiment.
Those ratios describe observed cost, not cost per successful task. The median-cost
ratios differ: approximately 3.41× and 1.30×, respectively.

The [MiniMax report](../../fixtures/bench/results/report-2026-10-20T23-53-49-926Z.json)
shows different behavior:

| Shape | Runs reaching surface | Non-surface calls, median | Cost total | Runs with zero completed steps |
|---|---:|---:|---:|---:|
| actions | 30/30 | 0 | $0.022694 | 0 |
| separate | 29/30 | 0 | $0.023141 | 1 |
| none | 0/30 | 13 | $0.186291 | 1 |
| opi | 10/30 | 3 | $0.080450 | 3 |

Here OPI costs less than the JSON control in aggregate. Zero-step runs and unvalidated
outcomes prevent treating that as a product win. Lower reachability also does not
necessarily mean higher recorded cost: a model can abandon work cheaply.

## The three-model matrix arrived during this review

The [360-run report](../../fixtures/bench/results/report-2026-10-21T01-03-37-655Z.json)
was saved at 01:03 UTC October 21 (20:03 Chicago, October 20). It uses the old harness
and control design. Its completion as a file does not mean its runs completed:

| Model | Shape | Reached tool / 30 | Zero-step runs / 30 | Cost total |
|---|---|---:|---:|---:|
| MiniMax | separate | 30 | 0 | $0.024257 |
| MiniMax | actions | 30 | 0 | $0.023406 |
| MiniMax | none | 0 | 0 | $0.537023 |
| MiniMax | opi | 19 | 11 | $0.149195 |
| DeepSeek | each of four shapes | 0 | 30 | $0 |
| Local Ornith | each of four shapes | 0 | 30 | $0 |

**251 of 360 runs recorded no completed model steps.** All DeepSeek and local-model
cells are unusable for the comparison. MiniMax's OPI cell also contains 11 zero-step
runs, so its aggregate/median figures cannot be interpreted as successful-task cost.
All 251 zero-step runs carry the same `ENOENT` launch error: the selected desktop
`2.1.0-arm64/opencode-cli` path no longer existed. This is an executable-path failure,
not evidence that DeepSeek or Ornith cannot use tools. The report does not explain why
the executable disappeared. Use a stable explicit executable path for reproducibility;
the harness now also re-discovers the desktop binary before each run and honors
`OPENCODE_BIN`. Do not present zero recorded spend as efficiency.

## Why the original inference is too strong

- **Different stores and capabilities.** The control reads JSON; OPI uses SQLite and
  also received a stale JSON copy. Fixture tools mutate an in-memory board, so shell
  edits and tool edits can diverge even in the fixture comparison.
- **Different task semantics.** Fixture `todo` is not an OPI state. OPI's seeder actually
  puts `kb-seed02` in `backlog`, despite its comment saying `ready`. Labels are stored
  as description text, priorities are numeric, and transitions enforce product rules.
- **No task-success oracle.** Calls and process exit do not prove a correct answer or
  committed mutation. “No malformed calls” also does not mean no semantic failures.
- **“Discovery” is broader than discovery.** `discoveryCalls` counts non-surface calls,
  including execution and verification. Namespace substring checks in Code Mode
  wrappers can hide mixed calls or attempts that never reached the plugin.
- **Declared bytes are not prompt tokens.** Code Mode catalog exposure and on-demand
  descriptions must be measured before claiming a schema is paid on every turn.
- **No controlled description ablation.** Old reports do not record a reliable source
  fingerprint or description variant. A later run alone cannot isolate the wording fix.
- **Competition is a separate condition.** Clean `XDG_CONFIG_HOME` excludes the user's
  standalone kanban plugin. A ranking probe in a different catalog does not establish
  what caused the isolated benchmark behavior.

Discovery is a plausible explanation worth testing. These results establish neither
that it is the sole cause nor that schema size is the cause. The brief's proposal to
replace “schema is second-order” with the opposite conclusion would overcorrect.

## Harness corrections in this revision

- Added `none-opi`: no registered plugin, the same SQLite seed and identical README
  locator as `opi`. Neither SQLite arm receives `board.json`.
- Retained `none` for the legacy fixture experiment; reports explicitly name both
  controls and comparison groups. Do not compare all five shapes as one controlled
  experiment.
- Moved the raw event stream outside the project so the model cannot read its own
  instrumentation as project evidence.
- Record timeouts, nonzero exits, zero-step runs, missing surface records, and unexpected
  tool counts as invalid. Exclude invalid runs from completed-run cost statistics;
  retain raw runs and per-model/shape `runHealth`, including all-invalid cells.
- Respect `--namespace` in non-surface counting and reject invalid repeat/concurrency
  values and unknown shapes.
- Mark task outcomes as unverified in the report. Completed-run statistics are not
  successful-task statistics, and their cost totals exclude invalid-run spend; raw
  records retain any captured spend for those runs.
- **One board, defined once.** `packages/bench/harness/board.ts` holds the five
  cards, their states and their priorities. The SQLite arms' seed, the fixture
  arms' `board.json`, the fixture plugin's in-memory board and the read tasks'
  expectations all derive from it. They did not agree: the fixture had a `todo`
  column the store does not have, and their priorities differed, so a surface
  could "win" on a board it found easier.
- **The read tasks have a success oracle.** `readPrompt` appends a JSON answer
  contract to the three read tasks; `extractAnswer` takes the final text part
  (not tool output, not reasoning); `gradeRead` checks the answer against the
  **authoritative store** — exact keys, exact count, exact title, state and
  priority — with the documented equivalents (`high` and `2` are one priority).
  A read that mutated state is a failure. Outcomes are `passed`, `failed` or
  `ungradable`, and a run that never produced an answer is `ungradable`, not
  `failed`: a broken harness must not look like a bad surface.
- **Cost per successful task** is the spend of **every attempt** divided by the
  successes, so a failed attempt's spend is counted and cheap abandonment cannot
  look efficient. With no successes the figure is **unavailable** — not zero and
  not infinite. A run whose final usage was not priced reports the measured
  figure and withholds the complete one, because incomplete billing makes it a
  lower bound.
- **The write tasks** are graded against the final SQLite state: revision
  increments must match the number of audit events, the audit payload must match
  the mutation, a no-op that merely matched the seed is not a pass, and
  verification must stay honestly `not_configured`. A claimed pass or waiver in
  a fixture with no gates is a failure.

Both SQLite arms start with equivalent logical board data. OPI still starts its own
indexing/runtime services; the control does not. Thus this is a product-availability
comparison, not a pure schema ablation or byte-identical runtime comparison.

## The matched read-task pair: product availability

The first experiment with a success oracle, a matched control and a working cost figure.
Both arms get the **same** SQLite store, the same README locator, no `board.json` in
either, and the same three read tasks. 36 runs: 2 models × 2 arms × 3 tasks × 3 repeats.

| Model | Arm | Answers | Ungradable | Spend | Cost per success | Rate over all runs | Rate over graded runs |
|---|---|---:|---:|---:|---:|---:|---:|
| `minimax-m3.1-flash` | `opi` | **5** | 4 | $0.052195 | **$0.010439** | 56% | **100%** |
| `minimax-m3.1-flash` | `none-opi` | **5** | 4 | $0.087525 | *unavailable* | 56% | **100%** |
| `deepseek-v4.1-flash` | `opi` | **9** | 0 | $0.021047 | **$0.002339** | **100%** | **100%** |
| `deepseek-v4.1-flash` | `none-opi` | **9** | 0 | $0.024097 | **$0.002677** | **100%** | **100%** |

**Not one graded answer was wrong.** Every answer the model produced was correct — 28 of
28 across both arms and both models. The ungradable runs are not wrong answers; they are
runs that never produced a parseable answer at all.

### What the ungradable runs are

Eight of the nine are **"final answer does not follow the JSON answer contract."** The
model answered correctly but did not return the requested JSON object — it wrote prose, or
a table, or a JSON object with extra fields. The answer was often right; the **shape**
was not what the contract asked for. One is a 180-second timeout.

This is a property of the **task setup**, not of the surface. The contract is appended to
the prompt, and a model that ignores it produces an answer the grader cannot read. It is
counted as `ungradable` rather than `failed`, and it is the same count in both arms.

### What this changes

**The earlier claim — that OPI's surface is more expensive than no tool — does not
survive.** On the matched pair, `opi` produced the **same number of correct answers** as
the control on both models, and cost **0.87×** the control per success on deepseek and
**less in total** on minimax. The control is not cheaper. It is not more expensive
either. **They are the same**, once the answer is actually checked.

The earlier reading came from a comparison that was unequal in five ways at once: a JSON
file against a SQLite store, no success check, a `discovery` metric that counted real
shell work, a usage check that rejected every run, and a trace read before it was
flushed. All five are fixed, and the claim does not survive the fixes.

**The expensive runs are the runs that did not answer.** Averaged on minimax:

| Arm | Passed: spend / steps | Ungradable: spend / steps |
|---|---|---|
| `opi` | $0.005574 / 14.0 | $0.008076 / 17.2 |
| `none-opi` | $0.006111 / 16.2 | $0.011904 / 18.6 |

The runs that wandered cost more than the runs that answered, **in both arms**. A surface
that gets the model to the right tool quickly spends less than one that does not — and
neither is dramatically different from the other.

### What the measurement cannot yet say

Both arms answer the same read questions correctly and at the same price, so this says
nothing about the **shape** of the surface. It says the product is **available**: with
`pi.task` the model reaches the board as readily as it does by reading the database, and
no more expensively.

The `separate` versus `actions` question needs the **fixture** arms on the same board,
which the shared board definition now makes possible — the fixture's JSON and the
SQLite seed had drifted apart, and one board is now defined once.

### The `none-opi` cell with no cost per success

`minimax`'s `none-opi` arm has no cost-per-success figure, because at least one of its
runs ended without complete billing. The harness reports the measured figure as a lower
bound and **withholds** the complete one. That is the guard working, and it is why the
comparison above uses deepseek's complete figures for the ratio.

## Surface shape: `separate` versus `actions`

The other experiment, and the one the whole exercise was raised to answer. **Same
backend, same behaviour, different tool interfaces**: the fixture plugin's in-memory board,
the same six operations (`list`, `get`, `create`, `update`, `move`, `remove`), the same
board, the same prompts, the same success oracle. Only the **interface** differs.

- `separate` — one tool per action, six tools, 1,967 bytes of schema
- `actions` — one tool with an `action` argument, one tool, 1,274 bytes

36 runs: 2 models × 2 shapes × 3 read tasks × 3 repeats.

| Model | Shape | Answers | Ungradable | Cost per success | Rate over all runs |
|---|---|---:|---:|---:|---:|
| `minimax-m3.1-flash` | `separate` | 8 | 1 | $0.001083 | 89% |
| `minimax-m3.1-flash` | `actions` | **9** | 0 | **$0.000893** | **100%** |
| `deepseek-v4.1-flash` | `separate` | 9 | 0 | $0.000801 | 100% |
| `deepseek-v4.1-flash` | `actions` | 9 | 0 | **$0.000774** | 100% |

**Not one graded answer was wrong** — 35 of 35. Every failure of either shape was an
answer that did not follow the JSON contract, and there was one.

**The single tool is cheaper on both models**: 1.21× cheaper per success on minimax,
1.03× on deepseek. Neither difference is large, and on deepseek both shapes answered
every question correctly.

### The mechanism, visible in the call counts

Totals across the 9 runs of each cell:

| Model | Shape | Tool calls | Model steps | Non-surface calls |
|---|---|---:|---:|---:|
| `minimax` | `separate` | **49** | 24 | 0 |
| `minimax` | `actions` | **23** | 21 | 3 |
| `deepseek` | `separate` | 10 | 10 | 0 |
| `deepseek` | `actions` | 10 | 10 | 0 |

The difference is entirely in **minimax**, and it is one specific behaviour. On
`list-all`, with the six-tool surface, it called `task_list` **10, 15 and 10 times** —
for one question, asking for the same list repeatedly. With the single tool it made
**9 calls across 3 runs**, three per run.

The six separate tools each advertise themselves separately, and the model kept
re-selecting one of them. The single tool has one thing to select, and it selected it
once.

**This is the "discovery" cost, isolated.** The earlier `discoveryCalls` metric counted
non-surface calls, which included real shell work and could not attribute a cause. Here
the cause is plain: the same operation, exposed six ways, was chosen repeatedly.

### What this says about the surface

**One tool per action is a worse interface than one tool with an action argument**, on
this task set, on both models. The `separate` shape costs more, never costs less, and
its advantage — each action with its own schema and description — bought nothing
measurable: zero malformed calls either way, and the same answers.

**But the difference is small**: 3% on deepseek, 21% on minimax, and on deepseek both
shapes were perfect. The earlier claim that the single tool was 6.7× cheaper came from
an unequal comparison and does not survive.

## The wording ablation: does the description change actually help?

The description change of October 2026 was made because a catalog probe said it should:
a model searching for *"list cards on the board"* ranked `pi.task` eighth, behind a
different plugin's tools. Nobody had measured whether it helps.

This measures it. The **control arm** is the same product with the **pre-change
wording**: same schema, same backend, same board, same tasks, same model. Only the
prose differs. Both wordings are kept in `packages/adapter-opencode/src/descriptions.ts`,
so the control cannot drift into the treatment.

36 runs: 2 models × 2 arms × 3 read tasks × 3 repeats.

| Model | Arm | Answers | Ungradable | Cost per success | Rate over all runs |
|---|---|---:|---:|---:|---:|
| `minimax-m3.1-flash` | `opi-baseline` (control) | 3 | 6 | $0.017119 | 33% |
| `minimax-m3.1-flash` | `opi` (revised) | **4** | 5 | **$0.014191** | **44%** |
| `deepseek-v4.1-flash` | `opi-baseline` (control) | 9 | 0 | $0.002490 | 100% |
| `deepseek-v4.1-flash` | `opi` (revised) | 9 | 0 | **$0.002313** | 100% |

**Every graded answer was correct** — 25 of 25. The ungradable runs are answers that
did not follow the JSON contract, in **both** arms.

### What the comparison shows

On deepseek, where both arms answered every question correctly, the comparison is a
pure cost comparison:

| Arm | Spend | Steps | Non-surface calls | Tool calls |
|---|---:|---:|---:|---:|
| `opi-baseline` | $0.022413 | 67 | 76 | 6 |
| `opi` (revised) | **$0.020818** | **63** | **67** | 8 |

The revised wording is **7% cheaper**, with **6% fewer steps** and **12% fewer
non-surface calls**. The non-surface count is the discovery cost: the model spent less
time looking for the tool and more time using it.

On minimax the revised arm produced **one more correct answer** (4 against 3) and was
**17% cheaper per success**, but it also spent *more* on two of the three tasks. The
per-task picture is noisy:

| Task | Control: passed / ungradable | Revised: passed / ungradable |
|---|---|---|
| `list-all` | 0 / 3 | **1** / 2 |
| `list-column` | 0 / 3 | **1** / 2 |
| `get-one` | **3** / 0 | 2 / 1 |

**The honest reading: the change is worth something, and it is small.** It is
consistently in the right direction — cheaper on both models, more answers on the model
that struggles — but the effect is in the single digits on the model that was already
perfect, and minimax's per-task numbers go both ways.

### What this does not show

Minimax's answers are mostly ungradable for a reason that has nothing to do with
wording: it does not return the JSON object the contract asks for. Nine of its
fifteen runs are ungradable in **both** arms. The wording change cannot be credited or
blamed for that, and the comparison between the arms is thinner than 36 runs suggests.

## The guidance ablation: a null result that was not null

The guidance change — telling the agent to read the project through the tools rather
than through the filesystem — was built and measured the same way as the description
change: a control arm with the pre-change guidance, kept in
`packages/adapter-opencode/src/guidance.ts`, selectable per instance.

| Model | Arm | Answers | Ungradable | Cost per success |
|---|---|---:|---:|---:|
| `minimax-m3.1-flash` | `direct` | **5** | 4 | unavailable |
| `minimax-m3.1-flash` | control | 3 | 6 | unavailable |
| `deepseek-v4.1-flash` | `direct` | 9 | 0 | $0.002511 |
| `deepseek-v4.1-flash` | control | 9 | 0 | $0.002376 |

The direct arm produced more answers on minimax and cost 6% more on deepseek. A
plausible result, and **not to be believed**, because the traces show what actually
happened:

### The skill was never loaded

OPI's guidance is a **skill**, and skills are loaded on demand. The traces of the
`direct` arm show the model never loading it:

```
[shell] ls -la
[read] ...
[shell] find .bench-config -type f | head -50
[execute] const s = await tools.pi.status({action:"summary"}); return s;
[shell] cd .../.opi-data && head -c 3000 .../registry.sqlite
...
[execute] const r = await tools.pi.task({action:"list", limit:200}); return r;
```

No skill load, anywhere. The model went to the filesystem, found the SQLite database,
and read it directly — which is precisely the failure the guidance was written to
prevent. **The guidance never reached the model, so the ablation measured nothing.**

### Why the skill never loaded

The skill's **description** is what makes a model load it:

> *"Reach for it when a question names a concept, a symbol, a task or a decision — and
> prefer it to reading whole files."*

The benchmark's questions are:

| Question | Trigger words present |
|---|---|
| "List every card on the board. Report the total count." | **none** |
| "List the cards that are in the `in_progress` column." | **none** |
| "Read the card with id `kb-seed03` and report its title…" | **none** |

**Not one of the three read tasks contains a trigger word.** The skill fires on "task";
the benchmark says "card". The model had no reason to load a guide that was not
mentioned.

### What this means for the results already recorded

**The description ablation is confounded in the same way.** The revised descriptions
carry the word "card" — which is why `pi.task` was found in the catalog ranking probe —
but the *skill* is a separate surface with its own trigger list, and it was not loaded
there either. The wording result is a measurement of the **catalog** effect, which is
real and was measured directly; it says nothing about the guidance, because the
guidance was not in play.

**And the discovery cost has a specific, fixable cause.** The model explored the
filesystem because it had no reason to believe there was a tool for this question. The
skill's trigger list is the thing that decides whether it finds out. That is a
**cheaper and more direct lever than either the descriptions or the guidance body**:
one phrase, in one place, that names the words people actually use.

This is a better hypothesis than either of the two that were measured, and it is
testable: change the skill's *description* so it triggers on "card" and "board", and
measure whether the model loads it and stops reading the database.

## The guidance ablation, corrected

The first guidance ablation measured nothing, for a reason that was not about wording:
**the `skill` tool was not enabled in the harness.** The skill was registered, and the
model had no way to load it, so no arm ever received the guidance. A null result that
looks exactly like "the change does not help" when the change never arrived.

The harness now enables `agent.build.tools.skill`, and the traces show the model loading
OPI's skill as its **first action** before reaching for any tool.

Re-run with that fixed — both arms carry the revised descriptions, so only the guidance
body differs.

| Model | Arm | Answers | Ungradable | Cost per success | Rate over all runs |
|---|---|---:|---:|---:|---:|
| `minimax-m3.1-flash` | control | **6** | 3 | **$0.004410** | **67%** |
| `minimax-m3.1-flash` | `direct` | 4 | 5 | $0.009313 | 44% |
| `deepseek-v4.1-flash` | control | 9 | 0 | $0.003060 | 100% |
| `deepseek-v4.1-flash` | `direct` | 9 | 0 | **$0.002644** | 100% |

**The result is split, and the split is the finding.**

| Model | Non-surface calls: control → direct | Steps: control → direct |
|---|---|---|
| `minimax` | 53 → **84** | 69 → **105** |
| `deepseek` | 72 → **44** | 79 → **61** |

On deepseek the direct guidance is **14% cheaper per success**, with **39% fewer
non-surface calls** — the model spent much less time looking for the tool. On minimax
it is **2.1× more expensive**, with *more* exploration, and it answered two fewer
questions.

**What this means.** The guidance is not a free win, and it is not a loss. It helps a
model that would otherwise waste time searching, and it **hurts** a model that is
already finding the tool — plausibly because the extra instruction adds a decision point
at the start of every run, and minimax is the model that gets the most unanswerable
answers anyway.

### The honest reading

**The guidance cannot be adopted on this evidence.** A change that is 14% better on one
model and 2.1× worse on another is not a change that can be justified for everyone, and
the models disagree in *direction*, not just in size. It needs either more models, or a
task set that does not depend on a model whose JSON-contract compliance is already the
limiting factor.

**The `skill` tool finding stands on its own**, and it is the more important one: the
harness was measuring a treatment that was never delivered. Every arm was blind. That
was found by reading a trace, not by reading a number, and it would have produced a
clean, wrong, published-sounding null result.

## The write tasks: the product's own surface, two shapes, one store

The surface-shape experiment measured the **fixture's** two shapes. The fixture is a
different product — no revision, no audit history, no guarded transitions — so it cannot
answer the write questions at all, and a comparison across the two backends would have
measured the backends.

So the **product's** task tool now has two shapes, over the **same** SQLite store, with
the same guard, the same audit history and the same implementation
(`packages/adapter-opencode/src/task-tool.ts`):

- `opi` — one tool, `pi.task`, with an `action` argument. What ships.
- `opi-split` — nine tools: `pi.task_list`, `pi.task_get`, `pi.task_create`,
  `pi.task_update`, `pi.task_transition`, `pi.task_link`, `pi.task_unlink`,
  `pi.task_history`, `pi.task_delete`. Each carries **only** the arguments its action
  needs.

48 runs: 2 models × 2 shapes × 4 write fixtures × 3 repeats. The four fixtures are the
ones `gradeWrite` supports: `move-card`, `update-priority-change`, `complete-card` and
`error-missing-arg`.

| Model | Shape | Answers | Failed | Ungradable | Cost per success | Rate |
|---|---|---:|---:|---:|---:|---:|
| `minimax-m3.1-flash` | `opi` | **12** | 0 | 0 | $0.010091 | **100%** |
| `minimax-m3.1-flash` | `opi-split` | 10 | 0 | 2 | unavailable | 83% |
| `deepseek-v4.1-flash` | `opi` | **12** | 0 | 0 | $0.004837 | 100% |
| `deepseek-v4.1-flash` | `opi-split` | **12** | 0 | 0 | unavailable | 100% |

**No graded write was wrong, in either shape or on either model.** The product's own
invariants held under test: revision increments matched the audit events, the audit
payloads matched the mutations, prior history was not rewritten, no unrelated card
changed, and verification stayed honestly `not_configured` — a claimed pass would have
been a failure.

The two ungradable runs are **timeouts**, not wrong answers, and the traces show why.
With the split shape, minimax could not work out that `expected_revision` was
required, so it went and read the plugin's **source code** to find out:

```
[shell] cd .../packages; grep -rn "expected_revision" --include=*.ts
[read] ...
[execute] const r = await tools.pi.task_update({
    task: "kb-seed01", priority: 1, expected_revision: 1,
  })
```

**The write succeeded** — priority 1, revision 2, verification `not_configured` — and
the run then timed out, still exploring. 38 tool calls for one update.

### What this says

**The single tool wins again, and this time on the product's own store and the product's
own write semantics.** On the read tasks, the split shape made a model call the same tool
10, 15 and 10 times for one question; here it made a model read the plugin's source
code to learn an argument that the single tool's schema already stated.

The mechanism is the same both times: **a wider surface gives a model more to choose
from, and more to misunderstand.** The split shape's own argument lists are *narrower* —
`pi.task_get` has no `state`, `pi.task_list` has no `task` — and the model still got
stuck, because the narrow list is only as good as the model's reading of it.

**The cost is small where the task is easy and large where the task is hard.** `move-card`
took 10 calls on `opi` and 7 on `opi-split` (deepseek); `update-priority-change` took 10
on `opi` and 19 on `opi-split`. The gap opens exactly where the task has a rule the
model has to know.

## The schema-size arm: the plan's premise, tested

ADR-009 proposed a **small** tool surface, on the stated reason that a smaller surface
costs less: fewer bytes on every request, and a smaller catalog to choose from. That
reason had never been tested. Every measurement so far changed the surface's
**structure** — one tool per action against one tool with an `action` argument — and a
structural change moves the size and the shape together, so the two could not be told
apart.

This arm isolates **size**. The same six tools, the same arguments, the same enums, the
same behaviour; only the **prose** is shorter. Each description is one line, and each
argument's description says what the argument *is* rather than when it is required —
the "when" is stated once, in the tool's description, instead of on every argument.

The surface shrank from **9,653 bytes to 5,993** — 38% less — with nothing else
changed.

60 runs: 2 models × 2 shapes × 5 tasks × 3 repeats. The five tasks are the three read
ones and two write ones, so the arm covers the read path and the guarded write path.

| Model | Shape | Answers | Ungradable | Schema | Cost per success | Rate |
|---|---|---:|---:|---:|---:|---:|
| `minimax-m3.1-flash` | `opi` (full) | 10 | 5 | 9,653 B | $0.011459 | 67% |
| `minimax-m3.1-flash` | `opi-minimal` | **14** | 1 | **5,993 B** | **$0.004407** | **93%** |
| `deepseek-v4.1-flash` | `opi` (full) | 15 | 0 | 9,653 B | $0.002152 | 100% |
| `deepseek-v4.1-flash` | `opi-minimal` | 15 | 0 | **5,993 B** | **$0.001528** | 100% |

**The smaller schema is better, on both models, and it is not close.**

- minimax: **38% cheaper per success** and **four more correct answers** (14 against 10).
- deepseek: **29% cheaper per success**, the same answers.

And the direction is the same as every other result in this file: **less text, less
exploration.**

### The mechanism

Non-surface calls, over each cell's 15 runs:

| Model | Shape | Non-surface calls | Steps | Non-surface as a share of steps |
|---|---|---:|---:|---:|
| `minimax` | `opi` | 208 | 256 | 81% |
| `minimax` | `opi-minimal` | **88** | 134 | **66%** |
| `deepseek` | `opi` | 64 | 84 | 76% |
| `deepseek` | `opi-minimal` | **24** | 51 | **47%** |

On the read tasks, where the difference is clearest (minimax, non-surface calls):

| Task | `opi` | `opi-minimal` |
|---|---:|---:|
| `list-all` | 31 | **0** |
| `list-column` | 48 | **2** |
| `get-one` | 22 | **12** |

The full schema's prose is long enough that a model reads the catalog, cannot work out
which tool answers the question, and goes looking. The minimal schema says the same
things in fewer words, and the model reaches the tool immediately.

### What this says about ADR-009

**ADR-009's premise was right and its conclusion was wrong.** It said a small surface is
better *because* it costs less — and it does cost less, substantially. But the reason it
gave was "fewer bytes on every request", which is the wrong mechanism: the saving is in
the **exploration**, not in the request. The bytes cost 38% less and the requests cost
38% less too, but the money went on the model's *searching*, and the smaller schema
searched less.

**And the plan's conclusion — seven tools with action arguments — was not the way to get
a small surface.** One tool per domain with short descriptions is smaller, and it is
smaller *and* easier to find.

## The three arms, re-taken on the minimal schema

The wording, guidance and structure arms were all measured against the **full**
schema. If the schema is shortened, they have to be re-taken against the new one,
because a change to one can move the others. 72 runs: 4 arms × 2 models × 3 read
tasks × 3 repeats.

| Model | Arm | Answers | Ungradable | Cost per success | Rate |
|---|---|---:|---:|---:|---:|
| `minimax` | minimal baseline | 7 | 2 | $0.001903 | 78% |
| `minimax` | baseline **wording** | 8 | 1 | $0.001751 | 89% |
| `minimax` | baseline **guidance** | **9** | 0 | **$0.001204** | **100%** |
| `deepseek` | minimal baseline | 9 | 0 | $0.000783 | 100% |
| `deepseek` | baseline **wording** | 9 | 0 | $0.000743 | 100% |
| `deepseek` | baseline **guidance** | 9 | 0 | $0.000822 | 100% |

**The result reversed, and it is worth being careful about why.**

On the full schema, the direct guidance *hurt* minimax — 2.1× the cost per success
against the baseline guidance. On the minimal schema, the **baseline** guidance is the
*best* arm: 100% against 78%, and 37% cheaper per success. The same change now helps
the model it used to hurt.

### What actually explains it

The ungradable runs are **all** "final answer does not follow the JSON answer
contract" — minimax writing prose where the contract asked for a JSON object. That is
an **output-format** failure, not a discovery failure, and it is what the differences
here are made of:

| Task | minimal | baseline wording | baseline guidance |
|---|---|---|---|
| `list-all` | 2p / 1u | 3p / 0u | 3p / 0u |
| `list-column` | 2p / 1u | 3p / 0u | 3p / 0u |
| `get-one` | 3p / 0u | 2p / 1u | 3p / 0u |

The ungradable run moves between tasks from arm to arm. That is the signature of a
model whose **format compliance varies run to run**, not of a lever that is working.
On deepseek, where every run was gradable, the three arms are within **5%** of each
other — $0.000743 to $0.000822 per success.

**So the honest reading is: on the minimal schema, the three levers no longer show a
measurable effect, and the differences that remain are minimax's format noise.**

That is not a null result about the levers. It is a **measurement that ran out of
resolution**, because the thing that moved the cost was never the thing being
measured. On the full schema the discovery cost was large enough (81% of minimax's
steps) to see through the noise. On the minimal schema it is 16 calls out of 35 steps,
and a single ungraded run swamps it.

**What this means for the decision.** The schema-size result stands — it is the
largest effect measured, and it was measured where the signal was strong enough to
see. The three other levers are **not yet settled on the minimal schema**, and they
should not be reported as settled. They need either a task set that minimax can
answer in the required format, or more repeats, or a third model.

## Next experiment and decision rule

Start with the read-only tasks `list-all,list-column,get-one`, inspecting retained
traces for answer correctness. Then add deterministic write checks against the
SQLite store, including revisions and verification invariants where relevant.
Do not use the full fixture task set as a product success test until unsupported
operations and state mappings have explicit expectations.

Example small paired run (uses configured model providers and may incur charges):

```sh
bun run packages/bench/harness/run.ts \
  --models ollama-cloud/minimax-m3.1-flash,ollama-cloud/deepseek-v4.1-flash \
  --shapes opi,none-opi --tasks list-all,list-column,get-one --repeats 3 --keep
```

`--keep` prints both the project and artifact directories. A matched SQLite model run
has not been performed as part of this correction; there is no claimed new cost result.

Before a larger paid matrix:

1. Add answer/final-state validation and report success rates per task and model.
2. Record executable version, source/schema hashes, prompt variant, and catalog condition.
3. Interleave or randomize matched cells to reduce ordering and provider/cache effects.
4. Test baseline wording versus revised wording with the same schema/backend; then test
   explicit direct-tool guidance separately. Test schema reduction separately again.
5. Test the competing kanban catalog as a distinct condition. Decide board ownership
   based on product responsibilities and routing behavior, not search rank alone.

Keep the six-tool interface provisionally. Choose a replacement only when it improves
cost and latency at comparable validated success rates. Do not remove task-state or
verification safeguards to make synthetic card operations appear successful.


## Architecture reconciliation: oracle hardening

The read oracle added after the initial control correction is now versioned as
`read-lexical-v2`. Regression cases reject numeric/key prefix matches, unrelated
numbers/list indices as counts, additional non-seed card keys, recognized contradictory
counts/priorities, and facts taken from a neighboring card. Seed-parity tests compare
its static facts with the actual SQLite seed. These are bounded lexical checks, not a
complete natural-language correctness proof; write tasks are still ungradable.

Report format 3 adds per-model/shape/task `outcomes`, including all-invalid cells,
`oracleVersion`, and distinct planned/attempted run counts. `successRate` now uses all
attempts as its denominator; `gradedSuccessRate` is conditional accuracy among graded
answers. `costPerSuccessfulTask` includes measured spend from every attempt. With no
successes it remains null. Unknown provider billing still needs explicit representation;
recorded zero must not be interpreted as proof that a request was free.

The older `summary` keeps completed-run statistics and may omit all-invalid cells;
use `outcomes` and `runHealth` for full failure accounting. Historical reports are not
rewritten. No new provider-backed benchmark was run for this change.

See [OPI-N01/N02](../architecture/implementation-backlog.md) for the completed increment
and remaining oracle/experiment work.


## Structured outcome validation supersedes the lexical runtime oracle

Report format 4 uses `structured-sqlite-v1`: read facts come from the pre-run snapshot,
final messages are assembled by identity, and four SQLite write tasks have state/history
checks. Read instructions changed equally for all arms; old and new runs must not be
pooled. Missing final usage is now explicit, and definitive cost/success stays null when
billing is incomplete. See the [outcome contract](outcome-validation.md) for exact task
coverage, unsupported cases, retained evidence and remaining experiment work.

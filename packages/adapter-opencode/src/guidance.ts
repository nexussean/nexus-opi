/**
 * The agent guidance, in two variants.
 *
 * ## Why there are two
 *
 * The benchmark found that OPI's surface costs as much as having **no tool at
 * all**, and the cause was discovery: a model searching the catalog for
 * *"list cards on the board"* ranked `pi.task` eighth, behind a different
 * plugin's tools.
 *
 * Two different fixes suggest themselves, and they are **not** the same fix:
 *
 * 1. **Describe the tool better.** Say what it is for, in the words people use.
 *    This is the description change, measured separately — see
 *    `descriptions.ts` and the wording ablation.
 * 2. **Tell the agent to use the tool.** Say, in the guidance the agent reads,
 *    that the board is read through `pi.task` and not by reading the database.
 *    This is what Hermes does: *"The model reads and routes tasks by calling
 *    tools directly, not by shelling out to `hermes kanban`."*
 *
 * A model that explores the filesystem before it reaches for the tool is a
 * model paying for the exploration. The description cannot prevent that — it
 * only says what the tool is **for**. The guidance can say what to **do**.
 *
 * These have to be measured separately, or a change to one is credited to the
 * other. This module is the second one.
 *
 * ## The difference
 *
 * The `baseline` variant is the guidance as it shipped before the change. The
 * `direct` variant adds a short section telling the agent to reach for the
 * tool rather than the filesystem.
 *
 * The guidance is the **skill**, which is loaded on demand. It is not in every
 * request, so it is not a per-request cost — it is a cost paid when the agent
 * needs it, and the question is whether it is worth it.
 */

export type GuidanceVariant = "baseline" | "direct"

/**
 * The guidance the skill carries.
 *
 * The `direct` variant's addition is at the end, so the diff is one block and
 * the rest is provably untouched.
 */
export const GUIDANCE: Record<GuidanceVariant, { opening: string; direct: string }> = {
  /**
   * The guidance as it shipped before October 2026. It says what OPI is for
   * and when to reach for it — but it never says to *prefer* the tool over
   * reading the filesystem, which is the behaviour the benchmark caught.
   */
  baseline: {
    opening: `## OpenCode Project Intelligence

OPI keeps a local index of this project: its files, its symbols, its tasks, its
decisions and its verification evidence. It is a **local** tool — nothing it
does leaves the machine.

### When to reach for it

- **"Where is X?"** or "which file handles Y?" — \`pi.context\` with the question
  in words. It returns cited snippets within a token budget, and each one says
  why it was selected. Prefer it to grep for anything that names a concept.
- **"What does this symbol touch?"** — \`pi.graph\` with \`neighbors\`, \`importers\`,
  \`impact\` or \`related_tests\`. Every result cites a file and a line, and states
  how confident it is.
- **"What is the next task?"** — \`pi.task\` with \`action: "list"\`. The board shows
  what is waiting for a dependency and what to do next.
- **"Can I close this?"** — \`pi.verify\` with \`action: "evaluate_task"\`. It reports
  whether the evidence is current. A task reaches \`done\` on passing evidence or
  on a recorded waiver, and nothing else.
- **"What did we decide?"** — \`pi.memory\` with \`action: "search"\`. Decisions and
  proposals come back in separate sections: only a confirmed decision or a
  verified fact may be acted on as true.

### What not to do

- **Do not read a whole file to answer a question.** \`pi.context\` gives the
  relevant span with a citation. Read the file when you need to change it.
- **Do not treat a graph edge as a proven call.** The edges are syntactic unless
  the tool says otherwise; a reference is a superset, not a call list.
- **Do not mark a task done because you believe the work is correct.** The
  evidence decides. If the checks have not run, the task is unverified, and
  saying so is the correct answer.
- **Do not treat a proposed memory as a decision.** It is a lead until a person
  confirms it.
- **Do not re-implement what the index already knows.** If \`pi.context\` answered
  it, do not grep for it again.

### Editing the project

OPI does not write your code. Use the normal editing tools. The index notices
the change on its own and refreshes within about a second.
`,
    direct: "",
  },

  /**
   * The same guidance, plus a short section that says what to **do** rather
   * than what the tools are for.
   *
   * The wording is Hermes's: *"The model reads and routes tasks by calling
   * tools directly, not by shelling out."* The benchmark caught exactly that
   * failure — a model that found the database and spent its run reading it.
   */
  direct: {
    opening: `## OpenCode Project Intelligence

OPI keeps a local index of this project: its files, its symbols, its tasks, its
decisions and its verification evidence. It is a **local** tool — nothing it
does leaves the machine.

### When to reach for it

- **"Where is X?"** or "which file handles Y?" — \`pi.context\` with the question
  in words. It returns cited snippets within a token budget, and each one says
  why it was selected. Prefer it to grep for anything that names a concept.
- **"What does this symbol touch?"** — \`pi.graph\` with \`neighbors\`, \`importers\`,
  \`impact\` or \`related_tests\`. Every result cites a file and a line, and states
  how confident it is.
- **"What is the next task?"** — \`pi.task\` with \`action: "list"\`. The board shows
  what is waiting for a dependency and what to do next.
- **"Can I close this?"** — \`pi.verify\` with \`action: "evaluate_task"\`. It reports
  whether the evidence is current. A task reaches \`done\` on passing evidence or
  on a recorded waiver, and nothing else.
- **"What did we decide?"** — \`pi.memory\` with \`action: "search"\`. Decisions and
  proposals come back in separate sections: only a confirmed decision or a
  verified fact may be acted on as true.

### Read through the tools, not the files

**The tools are the interface. Use them before you read anything.**

- **Do not read the task database, the index, or the board's files to answer a
  question about the project.** Call \`pi.task\`, \`pi.context\`, \`pi.graph\`,
  \`pi.memory\` or \`pi.verify\`. The database is OPI's storage, not yours to
  read, and reading it is slower, less complete and more likely to be wrong
  than asking the tool that owns it.
- **Do not search the filesystem for what the index already knows.** If
  \`pi.context\` answered it, do not grep for it again.
- **If you are unsure which tool answers the question, use the one whose name
  matches what you were asked** — the board is \`pi.task\`, the code is
  \`pi.context\` and \`pi.graph\`, the decisions are \`pi.memory\`, the checks are
  \`pi.verify\`.

### What not to do

- **Do not read a whole file to answer a question.** \`pi.context\` gives the
  relevant span with a citation. Read the file when you need to change it.
- **Do not treat a graph edge as a proven call.** The edges are syntactic unless
  the tool says otherwise; a reference is a superset, not a call list.
- **Do not mark a task done because you believe the work is correct.** The
  evidence decides. If the checks have not run, the task is unverified, and
  saying so is the correct answer.
- **Do not treat a proposed memory as a decision.** It is a lead until a person
  confirms it.
- **Do not re-implement what the index already knows.** If \`pi.context\` answered
  it, do not grep for it again.

### Editing the project

OPI does not write your code. Use the normal editing tools. The index notices
the change on its own and refreshes within about a second.
`,
    direct: "",
  },
}

/**
 * The guidance text for a variant.
 *
 * The `direct` variant is the `baseline` guidance with one section inserted,
 * so the rest of the text is provably identical.
 */
export function guidanceFor(variant: GuidanceVariant): string {
  const entry = GUIDANCE[variant]
  if (!entry) return GUIDANCE.baseline.opening
  return entry.opening
}

/**
 * The guidance variant a plugin instance should use.
 *
 * `direct` is the default, because it is what ships. `baseline` is the control
 * for the guidance ablation.
 */
export function guidanceVariantFor(value: unknown): GuidanceVariant {
  return value === "baseline" ? "baseline" : "direct"
}

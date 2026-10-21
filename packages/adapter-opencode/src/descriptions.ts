/**
 * The tool descriptions, in two variants.
 *
 * ## Why there are two
 *
 * The descriptions were changed in October 2026, after a measurement showed that a
 * model searching the catalog for *"list cards on the board"* ranked `pi.task` **8th** —
 * behind a *different* plugin's tools, whose descriptions said "card" while OPI's said
 * "task". Every description was rewritten to carry its own name and the words people
 * actually use.
 *
 * That change is a **hypothesis**, not a result. It was made because the catalog
 * ranking said it should help; nobody has measured whether it does.
 *
 * Measuring it needs a **control arm**: the same schema, the same backend, the same
 * board, the same tasks, the same model — and the **old** wording. This module keeps
 * both wordings, explicitly, so the ablation is a matched experiment rather than a
 * comparison against whatever the code happens to say today.
 *
 * The old wording is preserved here rather than left in version control, because the
 * old wording is the *control*, and a control that has to be reconstructed is a
 * control that can drift.
 *
 * ## The difference
 *
 * The `baseline` variant is the wording from before the change. The `revised` variant
 * adds, to each tool:
 *
 * - the tool's own **name** in its description ("the code context", "the code graph"),
 *   so a search for the tool's name finds it; and
 * - the **user's** words for the thing ("cards, issues and work items"), so a search
 *   for those finds it too.
 *
 * The action lists, the schemas, the arguments and the semantics are **identical**.
 * Only the prose differs. That is what makes the comparison a test of wording.
 */

/** Which wording a plugin instance uses. */
import { MINIMAL_DESCRIPTIONS } from "./schema-size.ts"

export type DescriptionVariant = "baseline" | "revised"

/**
 * The tool descriptions.
 *
 * Each entry is the description's lines, in order. The revised variant's extra lines
 * are marked, so the diff between the two is legible here and not only in the
 * rendering.
 */
export const DESCRIPTIONS: Record<DescriptionVariant, Record<string, string[]>> = {
  /**
   * The wording from before October 2026. It is the control, and it is kept
   * exactly as it was — including its missing the tool's own name.
   */
  baseline: {
    context: [
      "Get the code most likely to answer a question, with citations.",
      "",
      "Returns the smallest useful spans, each with a file, a line and why it was selected.",
      "The pack is bounded by a token budget; when it is cut, that is reported.",
      "Use this before reading files at random, and prefer it over broad searches.",
    ],
    graph: [
      "Query the code graph of the current project.",
      "",
      "action:",
      "- symbol_search: find where a symbol is defined.",
      "- neighbors: the files linked to a symbol or file by an import.",
      "- references: the places that mention a name. A superset, not a proven call list.",
      "- callers: the same, named for what a developer wants to know.",
      "- importers: the files that import a file.",
      "- impact: the files that import or mention a symbol.",
      "- related_tests: test files that might cover a symbol.",
      "",
      "Every result cites a file and a line, and says how confident it is.",
      "Edges are syntactic unless stated otherwise: no binding is proven.",
    ],
    task: [
      "Work with the project's task board.",
      "",
      "action:",
      "- list: the tasks, with what each is waiting for.",
      "- get: one task, with its acceptance criteria and evidence.",
      "- create: a new task.",
      "- update: change a task's title, criteria, priority or type.",
      "- transition: move a task to another state.",
      "- link: relate two tasks. 'blocks' makes one wait for the other.",
      "- unlink: remove a relation.",
      "- history: what happened to a task, in order.",
      "- delete: remove a task, its links and its history.",
      "",
      "A task is scoped to the current project. A key like 'PI-0012' is enough.",
      "",
      "Every task carries its verification state. A task that is done but",
      "unverified says so, and does not pretend otherwise. Moving a task to",
      "'done' needs passing checks or a recorded waiver, unless the project",
      "has no check policy at all.",
      "",
      "Writing a task needs its revision: read it first, then pass the",
      "revision you read. A stale revision is refused rather than overwritten.",
    ],
    memory: [
      "The project's decisions, facts and handoffs.",
      "",
      "action:",
      "- search: find memories. Decisions and leads are returned separately.",
      "- list: every memory, with its trust and whether it is stale.",
      "- propose: record something you noticed, with its evidence.",
      "- handoff: record what happened in this session, so the next one can pick it up.",
      "- resume: the last handoff for a task, so a session can continue.",
      "",
      "A memory's trust comes from who confirmed it, not from what it says.",
      "You can propose, and you can report a handoff. You cannot confirm a",
      "memory — a person does that, through the opi command line.",
      "",
      "A proposal is a lead, not a constraint. Only a confirmed decision or",
      "a verified fact may be acted on as true.",
    ],
    verify: [
      "The project's quality checks.",
      "",
      "action:",
      "- list_gates: the registered checks, and what can be detected.",
      "- propose_gates: suggest a check from what the project looks like.",
      "- configure_gate: change a gate's scope, timeout or the task types it is required for.",
      "- run: run an approved check, by its id.",
      "- results: the runs of a check, and whether they are still valid.",
      "- waive: record that a human accepted the risk of skipping a check.",
      "- evaluate_task: what a task's evidence says, and what is missing.",
      "",
      "A check is a reviewed command, not a string. `run` takes a gate id",
      "and nothing else — there is no way to hand it a command to run.",
      "Only an approved gate runs, and only when the project has turned on",
      "check execution.",
      "",
      "A green run is evidence for the code it ran against. If the code",
      "changes afterwards the evidence goes stale, and a stale run cannot",
      "complete a task.",
    ],
    status: [
      "Report what OPI knows about the current project.",
      "",
      "action:",
      "- summary: the project, its worktree and the feature flags. Default.",
      "- doctor: the same, plus resolved data paths and diagnostics.",
      "- index_status: the freshness of the code index.",
      "- reindex: rebuild the code index. Only meaningful once indexing exists.",
    ],
  },

  /**
   * The current wording. Each description carries its own name and the words people
   * use for the thing.
   */
  revised: {
    context: [
      "Get the code context most likely to answer a question, with citations.",
      "",
      "Returns the smallest useful spans, each with a file, a line and why it was selected.",
      "The pack is bounded by a token budget; when it is cut, that is reported.",
      "Use this before reading files at random, and prefer it over broad searches.",
    ],
    graph: [
      "Query the code graph of the current project — the symbol graph.",
      "",
      "action:",
      "- symbol_search: find where a symbol is defined.",
      "- neighbors: the files linked to a symbol or file by an import.",
      "- references: the places that mention a name. A superset, not a proven call list.",
      "- callers: the same, named for what a developer wants to know.",
      "- importers: the files that import a file.",
      "- impact: the files that import or mention a symbol.",
      "- related_tests: test files that might cover a symbol.",
      "",
      "Every result cites a file and a line, and says how confident it is.",
      "Edges are syntactic unless stated otherwise: no binding is proven.",
    ],
    task: [
      "Work with the project's task board — the cards, issues and work items on it.",
      "",
      "This is the board. A card is a task: it has a title, a priority, a",
      "state, acceptance criteria and verification evidence.",
      "",
      "action:",
      "- list: the tasks, with what each is waiting for.",
      "- get: one task, with its acceptance criteria and evidence.",
      "- create: a new task.",
      "- update: change a task's title, criteria, priority or type.",
      "- transition: move a task to another state.",
      "- link: relate two tasks. 'blocks' makes one wait for the other.",
      "- unlink: remove a relation.",
      "- history: what happened to a task, in order.",
      "- delete: remove a task, its links and its history.",
      "",
      "A task is scoped to the current project. A key like 'PI-0012' is enough.",
      "",
      "Every task carries its verification state. A task that is done but",
      "unverified says so, and does not pretend otherwise. Moving a task to",
      "'done' needs passing checks or a recorded waiver, unless the project",
      "has no check policy at all.",
      "",
      "Writing a task needs its revision: read it first, then pass the",
      "revision you read. A stale revision is refused rather than overwritten.",
    ],
    memory: [
      "The project's memory: its decisions, facts and handoffs.",
      "",
      "action:",
      "- search: find memories. Decisions and leads are returned separately.",
      "- list: every memory, with its trust and whether it is stale.",
      "- propose: record something you noticed, with its evidence.",
      "- handoff: record what happened in this session, so the next one can pick it up.",
      "- resume: the last handoff for a task, so a session can continue.",
      "",
      "A memory's trust comes from who confirmed it, not from what it says.",
      "You can propose, and you can report a handoff. You cannot confirm a",
      "memory — a person does that, through the opi command line.",
      "",
      "A proposal is a lead, not a constraint. Only a confirmed decision or",
      "a verified fact may be acted on as true.",
    ],
    verify: [
      "Verify the project: its quality checks, the verification gates and their evidence.",
      "",
      "action:",
      "- list_gates: the registered checks, and what can be detected.",
      "- propose_gates: suggest a check from what the project looks like.",
      "- configure_gate: change a gate's scope, timeout or the task types it is required for.",
      "- run: run an approved check, by its id.",
      "- results: the runs of a check, and whether they are still valid.",
      "- waive: record that a human accepted the risk of skipping a check.",
      "- evaluate_task: what a task's evidence says, and what is missing.",
      "",
      "A check is a reviewed command, not a string. `run` takes a gate id",
      "and nothing else — there is no way to hand it a command to run.",
      "Only an approved gate runs, and only when the project has turned on",
      "check execution.",
      "",
      "A green run is evidence for the code it ran against. If the code",
      "changes afterwards the evidence goes stale, and a stale run cannot",
      "complete a task.",
    ],
    status: [
      "Report what OPI knows about the current project — its status, index and flags.",
      "",
      "action:",
      "- summary: the project, its worktree and the feature flags. Default.",
      "- doctor: the same, plus resolved data paths and diagnostics.",
      "- index_status: the freshness of the code index.",
      "- reindex: rebuild the code index. Only meaningful once indexing exists.",
    ],
  },
}

/**
 * The description for a tool, in a variant.
 *
 * An unknown tool falls back to an empty description rather than throwing: a
 * missing description is a worse tool, not a failed plugin.
 *
 * The **size** is a separate axis from the **wording**. The wording variant
 * is the pre-October-2026 control; the size variant is the minimal schema.
 * They are independent, and a run that changes both would confound them.
 */
export function descriptionFor(
  variant: DescriptionVariant,
  tool: string,
  size: "full" | "minimal" = "full",
): string {
  if (size === "minimal") {
    // The minimal schema has its **own** two wordings, so the wording
    // comparison survives on the minimal surface.
    //
    // It did not, once: the minimal branch returned one fixed string, so the
    // "baseline wording" arm rendered exactly the same text as the "revised"
    // one and the comparison was between two identical surfaces.
    const minimal = MINIMAL_DESCRIPTIONS[variant]?.[tool]
    if (minimal) return minimal
  }
  const lines = DESCRIPTIONS[variant]?.[tool]
  if (!lines) return ""
  return lines.join("\n")
}

/**
 * The variant a plugin instance should use.
 *
 * `baseline` is the control and is **not** the default. The default is `revised`,
 * because the revised wording is the one that ships; the control exists so the
 * change can be measured, not so it can be avoided.
 */
export function variantFor(value: unknown): DescriptionVariant {
  return value === "baseline" ? "baseline" : "revised"
}

/**
 * The tool schemas, in two sizes.
 *
 * ## Why
 *
 * ADR-009 proposed a **small** tool surface, on the stated reason that a
 * smaller surface costs less: fewer bytes on every request, and a smaller
 * catalog to choose from. That reason has never been tested. Every measurement
 * so far has changed the surface's **structure** — one tool per action against
 * one tool with an `action` argument — and a structural change changes both
 * the size and the shape, so the two cannot be told apart.
 *
 * This module isolates **size**. The `minimal` variant carries the same
 * tools, the same arguments, the same enums and the same behaviour, and
 * only the **prose** is shorter: each description is one line, and each
 * argument's description says what it is rather than when it is required.
 *
 * That is the honest way to test the premise. A smaller schema that also
 * explains less would confound "less text" with "less useful text", and the
 * result would be about the second, not the first.
 *
 * ## What "minimal" means here
 *
 * - A description is one line, not a paragraph.
 * - An argument's description says what the argument **is**. Anything about
 *   *when* it is required is stated once, in the tool's description, rather
 *   than on every argument.
 * - No prose is removed that tells the model what the tool is for. That is
 *   the part the wording ablation showed matters.
 *
 * ## This is not a pure size intervention
 *
 * The minimal descriptions change **instructional content**, not only byte
 * count. The "when is this required" guidance moves from the arguments to
 * the tool's description, so a model reading only the tool's description
 * learns something it previously read from the arguments.
 *
 * Any claim about this variant is therefore a claim about **shorter
 * descriptions**, and the ADR has to say that. It is not a claim about
 * schema size in isolation, and the report must not pretend otherwise.
 *
 * The `full` variant is what ships.
 */

export type SchemaSize = "full" | "minimal"

/**
 * The wording of a description.
 *
 * The same two variants the shipping surface has: `baseline` is the
 * pre-October-2026 wording, which did not carry the tool's own name or the
 * words people use; `revised` is the one that does.
 */
export type Wording = "baseline" | "revised"

/**
 * The minimal descriptions, in both wordings.
 *
 * The two differ in exactly the way the full pair differs:
 *
 * - `baseline` does **not** name the tool's own subject, and does **not**
 *   use the words people use for the thing.
 * - `revised` does both.
 *
 * So the wording comparison survives on the minimal surface, and it measures
 * the same thing it measured on the full one.
 */
export const MINIMAL_DESCRIPTIONS: Record<Wording, Record<string, string>> = {
  /**
   * The minimal wording, in the pre-October-2026 voice.
   *
   * It says what the tool is for without naming it, and without the words
   * people use. That is the gap the wording change closed.
   */
  baseline: {
    context: "The most likely code to answer a question, with citations.",
    graph: "The symbol graph of the current project.",
    task: "The project's work board.",
    memory: "The project's decisions, facts and handoffs.",
    verify: "The project's quality checks.",
    status: "What is known about the current project.",
  },

  /**
   * The minimal wording, in the current voice.
   *
   * One line, and it names the tool's own subject and uses the words people
   * use for the thing.
   */
  revised: {
    context:
      "The code context most likely to answer a question, with citations. Prefer it to reading files.",
    graph: "The code graph of the current project: where a symbol is, what touches it, what covers it.",
    task: "The project's task board: the cards, issues and work items on it, and their state.",
    memory: "The project's memory: its decisions, facts and handoffs.",
    verify: "Verify the project: its quality checks, the verification gates and their evidence.",
    status: "What OPI knows about the current project: its status, index and flags.",
  },
}

/**
 * The minimal argument descriptions, in both wordings.
 *
 * The `baseline` form says what the argument is, without saying when it is
 * required — the guidance the full variant repeats on every argument. The
 * `revised` form keeps the requirement, because the wording change was
 * partly about the model being told what a tool needs.
 *
 * Only the `pi.task` tool's arguments are listed, because it is the one the
 * benchmark uses. The other tools' arguments keep their descriptions.
 */
export const MINIMAL_ARGUMENTS: Record<Wording, Record<string, Record<string, string>>> = {
  baseline: {
    task: {
      task: "The task's key, e.g. 'PI-0012'.",
      title: "The task's title.",
      description: "What the task is about.",
      acceptance: "What 'done' means for this task.",
      type: "What kind of work this is.",
      priority: "0 (lowest) to 3 (highest).",
      state: "The state to move to.",
      expected_revision: "The revision you read.",
      relation: "How the two tasks relate.",
      other: "The other task's key.",
      waiver: "Waive the check requirement. Needs an actor, a reason and a scope.",
      limit: "Maximum tasks to return.",
    },
  },
  revised: {
    task: {
      task: "The task's key, e.g. 'PI-0012'. Required for everything but list and create.",
      title: "The task's title. For create and update.",
      description: "What the task is about. For create and update.",
      acceptance: "What 'done' means for this task, in the task's own words.",
      type: "What kind of work this is.",
      priority: "0 (lowest) to 3 (highest).",
      state: "The state to move to. For transition.",
      expected_revision: "The revision you read. Required for update and transition.",
      relation: "How the two tasks relate. For link and unlink.",
      other: "The other task's key. For link and unlink.",
      waiver: "Waive the check requirement. Needs an actor, a reason and a scope.",
      limit: "Maximum tasks to return. Default 50.",
    },
  },
}

/**
 * The split shape's own minimal descriptions.
 *
 * The split shape has no `pi.task` description to shorten, so each of its
 * nine tools gets its action's description, shortened. The two wordings
 * differ in the same way: the `baseline` one does not name the action's
 * subject, the `revised` one does.
 */
export const MINIMAL_SPLIT_DESCRIPTIONS: Record<Wording, Record<string, string>> = {
  baseline: {
    list: "The items on the board, and what each is waiting for.",
    get: "One item, with its criteria and evidence.",
    create: "Make an item.",
    update: "Change an item's title, criteria, priority or type.",
    transition: "Move an item to another state.",
    link: "Relate two items. 'blocks' makes one wait for the other.",
    unlink: "Remove the relation between two items.",
    history: "What happened to an item, in order.",
    delete: "Remove an item, its links and its history.",
  },
  revised: {
    list: "The project's tasks, with what each is waiting for.",
    get: "One task, with its acceptance criteria and its verification evidence.",
    create: "Create a task.",
    update: "Change a task's title, criteria, priority or type.",
    transition: "Move a task to another state.",
    link: "Relate two tasks. 'blocks' makes one wait for the other.",
    unlink: "Remove a relation.",
    history: "What happened to a task, in order.",
    delete: "Remove a task, its links and its history.",
  },
}

/**
 * The split shape's minimal argument descriptions.
 *
 * The same shortened forms the single tool uses, for the arguments the
 * actions actually have. The baseline wording keeps the requirement, the
 * revised wording states it once more explicitly.
 */
export const MINIMAL_SPLIT_ARGUMENTS: Record<Wording, Record<string, Record<string, string>>> = {
  baseline: {
    list: { state: "Only return tasks in this state.", limit: "Maximum tasks to return." },
    get: { task: "The task's key, e.g. 'PI-0012'." },
    create: {
      title: "The task's title.",
      description: "What the task is about.",
      acceptance: "What 'done' means for this task.",
      type: "What kind of work this is.",
      priority: "0 (lowest) to 3 (highest).",
      state: "The state to create it in.",
    },
    update: {
      task: "The task's key, e.g. 'PI-0012'.",
      title: "The task's new title.",
      description: "What the task is about.",
      acceptance: "What 'done' means for this task.",
      type: "What kind of work this is.",
      priority: "0 (lowest) to 3 (highest).",
      expected_revision: "The revision you read.",
    },
    transition: {
      task: "The task's key, e.g. 'PI-0012'.",
      state: "The state to move to.",
      expected_revision: "The revision you read.",
    },
    link: {
      task: "The task's key, e.g. 'PI-0012'.",
      relation: "How the two tasks relate.",
      other: "The other task's key.",
    },
    unlink: {
      task: "The task's key, e.g. 'PI-0012'.",
      relation: "The relation to remove.",
      other: "The other task's key.",
    },
    history: { task: "The task's key, e.g. 'PI-0012'." },
    delete: {
      task: "The task's key, e.g. 'PI-0012'.",
      expected_revision: "The revision you read.",
    },
  },
  revised: {
    list: { state: "Only return tasks in this state.", limit: "Maximum tasks to return. Default 50." },
    get: { task: "The task's key, e.g. 'PI-0012'." },
    create: {
      title: "The task's title.",
      description: "What the task is about.",
      acceptance: "What 'done' means for this task, in the task's own words.",
      type: "What kind of work this is.",
      priority: "0 (lowest) to 3 (highest).",
      state: "The state to create it in. Default backlog.",
    },
    update: {
      task: "The task's key, e.g. 'PI-0012'.",
      title: "The task's new title.",
      description: "What the task is about.",
      acceptance: "What 'done' means for this task.",
      type: "What kind of work this is.",
      priority: "0 (lowest) to 3 (highest).",
      expected_revision: "The revision you read. Required.",
    },
    transition: {
      task: "The task's key, e.g. 'PI-0012'.",
      state: "The state to move to.",
      expected_revision: "The revision you read. Required.",
    },
    link: {
      task: "The task's key, e.g. 'PI-0012'.",
      relation: "How the two tasks relate.",
      other: "The other task's key.",
    },
    unlink: {
      task: "The task's key, e.g. 'PI-0012'.",
      relation: "The relation to remove.",
      other: "The other task's key.",
    },
    history: { task: "The task's key, e.g. 'PI-0012'." },
    delete: {
      task: "The task's key, e.g. 'PI-0012'.",
      expected_revision: "The revision you read. Required.",
    },
  },
}

/**
 * The size a plugin instance should use.
 *
 * `full` is the default, because it is what ships. `minimal` is the arm the
 * benchmark measures against it.
 */
export function schemaSizeFor(value: unknown): SchemaSize {
  return value === "minimal" ? "minimal" : "full"
}

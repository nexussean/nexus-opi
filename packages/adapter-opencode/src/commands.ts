import type { Plugin } from "@opencode/plugin"
import {
  formatBlockers,
  formatBoard,
  formatHandoff,
  formatList,
  formatNext,
  formatReview,
  type CommandContext,
  type Handoff,
} from "@opi/core"

/**
 * The slash commands.
 *
 * Each command gathers what OPI knows and hands it to the agent, with the
 * reasoning included. It does not decide anything: the state machine
 * decides what a task may be, the evidence rules decide whether it is done,
 * and the trust model decides which memory is a constraint.
 *
 * See [ADR-0025](../../docs/adr/0025-a-command-reports-the-rules-it-does-not-make-them.md).
 */

/** What the commands need from the plugin. */
export interface CommandSources {
  /** The project id, resolved when the command runs. */
  projectId: () => Promise<string | undefined>
  /** The project's tasks. */
  tasks: (projectId: string) => Promise<CommandContext["tasks"]>
  /** The project's relations. */
  edges: (projectId: string) => Promise<CommandContext["edges"]>
  /** The gates registered for the project. */
  gates: (projectId: string) => Promise<{
    id: string
    kind: string
    state: string
    description: string
    requiredForTypes: string[]
  }[]>
  /** The project root. */
  root: () => string
  /** The worktree's HEAD, when it has one. */
  head: () => string
  /** The last handoff, for a task or the project. */
  handoff: (projectId: string, taskKey?: string) => Promise<Handoff | undefined>
}

/**
 * The commands, and what each one is for.
 *
 * The `ask` is what the command hands to the agent with the report. It is a
 * question, not an instruction: the agent is the one that acts, through the
 * tools, under the same rules as always.
 */
const COMMANDS = [
  {
    name: "pi-board",
    description: "Show the project's task board, what is waiting, and what to do next.",
    build: (context: CommandContext): string => formatBoard(context),
    ask: "What should I work on next, and what is in the way?",
  },
  {
    name: "pi-next",
    description: "Explain the next task to work on and the checks it needs.",
    build: (context: CommandContext): string => formatNext(context),
    ask: "Start the next task. Read the code it names before changing anything.",
  },
  {
    name: "pi-blockers",
    description: "List the tasks that are waiting for a dependency, and on what.",
    build: (context: CommandContext): string => formatBlockers(context),
    ask: "What is blocking the work, and what would unblock it?",
  },
  {
    name: "pi-review",
    description: "Evaluate a task's evidence. It never marks the task done.",
    build: (context: CommandContext, argument: string): string =>
      formatReview(context, argument.trim() || firstTask(context)),
    ask:
      "Review this task's evidence against its acceptance criteria. Say what is missing. Do not mark it done unless the evidence is current.",
  },
  {
    name: "pi-handoff",
    description: "Show the last handoff, so a session can pick up where one left off.",
    build: (context: CommandContext, argument: string, handoff: Handoff | undefined): string => {
      if (!handoff) return "There is no handoff for this project yet."
      return formatHandoff(context, handoff)
    },
    ask: "Here is the last handoff. Continue the work it describes.",
  },
  {
    name: "pi-list",
    description: "List the project's tasks with their states.",
    build: (context: CommandContext): string => formatList(context),
    ask: "Which of these should I work on?",
  },
] as const

/** The first task's key, used when a command that needs one gets none. */
function firstTask(context: CommandContext): string {
  return context.tasks[0]?.publicKey ?? ""
}

/**
 * Register the commands with OpenCode.
 *
 * The registration is **defensive**: a plugin that throws during setup loses
 * its entire tool surface (see B13 in the compat doc). The commands are a
 * convenience, and a convenience must never be able to take the tools down
 * with it. If the command API is not there, the plugin still works.
 */
export async function registerCommands(ctx: Plugin.Context, sources: CommandSources): Promise<void> {
  const command = ctx.command as Plugin.Context["command"] | undefined
  if (!command?.transform) return
  await command.transform((editor) => {
    for (const command of COMMANDS) {
      editor.add({
        name: command.name,
        description: command.description,
        execute: async ({ sessionID, prompt, delivery }) => {
          const projectId = await sources.projectId()
          if (!projectId) {
            await ctx.session.prompt({
              ...prompt,
              sessionID,
              text: "This project's identity could not be resolved, so its tasks and decisions cannot be reached.",
              delivery,
            })
            return
          }

          const context: CommandContext = {
            projectId,
            tasks: await sources.tasks(projectId),
            edges: await sources.edges(projectId),
            gates: (await sources.gates(projectId)) as CommandContext["gates"],
            root: sources.root(),
            head: sources.head(),
          }

          const argument = prompt.text.trim()
          // Only the handoff command needs a handoff, and fetching one for
          // every command would be wasted work.
          const handoff =
            command.name === "pi-handoff"
              ? await sources.handoff(projectId, argument || undefined)
              : undefined

          const body = command.build(context, argument, handoff)

          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: [body, "", command.ask].join("\n"),
            delivery,
          })
        },
      })
    }
  })
}

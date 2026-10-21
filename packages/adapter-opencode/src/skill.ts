import type { Plugin } from "@opencode/plugin"
import { Skill } from "@opencode/plugin"
import { AbsolutePath } from "@opencode/schema"
import { guidanceFor, type GuidanceVariant } from "./guidance.ts"
import { triggerDescriptionFor, type TriggerVariant } from "./triggers.ts"

/**
 * The agent's guide to OPI.
 *
 * It is a **skill**, not an `AGENTS.md`: it is loaded on demand, so a project
 * that never uses OPI pays nothing for it. The plan is explicit about this —
 * "a small global `SKILL.md` loaded on demand rather than a large always-on
 * `AGENTS.md`".
 *
 * It says what OPI is for and when to reach for it. It does not repeat the
 * tools' schemas — the model has those in its catalog — and it does not
 * instruct the agent to use OPI for everything. An agent that reaches for the
 * index on every turn wastes the context it saves.
 */

/**
 * The guidance, from the variants module.
 *
 * The skill is the agent's guide. It is loaded on demand, so it is not a
 * per-request cost — it is a cost paid when the agent needs it, and the
 * question is whether it is worth it. The `direct` variant says what to
 * **do**; the `baseline` variant only says what the tools are for. They are
 * measured separately, because a change to one would otherwise be credited to
 * the other.
 */

/**
 * Register the skill with OpenCode.
 *
 * The registration is **defensive**, for the same reason the commands' is: a
 * plugin that throws during setup loses its entire tool surface. The skill is
 * a convenience and must never be able to take the tools down with it.
 */
export async function registerSkill(
  ctx: Plugin.Context,
  options: { guidance?: GuidanceVariant; trigger?: TriggerVariant } = {},
): Promise<void> {
  const skill = ctx.skill as Plugin.Context["skill"] | undefined
  if (!skill?.transform) return
  const content = guidanceFor(options.guidance ?? "direct")
  await skill.transform((editor) => {
    editor.add({
      id: Skill.ID.make("opencode-project-intelligence"),
      name: Skill.Name.make("project-intelligence"),
      /**
       * The description is the skill's **catalogue entry**, and it is the whole
       * interface: a skill is loaded on demand, and the only thing the model
       * reads first is this.
       *
       * So it decides whether the guide is ever read. The original fired on
       * "a concept, a symbol, a task or a decision" — and the benchmark's
       * questions ("List every card on the board") contain **none** of those
       * words. The guide was never loaded, and the model read the task database
       * directly, which is exactly what the guide tells it not to do.
       */
      description: triggerDescriptionFor(options.trigger ?? "cards"),
      path: AbsolutePath.make(ctx.location.directory),
      content,
    })
  })
}

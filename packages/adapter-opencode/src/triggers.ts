/**
 * The skill's **description**, in two variants.
 *
 * ## Why this matters more than the descriptions
 *
 * A skill is loaded **on demand**. The only thing the model sees before loading it
 * is its description — that is the whole catalogue entry. If the description does
 * not match the question, the guide is never read, and every word of guidance
 * inside it is a word that was never delivered.
 *
 * The benchmark caught this. OPI's guidance says *"Do not read the task database,
 * the index, or the board's files"*, and the traces show the model reading the task
 * database anyway — because the skill's **description** fired on *"a concept, a
 * symbol, a task or a decision"*, and the question was *"List every card on the
 * board"*. **Not one trigger word was present.** The guidance was never delivered,
 * so the ablation measured nothing.
 *
 * The description is therefore the cheapest and most direct lever on discovery: one
 * phrase, in one place, naming the words people actually use.
 *
 * The two variants:
 *
 * - `baseline` — the original trigger list: "a concept, a symbol, a task or a
 *   decision".
 * - `cards` — the same list, plus the words people use for the things OPI holds:
 *   "card", "board", "issue", "work item".
 */

export type TriggerVariant = "baseline" | "cards"

/**
 * The skill's description.
 *
 * The description is what the model reads when it decides whether to load the
 * skill. It is the catalogue entry, and the catalogue entry is the interface.
 */
export const TRIGGER_DESCRIPTIONS: Record<TriggerVariant, string> = {
  /**
   * The description as it shipped before the change. It fires on the product's
   * own vocabulary and not on the user's.
   */
  baseline:
    "Use OPI's local project index to answer questions about this project's code, tasks, decisions and verification evidence. Reach for it when a question names a concept, a symbol, a task or a decision — and prefer it to reading whole files.",

  /**
   * The same, plus the words people actually use.
   *
   * "card" and "board" are how a person asks about this. A skill that only
   * answers to "task" is a skill that does not load when the question says
   * "card".
   */
  cards:
    "Use OPI's local project index to answer questions about this project's code, tasks, cards, issues, decisions and verification evidence. Reach for it when a question names a concept, a symbol, a task, a card, a board, an issue or a decision — and prefer it to reading whole files.",
}

/**
 * The description for a variant.
 */
export function triggerDescriptionFor(variant: TriggerVariant): string {
  return TRIGGER_DESCRIPTIONS[variant] ?? TRIGGER_DESCRIPTIONS.cards
}

/**
 * The trigger variant a plugin instance should use.
 *
 * `cards` is the default, because it is what ships. `baseline` is the control.
 */
export function triggerVariantFor(value: unknown): TriggerVariant {
  return value === "baseline" ? "baseline" : "cards"
}

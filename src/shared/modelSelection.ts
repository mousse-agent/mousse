import { parseThinkingSuffixFromModelId } from './modelVariants'

/**
 * How a selected model is stored and handed to an agent. A selection keeps the model as its agent
 * lists it and the reasoning level in a field of its own (`{ model: 'opus', effort: 'high' }`).
 * Mousse versions before #490 packed the level into the model (`opus:high`); those records are
 * upgraded when read. The packed form is made again only where Mousse talks to an agent.
 */

/** A model and its reasoning level, as a selection stores them. */
export interface ModelPick {
  model: string
  effort?: string
}

/** A stored model string's reasoning level apart from the model: `opus:high` is `opus` at `high`. */
export function splitStoredModel(model: string): { model: string; effort?: string } {
  const { baseId, effort } = parseThinkingSuffixFromModelId(model)
  return effort ? { model: baseId, effort } : { model }
}

/**
 * A selection with a reasoning level packed into its model (written before #490) moved into its own
 * field. When the record also has the field (an agent definition's ref), the packed level is the
 * one it ran at, so it stays.
 */
export function upgradeSelection<T extends { model: string; effort?: string }>(selection: T): T
export function upgradeSelection<T extends { model: string; effort?: string }>(selection: T | undefined): T | undefined
export function upgradeSelection<T extends { model: string; effort?: string }>(selection: T | undefined): T | undefined {
  if (!selection || typeof selection.model !== 'string') return selection
  const split = splitStoredModel(selection.model)
  const stored = typeof selection.effort === 'string' && selection.effort.trim() ? selection.effort.trim() : undefined
  const effort = split.effort ?? stored
  const { effort: _effort, ...rest } = selection
  return { ...rest, model: split.model, ...(effort ? { effort } : {}) } as T
}

/** The model id an agent is given: the model, then `:effort` when a level is chosen. */
export function agentModelId(model: string, effort?: string): string {
  return effort ? `${model}:${effort}` : model
}

/**
 * The id the model menus work with. They offer each level of a model as an id of its own
 * (`opus:high`), so a stored selection is shown in them as one, and a pick is stored apart again
 * (`pickedSelection`). Nothing else holds a model in this form.
 */
export function pickerModelId(selection: ModelPick): string {
  return agentModelId(selection.model, selection.effort)
}

/** The model and level a model menu's id names. */
export function pickedSelection(pickerId: string): ModelPick {
  return splitStoredModel(pickerId)
}

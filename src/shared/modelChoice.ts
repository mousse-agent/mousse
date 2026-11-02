import { formatEffortLabel, parseIdSuffixes, parseModelVariant, parseThinkingSuffixFromModelId } from './modelVariants'
import { canonicalModelName, modelNameFromId, shortModelName } from './modelNames'
import { upgradeSelection } from './modelSelection'

/**
 * A model as Mousse shows it: which instance runs it, the model, what was chosen for it, and its
 * name. Screens get one of these and name it with `modelLabel`; none of them formats a stored model
 * string, so no screen can show `gpt-6.1-sol:low`.
 */
export interface ModelChoice {
  /** The instance that runs the model, when the selection names one. */
  instanceId?: string
  /** The provider name the selection stores (`llmProvider`), or a picker id. */
  provider: string
  /** The model's id without its reasoning level, speed or context. */
  modelId: string
  /** Its name in Mousse's one style ("Claude Opus 5.5"), never an id with suffixes. */
  name: string
  effort?: string
  context?: string
  speed?: string
}

/**
 * A stored selection: the model as listed, its reasoning level, and the name it had when chosen.
 * A listed id can itself name a context or speed (`fable-5@1m`, `gpt-6:fast`); records written
 * before #490 also carry the level in the model.
 */
export interface StoredModelSelection {
  instanceId?: string
  provider: string
  model: string
  effort?: string
  name?: string
}

/**
 * The choice a stored selection makes. `listedLabel` is the name the instance lists the model
 * under, when anything on hand lists it; without one the selection's stored name stands, else the
 * name comes from the id.
 */
export function modelChoiceOf(stored: StoredModelSelection, listedLabel?: string): ModelChoice {
  const selection = upgradeSelection(stored)
  const parsed = parseIdSuffixes(selection.model)
  const effort = selection.effort ?? parsed.effort
  const base = {
    ...(selection.instanceId ? { instanceId: selection.instanceId } : {}),
    provider: selection.provider,
    modelId: parsed.baseId,
    ...(effort ? { effort } : {})
  }
  const label = listedLabel?.trim() || selection.name?.trim()
  if (!label) {
    return { ...base, name: modelNameFromId(parsed.baseId), ...(parsed.context ? { context: parsed.context } : {}), ...(parsed.speed ? { speed: parsed.speed } : {}) }
  }
  const listed = parseModelVariant({ id: selection.model, label: canonicalModelName(label, parsed.baseId) })
  const context = listed.context ?? parsed.context
  const speed = parsed.speed ?? (listed.speed !== 'standard' ? listed.speed : undefined)
  return { ...base, name: listed.familyLabel, ...(context ? { context } : {}), ...(speed ? { speed } : {}) }
}

export interface ModelLabelOptions {
  /** Drop a brand the maker's logo beside the name already shows ("Opus 5.5"). */
  short?: boolean
  /** Name the reasoning level ("· High"); on by default. */
  effort?: boolean
}

/** The parts of a model's label: its name (with a fast variant), its context, its reasoning level. */
export function modelLabelParts(choice: ModelChoice, options: ModelLabelOptions = {}): string[] {
  const name = options.short ? shortModelName(choice.name) : choice.name
  const fast = choice.speed === 'fast' && !/\(fast\)/i.test(name) ? ' (fast)' : ''
  const parts = [`${name}${fast}`]
  if (choice.context) parts.push(choice.context)
  if (options.effort !== false && choice.effort && choice.effort !== 'off') parts.push(formatEffortLabel(choice.effort))
  return parts
}

/** A model as every screen names it: "Claude Opus 5.5 · High", "GPT-6.1 Sol · 1M · Low". */
export function modelLabel(choice: ModelChoice, options: ModelLabelOptions = {}): string {
  return modelLabelParts(choice, options).join(' · ')
}

/** The model of a listing a stored model string names: the exact id, else the id without its level or other suffixes. */
export function findListedModel<T extends { id: string }>(models: readonly T[], model: string): T | undefined {
  return (
    models.find((entry) => entry.id === model) ??
    models.find((entry) => entry.id === parseThinkingSuffixFromModelId(model).baseId) ??
    models.find((entry) => entry.id === parseIdSuffixes(model).baseId)
  )
}

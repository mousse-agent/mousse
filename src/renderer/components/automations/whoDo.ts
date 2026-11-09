import type { BotLook } from '../../../shared/bots/personal/look'
import type { SelectOption } from '../ui/Select'
import type { ModelGroup } from '../scheduled/jobDraft'

/**
 * The Who of an automation as data: what the picker offers (the default agent, the models, your bots) and how a choice
 * is written as one Select value. Pure, so the detail's form and its tests read the same rules. Bots are the only
 * reusable Who; an automation made with a saved agent before they were removed keeps it until it is changed.
 */

export interface BotChoice { id: string; name: string; look: BotLook }

/** What fills Who: the person's bots. */
export interface AutomationLibrary {
  bots: BotChoice[]
}

export const EMPTY_LIBRARY: AutomationLibrary = { bots: [] }

/** Who does it: the default agent, a model, a saved agent made before, or a bot. */
export type Who =
  | { kind: 'default' }
  | { kind: 'model'; key: string }
  | { kind: 'agent'; id: string }
  | { kind: 'bot'; id: string }

export function whoKey(who: Who): string {
  switch (who.kind) {
    case 'default': return 'default'
    case 'model': return `model:${who.key}`
    case 'agent': return `agent:${who.id}`
    case 'bot': return `bot:${who.id}`
  }
}

export function parseWhoKey(key: string): Who {
  const at = key.indexOf(':')
  const kind = at < 0 ? key : key.slice(0, at)
  const rest = at < 0 ? '' : key.slice(at + 1)
  if (kind === 'model' && rest) return { kind: 'model', key: rest }
  if (kind === 'agent' && rest) return { kind: 'agent', id: rest }
  if (kind === 'bot' && rest) return { kind: 'bot', id: rest }
  return { kind: 'default' }
}

/** The library from the daemon's list of bots, by name. */
export function libraryFrom(input: { bots?: ReadonlyArray<{ id: string; name: string; look: BotLook }> }): AutomationLibrary {
  return { bots: (input.bots ?? []).map((bot) => ({ id: bot.id, name: bot.name, look: bot.look })).sort((a, b) => a.name.localeCompare(b.name)) }
}

/**
 * The Who picker's options: your default agent first, then the models by provider and (when asked) your bots. A choice
 * that is gone stays listed as it was, so it is never silently lost.
 */
export function whoOptions(input: {
  defaultName: string
  models: readonly ModelGroup[]
  library: AutomationLibrary
  withBots: boolean
  current?: { key: string; label: string }
}): SelectOption[] {
  const options: SelectOption[] = [{ value: 'default', label: input.defaultName }]
  for (const group of input.models) for (const choice of group.choices) options.push({ value: `model:${choice.key}`, label: choice.label, group: group.label })
  if (input.withBots) for (const bot of input.library.bots) options.push({ value: `bot:${bot.id}`, label: bot.name, group: 'Bots' })
  if (input.current && !options.some((option) => option.value === input.current!.key)) options.push({ value: input.current.key, label: input.current.label })
  return options
}

/** The name a Who shows. */
export function whoName(who: Who, input: { defaultName: string; models: readonly ModelGroup[]; library: AutomationLibrary }): string {
  if (who.kind === 'default') return input.defaultName
  if (who.kind === 'model') return input.models.flatMap((group) => group.choices).find((choice) => choice.key === who.key)?.label ?? 'A model'
  if (who.kind === 'agent') return 'Saved agent'
  return input.library.bots.find((bot) => bot.id === who.id)?.name ?? 'Bot'
}

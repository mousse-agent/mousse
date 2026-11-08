import type { AgentDefinitionSummary } from '../../../shared/agents/types'
import type { BotSchedule } from '../../../shared/bots/personal/definition'
import type { BotLook } from '../../../shared/bots/personal/look'
import type { JobSchedule } from '../../../shared/types'
import { parseSimpleCron } from '../../../shared/scheduleLabel'
import type { SelectOption } from '../ui/Select'
import type { ModelGroup } from '../scheduled/jobDraft'

/**
 * The Who and Do of an automation as data: what the pickers offer (models, saved agents, bots; a prompt or a
 * workflow), how a choice is written as one Select value, and what a bot's schedule can be. Pure, so the create row,
 * the detail and their tests read the same rules.
 */

export interface SavedAgentChoice { id: string; name: string; purpose?: string }
export interface WorkflowChoice { id: string; slug: string; name: string; description?: string; revisionId: string }
export interface BotChoice { id: string; name: string; look: BotLook }

/** What fills the Who and Do slots: published, turned-on saved agents and workflows, and the person's bots. */
export interface AutomationLibrary {
  agents: SavedAgentChoice[]
  workflows: WorkflowChoice[]
  bots: BotChoice[]
}

export const EMPTY_LIBRARY: AutomationLibrary = { agents: [], workflows: [], bots: [] }

/** Who does it: the default agent, a model, a saved agent, or a bot. */
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

/** The library from the daemon's lists: only what can run now (published and turned on, not archived). */
export function libraryFrom(input: {
  agents?: readonly AgentDefinitionSummary[]
  workflows?: ReadonlyArray<{ id: string; slug: string; name: string; description?: string; enabled: boolean; archived?: boolean; headRevisionId?: string | null }>
  bots?: ReadonlyArray<{ id: string; name: string; look: BotLook }>
}): AutomationLibrary {
  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name)
  return {
    agents: (input.agents ?? [])
      .filter((agent) => agent.publishedRevision && agent.enabled && !agent.archived)
      .map((agent) => ({ id: agent.id, name: agent.name, ...(agent.purpose ? { purpose: agent.purpose } : {}) }))
      .sort(byName),
    workflows: (input.workflows ?? [])
      .filter((workflow) => workflow.headRevisionId && workflow.enabled && !workflow.archived)
      .map((workflow) => ({ id: workflow.id, slug: workflow.slug, name: workflow.name, revisionId: workflow.headRevisionId!, ...(workflow.description ? { description: workflow.description } : {}) }))
      .sort(byName),
    bots: (input.bots ?? []).map((bot) => ({ id: bot.id, name: bot.name, look: bot.look })).sort(byName)
  }
}

/**
 * The Who picker's options: your default agent first, then the models by provider, your saved agents and (on the
 * create row) your bots. A saved agent or bot that is gone stays listed as it was, so the choice is never silently lost.
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
  for (const agent of input.library.agents) options.push({ value: `agent:${agent.id}`, label: agent.name, group: 'Saved agents' })
  if (input.withBots) for (const bot of input.library.bots) options.push({ value: `bot:${bot.id}`, label: bot.name, group: 'Bots' })
  if (input.current && !options.some((option) => option.value === input.current!.key)) options.push({ value: input.current.key, label: input.current.label })
  return options
}

/** The name a Who shows. */
export function whoName(who: Who, input: { defaultName: string; models: readonly ModelGroup[]; library: AutomationLibrary }): string {
  if (who.kind === 'default') return input.defaultName
  if (who.kind === 'model') return input.models.flatMap((group) => group.choices).find((choice) => choice.key === who.key)?.label ?? 'A model'
  if (who.kind === 'agent') return input.library.agents.find((agent) => agent.id === who.id)?.name ?? 'Saved agent'
  return input.library.bots.find((bot) => bot.id === who.id)?.name ?? 'Bot'
}

/**
 * A bot's schedule from the create row's When. A bot repeats: every N minutes (at least 5) or a cron time; a one-time
 * run or On demand is something you ask the bot in its chat.
 */
export function botWhen(schedule: JobSchedule): { ok: true; when: BotSchedule['when'] } | { ok: false; reason: string } {
  if (schedule.kind === 'interval') {
    const minutes = schedule.minutes ?? 0
    return minutes >= 5 ? { ok: true, when: { kind: 'interval', minutes } } : { ok: false, reason: 'A bot runs at most every 5 minutes.' }
  }
  if (schedule.kind === 'cron' && schedule.expr) {
    const cron = parseSimpleCron(schedule.expr)
    if (cron?.kind === 'minutes' && cron.every < 5) return { ok: false, reason: 'A bot runs at most every 5 minutes.' }
    return { ok: true, when: { kind: 'cron', expr: schedule.expr } }
  }
  return { ok: false, reason: 'A bot repeats. For one run, ask it in its chat.' }
}

/** The workflows whose slug or name starts with what follows `/` in the text; all of them for a bare `/`. */
export function matchWorkflows(text: string, workflows: readonly WorkflowChoice[]): WorkflowChoice[] {
  const match = /^\/(\S*)$/.exec(text.trim())
  if (!match) return []
  const typed = match[1]!.toLowerCase()
  return workflows.filter((workflow) => workflow.slug.toLowerCase().startsWith(typed) || workflow.name.toLowerCase().startsWith(typed)).slice(0, 8)
}

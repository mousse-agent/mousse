import { BOT_CUSTOM_SLOT_NAME, MAX_BOT_CUSTOM_SLOT_DESCRIPTION, type BotModelPick } from '../../../shared/bots/personal/definition'
import type { LlmProviderOption } from '../../../shared/settings'

/**
 * The owner's `/` commands in a bot's chat. Mousse runs them itself: they never reach the bot, so they cost no tokens.
 * This module only reads text: what a message asks for (`parseBotCommand`) and what the composer offers while it is
 * typed (`botCommandSuggestions`). The store runs them (`botsStore.runCommand`).
 */

/** A base slot as the owner names it: Talk, the work rows (Work is all three), and Images. */
export type BotBaseSlot = 'talk' | 'work' | 'light' | 'medium' | 'hard' | 'images'
export const BOT_BASE_SLOTS: readonly BotBaseSlot[] = ['talk', 'work', 'light', 'medium', 'hard', 'images']

export type BotCommand =
  | { kind: 'clear' | 'stop' | 'status' | 'pause' | 'resume' | 'memory' | 'reset' | 'model-list' }
  | { kind: 'forget'; history: boolean }
  /** `slot`: lower case; a base slot or a custom one. `description`: everything after the model, for a custom slot. */
  | { kind: 'model-set'; slot: string; model: string; description?: string }
  | { kind: 'model-off'; slot: string }
  /** A `/word` that is no command. */
  | { kind: 'unknown'; name: string }
  /** A command written the wrong way: `text` is the one line that says how. */
  | { kind: 'invalid'; text: string }

/** One command as the list shows it: what to type, and what it does. */
interface CommandRow { usage: string; action: string; fill: string; complete: boolean }

const COMMANDS: readonly CommandRow[] = [
  { usage: '/clear', action: 'Wipe the chat', fill: '/clear', complete: true },
  { usage: '/stop', action: 'Stop all running work', fill: '/stop', complete: true },
  { usage: '/status', action: 'Show work, threads and schedules', fill: '/status', complete: true },
  { usage: '/pause', action: 'Turn off schedules and wake-ups', fill: '/pause', complete: true },
  { usage: '/resume', action: 'Turn them back on', fill: '/resume', complete: true },
  { usage: '/memory', action: 'Open saved memory', fill: '/memory', complete: true },
  { usage: '/forget', action: 'Wipe saved memory', fill: '/forget', complete: true },
  { usage: '/forget history', action: 'Wipe chat and run notes, keep memory', fill: '/forget history', complete: true },
  { usage: '/reset', action: 'Start fresh: chat, memory, schedules', fill: '/reset', complete: true },
  { usage: '/model', action: 'List models, or set one', fill: '/model ', complete: true }
]

const NO_ARGS = new Set(['clear', 'stop', 'status', 'pause', 'resume', 'memory', 'reset'])

/** The first word of a command: `/` and a letter, then letters, digits and dashes. A path (`/Users/me`) is no command. */
const COMMAND_WORD = /^\/([a-z][a-z0-9-]*)(?=\s|$)/i

/** A base slot's canonical name, for a word the owner typed (`image` is `images`); undefined for any other word. */
export function baseSlotOf(word: string): BotBaseSlot | undefined {
  const lower = word.toLowerCase()
  if (lower === 'image') return 'images'
  return (BOT_BASE_SLOTS as readonly string[]).includes(lower) ? lower as BotBaseSlot : undefined
}

/**
 * What a message asks for, or null when it is an ordinary message for the bot (it does not start with a `/` command
 * word). Anything that starts with one is never sent: an unknown word is `unknown`, a wrong form `invalid`.
 */
export function parseBotCommand(text: string): BotCommand | null {
  const trimmed = text.trim()
  const head = COMMAND_WORD.exec(trimmed)
  if (!head) return null
  const name = head[1]!.toLowerCase()
  const rest = trimmed.slice(head[0].length).trim()
  if (NO_ARGS.has(name)) return rest ? { kind: 'invalid', text: `/${name} takes nothing after it.` } : { kind: name as 'clear' }
  if (name === 'forget') {
    if (!rest) return { kind: 'forget', history: false }
    return rest.toLowerCase() === 'history' ? { kind: 'forget', history: true } : { kind: 'invalid', text: 'Use /forget or /forget history.' }
  }
  if (name === 'model') return parseModel(rest)
  return { kind: 'unknown', name }
}

const MODEL_USAGE = 'Use /model <slot> <model> [description], or /model <slot> off.'

function parseModel(rest: string): BotCommand {
  if (!rest) return { kind: 'model-list' }
  const slotWord = /^\S+/.exec(rest)![0]
  const slot = baseSlotOf(slotWord) ?? slotWord.toLowerCase()
  if (!baseSlotOf(slotWord) && !BOT_CUSTOM_SLOT_NAME.test(slot)) return { kind: 'invalid', text: 'A slot name is a letter, then letters, digits, - or _ (up to 24).' }
  const afterSlot = rest.slice(slotWord.length).trim()
  if (!afterSlot) return { kind: 'invalid', text: MODEL_USAGE }
  const model = /^\S+/.exec(afterSlot)![0]
  // The description is everything after the model, as typed: no quotes needed.
  const description = afterSlot.slice(model.length).trim().replace(/\s+/g, ' ')
  if (model.toLowerCase() === 'off') {
    if (description) return { kind: 'invalid', text: MODEL_USAGE }
    return baseSlotOf(slot) ? { kind: 'invalid', text: `${slot} is a base slot; it can't be removed.` } : { kind: 'model-off', slot }
  }
  if (description && baseSlotOf(slot)) return { kind: 'invalid', text: 'Only a custom slot takes a description.' }
  if (description.length > MAX_BOT_CUSTOM_SLOT_DESCRIPTION) return { kind: 'invalid', text: `Keep the description under ${MAX_BOT_CUSTOM_SLOT_DESCRIPTION} characters.` }
  return { kind: 'model-set', slot, model, ...(description ? { description } : {}) }
}

/** `/model`'s word for a model: its entry and its id (`openai-codex:gpt-6.1-sol`). */
export const modelToken = (instanceId: string, model: string) => `${instanceId}:${model}`

/**
 * The pick a model word names among `providers`: `entry:model`, or a model's id or name alone when exactly one entry
 * offers it. Case is ignored. `error` is the one line to show when it names none, or more than one.
 */
export function resolveModelWord(word: string, providers: readonly LlmProviderOption[]): { pick: BotModelPick; label: string } | { error: string } {
  const lower = word.toLowerCase()
  const all = providers.flatMap((provider) => (provider.instanceId ? provider.models.map((model) => ({ provider, model, instanceId: provider.instanceId! })) : []))
  const exact = all.filter(({ instanceId, model }) => modelToken(instanceId, model.id).toLowerCase() === lower)
  const matches = exact.length ? exact : all.filter(({ model }) => model.id.toLowerCase() === lower || model.label.toLowerCase() === lower)
  if (matches.length === 1) {
    const { provider, model, instanceId } = matches[0]!
    return { pick: { instanceId, model: model.id }, label: `${model.label} · ${provider.label}` }
  }
  if (matches.length > 1) return { error: `${word} is on several entries; use entry:model.` }
  return { error: `No model ${word}. Type /model <slot> and pick one.` }
}

/** One row of the composer's list: what it shows, and the composer's text once it is picked. */
export interface BotCommandSuggestion {
  key: string
  label: string
  description: string
  /** The composer's text after picking it. */
  fill: string
  /** Enter on it runs it when the composer already reads `fill`. */
  complete: boolean
}

/** What the `/model` suggestions know: the custom slots and their descriptions, what each slot runs on, and the models. */
export interface BotCommandContext {
  custom?: ReadonlyArray<{ name: string; description?: string }>
  /** By slot name, the model it runs on now ("Opus 5.5"). */
  slotModels?: Readonly<Record<string, string>>
  providers?: readonly LlmProviderOption[]
  /** The Images slot's models. */
  imageProviders?: readonly LlmProviderOption[]
}

/** The most model rows the list shows at once; typing narrows it. */
export const MAX_MODEL_SUGGESTIONS = 40

/**
 * The composer's rows while a command is typed at the start of the box: the commands that start with what is typed;
 * after `/model `, the slots; after a slot, its models (and `off` for a custom slot). Empty for anything else.
 */
export function botCommandSuggestions(input: string, context: BotCommandContext = {}): BotCommandSuggestion[] {
  if (!input.startsWith('/') || input.includes('\n')) return []
  const typed = input.toLowerCase().replace(/\s+/g, ' ')
  const slotStage = /^\/model (\S*)$/.exec(typed)
  if (slotStage) return slotSuggestions(slotStage[1]!, context)
  const modelStage = /^\/model (\S+) (\S*)$/.exec(typed)
  if (modelStage) return modelSuggestions(modelStage[1]!, modelStage[2]!, context)
  return COMMANDS.filter((row) => row.usage.startsWith(typed))
    .map((row) => ({ key: row.usage, label: row.usage, description: row.action, fill: row.fill, complete: row.complete }))
}

function slotSuggestions(typed: string, context: BotCommandContext): BotCommandSuggestion[] {
  const rows = [
    ...BOT_BASE_SLOTS.map((name) => ({ name, about: context.slotModels?.[name] ?? baseSlotAbout(name) })),
    ...(context.custom ?? []).map((slot) => ({ name: slot.name, about: [context.slotModels?.[slot.name], slot.description].filter(Boolean).join(' · ') || 'Custom slot' }))
  ]
  return rows.filter((row) => row.name.startsWith(typed)).map((row) => ({ key: `slot:${row.name}`, label: row.name, description: row.about, fill: `/model ${row.name} `, complete: false }))
}

function baseSlotAbout(name: BotBaseSlot): string {
  if (name === 'talk') return 'Chat replies'
  if (name === 'work') return 'All work'
  if (name === 'images') return 'Pictures'
  return `${name[0]!.toUpperCase()}${name.slice(1)} work`
}

function modelSuggestions(slotWord: string, typed: string, context: BotCommandContext): BotCommandSuggestion[] {
  const base = baseSlotOf(slotWord)
  const slot = base ?? slotWord.toLowerCase()
  if (!base && !BOT_CUSTOM_SLOT_NAME.test(slot)) return []
  const custom = !base
  const existing = custom && (context.custom ?? []).some((entry) => entry.name === slot)
  const rows: BotCommandSuggestion[] = []
  if (existing && 'off'.startsWith(typed)) rows.push({ key: 'off', label: 'off', description: 'Remove this slot', fill: `/model ${slot} off`, complete: true })
  for (const provider of (base === 'images' ? context.imageProviders : context.providers) ?? []) {
    if (!provider.instanceId) continue
    for (const model of provider.models) {
      const token = modelToken(provider.instanceId, model.id)
      if (typed && !token.toLowerCase().includes(typed) && !model.label.toLowerCase().includes(typed)) continue
      // A custom slot takes a description after the model: the space is left for it.
      rows.push({ key: `model:${token}`, label: token, description: `${model.label} · ${provider.label}`, fill: `/model ${slot} ${token}${custom ? ' ' : ''}`, complete: true })
      if (rows.length >= MAX_MODEL_SUGGESTIONS) return rows
    }
  }
  return rows
}

import type { BotDetail, BotSummary, BotWorkItem, BotLaunchedThread } from '../../../shared/bots/personal/chat'
import type { BotModelPick } from '../../../shared/bots/personal/definition'
import type { BotsPersonalV2Result } from '../../../shared/bots/personal/methods'
import type { LlmProviderOption } from '../../../shared/settings'
import { botsClient, useBotsStore, type BotConfirmCommand } from '../../stores/botsStore'
import { noteBotStopAsked } from '../../stores/botLiveReplies'
import { errorText } from '../../services/personalBotsClient'
import { baseSlotOf, parseBotCommand, resolveModelWord, type BotCommand } from './botCommands'

/**
 * Runs the owner's `/` commands in a bot's chat (`botCommands.ts` reads them). Nothing here reaches the bot: each
 * command calls the service's own methods, and its result is a line in the chat for the owner alone (`addNote`).
 */

type ModelInfo = BotsPersonalV2Result<'bots.model.get'>

const store = useBotsStore.getState
const note = (botId: string, text: string) => store().addNote(botId, text)
const fail = (botId: string, text: string) => store().addNote(botId, text, true)

/**
 * Sends what the bot's composer holds. A `/` command runs here and is never sent (the box empties); anything else goes
 * to the bot as before.
 */
export async function submitBotChat(botId: string): Promise<void> {
  // The commands set a bot up, which a bot of another computer is on its own computer: there, `/` is just words.
  if (store().bots.find((entry) => entry.id === botId)?.lives) return store().send(botId)
  const command = parseBotCommand(store().drafts[botId] ?? '')
  if (!command) return store().send(botId)
  store().setDraft(botId, '')
  await runBotCommand(botId, command)
}

/** Runs one command; `/forget` and `/reset` only open their confirm, which calls `runConfirmed`. */
export async function runBotCommand(botId: string, command: BotCommand): Promise<void> {
  const bot = store().bots.find((entry) => entry.id === botId)
  try {
    switch (command.kind) {
      case 'unknown': return fail(botId, `/${command.name} isn't a command. Type / to see them.`)
      case 'invalid': return fail(botId, command.text)
      case 'memory': return store().openMemory(botId)
      case 'forget': return confirm(botId, command.history ? 'forget-history' : 'forget')
      case 'reset': return confirm(botId, 'reset')
      case 'clear': {
        await botsClient().clearChat(botId)
        emptyChat(botId)
        return note(botId, 'Chat cleared.')
      }
      case 'stop': return note(botId, await stopAll(botId, bot))
      case 'status': return note(botId, statusText(bot, await botsClient().get(botId)))
      case 'pause': {
        if (bot?.state === 'paused') return note(botId, 'Already paused.')
        await botsClient().pause(botId)
        void store().refresh()
        return note(botId, 'Paused: schedules and wake-ups are off.')
      }
      case 'resume': {
        await botsClient().resume(botId)
        void store().refresh()
        return note(botId, 'Resumed.')
      }
      case 'model-list': return note(botId, modelListText(await modelInfo(botId, true)))
      case 'model-set': return note(botId, await setSlot(botId, command))
      case 'model-off': {
        const info = await modelInfo(botId)
        if (info.custom && !info.custom.some((slot) => slot.name === command.slot)) return fail(botId, `No slot named ${command.slot}.`)
        await botsClient().setCustomSlot(botId, command.slot, null)
        void store().loadModelInfo(botId)
        return note(botId, `${command.slot} removed.`)
      }
    }
  } catch (cause) {
    fail(botId, errorText(cause))
  }
}

/** After the owner confirmed `/forget`, `/forget history` or `/reset`. The confirm closes either way. */
export async function runConfirmed(botId: string, command: BotConfirmCommand): Promise<void> {
  useBotsStore.setState({ dialog: null })
  try {
    if (command === 'reset') {
      await botsClient().reset(botId)
      emptyChat(botId)
      useBotsStore.setState((state) => ({ notes: { ...state.notes, [botId]: [] }, memory: { ...state.memory, [botId]: [] } }))
      void store().refresh()
      return note(botId, 'Fresh start: chat, memory, schedules and reminders wiped.')
    }
    const { forgotten } = await botsClient().wipeMemory(botId, command === 'forget-history' ? 'saved' : undefined)
    if (command === 'forget-history') {
      emptyChat(botId)
      return note(botId, 'Chat history and run notes wiped; memory kept.')
    }
    useBotsStore.setState((state) => ({ memory: { ...state.memory, [botId]: [] } }))
    return note(botId, forgotten === 1 ? 'Memory wiped: 1 entry.' : `Memory wiped: ${forgotten} entries.`)
  } catch (cause) {
    fail(botId, errorText(cause))
  }
}

function confirm(botId: string, command: BotConfirmCommand) {
  useBotsStore.setState({ dialog: { kind: 'confirm', botId, command } })
}

/** The chat as the service has it now: nothing held, then its newest page read again. */
function emptyChat(botId: string) {
  useBotsStore.setState((state) => {
    const replyingTo = { ...state.replyingTo }
    delete replyingTo[botId]
    return { chats: { ...state.chats, [botId]: { messages: [], hasMore: false, loadingOlder: false } }, pending: { ...state.pending, [botId]: [] }, replyingTo }
  })
  void store().loadChat(botId)
}

/** Stops the chat's turn, every piece of work and every background command; says how many. */
async function stopAll(botId: string, bot: BotSummary | undefined): Promise<string> {
  const client = botsClient()
  const ids = [...(bot?.work ?? []).map((item) => item.id), ...(bot?.watchers ?? []).map((item) => item.id)]
  const stops: Array<Promise<unknown>> = ids.map((id) => client.stopWork(botId, id))
  if (bot?.chat) {
    noteBotStopAsked(botId)
    stops.push(client.stop(botId))
  }
  if (!stops.length) return 'Nothing is running.'
  await Promise.all(stops)
  void store().refresh()
  return stops.length === 1 ? 'Stopped 1 thing.' : `Stopped ${stops.length} things.`
}

/** "4 min", "1 h 5 min", "now". */
function since(at: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'now'
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}

const WORK_STATE: Record<BotWorkItem['status'], string> = { running: '', queued: 'waiting', waiting_for_internet: 'waiting for internet', paused: 'held' }
const THREAD_STATE: Record<BotLaunchedThread['status'], string> = { running: 'running', queued: 'waiting', paused: 'held', subagents: 'subagents working', needs_input: 'needs you', on_hold: 'needs you', idle: 'idle', done: 'done', failed: 'failed', stopped: 'stopped' }

/** `/status`: the bot's work, background commands, threads, schedules and reminders, one short line each. */
export function statusText(bot: BotSummary | undefined, detail: BotDetail, now = Date.now()): string {
  const summary = detail.summary ?? bot
  const lines: string[] = []
  if (summary?.state === 'paused') lines.push(summary.stateText.startsWith('Paused') ? `${summary.stateText}.` : 'Paused.')
  if (summary?.chat) lines.push('Chat: replying')
  const work = summary?.work ?? []
  lines.push(work.length
    ? `Work: ${work.map((item) => {
      const state = item.status === 'paused' && item.waitsFor === 'answer' ? 'waiting on you' : WORK_STATE[item.status]
      return `${item.title} (${state || since(item.startedAt, now)})`
    }).join(', ')}`
    : 'Work: none')
  const watchers = summary?.watchers ?? []
  if (watchers.length) lines.push(`Background: ${watchers.map((item) => item.title).join(', ')}`)
  const threads = summary?.threads ?? []
  if (threads.length) {
    const shown = threads.slice(0, 5).map((thread) => `${thread.title} (${THREAD_STATE[thread.status]})`)
    lines.push(`Threads: ${shown.join(', ')}${threads.length > 5 ? ` +${threads.length - 5}` : ''}`)
  }
  const schedules = detail.runs.filter((run) => run.kind === 'schedule')
  lines.push(schedules.length ? `Schedules: ${schedules.map((run) => `${run.label}${run.paused ? ' (off)' : ''}`).join(', ')}` : 'Schedules: none')
  const reminders = detail.reminders ?? []
  if (reminders.length) lines.push(`Reminders: ${reminders.length} waiting`)
  return lines.join('\n')
}

/** The bot's slots and choices: held ones, or read again (`fresh`, and when none are held). */
async function modelInfo(botId: string, fresh = false): Promise<ModelInfo> {
  const held = store().modelInfo[botId]
  if (held && !fresh) return held
  const problem = await store().loadModelInfo(botId)
  const info = store().modelInfo[botId]
  if (!info) throw new Error(problem ?? 'Could not read the models.')
  return info
}

/** "Opus 5.5 · Team Claude" for a pick among `providers`; its model id when they don't offer it now. */
export function pickLabel(pick: BotModelPick | null | undefined, providers: readonly LlmProviderOption[] | undefined): string | undefined {
  if (!pick) return undefined
  const provider = providers?.find((entry) => entry.instanceId === pick.instanceId)
  const model = provider?.models.find((entry) => entry.id === pick.model)
  return provider && model ? `${model.label} · ${provider.label}` : pick.model
}

const sameModel = (a: BotModelPick | null | undefined, b: BotModelPick | null | undefined) => (a?.instanceId ?? '') === (b?.instanceId ?? '') && (a?.model ?? '') === (b?.model ?? '') && (a?.effort ?? '') === (b?.effort ?? '')

/** By slot name, the model it runs on now, as `/model`'s list and its suggestions show it. */
export function slotModels(info: ModelInfo | undefined): Record<string, string> {
  if (!info) return {}
  const shown: Record<string, string> = {}
  const rows = info.slots
  const label = (key: 'talk' | 'light' | 'medium' | 'hard') => pickLabel(rows?.[key], info.providers) ?? info.named?.[key] ?? (rows ? 'Same as another row' : info.model ?? 'Mousse chooses')
  for (const key of ['talk', 'light', 'medium', 'hard'] as const) shown[key] = label(key)
  if (rows && sameModel(rows.light, rows.medium) && sameModel(rows.medium, rows.hard)) shown.work = shown.medium!
  if (info.image !== undefined) shown.images = pickLabel(info.image, info.imageProviders) ?? 'None'
  for (const slot of info.custom ?? []) shown[slot.name] = pickLabel(slot.pick, info.providers) ?? slot.pick.model
  return shown
}

/** `/model`: every slot and its model, one line each; Work once while its three levels share a model. */
export function modelListText(info: ModelInfo): string {
  const shown = slotModels(info)
  const lines = [`talk: ${shown.talk}`]
  if (shown.work) lines.push(`work: ${shown.work}`)
  else for (const key of ['light', 'medium', 'hard']) lines.push(`${key}: ${shown[key]}`)
  if (shown.images) lines.push(`images: ${shown.images}`)
  for (const slot of info.custom ?? []) lines.push(`${slot.name}: ${shown[slot.name]}${slot.description ? ` (${slot.description})` : ''}`)
  return lines.join('\n')
}

/** `/model <slot> <model> [description]`: sets a base slot, or adds or changes a custom one. */
async function setSlot(botId: string, command: Extract<BotCommand, { kind: 'model-set' }>): Promise<string> {
  const info = await modelInfo(botId)
  const base = baseSlotOf(command.slot)
  const found = resolveModelWord(command.model, base === 'images' ? info.imageProviders ?? [] : info.providers ?? [])
  if ('error' in found) throw new Error(found.error)
  const client = botsClient()
  if (base === 'images') await client.setImage(botId, found.pick)
  else if (base === 'work') await client.setSlots(botId, { slots: { light: found.pick, medium: found.pick, hard: found.pick } })
  else if (base) await client.setSlots(botId, { slots: { [base]: found.pick } })
  else await client.setCustomSlot(botId, command.slot, found.pick, command.description)
  void store().loadModelInfo(botId)
  void store().refresh()
  return `${command.slot} now runs on ${found.label}.`
}

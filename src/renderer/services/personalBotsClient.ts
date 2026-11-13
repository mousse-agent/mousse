import type { BotChatMessage, BotChip, BotDetail, BotSummary } from '../../shared/bots/personal/chat'
import type { BotLook } from '../../shared/bots/personal/look'
import type { BotMemoryListing } from '../../shared/bots/personal/memory'
import type { BotModelSlots, BotSchedule } from '../../shared/bots/personal/definition'
import type { BotChatAttachment, BotsPersonalV2EventData, BotsPersonalV2Method, BotsPersonalV2Params, BotsPersonalV2Result } from '../../shared/bots/personal/methods'
import type { PlatformRequestApi } from '../../shared/platform'

/**
 * The Bot UI's methods (`bots.personal.v2`, Bot Phase 1 §5.11) over the host's profile-bound
 * bridge. No result carries a model, apart from the Runs on pickers' (`bots.model.*`, #673).
 */
export interface PersonalBotsClient {
  list(): Promise<BotSummary[]>
  /**
   * `slots`: the rows picked on New bot (#673), all four, sent only to a service whose choices carry `providers`;
   * `model`: one model on every row (the single picker of an older service). An older service refuses the keys.
   */
  create(input: { look: BotLook; name?: string; description: string; clientRequestId: string; model?: string; slots?: BotModelSlots }): Promise<BotSummary>
  get(botId: string): Promise<BotDetail>
  update(botId: string, change: { name?: string; look?: BotLook }): Promise<BotSummary>
  pause(botId: string): Promise<BotSummary>
  resume(botId: string): Promise<BotSummary>
  /** Archives the bot now; its chat and memory are erased at `purgeAt`. */
  remove(botId: string): Promise<{ purgeAt: string }>
  messages(botId: string, page?: { beforeSeq?: number; limit?: number }): Promise<BotsPersonalV2Result<'bots.chat.list'>>
  send(botId: string, text: string, clientRequestId: string, attachments?: BotChatAttachment[], replyTo?: string): Promise<BotChatMessage>
  stop(botId: string): Promise<void>
  /** Stops one piece of work; the chat goes on. */
  stopWork(botId: string, workId: string): Promise<void>
  markRead(botId: string, seq: number): Promise<void>
  answer(botId: string, askId: string, answer: 'allow' | 'not_now'): Promise<BotChatMessage>
  revokePermission(botId: string, permissionId: string): Promise<BotDetail>
  addSchedule(botId: string, when: BotSchedule['when'], prompt: string, model?: string): Promise<BotDetail>
  /** The bot's rows (`slots`, absent from an older service), its Talk model by name, and the computers it can run on (#673). */
  model(botId: string): Promise<BotsPersonalV2Result<'bots.model.get'>>
  /** One model on every row, or Automatic (null): the single picker of an older service. */
  setModel(botId: string, model: string | null): Promise<BotSummary>
  /**
   * Changes the bot's rows (#673) over the rows as they are now: `slots`, the rows the owner picked; `oneWork`, Medium
   * work's pick on all work (Advanced closing). Only a service that sent `slots` has it.
   */
  setSlots(botId: string, change: { slots: Partial<BotModelSlots> } | { oneWork: true }): Promise<BotSummary>
  /** What New bot's Runs on line offers before the bot exists; an older service lacks it and rejects. */
  modelChoices(): Promise<BotsPersonalV2Result<'bots.model.choices'>>
  removeSchedule(botId: string, scheduleId: string): Promise<BotDetail>
  /** Cancels a waiting reminder; it never fires. */
  cancelReminder(botId: string, reminderId: string): Promise<BotDetail>
  exportMemory(botId: string, dir: string): Promise<{ files: string[] }>
  /** What the bot remembers: the entries every turn carries. */
  memory(botId: string): Promise<BotMemoryListing>
  /** Forgets one entry (`m12`): the next turn no longer carries it. */
  forgetMemory(botId: string, id: string): Promise<void>
}

export function createPersonalBotsClient(transport: PlatformRequestApi): PersonalBotsClient {
  const call = <M extends BotsPersonalV2Method>(method: M, params: BotsPersonalV2Params<M>) =>
    transport.request<BotsPersonalV2Result<M>>(method, params)
  return {
    list: async () => (await call('bots.personal.list', {})).bots,
    create: async ({ look, name, description, clientRequestId, model, slots }) =>
      (await call('bots.create', { look, description, clientRequestId, ...(name ? { name } : {}), ...(slots ? { slots } : model ? { model } : {}) })).bot,
    get: (botId) => call('bots.get', { botId }),
    update: async (botId, change) => (await call('bots.update', { botId, ...change })).bot,
    pause: async (botId) => (await call('bots.personal.pause', { botId })).bot,
    resume: async (botId) => (await call('bots.personal.resume', { botId })).bot,
    remove: (botId) => call('bots.delete', { botId }),
    messages: (botId, page = {}) => call('bots.chat.list', { botId, ...page }),
    send: async (botId, text, clientRequestId, attachments, replyTo) =>
      (await call('bots.chat.send', { botId, text, clientRequestId, ...(attachments?.length ? { attachments } : {}), ...(replyTo ? { replyTo } : {}) })).message,
    stop: async (botId) => { await call('bots.chat.stop', { botId }) },
    stopWork: async (botId, workId) => { await call('bots.work.stop', { botId, workId }) },
    markRead: async (botId, seq) => { await call('bots.chat.markRead', { botId, seq }) },
    answer: async (botId, askId, answer) => (await call('bots.asks.answer', { botId, askId, answer })).message,
    revokePermission: (botId, permissionId) => call('bots.permissions.revoke', { botId, permissionId }),
    addSchedule: (botId, when, prompt, model) => call('bots.schedules.add', { botId, when, prompt, ...(model ? { model } : {}) }),
    model: (botId) => call('bots.model.get', { botId }),
    setModel: async (botId, model) => (await call('bots.model.set', { botId, model })).bot,
    setSlots: async (botId, change) => (await call('bots.model.setSlots', { botId, ...change })).bot,
    modelChoices: () => call('bots.model.choices', {}),
    removeSchedule: (botId, scheduleId) => call('bots.schedules.remove', { botId, scheduleId }),
    cancelReminder: (botId, reminderId) => call('bots.reminders.cancel', { botId, reminderId }),
    exportMemory: (botId, dir) => call('bots.memory.export', { botId, dir }),
    memory: (botId) => call('bots.memory.list', { botId }),
    forgetMemory: async (botId, id) => { await call('bots.memory.forget', { botId, id }) }
  }
}

/** The preload's bot group: the events it forwards (`bots:changed`, `bots:message`, `bots:activity`) and a file's path. */
export interface PersonalBotsEvents {
  onChanged?(cb: (event: { botId?: string }) => void): () => void
  onMessage?(cb: (event: BotsPersonalV2EventData['bots.message']) => void): () => void
  onActivity?(cb: (event: { botId: string; activationId: string; chip: BotChip | null }) => void): () => void
  /** A composer file's path on this computer (see `attachmentPath`). */
  attachmentPath?(file: File): Promise<string>
}

/** The preload's bot events; a bridge that lacks one (an older preload) just never calls it. */
export function personalBotsEvents(): PersonalBotsEvents {
  return ((window.mousse as unknown as { personalBots?: PersonalBotsEvents } | undefined)?.personalBots) ?? {}
}

/**
 * A composer file's path on this computer, from the preload: where it is, or a temporary copy of a
 * pasted one. `bots.chat.send` names files by path; the service copies them for the bot.
 */
export function attachmentPath(file: File): Promise<string> {
  const bridge = personalBotsEvents()
  return bridge.attachmentPath ? bridge.attachmentPath(file) : Promise.reject(new Error('Restart Mousse to attach files to a bot message.'))
}

/** The plain message of a failed request (RPC errors carry a code and a message). */
export function errorText(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'message' in cause) return String((cause as { message: unknown }).message)
  return String(cause)
}

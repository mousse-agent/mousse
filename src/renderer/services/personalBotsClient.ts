import type { BotChatMessage, BotChip, BotDetail, BotSummary } from '../../shared/bots/personal/chat'
import type { BotLook } from '../../shared/bots/personal/look'
import type { BotSchedule } from '../../shared/bots/personal/definition'
import type { BotChatAttachment, BotsPersonalV2EventData, BotsPersonalV2Method, BotsPersonalV2Params, BotsPersonalV2Result } from '../../shared/bots/personal/methods'
import type { PlatformRequestApi } from '../../shared/platform'

/**
 * The Bot UI's methods (`bots.personal.v2`, Bot Phase 1 §5.11) over the host's profile-bound
 * bridge. No result carries a model: the renderer never needs one.
 */
export interface PersonalBotsClient {
  list(): Promise<BotSummary[]>
  create(input: { look: BotLook; name?: string; description: string; clientRequestId: string }): Promise<BotSummary>
  get(botId: string): Promise<BotDetail>
  update(botId: string, change: { name?: string; look?: BotLook }): Promise<BotSummary>
  pause(botId: string): Promise<BotSummary>
  resume(botId: string): Promise<BotSummary>
  /** Archives the bot now; its chat and memory are erased at `purgeAt`. */
  remove(botId: string): Promise<{ purgeAt: string }>
  messages(botId: string, page?: { beforeSeq?: number; limit?: number }): Promise<BotsPersonalV2Result<'bots.chat.list'>>
  send(botId: string, text: string, clientRequestId: string, attachments?: BotChatAttachment[]): Promise<BotChatMessage>
  stop(botId: string): Promise<void>
  markRead(botId: string, seq: number): Promise<void>
  answer(botId: string, askId: string, answer: 'allow' | 'not_now'): Promise<BotChatMessage>
  revokePermission(botId: string, permissionId: string): Promise<BotDetail>
  addSchedule(botId: string, when: BotSchedule['when'], prompt: string, model?: string): Promise<BotDetail>
  /** The bot's model by hand or by usage (null), and the computers it can run on (#673). */
  model(botId: string): Promise<BotsPersonalV2Result<'bots.model.get'>>
  setModel(botId: string, model: string | null): Promise<BotSummary>
  removeSchedule(botId: string, scheduleId: string): Promise<BotDetail>
  exportMemory(botId: string, dir: string): Promise<{ files: string[] }>
}

export function createPersonalBotsClient(transport: PlatformRequestApi): PersonalBotsClient {
  const call = <M extends BotsPersonalV2Method>(method: M, params: BotsPersonalV2Params<M>) =>
    transport.request<BotsPersonalV2Result<M>>(method, params)
  return {
    list: async () => (await call('bots.personal.list', {})).bots,
    create: async ({ look, name, description, clientRequestId }) =>
      (await call('bots.create', { look, description, clientRequestId, ...(name ? { name } : {}) })).bot,
    get: (botId) => call('bots.get', { botId }),
    update: async (botId, change) => (await call('bots.update', { botId, ...change })).bot,
    pause: async (botId) => (await call('bots.personal.pause', { botId })).bot,
    resume: async (botId) => (await call('bots.personal.resume', { botId })).bot,
    remove: (botId) => call('bots.delete', { botId }),
    messages: (botId, page = {}) => call('bots.chat.list', { botId, ...page }),
    send: async (botId, text, clientRequestId, attachments) =>
      (await call('bots.chat.send', { botId, text, clientRequestId, ...(attachments?.length ? { attachments } : {}) })).message,
    stop: async (botId) => { await call('bots.chat.stop', { botId }) },
    markRead: async (botId, seq) => { await call('bots.chat.markRead', { botId, seq }) },
    answer: async (botId, askId, answer) => (await call('bots.asks.answer', { botId, askId, answer })).message,
    revokePermission: (botId, permissionId) => call('bots.permissions.revoke', { botId, permissionId }),
    addSchedule: (botId, when, prompt, model) => call('bots.schedules.add', { botId, when, prompt, ...(model ? { model } : {}) }),
    model: (botId) => call('bots.model.get', { botId }),
    setModel: async (botId, model) => (await call('bots.model.set', { botId, model })).bot,
    removeSchedule: (botId, scheduleId) => call('bots.schedules.remove', { botId, scheduleId }),
    exportMemory: (botId, dir) => call('bots.memory.export', { botId, dir })
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

import type { BotChatMessage, BotChip, BotDetail, BotSummary } from '../../shared/bots/personal/chat'
import type { BotLook } from '../../shared/bots/personal/look'
import type { BotMemoryEntry, BotMemoryListing } from '../../shared/bots/personal/memory'
import type { BotModelPick, BotModelSlots, BotSchedule } from '../../shared/bots/personal/definition'
import type { BotChatAttachment, BotReplyEvent, BotsElsewhereApi, BotsElsewhereMethod, BotsPersonalV2EventData, BotsPersonalV2Method, BotsPersonalV2Params, BotsPersonalV2Result } from '../../shared/bots/personal/methods'
import type { PlatformRequestApi } from '../../shared/platform'
import type { BotDeviceAccess, BotDevicesView, NewBotAccess } from '../../shared/bots/personal/deviceAccess'
import type { BotMark, BotMarksApi, BotMarksByRef } from '../../shared/bots/personal/marks'

/**
 * The Bot UI's methods (`bots.personal.v2`, Bot Phase 1 §5.11) over the host's profile-bound
 * bridge. No result carries a model, apart from the Runs on pickers' (`bots.model.*`, #673).
 */
export interface PersonalBotsClient {
  list(): Promise<BotSummary[]>
  /**
   * The bots of the owner's other computers, as this computer lists them (`bots.remote.list`): qualified ids, each with
   * the computer it lives on (`lives`). Read from what this computer keeps; never waits on another one.
   */
  remoteList(): Promise<BotSummary[]>
  /** This window shows (or no longer shows) the chat of a bot of another computer: its chat streams here while it does. */
  focus(botId: string, focused: boolean): Promise<void>
  /** What this computer marks on the bots it lists (pin, hide, mute, marked unread), by bot ref. An older service lacks it. */
  marks(): Promise<BotMarksByRef>
  /** Sets or clears one mark on one bot, on this computer only; every bot's marks as they are now. */
  setMark(botId: string, mark: BotMark, on: boolean): Promise<BotMarksByRef>
  /**
   * `slots`: the rows picked on New bot (#673), all four, sent only to a service whose choices carry `providers`;
   * `model`: one model on every row (the single picker of an older service). An older service refuses the keys.
   * `image`: the Images row (#1088), sent only to a service whose choices carry `imageProviders`. `access`: the Devices
   * step (this computer alone when it is not shown), sent only to a service whose choices carry `reachOnCreate`.
   */
  create(input: { look: BotLook; name?: string; description: string; clientRequestId: string; model?: string; slots?: BotModelSlots; image?: BotModelPick; access?: NewBotAccess }): Promise<BotSummary>
  get(botId: string): Promise<BotDetail>
  /** `description`: the bot's prompt, as the owner edits it in About; null resets it. An older service refuses it. */
  update(botId: string, change: { name?: string; look?: BotLook; description?: string | null }): Promise<BotSummary>
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
  /** The owner's reaction on one of the bot's messages: an emoji, or `null` to remove it. The message as it is now. */
  react(botId: string, messageId: string, emoji: string | null): Promise<BotChatMessage>
  answer(botId: string, askId: string, answer: 'allow' | 'not_now'): Promise<BotChatMessage>
  snoozeReminder(botId: string, messageId: string, choice: import('../../shared/bots/personal/chat').BotSnoozeChoice): Promise<BotsPersonalV2Result<'bots.reminders.snooze'>>
  /**
   * The owner taps one of a question's answers: their reply, and the question's bubble as it is now. An older service
   * lacks it and rejects; the owner answers with Reply there.
   */
  answerAction(botId: string, actionId: string, digest: string, answer: 'send' | 'not_now'): Promise<BotsPersonalV2Result<'bots.actions.answer'>>
  /** The owner's Continue or Stop on what the bot holds past the limit between bots, by its batch (`BotSummary.chainHold`). */
  answerChainHold(botId: string, holdId: string, answer: 'continue' | 'stop'): Promise<BotsPersonalV2Result<'bots.chainHold.answer'>>
  answerQuestion(botId: string, questionId: string, choice: string, clientRequestId: string): Promise<BotsPersonalV2Result<'bots.questions.answer'>>
  setPermission(botId: string, permissionId: string, enabled: boolean): Promise<BotDetail>
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
  /** The Images row (#1088): a model to make pictures with, or null for none. Only a service that sent `imageProviders` has it. */
  setImage(botId: string, pick: BotModelPick | null): Promise<BotSummary>
  /** Adds or changes a custom slot (`pick`), or removes it (null). An older service lacks it and rejects. */
  setCustomSlot(botId: string, name: string, pick: BotModelPick | null, description?: string): Promise<BotSummary>
  /** Wipes the chat's messages; memory stays. An older service lacks it and rejects. */
  clearChat(botId: string): Promise<void>
  /** Forgets every memory entry, or (`keep: 'saved'`) the chat, its history and run notes only. */
  wipeMemory(botId: string, keep?: 'saved'): Promise<{ forgotten: number }>
  /** A fresh start: chat, memory, schedules and reminders go; name, look, permissions and models stay. */
  reset(botId: string): Promise<BotSummary>
  /** Saves the bot's face picture (a PNG in base64) drawn from `key`. Only a service whose summaries carry `facePicture` has it. */
  saveFacePicture(botId: string, key: string, png: string): Promise<{ path: string }>
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
  /** New words for an entry (`ref`, the version shown): its next version. An older service lacks it and rejects. */
  editMemory(botId: string, ref: string, text: string): Promise<BotMemoryEntry>
  /** Which of the owner's devices reach the bot, and the devices to pick from. An older service lacks it and rejects. */
  devices(botId: string): Promise<BotDevicesView>
  /** Saves which devices reach the bot; only this computer's window and command line may. */
  setDevices(botId: string, access: BotDeviceAccess): Promise<BotDevicesView>
}

export function createPersonalBotsClient(transport: PlatformRequestApi): PersonalBotsClient {
  const call = <M extends BotsPersonalV2Method>(method: M, params: BotsPersonalV2Params<M>) =>
    transport.request<BotsPersonalV2Result<M>>(method, params)
  const elsewhere = <M extends BotsElsewhereMethod>(method: M, params: BotsElsewhereApi[M]['params']) =>
    transport.request<BotsElsewhereApi[M]['result']>(method, params)
  return {
    list: async () => (await call('bots.personal.list', {})).bots,
    remoteList: async () => (await elsewhere('bots.remote.list', {})).bots,
    focus: async (botId, focused) => { await elsewhere('bots.focus', { botId, focused }) },
    marks: async () => (await transport.request<BotMarksApi['bots.marks.list']['result']>('bots.marks.list', {})).marks,
    setMark: async (botId, mark, on) => (await transport.request<BotMarksApi['bots.marks.set']['result']>('bots.marks.set', { botId, mark, on })).marks,
    create: async ({ look, name, description, clientRequestId, model, slots, image, access }) =>
      (await call('bots.create', { look, description, clientRequestId, ...(name ? { name } : {}), ...(slots ? { slots } : model ? { model } : {}), ...(image ? { image } : {}), ...(access ? { access } : {}) })).bot,
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
    react: async (botId, messageId, emoji) => (await call('bots.chat.react', { botId, messageId, emoji })).message,
    answer: async (botId, askId, answer) => (await call('bots.asks.answer', { botId, askId, answer })).message,
    snoozeReminder: (botId, messageId, choice) => call('bots.reminders.snooze', { botId, messageId, choice }),
    answerAction: (botId, actionId, digest, answer) => call('bots.actions.answer', { botId, actionId, digest, answer }),
    answerChainHold: (botId, holdId, answer) => call('bots.chainHold.answer', { botId, holdId, answer }),
    answerQuestion: (botId, questionId, choice, clientRequestId) => call('bots.questions.answer', { botId, questionId, choice, clientRequestId }),
    setPermission: (botId, permissionId, enabled) => call('bots.permissions.set', { botId, permissionId, enabled }),
    revokePermission: (botId, permissionId) => call('bots.permissions.revoke', { botId, permissionId }),
    addSchedule: (botId, when, prompt, model) => call('bots.schedules.add', { botId, when, prompt, ...(model ? { model } : {}) }),
    model: (botId) => call('bots.model.get', { botId }),
    setModel: async (botId, model) => (await call('bots.model.set', { botId, model })).bot,
    setSlots: async (botId, change) => (await call('bots.model.setSlots', { botId, ...change })).bot,
    setImage: async (botId, pick) => (await call('bots.model.setImage', { botId, pick })).bot,
    setCustomSlot: async (botId, name, pick, description) =>
      (await call('bots.model.setCustom', { botId, name, pick, ...(description ? { description } : {}) })).bot,
    clearChat: async (botId) => { await call('bots.chat.clear', { botId }) },
    wipeMemory: (botId, keep) => call('bots.memory.wipe', { botId, ...(keep ? { keep } : {}) }),
    reset: async (botId) => (await call('bots.reset', { botId })).bot,
    saveFacePicture: (botId, key, png) => call('bots.facePicture.save', { botId, key, png }),
    modelChoices: () => call('bots.model.choices', {}),
    removeSchedule: (botId, scheduleId) => call('bots.schedules.remove', { botId, scheduleId }),
    cancelReminder: (botId, reminderId) => call('bots.reminders.cancel', { botId, reminderId }),
    exportMemory: (botId, dir) => call('bots.memory.export', { botId, dir }),
    memory: (botId) => call('bots.memory.list', { botId }),
    forgetMemory: async (botId, id) => { await call('bots.memory.forget', { botId, id }) },
    editMemory: async (botId, ref, text) => (await call('bots.memory.edit', { botId, id: ref, text })).entry,
    devices: (botId) => transport.request<BotDevicesView>('bots.devices.get', { botId }),
    setDevices: (botId, access) => transport.request<BotDevicesView>('bots.devices.set', { botId, access })
  }
}

/** The preload's bot group: the events it forwards (`bots:changed`, `bots:message`, `bots:activity`, `bots:reply`) and a file's path. */
export interface PersonalBotsEvents {
  /**
   * `reread`: the window's service connection was opened again, so chats it holds may have missed rows; with `botId`,
   * that one bot's chat stream opened again (a bot of another computer). `remote`: the other computers' bots changed.
   */
  /** `marks`: only what this computer marks on bots changed (`bots.marks.set`, from any of its windows). */
  onChanged?(cb: (event: { botId?: string; reread?: boolean; remote?: boolean; marks?: boolean }) => void): () => void
  /** A bot of another computer writing its reply, while this window shows its chat. */
  onReply?(cb: (event: BotReplyEvent) => void): () => void
  onMessage?(cb: (event: BotsPersonalV2EventData['bots.message']) => void): () => void
  onActivity?(cb: (event: { botId: string; activationId: string; chip: BotChip | null; status?: string }) => void): () => void
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

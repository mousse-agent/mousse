import { useEffect } from 'react'
import { create } from 'zustand'
import type { BotChatMessage, BotChatQuote, BotChip, BotDetail, BotSummary } from '../../shared/bots/personal/chat'
import type { BotLook } from '../../shared/bots/personal/look'
import type { BotModelPick, BotModelSlots } from '../../shared/bots/personal/definition'
import { attachmentTooLargeText } from '../../shared/bots/personal/attachments'
import { MAX_BOT_CHAT_ATTACHMENT_BYTES, MAX_BOT_CHAT_ATTACHMENTS, type BotChatAttachment, type BotShownRows } from '../../shared/bots/personal/methods'
import type { BotFaceState } from '../components/bots/face/BotFace'
import type { AttachedFile } from '../components/ChatComposer'
import { attachmentPath, createPersonalBotsClient, errorText, personalBotsEvents, type PersonalBotsClient } from '../services/personalBotsClient'
import { keepEqualById } from '../lib/keepEqual'

/**
 * The owner's bots in the Chats tab (Bot Phase 1 §5.12): the list, each bot's chat as far as it
 * was read, the live chip of a working bot, owner messages on their way, and About's detail.
 * Pushed by `bots.changed`, `bots.message` and `bots.activity`; while the Chats tab is open,
 * `useBotsPolling` lists them again every 30 seconds while the window shows, and as soon as it shows
 * again, in case an event was missed. A list that changed nothing keeps the objects held, so nothing renders again for it.
 */

/** Messages one chat page asks for. */
/** A record without one key. */
function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

export const BOT_CHAT_PAGE = 50
/** How long the face plays "done" after a working bot goes idle with a good outcome. */
export const BOT_HAPPY_MS = 2500
/** A fallback for a missed push: every change to a bot is pushed. */
const POLL_MS = 30_000

export interface BotChatCache {
  messages: BotChatMessage[]
  /** Older messages exist before the first one held. */
  hasMore: boolean
  loadingOlder: boolean
}

export type BotDialog = { kind: 'rename' | 'look' | 'delete'; botId: string }

/**
 * What the owner has put into New bot so far. It lives here, not in the dialog, so nothing that
 * closes or remounts the dialog loses it; Create bot clears it once the bot is made.
 */
export interface NewBotDraft {
  /** Picked when the dialog first opens: one the owner's other bots don't wear. */
  look: BotLook | null
  name: string
  description: string
  /** A model picked by hand on the single Runs on picker (#673, an older service); null is by usage, the default. */
  model: string | null
  /**
   * The rows on Runs on (#673, `BotModelRows`), each a pick or null (Pick a model). null until Runs on's choices come:
   * then the owner's last bot's picks that are still offered (`seedNewBotRows`), else every row empty. Create bot waits
   * until every row holds a pick, and sends them only to a service whose choices carry `providers`.
   */
  slots: BotShownRows | null
  /** The Images row (#1088): a model to make pictures with, or null (none, the default). */
  image: BotModelPick | null
  /** The step New bot shows, so closing and reopening returns to it. */
  step: NewBotStep
  /** The owner typed or picked something: a click beside the dialog no longer closes it. */
  touched: boolean
}
/** New bot's steps: the look, what it does (name and sentence), and where it runs. */
export type NewBotStep = 'look' | 'about' | 'runsOn'
const EMPTY_NEW_BOT: NewBotDraft = { look: null, name: '', description: '', model: null, slots: null, image: null, step: 'look', touched: false }

/**
 * The step that can fix a refused create: a model no longer offered is Runs on's, a name or sentence the service
 * refuses is What it does's. Anything else (no answer, a busy service) stays where Create bot was pressed.
 */
export function newBotStepForFailure(cause: unknown, current: NewBotStep): NewBotStep {
  const code = cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code: unknown }).code) : ''
  if (code === 'model_unavailable') return 'runsOn'
  if (code === 'invalid_params' || code === 'bot_invalid') return 'about'
  return current
}

interface BotsState {
  profileId: string | null
  bots: BotSummary[]
  loaded: boolean
  chats: Record<string, BotChatCache>
  /** A chat's first load while it runs, or after it failed (until Retry). Absent once the chat is held. */
  chatLoad: Record<string, 'loading' | 'failed'>
  /** The current step of a working bot. */
  live: Record<string, { activationId: string; chip?: BotChip }>
  /** The live chip of each running activation (the chat's turn and each piece of work), by activation id. */
  activity: Record<string, BotChip>
  /** Owner messages sent and not yet confirmed, shown as sent. */
  pending: Record<string, BotChatMessage[]>
  details: Record<string, BotDetail>
  /** Until when (epoch ms) a bot's face plays "done". */
  happy: Record<string, number>
  drafts: Record<string, string>
  /** The files in each bot's composer: picked, dropped or pasted. */
  attachments: Record<string, AttachedFile[]>
  /** The message each bot's composer replies to (Reply on a message), shown above the box until sent or dismissed. */
  replyingTo: Record<string, BotChatQuote>
  /** The service has no `bots.chat.react` (an older one): messages show no reaction bar. */
  reactionsMissing: boolean
  error: string | null
  /** The bot `error` is about; null when it is about none (a new bot). Only that bot's chat shows it. */
  errorBotId: string | null
  busy: boolean
  newBotOpen: boolean
  newBotDraft: NewBotDraft
  aboutOpen: boolean
  dialog: BotDialog | null
  activate(profileId: string): void
  refresh(): Promise<void>
  loadChat(botId: string): Promise<void>
  loadOlder(botId: string): Promise<void>
  /** Loads older pages until the message is held; false when the chat has no such message. */
  findMessage(botId: string, messageId: string): Promise<boolean>
  markRead(botId: string): void
  setDraft(botId: string, text: string): void
  setAttachments(botId: string, attachments: AttachedFile[]): void
  /** Reply to a message (null: not any more). */
  setReplyingTo(botId: string, quote: BotChatQuote | null): void
  send(botId: string): Promise<void>
  stop(botId: string): Promise<void>
  /** Stops one piece of work (the line above the composer); the chat goes on. */
  stopWork(botId: string, workId: string): Promise<void>
  answer(botId: string, askId: string, answer: 'allow' | 'not_now'): Promise<void>
  /**
   * The owner's reaction on one of the bot's messages: shown at once, and put back as it was when the service refuses
   * it. `null` removes it. It never starts a turn.
   */
  react(botId: string, messageId: string, emoji: string | null): Promise<void>
  exportMemory(botId: string, askId: string): Promise<void>
  openNewBot(): void
  /** Closes New bot; what was put in stays for the next time it opens. */
  closeNewBot(): void
  setNewBotDraft(change: Partial<Omit<NewBotDraft, 'touched' | 'step'>>): void
  /**
   * New bot's rows once Runs on's choices come: the draft's rows, else `last` (the owner's last bot's picks), each kept
   * only while `offered` (a pick no longer offered is empty again). Seeding is not putting anything in.
   */
  seedNewBotRows(last: BotShownRows | undefined, offered: (pick: BotModelPick) => boolean): void
  /** Moves New bot to a step; moving alone is not putting anything in. */
  setNewBotStep(step: NewBotStep): void
  /** One create at a time: a second call while one is on its way gets the same answer. */
  create(input: { look: BotLook; name?: string; description: string; model?: string; slots?: BotModelSlots; image?: BotModelPick }): Promise<BotSummary | null>
  update(botId: string, change: { name?: string; look?: BotLook }): Promise<boolean>
  pause(botId: string): Promise<void>
  resume(botId: string): Promise<void>
  remove(botId: string): Promise<boolean>
  loadDetail(botId: string): Promise<void>
  revokePermission(botId: string, permissionId: string): Promise<void>
  removeSchedule(botId: string, scheduleId: string): Promise<void>
  cancelReminder(botId: string, reminderId: string): Promise<void>
}

let client: PersonalBotsClient | null = null
/** The client the store talks through; tests pass a fake. */
export function setBotsClient(next: PersonalBotsClient | null): void { client = next }
function bots(): PersonalBotsClient {
  return client ?? (client = createPersonalBotsClient(window.mousse.platformRequest))
}
/** The client the bot screens talk through (About's model and computer). */
export function botsClient(): PersonalBotsClient {
  return bots()
}

let epoch = 0
let refreshOperation: Promise<void> | undefined
let unsubscribe: Array<() => void> = []
/** Each bot's last send whose words came back after a failure: sending the same words again reuses its request id. */
const failedSends = new Map<string, { text: string; clientRequestId: string }>()
/** The id of the bubble shown while the message sent with `clientRequestId` is on its way. */
const pendingId = (clientRequestId: string) => `pending:${clientRequestId}`
/** Each bot's page of older messages on its way. */
const olderLoads = new Map<string, Promise<void>>()
let pendingCreate: { key: string; clientRequestId: string } | undefined
let createOperation: Promise<BotSummary | null> | undefined
/** Bots made here that no list has carried yet. */
const created = new Set<string>()
const readSeq = new Map<string, number>()
/** Bots deleted in this profile: a list that was on its way when one was deleted never brings it back. */
const removed = new Set<string>()
/**
 * Each message's reactions on their way (`botId:messageId`): the reaction the service last confirmed, and the newest
 * pick's number. A refused pick puts back the confirmed one, never another pick's, and only the newest pick is shown.
 */
const reactions = new Map<string, { confirmed: string | undefined; latest: number }>()
let reactionPicks = 0
/** The service does not know the method (an older one), by its code or, over IPC, its message. */
const missingMethod = (cause: unknown) => ['method_not_available', 'method_not_found', 'unknown_method', 'platform_method_not_allowed'].includes(String((cause as { code?: unknown } | null)?.code ?? ''))
  || /method[ _]not[ _](?:allowed|found|available)|unknown[ _]method|domain method is unavailable|not allowlisted/i.test(cause instanceof Error ? cause.message : String(cause))
const happyTimers = new Map<string, ReturnType<typeof setTimeout>>()

const bySeq = (a: BotChatMessage, b: BotChatMessage) => a.seq - b.seq
/** `messages` with `incoming` added or replaced by id, in seq order. */
function upsert(messages: BotChatMessage[], incoming: BotChatMessage[]): BotChatMessage[] {
  const byId = new Map(messages.map((message) => [message.id, message]))
  for (const message of incoming) byId.set(message.id, message)
  return [...byId.values()].sort(bySeq)
}
const replaceBot = (list: BotSummary[], bot: BotSummary) =>
  removed.has(bot.id) ? list : list.some((entry) => entry.id === bot.id) ? list.map((entry) => (entry.id === bot.id ? bot : entry)) : [...list, bot]

/** A composer file as `bots.chat.send` names it: its name and its path on this computer. */
async function attachmentOf(attached: AttachedFile): Promise<BotChatAttachment> {
  return { name: attached.file.name || 'file', path: await attachmentPath(attached.file) }
}

/** Why these files can't be sent, or null when they can. */
function attachmentsRefusal(files: readonly AttachedFile[]): string | null {
  if (files.length > MAX_BOT_CHAT_ATTACHMENTS) return `Attach at most ${MAX_BOT_CHAT_ATTACHMENTS} files.`
  const large = files.find((attached) => attached.file.size > MAX_BOT_CHAT_ATTACHMENT_BYTES)
  return large ? attachmentTooLargeText(large.file.name) : null
}

/** The face a bot shows now: its state, or "done" for a moment after it finished well. */
export function botFaceState(bot: BotSummary, happyUntil: number | undefined, now = Date.now()): BotFaceState {
  return bot.state === 'idle' && happyUntil !== undefined && happyUntil > now ? 'happy' : bot.state
}

export const useBotsStore = create<BotsState>((set, get) => {
  const fail = (owner: number, cause: unknown, botId: string | null = null) => { if (owner === epoch) set({ error: errorText(cause), errorBotId: botId, busy: false }) }
  const cacheOf = (botId: string): BotChatCache => get().chats[botId] ?? { messages: [], hasMore: false, loadingOlder: false }
  const putMessages = (botId: string, incoming: BotChatMessage[]) => set((state) => {
    if (removed.has(botId)) return {}
    const cache = state.chats[botId] ?? { messages: [], hasMore: false, loadingOlder: false }
    // A confirmed message clears only the bubble sent with its request id, so two identical messages on their way stay two.
    const owned = new Set(incoming.flatMap((message) => (message.author === 'owner' && message.clientRequestId ? [pendingId(message.clientRequestId)] : [])))
    const pending = (state.pending[botId] ?? []).filter((message) => !owned.has(message.id))
    return { chats: { ...state.chats, [botId]: { ...cache, messages: upsert(cache.messages, incoming) } }, pending: { ...state.pending, [botId]: pending } }
  })
  /** A list with the bots made here that no list carried yet: one asked for before a bot was made doesn't drop it. */
  const withCreated = (listed: BotSummary[]): BotSummary[] => {
    for (const bot of listed) created.delete(bot.id)
    return created.size ? [...listed, ...get().bots.filter((bot) => created.has(bot.id))] : listed
  }
  const putBot = (bot: BotSummary) => set((state) => ({ bots: replaceBot(state.bots, bot), ...celebrate(state.bots, [bot]) }))
  /** "Done": a bot that was working and is now idle after a good run plays happy for a moment. */
  const celebrate = (before: BotSummary[], after: BotSummary[]): Pick<BotsState, 'happy'> | Record<string, never> => {
    const happy = { ...get().happy }
    let changed = false
    for (const bot of after) {
      const previous = before.find((entry) => entry.id === bot.id)
      if (previous?.state !== 'working' || bot.state !== 'idle' || bot.lastOutcome !== 'ok') continue
      happy[bot.id] = Date.now() + BOT_HAPPY_MS
      changed = true
      clearTimeout(happyTimers.get(bot.id))
      happyTimers.set(bot.id, setTimeout(() => {
        happyTimers.delete(bot.id)
        set((state) => { const { [bot.id]: _done, ...rest } = state.happy; return { happy: rest } })
      }, BOT_HAPPY_MS))
    }
    return changed ? { happy } : {}
  }
  const subscribe = () => {
    for (const stop of unsubscribe) stop()
    const events = personalBotsEvents()
    unsubscribe = [
      events.onChanged?.((event) => {
        void get().refresh()
        if (event?.botId && get().aboutOpen && get().details[event.botId]) void get().loadDetail(event.botId)
        // The window's service connection was opened again: a chat it holds reads its newest rows, which also fills
        // any it missed (#1042).
        if (event?.reread) for (const botId of Object.keys(get().chats)) void get().loadChat(botId)
      }),
      events.onMessage?.((event) => { if (event?.botId && event.message) putMessages(event.botId, [event.message]) }),
      events.onActivity?.((event) => {
        if (!event?.botId) return
        set((state) => ({
          live: { ...state.live, [event.botId]: { activationId: event.activationId, ...(event.chip ? { chip: event.chip } : {}) } },
          activity: event.chip ? { ...state.activity, [event.activationId]: event.chip } : withoutKey(state.activity, event.activationId)
        }))
      })
    ].filter((stop): stop is () => void => typeof stop === 'function')
  }

  return {
    profileId: null, bots: [], loaded: false, chats: {}, chatLoad: {}, live: {}, activity: {}, pending: {}, details: {}, happy: {}, drafts: {}, attachments: {}, replyingTo: {},
    reactionsMissing: false, error: null, errorBotId: null, busy: false, newBotOpen: false, newBotDraft: EMPTY_NEW_BOT, aboutOpen: false, dialog: null,

    activate(profileId) {
      if (get().profileId === profileId) return
      epoch += 1
      refreshOperation = undefined
      failedSends.clear()
      olderLoads.clear()
      pendingCreate = undefined
      createOperation = undefined
      created.clear()
      readSeq.clear()
      removed.clear()
      reactions.clear()
      set({ profileId, bots: [], loaded: false, chats: {}, chatLoad: {}, live: {}, activity: {}, pending: {}, details: {}, happy: {}, drafts: {}, attachments: {}, replyingTo: {},
        reactionsMissing: false, error: null, errorBotId: null, busy: false, newBotOpen: false, newBotDraft: EMPTY_NEW_BOT, aboutOpen: false, dialog: null })
      subscribe()
    },

    async refresh() {
      if (refreshOperation) return refreshOperation
      const owner = epoch
      const operation = (async () => {
        try {
          const list = withCreated((await bots().list()).filter((bot) => !removed.has(bot.id)))
          if (owner !== epoch) return
          set((state) => {
            // A list that brought nothing new keeps the bots held, so the open chat does not render again.
            const bots = keepEqualById(state.bots, list)
            // A live chip lasts while its bot works.
            const working = Object.entries(state.live).filter(([id]) => list.some((bot) => bot.id === id && bot.state === 'working'))
            const live = working.length === Object.keys(state.live).length ? state.live : Object.fromEntries(working)
            // A chip lasts while its activation (a chat turn or a piece of work) runs.
            const running = new Set(list.flatMap((bot) => [...(bot.chat ? [bot.chat.activationId] : []), ...(bot.work ?? []).map((item) => item.id)]))
            const kept = Object.entries(state.activity).filter(([id]) => running.has(id))
            const activity = kept.length === Object.keys(state.activity).length ? state.activity : Object.fromEntries(kept)
            return { bots, loaded: true, live, activity, ...celebrate(state.bots, bots) }
          })
        } catch {
          // A missed list is listed again by the next event or poll; the open chat keeps what it has.
          if (owner === epoch) set({ loaded: true })
        }
      })()
      refreshOperation = operation
      try { await operation } finally { if (refreshOperation === operation) refreshOperation = undefined }
    },

    async loadChat(botId) {
      const owner = epoch
      // A chat with nothing held yet says it is loading, and that it failed with Retry; one already shown just updates.
      const first = !get().chats[botId]
      if (first) set((state) => ({ chatLoad: { ...state.chatLoad, [botId]: 'loading' } }))
      try {
        const page = await bots().messages(botId, { limit: BOT_CHAT_PAGE })
        if (owner !== epoch) return
        set((state) => {
          if (removed.has(botId)) return {}
          const chatLoad = withoutKey(state.chatLoad, botId)
          // A full page that does not reach what is held leaves a gap (rows were missed): it starts the chat over.
          const first = Math.min(...page.messages.map((message) => message.seq))
          const gap = page.messages.length >= BOT_CHAT_PAGE && !(state.chats[botId]?.messages ?? []).some((message) => message.seq === first)
          const held = (state.chats[botId]?.messages ?? []).filter((message) => !gap || message.seq > first)
          const { [botId]: _old, ...live } = state.live
          return {
            chats: { ...state.chats, [botId]: { messages: upsert(held, page.messages), hasMore: page.messages.length >= BOT_CHAT_PAGE, loadingOlder: false } },
            live: page.live ? { ...live, [botId]: page.live } : live,
            chatLoad
          }
        })
      } catch (cause) {
        if (owner !== epoch) return
        if (get().chats[botId]) fail(owner, cause, botId)
        else set((state) => ({ chatLoad: { ...state.chatLoad, [botId]: 'failed' } }))
      }
    },

    loadOlder(botId) {
      const cache = cacheOf(botId)
      // A page already on its way is the one asked for again: whoever waits on it waits for that page.
      const loading = olderLoads.get(botId)
      if (loading) return loading
      if (!cache.hasMore || cache.loadingOlder || !cache.messages.length) return Promise.resolve()
      const owner = epoch
      set((state) => ({ chats: { ...state.chats, [botId]: { ...cache, loadingOlder: true } } }))
      const operation: Promise<void> = (async () => {
        try {
          const page = await bots().messages(botId, { beforeSeq: cache.messages[0]!.seq, limit: BOT_CHAT_PAGE })
          if (owner !== epoch) return
          set((state) => {
            const current = state.chats[botId] ?? cache
            return { chats: { ...state.chats, [botId]: { messages: upsert(current.messages, page.messages), hasMore: page.messages.length >= BOT_CHAT_PAGE, loadingOlder: false } } }
          })
        } catch (cause) {
          if (owner === epoch) set((state) => ({ error: errorText(cause), errorBotId: botId, chats: { ...state.chats, [botId]: { ...cacheOf(botId), loadingOlder: false } } }))
        } finally {
          if (owner === epoch) olderLoads.delete(botId)
        }
      })()
      olderLoads.set(botId, operation)
      return operation
    },

    async findMessage(botId, messageId) {
      for (;;) {
        const before = cacheOf(botId)
        if (before.messages.some((message) => message.id === messageId)) return true
        if (!before.hasMore || !before.messages.length) return false
        await get().loadOlder(botId)
        // A page that brought nothing older (it failed, or the profile changed) ends the search.
        const after = cacheOf(botId)
        if (!after.messages.length || after.messages[0]!.seq >= before.messages[0]!.seq) return after.messages.some((message) => message.id === messageId)
      }
    },

    markRead(botId) {
      const last = cacheOf(botId).messages.at(-1)
      if (!last || (readSeq.get(botId) ?? 0) >= last.seq) return
      readSeq.set(botId, last.seq)
      set((state) => ({ bots: state.bots.map((bot) => (bot.id === botId && bot.unread ? { ...bot, unread: 0 } : bot)) }))
      void bots().markRead(botId, last.seq).catch(() => readSeq.delete(botId))
    },

    setDraft(botId, text) { set((state) => ({ drafts: { ...state.drafts, [botId]: text } })) },
    setAttachments(botId, attachments) { set((state) => ({ attachments: { ...state.attachments, [botId]: attachments } })) },
    setReplyingTo(botId, quote) {
      set((state) => {
        const replyingTo = { ...state.replyingTo }
        if (quote) replyingTo[botId] = quote
        else delete replyingTo[botId]
        return { replyingTo }
      })
    },

    async send(botId) {
      const text = (get().drafts[botId] ?? '').trim()
      const attachments = get().attachments[botId] ?? []
      const replyTo = get().replyingTo[botId]
      if (!text && !attachments.length) return
      const refusal = attachmentsRefusal(attachments)
      if (refusal) {
        set({ error: refusal, errorBotId: botId })
        return
      }
      const owner = epoch
      // The same words sent again after a failure reuse their request id, so they are not sent twice. Words sent
      // again while the first are still on their way are a second message, with their own id.
      const previous = failedSends.get(botId)
      const admission = previous?.text === text ? previous : { text, clientRequestId: crypto.randomUUID() }
      failedSends.delete(botId)
      const shown: BotChatMessage = {
        seq: Number.MAX_SAFE_INTEGER, id: pendingId(admission.clientRequestId), at: new Date().toISOString(), author: 'owner', kind: 'text',
        text, chips: [], ...(attachments.length ? { attachments: attachments.map((attached) => ({ name: attached.file.name, path: '' })) } : {}),
        ...(replyTo ? { replyTo } : {})
      }
      set((state) => ({
        error: null,
        drafts: { ...state.drafts, [botId]: '' },
        attachments: { ...state.attachments, [botId]: [] },
        replyingTo: withoutKey(state.replyingTo, botId),
        pending: { ...state.pending, [botId]: [...(state.pending[botId] ?? []), shown] }
      }))
      try {
        const files = await Promise.all(attachments.map(attachmentOf))
        const message = await bots().send(botId, text, admission.clientRequestId, files, replyTo?.id)
        for (const attached of attachments) if (attached.previewUrl) URL.revokeObjectURL(attached.previewUrl)
        if (owner !== epoch) return
        set((state) => ({ pending: { ...state.pending, [botId]: (state.pending[botId] ?? []).filter((entry) => entry.id !== shown.id) } }))
        putMessages(botId, [message])
      } catch (cause) {
        if (owner !== epoch) return
        // Nothing was sent: the words and files go back into the composer.
        failedSends.set(botId, admission)
        set((state) => ({
          error: errorText(cause),
          errorBotId: botId,
          drafts: { ...state.drafts, [botId]: state.drafts[botId] || text },
          attachments: { ...state.attachments, [botId]: state.attachments[botId]?.length ? state.attachments[botId]! : attachments },
          replyingTo: replyTo && !state.replyingTo[botId] ? { ...state.replyingTo, [botId]: replyTo } : state.replyingTo,
          pending: { ...state.pending, [botId]: (state.pending[botId] ?? []).filter((entry) => entry.id !== shown.id) }
        }))
      }
    },

    async stop(botId) {
      const owner = epoch
      try { await bots().stop(botId); if (owner === epoch) void get().refresh() } catch (cause) { fail(owner, cause, botId) }
    },

    async stopWork(botId, workId) {
      const owner = epoch
      try { await bots().stopWork(botId, workId); if (owner === epoch) void get().refresh() } catch (cause) { fail(owner, cause, botId) }
    },

    async answer(botId, askId, answer) {
      const owner = epoch
      set({ error: null })
      try {
        const message = await bots().answer(botId, askId, answer)
        if (owner !== epoch) return
        putMessages(botId, [message])
        void get().refresh()
      } catch (cause) { fail(owner, cause, botId) }
    },

    async react(botId, messageId, emoji) {
      const owner = epoch
      const before = get().chats[botId]?.messages.find((message) => message.id === messageId)
      if (!before) return
      const key = `${botId}:${messageId}`
      const pick = ++reactionPicks
      const entry = reactions.get(key) ?? { confirmed: before.reaction, latest: pick }
      entry.latest = pick
      reactions.set(key, entry)
      const shown = (reaction: string | undefined) => {
        const now = get().chats[botId]?.messages.find((message) => message.id === messageId)
        if (!now) return
        const { reaction: _old, ...rest } = now
        putMessages(botId, [reaction === undefined ? rest : { ...rest, reaction }])
      }
      shown(emoji ?? undefined)
      set({ error: null })
      try {
        const message = await bots().react(botId, messageId, emoji)
        if (owner !== epoch) return
        entry.confirmed = message.reaction
        if (entry.latest !== pick) return
        reactions.delete(key)
        putMessages(botId, [message])
      } catch (cause) {
        if (owner !== epoch || entry.latest !== pick) return
        reactions.delete(key)
        shown(entry.confirmed)
        // An older service has no reactions: the bar goes, with nothing to read.
        if (missingMethod(cause)) set({ reactionsMissing: true })
        else fail(owner, cause, botId)
      }
    },

    async exportMemory(botId, askId) {
      const owner = epoch
      set({ error: null })
      try {
        const dir = await window.mousse.dialog.pickFolder({ title: 'Choose a folder for the bot’s memory', buttonLabel: 'Save here' })
        // Cancelled: the card stays open, so the owner can pick again or say Not now.
        if (!dir || owner !== epoch) return
        await bots().exportMemory(botId, dir)
        if (owner !== epoch) return
        const message = await bots().answer(botId, askId, 'allow')
        if (owner === epoch) putMessages(botId, [message])
      } catch (cause) { fail(owner, cause, botId) }
    },

    openNewBot() { set({ newBotOpen: true, error: null, errorBotId: null }) },

    closeNewBot() { set({ newBotOpen: false, error: null }) },

    setNewBotDraft(change) { set((state) => ({ newBotDraft: { ...state.newBotDraft, ...change, touched: true } })) },

    seedNewBotRows(last, offered) {
      set((state) => {
        const rows = state.newBotDraft.slots ?? last
        const keep = (pick: BotModelPick | null | undefined) => (pick && offered(pick) ? pick : null)
        return { newBotDraft: { ...state.newBotDraft, slots: { talk: keep(rows?.talk), light: keep(rows?.light), medium: keep(rows?.medium), hard: keep(rows?.hard) } } }
      })
    },

    setNewBotStep(step) { set((state) => ({ error: state.errorBotId === null ? null : state.error, newBotDraft: { ...state.newBotDraft, step } })) },

    create(input) {
      if (createOperation) return createOperation
      const owner = epoch
      const key = JSON.stringify(input)
      if (pendingCreate?.key !== key) pendingCreate = { key, clientRequestId: crypto.randomUUID() }
      const clientRequestId = pendingCreate.clientRequestId
      set({ busy: true, error: null, errorBotId: null })
      const operation = (async () => {
        try {
          const bot = await bots().create({ ...input, clientRequestId })
          if (owner !== epoch) return null
          pendingCreate = undefined
          created.add(bot.id)
          set((state) => ({ bots: replaceBot(state.bots, bot), busy: false, newBotOpen: false, newBotDraft: EMPTY_NEW_BOT }))
          return bot
        } catch (cause) {
          if (owner !== epoch) return null
          set((state) => ({ error: createFailureText(cause), errorBotId: null, busy: false, newBotDraft: { ...state.newBotDraft, step: newBotStepForFailure(cause, state.newBotDraft.step) } }))
          // An answer that never came may still have made the bot: the list shows it if so.
          void get().refresh()
          return null
        }
      })()
      createOperation = operation
      void operation.finally(() => { if (createOperation === operation) createOperation = undefined })
      return operation
    },

    async update(botId, change) {
      const owner = epoch
      set({ busy: true, error: null })
      try {
        const bot = await bots().update(botId, change)
        if (owner !== epoch) return false
        putBot(bot)
        set({ busy: false })
        return true
      } catch (cause) { fail(owner, cause, botId); return false }
    },

    async pause(botId) {
      const owner = epoch
      try { const bot = await bots().pause(botId); if (owner === epoch) putBot(bot) } catch (cause) { fail(owner, cause, botId) }
    },

    async resume(botId) {
      const owner = epoch
      try { const bot = await bots().resume(botId); if (owner === epoch) putBot(bot) } catch (cause) { fail(owner, cause, botId) }
    },

    async remove(botId) {
      const owner = epoch
      set({ busy: true, error: null })
      try {
        await bots().remove(botId)
        if (owner !== epoch) return false
        removed.add(botId)
        set((state) => {
          const { [botId]: _chat, ...chats } = state.chats
          const { [botId]: _detail, ...details } = state.details
          const { [botId]: _live, ...live } = state.live
          const { [botId]: _pending, ...pending } = state.pending
          return { bots: state.bots.filter((bot) => bot.id !== botId), chats, details, live, pending, busy: false, dialog: null, aboutOpen: false }
        })
        return true
      } catch (cause) { fail(owner, cause, botId); return false }
    },

    async loadDetail(botId) {
      const owner = epoch
      try {
        const detail = await bots().get(botId)
        if (owner === epoch && !removed.has(botId)) set((state) => ({ details: { ...state.details, [botId]: detail }, bots: replaceBot(state.bots, detail.summary) }))
      } catch (cause) { fail(owner, cause, botId) }
    },

    async revokePermission(botId, permissionId) {
      const owner = epoch
      try {
        const detail = await bots().revokePermission(botId, permissionId)
        if (owner === epoch) set((state) => ({ details: { ...state.details, [botId]: detail } }))
      } catch (cause) { fail(owner, cause, botId) }
    },

    async removeSchedule(botId, scheduleId) {
      const owner = epoch
      try {
        const detail = await bots().removeSchedule(botId, scheduleId)
        if (owner === epoch) set((state) => ({ details: { ...state.details, [botId]: detail } }))
      } catch (cause) { fail(owner, cause, botId) }
    },

    async cancelReminder(botId, reminderId) {
      const owner = epoch
      try {
        const detail = await bots().cancelReminder(botId, reminderId)
        if (owner === epoch) set((state) => ({ details: { ...state.details, [botId]: detail } }))
      } catch (cause) { fail(owner, cause, botId) }
    }
  }
})

/** Failures whose words come from the service and are meant for the owner as they are. */
const PLAIN_CREATE_FAILURES = new Set(['invalid_params', 'bot_invalid', 'bots_unavailable', 'model_unavailable'])

/**
 * What New bot says when Create bot fails. No answer, a lost connection or an unexpected error all
 * mean the same to the owner: try again, which reuses the request and never makes the bot twice.
 */
export function createFailureText(cause: unknown): string {
  const code = cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code: unknown }).code) : ''
  const text = errorText(cause)
  if (PLAIN_CREATE_FAILURES.has(code) && text) return text
  return 'Mousse couldn’t finish making the bot. What you wrote is kept: press Create bot to try again. It won’t make the same bot twice.'
}

let pollers = 0
let pollTimer: ReturnType<typeof setInterval> | undefined

/** A poll tick: a hidden window (minimised) lists nothing, and lists again as soon as it shows. */
function pollVisible(): void {
  if (document.visibilityState !== 'hidden') void useBotsStore.getState().refresh()
}

/**
 * Lists the bots now and every 30 seconds while a view that shows them is mounted: the Chats tab's
 * sidebar and the chat pane. The sidebar can be shown without the pane (after a restart the pane
 * opens on Projects), so each lists them; they share one timer. A hidden window skips the ticks.
 */
export function useBotsPolling(): void {
  const profileId = useBotsStore((s) => s.profileId)
  useEffect(() => {
    void useBotsStore.getState().refresh()
    pollers += 1
    if (pollTimer === undefined) {
      pollTimer = setInterval(pollVisible, POLL_MS)
      document.addEventListener('visibilitychange', pollVisible)
    }
    return () => {
      pollers -= 1
      if (pollers === 0 && pollTimer !== undefined) {
        clearInterval(pollTimer)
        pollTimer = undefined
        document.removeEventListener('visibilitychange', pollVisible)
      }
    }
  }, [profileId])
}

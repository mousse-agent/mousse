import { useEffect } from 'react'
import { create } from 'zustand'
import type { BotChatMessage, BotChip, BotDetail, BotSummary } from '../../shared/bots/personal/chat'
import type { BotLook } from '../../shared/bots/personal/look'
import type { BotChatAttachment } from '../../shared/bots/personal/methods'
import type { BotFaceState } from '../components/bots/face/BotFace'
import { createPersonalBotsClient, errorText, personalBotsEvents, type PersonalBotsClient } from '../services/personalBotsClient'
import { keepEqualById } from '../lib/keepEqual'

/**
 * The owner's bots in the Chats tab (Bot Phase 1 §5.12): the list, each bot's chat as far as it
 * was read, the live chip of a working bot, owner messages on their way, and About's detail.
 * Pushed by `bots.changed`, `bots.message` and `bots.activity`; while the Chats tab is open,
 * `useBotsPolling` lists them again every 2 seconds while the window shows, in case an event was
 * missed. A list that changed nothing keeps the objects held, so nothing renders again for it.
 */

/** Messages one chat page asks for. */
export const BOT_CHAT_PAGE = 50
/** How long the face plays "done" after a working bot goes idle with a good outcome. */
export const BOT_HAPPY_MS = 2500
const POLL_MS = 2000

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
  /** The owner typed or picked something: a click beside the dialog no longer closes it. */
  touched: boolean
}
const EMPTY_NEW_BOT: NewBotDraft = { look: null, name: '', description: '', touched: false }

interface BotsState {
  profileId: string | null
  bots: BotSummary[]
  loaded: boolean
  chats: Record<string, BotChatCache>
  /** The current step of a working bot. */
  live: Record<string, { activationId: string; chip?: BotChip }>
  /** Owner messages sent and not yet confirmed, shown as sent. */
  pending: Record<string, BotChatMessage[]>
  details: Record<string, BotDetail>
  /** Until when (epoch ms) a bot's face plays "done". */
  happy: Record<string, number>
  drafts: Record<string, string>
  attachments: Record<string, BotChatAttachment[]>
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
  markRead(botId: string): void
  setDraft(botId: string, text: string): void
  setAttachments(botId: string, attachments: BotChatAttachment[]): void
  send(botId: string): Promise<void>
  stop(botId: string): Promise<void>
  answer(botId: string, askId: string, answer: 'allow' | 'not_now'): Promise<void>
  exportMemory(botId: string, askId: string): Promise<void>
  openNewBot(): void
  /** Closes New bot; what was put in stays for the next time it opens. */
  closeNewBot(): void
  setNewBotDraft(change: Partial<Omit<NewBotDraft, 'touched'>>): void
  /** One create at a time: a second call while one is on its way gets the same answer. */
  create(input: { look: BotLook; name?: string; description: string }): Promise<BotSummary | null>
  update(botId: string, change: { name?: string; look?: BotLook }): Promise<boolean>
  pause(botId: string): Promise<void>
  resume(botId: string): Promise<void>
  remove(botId: string): Promise<boolean>
  loadDetail(botId: string): Promise<void>
  revokePermission(botId: string, permissionId: string): Promise<void>
  removeSchedule(botId: string, scheduleId: string): Promise<void>
}

let client: PersonalBotsClient | null = null
/** The client the store talks through; tests pass a fake. */
export function setBotsClient(next: PersonalBotsClient | null): void { client = next }
function bots(): PersonalBotsClient {
  return client ?? (client = createPersonalBotsClient(window.mousse.platformRequest))
}

let epoch = 0
let refreshOperation: Promise<void> | undefined
let unsubscribe: Array<() => void> = []
const pendingSends = new Map<string, { text: string; clientRequestId: string }>()
let pendingCreate: { key: string; clientRequestId: string } | undefined
let createOperation: Promise<BotSummary | null> | undefined
/** Bots made here that no list has carried yet. */
const created = new Set<string>()
const readSeq = new Map<string, number>()
/** Bots deleted in this profile: a list that was on its way when one was deleted never brings it back. */
const removed = new Set<string>()
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
    const owned = incoming.filter((message) => message.author === 'owner').map((message) => message.text)
    const pending = (state.pending[botId] ?? []).filter((message) => !owned.includes(message.text))
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
      }),
      events.onMessage?.((event) => { if (event?.botId && event.message) putMessages(event.botId, [event.message]) }),
      events.onActivity?.((event) => {
        if (!event?.botId) return
        set((state) => ({ live: { ...state.live, [event.botId]: { activationId: event.activationId, ...(event.chip ? { chip: event.chip } : {}) } } }))
      })
    ].filter((stop): stop is () => void => typeof stop === 'function')
  }

  return {
    profileId: null, bots: [], loaded: false, chats: {}, live: {}, pending: {}, details: {}, happy: {}, drafts: {}, attachments: {},
    error: null, errorBotId: null, busy: false, newBotOpen: false, newBotDraft: EMPTY_NEW_BOT, aboutOpen: false, dialog: null,

    activate(profileId) {
      if (get().profileId === profileId) return
      epoch += 1
      refreshOperation = undefined
      pendingSends.clear()
      pendingCreate = undefined
      createOperation = undefined
      created.clear()
      readSeq.clear()
      removed.clear()
      set({ profileId, bots: [], loaded: false, chats: {}, live: {}, pending: {}, details: {}, happy: {}, drafts: {}, attachments: {},
        error: null, errorBotId: null, busy: false, newBotOpen: false, newBotDraft: EMPTY_NEW_BOT, aboutOpen: false, dialog: null })
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
            return { bots, loaded: true, live, ...celebrate(state.bots, bots) }
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
      try {
        const page = await bots().messages(botId, { limit: BOT_CHAT_PAGE })
        if (owner !== epoch) return
        set((state) => {
          if (removed.has(botId)) return {}
          // A full page that does not reach what is held leaves a gap (rows were missed): it starts the chat over.
          const first = Math.min(...page.messages.map((message) => message.seq))
          const gap = page.messages.length >= BOT_CHAT_PAGE && !(state.chats[botId]?.messages ?? []).some((message) => message.seq === first)
          const held = (state.chats[botId]?.messages ?? []).filter((message) => !gap || message.seq > first)
          const { [botId]: _old, ...live } = state.live
          return {
            chats: { ...state.chats, [botId]: { messages: upsert(held, page.messages), hasMore: page.messages.length >= BOT_CHAT_PAGE, loadingOlder: false } },
            live: page.live ? { ...live, [botId]: page.live } : live
          }
        })
      } catch (cause) { fail(owner, cause, botId) }
    },

    async loadOlder(botId) {
      const cache = cacheOf(botId)
      if (!cache.hasMore || cache.loadingOlder || !cache.messages.length) return
      const owner = epoch
      set((state) => ({ chats: { ...state.chats, [botId]: { ...cache, loadingOlder: true } } }))
      try {
        const page = await bots().messages(botId, { beforeSeq: cache.messages[0]!.seq, limit: BOT_CHAT_PAGE })
        if (owner !== epoch) return
        set((state) => {
          const current = state.chats[botId] ?? cache
          return { chats: { ...state.chats, [botId]: { messages: upsert(current.messages, page.messages), hasMore: page.messages.length >= BOT_CHAT_PAGE, loadingOlder: false } } }
        })
      } catch (cause) {
        if (owner === epoch) set((state) => ({ error: errorText(cause), errorBotId: botId, chats: { ...state.chats, [botId]: { ...cacheOf(botId), loadingOlder: false } } }))
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

    async send(botId) {
      const text = (get().drafts[botId] ?? '').trim()
      const attachments = get().attachments[botId] ?? []
      if (!text && !attachments.length) return
      const owner = epoch
      // The same words sent again after a failure reuse their request id, so they are not sent twice.
      const previous = pendingSends.get(botId)
      const admission = previous?.text === text ? previous : { text, clientRequestId: crypto.randomUUID() }
      pendingSends.set(botId, admission)
      const shown: BotChatMessage = {
        seq: Number.MAX_SAFE_INTEGER, id: `pending:${admission.clientRequestId}`, at: new Date().toISOString(), author: 'owner', kind: 'text',
        text, chips: [], ...(attachments.length ? { attachments } : {})
      }
      set((state) => ({
        error: null,
        drafts: { ...state.drafts, [botId]: '' },
        attachments: { ...state.attachments, [botId]: [] },
        pending: { ...state.pending, [botId]: [...(state.pending[botId] ?? []), shown] }
      }))
      try {
        const message = await bots().send(botId, text, admission.clientRequestId, attachments)
        if (owner !== epoch) return
        pendingSends.delete(botId)
        set((state) => ({ pending: { ...state.pending, [botId]: (state.pending[botId] ?? []).filter((entry) => entry.id !== shown.id) } }))
        putMessages(botId, [message])
      } catch (cause) {
        if (owner !== epoch) return
        // Nothing was sent: the words go back into the composer.
        set((state) => ({
          error: errorText(cause),
          errorBotId: botId,
          drafts: { ...state.drafts, [botId]: state.drafts[botId] || text },
          attachments: { ...state.attachments, [botId]: state.attachments[botId]?.length ? state.attachments[botId]! : attachments },
          pending: { ...state.pending, [botId]: (state.pending[botId] ?? []).filter((entry) => entry.id !== shown.id) }
        }))
      }
    },

    async stop(botId) {
      const owner = epoch
      try { await bots().stop(botId); if (owner === epoch) void get().refresh() } catch (cause) { fail(owner, cause, botId) }
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
          set({ error: createFailureText(cause), errorBotId: null, busy: false })
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
    }
  }
})

/** Failures whose words come from the service and are meant for the owner as they are. */
const PLAIN_CREATE_FAILURES = new Set(['invalid_params', 'bot_invalid', 'bots_unavailable'])

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
 * Lists the bots now and every 2 seconds while a view that shows them is mounted: the Chats tab's
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

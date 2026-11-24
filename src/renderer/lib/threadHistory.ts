import { create } from 'zustand'
import { isThreadStarted } from '../../shared/threadTitle'
import type { Thread } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { useBotsStore } from '../stores/botsStore'
import { useChatsStore } from '../stores/chatsStore'
import { activeRailPage, openRailPage } from './railPages'
import { confirmNavigation } from '../services/navigationGuards'
import { selectThread } from './threadActions'

/**
 * The window's thread history, like a browser's: every thread (and Automations or Usage page, bot's chat
 * or Chats conversation) opened in this window, in order, and where in that list the window is. Back and forward walk it; opening
 * another one after going back drops what was ahead. Kept per window and never saved.
 */
export interface ThreadHistory {
  entries: string[]
  index: number
}

/** The most threads the history keeps; the oldest go first. */
export const THREAD_HISTORY_LIMIT = 100

export const EMPTY_THREAD_HISTORY: ThreadHistory = { entries: [], index: -1 }

/** The history after `threadId` was opened. Opening the thread the window is already on changes nothing. */
export function pushVisit(history: ThreadHistory, threadId: string, limit = THREAD_HISTORY_LIMIT): ThreadHistory {
  if (history.entries[history.index] === threadId) return history
  const entries = [...history.entries.slice(0, history.index + 1), threadId]
  const drop = Math.max(0, entries.length - limit)
  return { entries: drop ? entries.slice(drop) : entries, index: entries.length - 1 - drop }
}

/**
 * The index one step back (`-1`) or forward (`1`) that can still be opened, or null. Threads that were
 * deleted, archived or never started since are skipped, and so is the one the window is on.
 */
export function stepTarget(history: ThreadHistory, direction: 1 | -1, canOpen: (threadId: string) => boolean): number | null {
  const current = history.entries[history.index]
  for (let index = history.index + direction; index >= 0 && index < history.entries.length; index += direction) {
    const id = history.entries[index]!
    if (id !== current && canOpen(id)) return index
  }
  return null
}

/**
 * The entries behind (`-1`) or ahead of (`1`) the window that can be opened, nearest first, each thread
 * once (its nearest visit).
 */
export function historyList(history: ThreadHistory, direction: 1 | -1, canOpen: (threadId: string) => boolean): { index: number; threadId: string }[] {
  const seen = new Set([history.entries[history.index]])
  const list: { index: number; threadId: string }[] = []
  for (let index = history.index + direction; index >= 0 && index < history.entries.length; index += direction) {
    const id = history.entries[index]!
    if (seen.has(id) || !canOpen(id)) continue
    seen.add(id)
    list.push({ index, threadId: id })
  }
  return list
}

/** Whether a history entry can be opened: the thread is still listed, started, and not archived. */
export function openableThread(thread: Pick<Thread, 'archivedAt' | 'startedAt' | 'name' | 'automationManager'> | undefined): boolean {
  return Boolean(thread && !thread.archivedAt && !thread.automationManager && isThreadStarted(thread))
}

interface ThreadHistoryState extends ThreadHistory {
  /** Records a thread the window opened. */
  visit(threadId: string): void
  /** Forgets everything, as when the window switches profile. */
  reset(): void
}

export const useThreadHistoryStore = create<ThreadHistoryState>((set) => ({
  ...EMPTY_THREAD_HISTORY,
  visit: (threadId) => set((state) => pushVisit(state, threadId)),
  reset: () => set(EMPTY_THREAD_HISTORY)
}))

/** The thread ids the Chats tab owns: they live in Chats, not in the thread history. */
function chatThreadIds(): Set<string> {
  return new Set(useChatsStore.getState().snapshot.chats.flatMap((chat) => (chat.threadId ? [chat.threadId] : [])))
}

/**
 * The pages that open over the workspace and count as places in the history, as entries `page:<name>`.
 * Settings is not one: it has its own Back and makes the rest of the window inert.
 */
export type HistoryPage = 'automations' | 'usage'
const PAGE_ENTRY = 'page:'
export const HISTORY_PAGE_TITLES: Record<HistoryPage, string> = { automations: 'Automations', usage: 'Usage' }

/** The page a history entry stands for, or null for a thread. */
export function historyPage(entry: string): HistoryPage | null {
  if (!entry.startsWith(PAGE_ENTRY)) return null
  const page = entry.slice(PAGE_ENTRY.length)
  return page === 'automations' || page === 'usage' ? page : null
}

/** The history page the window shows, or null while it shows the workspace (or Settings). */
function shownPage(state: Pick<ReturnType<typeof useAppStore.getState>, 'scheduledOpen' | 'usageOpen' | 'settingsOpen'>): HistoryPage | null {
  const page = activeRailPage(state)
  return page === 'automations' || page === 'usage' ? page : null
}

/**
 * A bot's chat or a Chats conversation, as a history entry: `bot:<id>` or `chat:<id>`. A Chats
 * conversation's own thread is never an entry; its `chat:` entry stands for it.
 */
export type ChatsPlace = { kind: 'bot' | 'chat'; id: string }
const BOT_ENTRY = 'bot:'
const CHAT_ENTRY = 'chat:'

/** The bot's chat or Chats conversation a history entry stands for, or null. */
export function chatsPlace(entry: string): ChatsPlace | null {
  if (entry.startsWith(BOT_ENTRY)) return { kind: 'bot', id: entry.slice(BOT_ENTRY.length) }
  if (entry.startsWith(CHAT_ENTRY)) return { kind: 'chat', id: entry.slice(CHAT_ENTRY.length) }
  return null
}

type AppState = ReturnType<typeof useAppStore.getState>
type ChatsState = ReturnType<typeof useChatsStore.getState>

/** The entry for what the Chats workspace shows, or null while the window shows something else (or nothing there). */
function shownChatsEntry(
  app: Pick<AppState, 'sidebarMode' | 'scheduledOpen' | 'usageOpen' | 'settingsOpen'>,
  chats: Pick<ChatsState, 'activeBotId' | 'activeChatId'>
): string | null {
  if (app.sidebarMode !== 'chats' || shownPage(app)) return null
  if (chats.activeBotId) return BOT_ENTRY + chats.activeBotId
  if (chats.activeChatId) return CHAT_ENTRY + chats.activeChatId
  return null
}

/** The name a bot's chat or Chats conversation shows in the history list, or undefined for other entries. */
export function chatsPlaceTitle(entry: string): string | undefined {
  const place = chatsPlace(entry)
  if (!place) return undefined
  const name = place.kind === 'bot'
    ? useBotsStore.getState().bots.find((bot) => bot.id === place.id)?.name
    : useChatsStore.getState().snapshot.chats.find((chat) => chat.id === place.id)?.name
  return name?.trim() || (place.kind === 'bot' ? 'Bot' : 'Chat')
}

/** `openableThread` against the current store; a page can always be opened again, a bot or chat while it is listed. */
export function canOpenFromHistory(entry: string): boolean {
  if (historyPage(entry)) return true
  const place = chatsPlace(entry)
  if (place?.kind === 'bot') return useBotsStore.getState().bots.some((bot) => bot.id === place.id)
  if (place?.kind === 'chat') return useChatsStore.getState().snapshot.chats.some((chat) => chat.id === place.id)
  if (chatThreadIds().has(entry)) return false
  return openableThread(useAppStore.getState().threads.find((thread) => thread.id === entry))
}

/** Opens a bot's chat or Chats conversation, closing a page that covers the workspace once it has opened. */
async function openChatsPlace(place: ChatsPlace): Promise<void> {
  const chats = useChatsStore.getState()
  // openBot/openChat skip their guard for the place already selected; a page about to be closed still needs it.
  const selected = place.kind === 'bot' ? chats.activeBotId === place.id : chats.activeChatId === place.id
  if (selected && shownPage(useAppStore.getState()) && !await confirmNavigation()) return
  if (place.kind === 'bot') await chats.openBot(place.id)
  else await chats.openChat(place.id)
  const now = useChatsStore.getState()
  if ((place.kind === 'bot' ? now.activeBotId : now.activeChatId) !== place.id) return
  const app = useAppStore.getState()
  app.setScheduledOpen(false)
  app.setUsageOpen(false)
}

/** The entry `goToHistoryIndex` is opening, while it does. */
let steppingTo: string | null = null

/** Opens the history entry at `index`. When the switch is refused (unsaved changes kept), the window stays where it was. */
export async function goToHistoryIndex(index: number): Promise<void> {
  const store = useThreadHistoryStore.getState()
  const entry = store.entries[index]
  if (entry === undefined || index === store.index) return
  const from = store.index
  const page = historyPage(entry)
  const place = chatsPlace(entry)
  // Moved first, so the switch below is read as a step through the history, not a new visit.
  useThreadHistoryStore.setState({ index })
  const outer = steppingTo
  steppingTo = entry
  try {
    if (page) await openRailPage(page)
    else if (place) await openChatsPlace(place)
    else await selectThread(entry)
  } finally {
    steppingTo = outer
    const state = useAppStore.getState()
    const arrived = page ? shownPage(state) === page
      : place ? shownChatsEntry(state, useChatsStore.getState()) === entry
      : state.activeThreadId === entry && shownPage(state) === null && state.sidebarMode === 'projects'
    if (!arrived && useThreadHistoryStore.getState().index === index) useThreadHistoryStore.setState({ index: from })
  }
}

/** One step back (`-1`) or forward (`1`). Nothing happens at either end. */
export function stepHistory(direction: 1 | -1): Promise<void> {
  const target = stepTarget(useThreadHistoryStore.getState(), direction, canOpenFromHistory)
  return target === null ? Promise.resolve() : goToHistoryIndex(target)
}

/**
 * Keeps the history in step with the window: every thread it opens is a visit, except a Chats
 * conversation's own thread, and so are Automations, Usage, a bot's chat and a Chats conversation.
 * Leaving one of those pages, or Chats, for the thread workspace is a visit to the thread it shows,
 * unless another thread is being opened (that one is the visit). A profile switch starts a new history.
 * Returns what stops it.
 */
export function trackThreadHistory(): () => void {
  let stopped = false
  // While the history steps to an entry, the stale chat that Chats still holds is not a visit (it would cut off what is ahead).
  const visit = (entry: string) => {
    if (steppingTo !== null && entry !== steppingTo) return
    useThreadHistoryStore.getState().visit(entry)
  }
  const record = (threadId: string | null) => {
    if (!threadId || chatThreadIds().has(threadId)) return
    visit(threadId)
  }
  const initial = useAppStore.getState()
  const initialPage = shownPage(initial)
  const initialChats = shownChatsEntry(initial, useChatsStore.getState())
  if (initialPage) visit(PAGE_ENTRY + initialPage)
  else if (initialChats) visit(initialChats)
  else if (initial.sidebarMode === 'projects') record(initial.activeThreadId)
  const unsubscribeApp = useAppStore.subscribe((state, previous) => {
    if (state.profileId !== previous.profileId) useThreadHistoryStore.getState().reset()
    const page = shownPage(state)
    const before = shownPage(previous)
    const chats = useChatsStore.getState()
    const chatsEntry = shownChatsEntry(state, chats)
    const leftChats = state.sidebarMode === 'projects' && previous.sidebarMode === 'chats'
    if (page && page !== before) visit(PAGE_ENTRY + page)
    else if (chatsEntry && chatsEntry !== shownChatsEntry(previous, chats)) visit(chatsEntry)
    // Back to the thread workspace: once the thread being opened, if any, has been switched to in the same task.
    else if (!page && (before || leftChats)) {
      queueMicrotask(() => {
        const now = useAppStore.getState()
        if (!stopped && !shownPage(now) && now.sidebarMode === 'projects' && !now.openingThreadId) record(now.activeThreadId)
      })
    }
    // A thread switched to behind Chats (the main process's echo) is not on screen, so not a visit.
    if (!page && state.sidebarMode === 'projects' && state.activeThreadId !== previous.activeThreadId) record(state.activeThreadId)
  })
  const unsubscribeChats = useChatsStore.subscribe((state, previous) => {
    const app = useAppStore.getState()
    const entry = shownChatsEntry(app, state)
    if (entry && entry !== shownChatsEntry(app, previous)) visit(entry)
  })
  return () => {
    stopped = true
    unsubscribeApp()
    unsubscribeChats()
  }
}

/** The mouse's back and forward buttons, as `MouseEvent.button` reports them. */
export const MOUSE_BACK_BUTTON = 3
export const MOUSE_FORWARD_BUTTON = 4

/**
 * The history step a mouse button asks for, or null for every other button. The browser panel's page
 * gets its own mouse events, so its buttons keep navigating that page.
 */
export function mouseHistoryDirection(event: Pick<MouseEvent, 'button'>): 1 | -1 | null {
  if (event.button === MOUSE_BACK_BUTTON) return -1
  if (event.button === MOUSE_FORWARD_BUTTON) return 1
  return null
}

/**
 * Listens for the mouse's back and forward buttons on a window-like target. The step runs on release,
 * as in a browser; the press is swallowed so nothing else reads it. Returns what removes the listeners.
 */
export function attachMouseHistory(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  run: (direction: 1 | -1) => void
): () => void {
  const swallow = (event: MouseEvent) => {
    if (mouseHistoryDirection(event) !== null) event.preventDefault()
  }
  const release = (event: MouseEvent) => {
    const direction = mouseHistoryDirection(event)
    if (direction === null) return
    event.preventDefault()
    run(direction)
  }
  target.addEventListener('mousedown', swallow)
  target.addEventListener('auxclick', swallow)
  target.addEventListener('mouseup', release)
  return () => {
    target.removeEventListener('mousedown', swallow)
    target.removeEventListener('auxclick', swallow)
    target.removeEventListener('mouseup', release)
  }
}

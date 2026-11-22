import { confirmNavigation } from '../services/navigationGuards'
import { useAppStore } from '../stores/appStore'
import { useBotsStore } from '../stores/botsStore'
import { useChatsStore } from '../stores/chatsStore'
import { openAndSelect } from './threadActions'

let followingWorkspace = false

/** Leaving Chats (a tab click, a thread opened elsewhere) ends a bot's thread in its pane. */
function followWorkspace(): void {
  if (followingWorkspace) return
  followingWorkspace = true
  useAppStore.subscribe((state, before) => {
    if (state.sidebarMode !== 'chats' && before.sidebarMode === 'chats' && useChatsStore.getState().botThread) useChatsStore.setState({ botThread: null })
  })
}

/**
 * Opens a thread a bot started in that bot's chat pane: the pane shows the thread under the bot's header ("alpha /
 * thread"), the sidebar stays on Chats with the bot chosen, and the window's title bar shows no thread path. The thread
 * is selected as usual, so its composer, run and panels are the thread's own.
 */
export async function openBotThread(botId: string, threadId: string): Promise<void> {
  if (!await confirmNavigation()) return
  followWorkspace()
  const app = useAppStore.getState()
  // A page opened from the rail covers the workspace; the thread has to be visible.
  app.setScheduledOpen(false)
  app.setUsageOpen(false)
  app.setThreadsSidebarView('chats')
  const chats = useChatsStore.getState()
  if (botId !== chats.activeBotId) useBotsStore.setState({ aboutOpen: false, error: null })
  useChatsStore.setState({ activeBotId: botId, openingBotId: null, botThread: { botId, threadId }, activeChatId: null, conversation: null, error: null, errorSource: null, loading: false })
  if (app.activeThreadId === threadId && !app.openingThreadId) return
  // A select that fails is settled by selectOrSettle (the chat stops waiting for its view); a row click has nothing to add.
  await openAndSelect(threadId, { keepWorkspace: true }).catch(() => undefined)
}

/** Back from a bot's thread to the bot's chat, in the same pane. */
export function closeBotThread(): void {
  const open = useChatsStore.getState().botThread
  if (!open) return
  useChatsStore.setState({ botThread: null })
  if (!useBotsStore.getState().chats[open.botId]) void useBotsStore.getState().loadChat(open.botId)
}

/**
 * Show in sidebar, from a bot's thread in its pane: the thread is listed again and the sidebar goes back to the thread
 * list tab used last (Projects or Threads) with the thread chosen, the thread now in the workspace beside it.
 */
export function showBotThreadInSidebar(threadId: string): void {
  const app = useAppStore.getState()
  useChatsStore.setState({ botThread: null })
  app.setThreadsSidebarView(app.lastThreadListView)
  if (app.activeThreadId !== threadId) void openAndSelect(threadId)
}

/**
 * The bot's thread its chat pane shows now: open (`botThread`), its bot chosen, the thread selected and Chats on screen.
 * While the thread is still being opened the pane goes on showing the bot's chat.
 */
export function useShownBotThread(): { botId: string; threadId: string } | null {
  const botThread = useChatsStore((s) => (s.botThread && s.activeBotId === s.botThread.botId ? s.botThread : null))
  const shown = useAppStore((s) => Boolean(botThread) && s.sidebarMode === 'chats' && s.activeThreadId === botThread?.threadId)
  return shown ? botThread : null
}

/** Whether a bot's thread shows in its chat pane right now (the same test as `useShownBotThread`, read once). */
export function botThreadShownNow(): boolean {
  const chats = useChatsStore.getState()
  const app = useAppStore.getState()
  const open = chats.botThread && chats.activeBotId === chats.botThread.botId ? chats.botThread : null
  return Boolean(open) && app.sidebarMode === 'chats' && app.activeThreadId === open?.threadId
}

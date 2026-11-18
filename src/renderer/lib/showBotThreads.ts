import { confirmNavigation } from '../services/navigationGuards'
import { useAppStore } from '../stores/appStore'
import { workspaceModeFor } from '../stores/sidebarTabAgreement'
import { useThreadFilterStore } from '../stores/threadFilterStore'

/**
 * A bot's "See all": the sidebar opens on its Threads tab, filtered to the threads the bot started (hidden ones too).
 * Archived, opened there, keeps the same filter. Leaving the open view asks first, as the tab does.
 */
export async function showBotThreads(botId: string): Promise<boolean> {
  const state = useAppStore.getState()
  if (state.sidebarMode !== workspaceModeFor('threads') && !await confirmNavigation()) return false
  useThreadFilterStore.getState().showBot(botId)
  const app = useAppStore.getState()
  app.setThreadsSidebarView('threads')
  if (!app.threadsSidebarOpen) app.setThreadsSidebarOpen(true)
  return true
}

/** How many threads a bot started that are not archived: the count on its "See all". Subagents are not counted. */
export function botThreadCount(threads: ReadonlyArray<{ startedByBot?: { botId: string }; settledAt?: string; lineage?: unknown }>, botId: string): number {
  let count = 0
  for (const thread of threads) if (thread.startedByBot?.botId === botId && !thread.settledAt && !thread.lineage) count += 1
  return count
}

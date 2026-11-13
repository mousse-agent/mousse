import { confirmNavigation } from '../services/navigationGuards'
import { useAppStore } from '../stores/appStore'
import { openAndSelect } from './threadActions'

/**
 * Opens a thread the way a sidebar click does: leaves any other view, asks to discard unsaved
 * changes, then selects it. Used where a thread is opened from outside the sidebar, such as a
 * subagent row in Lineage or the link back to a subagent's parent.
 */
export async function openThread(threadId: string): Promise<void> {
  if (!await confirmNavigation()) return
  const state = useAppStore.getState()
  state.setSidebarMode('projects')
  if (state.activeThreadId === threadId && !state.openingThreadId) return
  await openAndSelect(threadId)
}

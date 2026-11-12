import { create } from 'zustand'
import { useAppStore } from '../stores/appStore'

/** How long a request to show a project waits for the sidebar to take it; a later sidebar ignores an older one. */
export const SIDEBAR_REVEAL_TIMEOUT_MS = 2_000

export interface ProjectRevealRequest {
  projectId: string
  /** Tells two requests for the same project apart. */
  seq: number
  at: number
}

export const useSidebarRevealStore = create<{ project: ProjectRevealRequest | null }>(() => ({ project: null }))

let seq = 0

/**
 * Shows a project's threads: opens the sidebar on its Projects tab, then the sidebar opens the
 * project's group and scrolls it into view.
 */
export function showProjectInSidebar(projectId: string): void {
  const store = useAppStore.getState()
  if (!store.threadsSidebarOpen) store.setThreadsSidebarOpen(true)
  if (store.threadsSidebarView !== 'projects') store.setThreadsSidebarView('projects')
  useSidebarRevealStore.setState({ project: { projectId, seq: ++seq, at: Date.now() } })
}

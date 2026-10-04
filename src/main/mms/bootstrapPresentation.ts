import type { GuiMmsController } from './GuiMmsController'
import type { PresentationState } from './PresentationState'
import { broadcastThreadSnapshot } from './protocolEventBridge'

/** Hydrate a subscribed window without delaying its first paint. */
export async function bootstrapPresentation(
  guiMms: GuiMmsController,
  presentation: PresentationState,
  broadcast: (channel: string, data: unknown) => void,
  opts?: { onTurnSnapshot?: (snap: unknown) => void; isCurrent?: () => boolean }
): Promise<void> {
  const isCurrent = opts?.isCurrent ?? (() => true)
  const initialActiveId = presentation.getActiveThreadId()
  const [threadsRes, projectsRes] = await Promise.all([
    guiMms.request<{ threads: { id: string; settledAt?: string; name?: string }[] }>('threads.list'),
    guiMms.request<{ projects: unknown[] }>('projects.list')
  ])
  if (!isCurrent()) return
  broadcast('projects:updated', projectsRes.projects)
  broadcast('threads:updated', threadsRes.threads)

  let activeId = presentation.getActiveThreadId()
  const usable = threadsRes.threads.filter((t) => !t.settledAt)
  if (activeId === initialActiveId && activeId && !usable.some((t) => t.id === activeId)) activeId = null
  if (!activeId) {
    if (usable.length > 0) {
      activeId = usable[0].id
    } else {
      const created = await guiMms.request<{ thread: { id: string } }>('threads.create', { name: 'New Chat' })
      if (!isCurrent()) return
      // A manual selection can win while an empty workspace is being created.
      activeId = presentation.getActiveThreadId() ?? created.thread.id
      const refreshed = await guiMms.request<{ threads: unknown[] }>('threads.list')
      if (!isCurrent()) return
      broadcast('threads:updated', refreshed.threads)
      const selectedNow = presentation.getActiveThreadId()
      if (selectedNow && selectedNow !== initialActiveId) activeId = selectedNow
    }
  }
  presentation.setActiveThreadId(activeId)
  // Select before the snapshot: the renderer filters view events by its selection.
  broadcast('thread:selected', { id: activeId })
  const snap = await guiMms.snapshotThread(activeId)
  if (!isCurrent() || presentation.getActiveThreadId() !== activeId) return
  const full = snap as {
    agents?: unknown[]
    tasks?: unknown[]
    pendingQuestions?: Array<{ requestId: string; questions: unknown }>
  }
  opts?.onTurnSnapshot?.(snap)
  broadcastThreadSnapshot(activeId, {
    messages: snap.messages,
    queue: snap.queue,
    connectionFailed: snap.connectionFailed,
    agents: full.agents,
    tasks: full.tasks
  }, broadcast, presentation)
  for (const q of full.pendingQuestions ?? []) {
    broadcast('orchestrator:questionsPending', { ...q, threadId: activeId })
  }
}

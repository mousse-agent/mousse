import type { Thread } from '../../shared/types'
import { visibleThreads } from '../../shared/threadLineage'
import { isQualifiedId } from '../../shared/threadRef'
import { waitsForComputer } from '../../shared/bridge/computerErrors'
import type { GuiMmsController } from './GuiMmsController'
import type { PresentationState } from './PresentationState'
import { broadcastThreadSnapshot, threadListPayload } from './protocolEventBridge'

/** Hydrate a subscribed window without delaying its first paint. */
export async function bootstrapPresentation(
  guiMms: GuiMmsController,
  presentation: PresentationState,
  broadcast: (channel: string, data: unknown) => void,
  opts?: {
    onTurnSnapshot?: (snap: unknown) => void
    isCurrent?: () => boolean
    /** The thread to open when the window has none yet (the one it showed last time), if it is still open. */
    preferThreadId?: string
  }
): Promise<void> {
  const isCurrent = opts?.isCurrent ?? (() => true)
  const initialActiveId = presentation.getActiveThreadId()
  const [threadsRes, projectsRes] = await Promise.all([
    guiMms.request<{ threads: Pick<Thread, 'id' | 'archivedAt' | 'name' | 'lineage'>[] }>('threads.list'),
    guiMms.request<{ projects: unknown[] }>('projects.list')
  ])
  if (!isCurrent()) return
  broadcast('projects:updated', projectsRes.projects)
  broadcast('threads:updated', threadListPayload(threadsRes))

  let activeId = presentation.getActiveThreadId()
  const usable = threadsRes.threads.filter((t) => !t.archivedAt)
  if (activeId === initialActiveId && activeId && !usable.some((t) => t.id === activeId)) activeId = null
  if (!activeId) {
    // Startup never opens a subagent: it sits under its parent, which is what the sidebar lists.
    const selectable = visibleThreads(usable, threadsRes.threads)
    const preferred = opts?.preferThreadId ? selectable.find((t) => t.id === opts.preferThreadId) : undefined
    if (selectable.length > 0) {
      activeId = (preferred ?? selectable[0]).id
    } else {
      const created = await guiMms.request<{ thread: { id: string } }>('threads.create', { name: 'New Chat' })
      if (!isCurrent()) return
      // A manual selection can win while an empty workspace is being created.
      activeId = presentation.getActiveThreadId() ?? created.thread.id
      const refreshed = await guiMms.request<{ threads: unknown[] }>('threads.list')
      if (!isCurrent()) return
      broadcast('threads:updated', threadListPayload(refreshed))
      const selectedNow = presentation.getActiveThreadId()
      if (selectedNow && selectedNow !== initialActiveId) activeId = selectedNow
    }
  }
  presentation.setActiveThreadId(activeId)
  // The daemon keeps a thread the window shows loaded; nothing waits for it. Threads of other computers are focused
  // when they are selected.
  if (!isQualifiedId(activeId)) void guiMms.request('threads.focus', { threadId: activeId, focused: true }).catch(() => undefined)
  // The window opens on this thread, so it is seen: its Done clears.
  void guiMms.request('threads.markSeen', { threadId: activeId }).catch(() => undefined)
  // Select before the snapshot: the renderer filters view events by its selection.
  broadcast('thread:selected', { id: activeId })
  let snap: Awaited<ReturnType<GuiMmsController['snapshotThread']>>
  try {
    snap = await guiMms.snapshotThread(activeId)
  } catch (error) {
    // A thread of another computer that cannot be reached (the one the window showed last, its computer now offline)
    // does not fail the window's load: the window opens, and that thread says it could not be read, with Retry.
    if (!isQualifiedId(activeId) || !waitsForComputer(error)) throw error
    if (isCurrent() && presentation.getActiveThreadId() === activeId) {
      broadcast('thread:view-failed', { threadId: activeId, ...(error instanceof Error && error.message ? { reason: error.message } : {}) })
    }
    return
  }
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
    tasks: full.tasks,
    earlier: snap.earlier
  }, broadcast, presentation)
  for (const q of full.pendingQuestions ?? []) {
    broadcast('orchestrator:questionsPending', { ...q, threadId: activeId })
  }
}

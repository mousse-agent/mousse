import { useEffect, useRef, useCallback, useState, startTransition, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'

import { ChatWorkspace } from './components/chats/ChatWorkspace'
import { NewBotDialogHost } from './components/bots/NewBotDialog'
import { useChatsStore } from './stores/chatsStore'
import { OrchestratorChat } from './components/OrchestratorChat'

import { MainViewTabs } from './components/MainViewTabs'

import { MainViewPanel } from './components/MainViewPanel'
import { KeepMounted } from './components/KeepMounted'

import { ThreadsSidebar } from './components/ThreadsSidebar'
import { SlidingThreadsPane } from './components/SlidingThreadsPane'
import { ScheduledPage } from './components/ScheduledPage'
import { NavigationRail } from './components/NavigationRail'
import { useThreadsPeek } from './hooks/useThreadsPeek'
import { ThreadSideCard } from './components/sideCard/ThreadSideCard'
import { QuickActionEditorHost } from './components/QuickActionEditor'
import { WorkspaceLoading } from './components/WorkspaceLoading'

import { LinuxWindowResizeHandles } from './components/LinuxWindowResizeHandles'
import { TitleBar } from './components/TitleBar'
import { SubscriptionUsagePage } from './components/SubscriptionUsagePage'
import { CommandPalette } from './components/CommandPalette'
import { ToastHost } from './components/ui/Toast'
import { ThreadRenameDialog } from './components/ThreadRenameDialog'
import { showThreadToast, watchOpenedThreadToasts } from './lib/threadToasts'

import { openSurface } from './lib/surfaces'
import { DEFAULT_THREADS_SIDEBAR_WIDTH, resizerKeyTarget } from './lib/resizerKeys'
import { mainAreaStyle, mainAreaWidthAtPointer, mainAreaWidthBounds } from './lib/panelSplit'
import { selectThread } from './lib/threadActions'
import { isSessionClosing } from './lib/errorText'
import { useAppStore } from './stores/appStore'
import { useViewSwap } from './lib/motion'
import { normalizeRunSettings } from '../shared/settings'
import { useAppCommands } from './commands/useAppCommands'
import { useCommandShortcuts } from './commands/useCommandShortcuts'

import './styles/app.css'



const MIN_THREADS_SIDEBAR_WIDTH = 180

const MAX_THREADS_SIDEBAR_WIDTH = 480

const threadsSidebarMaxWidth = (): number =>
  Math.max(MIN_THREADS_SIDEBAR_WIDTH, Math.min(MAX_THREADS_SIDEBAR_WIDTH, window.innerWidth * 0.4))

/**
 * The row the conversation shares with the panel area: their two widths, without the divider between
 * them, and the panel area's right edge. The panel area keeps a width in pixels within this row's
 * bounds (lib/panelSplit).
 */
function conversationRow(sidebar: HTMLElement | null) {
  const main = sidebar?.parentElement?.querySelector<HTMLElement>(':scope > .main-area')
  if (!sidebar || !main) return null
  const { right, width: mainWidth } = main.getBoundingClientRect()
  const width = sidebar.getBoundingClientRect().width + mainWidth
  const workspaceWidth = sidebar.parentElement?.clientWidth ?? 0
  return width > 0 && workspaceWidth > 0 ? { right, width, mainWidth, workspaceWidth } : null
}

// Event delivery is primary. This low-frequency reconciliation covers renderer
// reload/subscription races without repainting when the list is unchanged.
const THREAD_LIST_RECONCILE_MS = 2_000



export default function App() {

  useCommandShortcuts()
  useAppCommands()
  const setShortcuts = useAppStore((s) => s.setShortcuts)
  const usageOpen = useAppStore((s) => s.usageOpen)
  const setUsageOpen = useAppStore((s) => s.setUsageOpen)
  useEffect(() => {
    const openUsage = () => setUsageOpen(true)
    window.addEventListener('mousse:open-usage', openUsage)
    return () => window.removeEventListener('mousse:open-usage', openUsage)
  }, [setUsageOpen])
  const mainAreaWidth = useAppStore((s) => s.mainAreaWidth)
  const profileId = useAppStore((s) => s.profileId)
  const profileReady = useAppStore((s) => s.profileReady)
  const overlayOpen = useAppStore((s) => s.settingsOpen)
  const railPageOpen = useAppStore((s) => s.scheduledOpen || s.usageOpen)
  const workspaceReady = useAppStore((s) => s.workspaceReady)
  const sidebarMode = useAppStore((s) => s.sidebarMode)
  const threadsSidebarView = useAppStore((s) => s.threadsSidebarView)
  // The workspace beside the sidebar swaps with the sidebar's tabs (Projects/Threads or Chats): the old one
  // fades out, inert, then the new one fades in, in step with the sidebar lists (sidebar-view-motion.css).
  const { shown: workspaceMode, phase: workspaceSwap } = useViewSwap(sidebarMode)
  useEffect(() => {
    if (!profileReady) return
    useChatsStore.getState().activate(profileId)
    void useChatsStore.getState().refresh()
    if (sidebarMode !== 'chats' && threadsSidebarView !== 'chats') return
    const timer = setInterval(() => { void useChatsStore.getState().refresh() }, 1000)
    return () => clearInterval(timer)
  }, [profileId, profileReady, sidebarMode, threadsSidebarView])

  const setMainAreaWidth = useAppStore((s) => s.setMainAreaWidth)

  const applyThreadMessages = useAppStore((s) => s.applyThreadMessages)

  const setAgents = useAppStore((s) => s.setAgents)

  const setTasks = useAppStore((s) => s.setTasks)

  const applyThreadView = useAppStore((s) => s.applyThreadView)

  const setAppInfo = useAppStore((s) => s.setAppInfo)

  const addMessage = useAppStore((s) => s.addMessage)
  const updateMessage = useAppStore((s) => s.updateMessage)

  const setMainView = useAppStore((s) => s.setMainView)
  const openDocument = useAppStore((s) => s.openDocument)

  const mainView = useAppStore((s) => s.mainView)

  const mainAreaOpen = useAppStore((s) => s.mainAreaOpen)

  const setMainAreaOpen = useAppStore((s) => s.setMainAreaOpen)

  const threadsSidebarOpen = useAppStore((s) => s.threadsSidebarOpen)

  const threadsSidebarWidth = useAppStore((s) => s.threadsSidebarWidth)

  const setThreadsSidebarWidth = useAppStore((s) => s.setThreadsSidebarWidth)

  const setThreadsSidebarOpen = useAppStore((s) => s.setThreadsSidebarOpen)

  const setProjects = useAppStore((s) => s.setProjects)

  const setThreads = useAppStore((s) => s.setThreads)
  const switchToThread = useAppStore((s) => s.switchToThread)
  const setThreadActivity = useAppStore((s) => s.setThreadActivity)
  const setTurnState = useAppStore((s) => s.setTurnState)
  const setTurnSnapshot = useAppStore((s) => s.setTurnSnapshot)

  const [resizing, setResizing] = useState<'main' | 'threads' | null>(null)
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0)
  const retryBootstrap = useCallback(() => setBootstrapAttempt((attempt) => attempt + 1), [])
  // A rail page that replaces the workspace hides the sidebar, so the peek stands down for it.
  const threadsPeek = useThreadsPeek(!threadsSidebarOpen && !railPageOpen)
  const resizeRef = useRef<{
    kind: 'main' | 'threads' | null
    pointerId: number | null
    clientX: number | null
    frame: number | null
  }>({ kind: null, pointerId: null, clientX: null, frame: null })
  const sidebarRef = useRef<HTMLElement>(null)
  const threadsPaneRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (profileReady) return
    let disposed = false
    setBootstrapError(null)
    // These bootstrap methods establish the exact window's trusted binding.
    // No profile-scoped content request may use the initial placeholder ID.
    void Promise.all([window.mousse.profiles.list(), window.mousse.profiles.status()])
      .then(([listed, status]) => {
        if (disposed) return
        const bound = status.binding?.profileId
        if (!bound || !listed.profiles.some((profile) => profile.id === bound)) {
          throw new Error('Workspace profile binding is unavailable')
        }
        useAppStore.getState().activateProfile(bound)
      }).catch((error: unknown) => {
        if (!disposed && !isSessionClosing(error)) setBootstrapError(error instanceof Error ? error.message : String(error))
      })
    return () => { disposed = true }
  }, [profileReady, bootstrapAttempt])

  useEffect(() => {
    const platform = window.mousse.platform
    const root = document.documentElement
    root.classList.toggle('platform-darwin', platform === 'darwin')
    root.classList.toggle('platform-win32', platform === 'win32')
    if (!profileReady) return
    setBootstrapError(null)
    useAppStore.setState({ workspaceReady: false })

    // Do not let list reconciliation overwrite newer events that arrive while
    // the IPC request is in flight.
    let threadListRevision = 0
    let threadRefreshInFlight = false
    let threadRefreshQueued = false
    let disposed = false
    let hydrationFinished = false
    let hydrationReceived = false
    const isCurrentProfile = (): boolean =>
      !disposed && useAppStore.getState().profileId === profileId
    const applyIfCurrent = <T,>(apply: (value: T) => void) => (value: T): void => {
      if (isCurrentProfile()) apply(value)
    }
    const finishHydration = (): void => {
      if (isCurrentProfile() && hydrationFinished && hydrationReceived) {
        useAppStore.setState({ workspaceReady: true })
      }
    }

    const applyThreadList = (threads: Awaited<ReturnType<typeof window.mousse.threads.listAll>>) => {
      if (!isCurrentProfile()) return
      threadListRevision += 1
      setThreads(threads)
    }

    const refreshThreads = async (): Promise<void> => {
      if (disposed) return
      if (threadRefreshInFlight) {
        threadRefreshQueued = true
        return
      }
      threadRefreshInFlight = true
      const requestedAtRevision = threadListRevision
      try {
        const threads = await window.mousse.threads.listAll()
        // Never let an older list request overwrite a newer live event.
        if (isCurrentProfile() && requestedAtRevision === threadListRevision) {
          setThreads(threads)
        }
      } catch {
        // Reconnect handling will retry; keep the last good sidebar snapshot.
      } finally {
        threadRefreshInFlight = false
        if (threadRefreshQueued && !disposed) {
          threadRefreshQueued = false
          void refreshThreads()
        }
      }
    }
    void window.mousse.app.getInfo().then((info) => {
      if (!isCurrentProfile()) return
      setAppInfo(info)
      const root = document.documentElement
      root.classList.toggle('platform-darwin', info.platform === 'darwin')
      root.classList.toggle('platform-win32', info.platform === 'win32')
    })



    // The bound profile's shortcut overrides and new-chat worktree default; later changes arrive through settings.onChanged below.
    window.mousse.settings.get().then(applyIfCurrent((settings) => {
      setShortcuts(settings.shortcuts ?? {})
      useAppStore.getState().setRunDefaults(normalizeRunSettings(settings.runs))
    })).catch(() => {})
    void window.mousse.threads.getActivity().then(applyIfCurrent(setThreadActivity))
    window.mousse.turn.getSnapshot().then(applyIfCurrent(setTurnSnapshot)).catch(() => {})

    const isSelectedThread = (threadId: string): boolean => {
      if (!isCurrentProfile()) return false
      const active = useAppStore.getState().activeThreadId
      // Unbound / early-boot messages use a sentinel; accept only when no thread is selected.
      if (threadId === '__unbound__') return active == null
      return active === threadId
    }

    const unsubs = [
      window.mousse.orchestrator.onThreadMessage(({ threadId, message }) => {
        if (!isSelectedThread(threadId)) return
        if (message.role === 'user') {
          const cur = useAppStore.getState().messages
          const idx = cur.findIndex((m) => m.id.startsWith('optimistic:') && m.content === message.content)
          if (idx !== -1) {
            const next = cur.filter((m) => !(m.id.startsWith('optimistic:') && m.content === message.content))
            useAppStore.getState().setMessages([...next, message])
            return
          }
        }
        addMessage(message)
      }),
      window.mousse.orchestrator.onThreadMessageUpdated(({ threadId, message }) => {
        if (!isSelectedThread(threadId)) return
        updateMessage(message)
      }),
      // Non-selected or legacy full-sync path (select/resnapshot use thread:view instead).
      window.mousse.orchestrator.onThreadMessages((snapshot) => {
        if (!isCurrentProfile()) return
        // Restore events replace retired rows; hydration snapshots retain a live tail.
        // The store checks selection/profile atomically, including a switch in flight.
        startTransition(() => applyThreadMessages(snapshot, profileId))
        if (isSelectedThread(snapshot.threadId)) {
          hydrationReceived = true
          finishHydration()
        }
      }),
      // Combined select/resnapshot payload: one store update for messages + agents + tasks.
      window.mousse.threads.onView((view) => {
        if (!isSelectedThread(view.threadId)) return
        startTransition(() => applyThreadView(view))
        hydrationReceived = true
        finishHydration()
      }),
      // Live agent/task registry updates for the selected thread (not the select path).
      window.mousse.agents.onUpdated(applyIfCurrent(setAgents)),
      window.mousse.tasks.onUpdated(applyIfCurrent(setTasks)),
      window.mousse.projects.onUpdated(applyIfCurrent(setProjects)),
      window.mousse.threads.onUpdated(applyThreadList),
      // Sidebar already calls switchToThread optimistically; this covers createAndSelect
      // and other main-driven selection without showing the previous transcript.
      window.mousse.threads.onSelected(applyIfCurrent(({ id }) => switchToThread(id))),
      window.mousse.threads.onActivity(applyIfCurrent(setThreadActivity)),
      // Keep the default provider current; subagent rows of threads on the default draw its logo.
      window.mousse.settings.onChanged(applyIfCurrent((settings) => {
        const info = useAppStore.getState().appInfo
        const llmProvider = settings?.provider?.llmProvider ?? ''
        if (info && info.llmProvider !== llmProvider) setAppInfo({ ...info, llmProvider })
        setShortcuts(settings?.shortcuts ?? {})
        useAppStore.getState().setRunDefaults(normalizeRunSettings(settings?.runs))
      })),
      window.mousse.turn.onTurnState(applyIfCurrent(setTurnState)),
      window.mousse.turn.onTurnSnapshot(applyIfCurrent(setTurnSnapshot)),
      window.mousse.app.onNavigateMainView((view) => {
        if (view === 'terminal' || view === 'browser' || view === 'files' || view === 'git' || view === 'review' || view === 'pullRequest') {
          openSurface(view)
          return
        }
        setMainView(view)
        setMainAreaOpen(true)
      }),
      window.mousse.documents.onOpened(({ title, markdown }) => {
        openDocument(title, markdown)
      }),
      // A thread's notification was clicked: open that thread.
      window.mousse.app.onOpenThread(applyIfCurrent((threadId: string) => void selectThread(threadId))),
      // A thread the person is not looking at finished, needs them, or stopped.
      window.mousse.app.onThreadToast(applyIfCurrent(showThreadToast)),
      watchOpenedThreadToasts()
    ]

    // Subscribe before requesting the first selected-thread snapshot. Initial
    // hydration belongs to this bound window, rather than the base client.
    void window.mousse.threads.initialize().then(() => {
      hydrationFinished = true
      finishHydration()
    }).catch((error: unknown) => {
      // A window whose service connection is closing quits or reloads next; it shows nothing.
      if (isCurrentProfile() && !isSessionClosing(error)) setBootstrapError(error instanceof Error ? error.message : String(error))
    })

    const threadSyncTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshThreads()
    }, THREAD_LIST_RECONCILE_MS)
    const onWindowFocus = (): void => {
      void refreshThreads()
    }
    window.addEventListener('focus', onWindowFocus)

    return () => {
      disposed = true
      window.clearInterval(threadSyncTimer)
      window.removeEventListener('focus', onWindowFocus)
      unsubs.forEach((u) => u())
    }
  }, [
    applyThreadMessages,
    setAgents,
    setTasks,
    applyThreadView,
    setAppInfo,
    setShortcuts,
    addMessage,
    updateMessage,
    setProjects,
    setThreads,
    switchToThread,
    setThreadActivity,
    setTurnState,
    setTurnSnapshot,
    setMainView,
    openDocument,
    setMainAreaOpen,
    profileId,
    profileReady,
    bootstrapAttempt
  ])



  const applyResize = useCallback((clientX: number) => {
    const { kind } = resizeRef.current
    if (kind === 'threads') {
      const paneLeft = threadsPaneRef.current?.getBoundingClientRect().left
      if (paneLeft === undefined) return
      setThreadsSidebarWidth(Math.min(threadsSidebarMaxWidth(), Math.max(MIN_THREADS_SIDEBAR_WIDTH, clientX - paneLeft)))
      return
    }
    if (kind === 'main') {
      // The divider stops where the conversation reaches its 280px minimum or its 60% share.
      const row = conversationRow(sidebarRef.current)
      if (row) setMainAreaWidth(mainAreaWidthAtPointer(clientX, row))
    }
  }, [setMainAreaWidth, setThreadsSidebarWidth])

  // Both dividers are keyboard separators: Left/Right move 16px, Home/End go to the bounds.
  const onThreadsResizerKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = resizerKeyTarget(event.key, threadsSidebarWidth, MIN_THREADS_SIDEBAR_WIDTH, threadsSidebarMaxWidth())
    if (next === undefined) return
    event.preventDefault()
    setThreadsSidebarWidth(next)
  }

  const onMainResizerKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Keys move the divider: Right widens the conversation, so it narrows the panel area.
    const row = conversationRow(sidebarRef.current)
    if (!row) return
    const { min, max } = mainAreaWidthBounds(row)
    const conversation = resizerKeyTarget(event.key, row.width - row.mainWidth, row.width - max, row.width - min)
    if (conversation == null) return
    event.preventDefault()
    setMainAreaWidth(row.width - conversation)
  }

  const flushResize = useCallback(() => {
    const { clientX, frame } = resizeRef.current
    if (frame !== null) cancelAnimationFrame(frame)
    resizeRef.current.frame = null
    resizeRef.current.clientX = null
    if (clientX !== null) applyResize(clientX)
  }, [applyResize])

  const queueResize = useCallback((clientX: number) => {
    resizeRef.current.clientX = clientX
    if (resizeRef.current.frame !== null) return
    resizeRef.current.frame = requestAnimationFrame(() => {
      resizeRef.current.frame = null
      const nextX = resizeRef.current.clientX
      resizeRef.current.clientX = null
      if (nextX !== null) applyResize(nextX)
    })
  }, [applyResize])

  const endResize = useCallback((pointerId?: number) => {
    if (!resizeRef.current.kind || (pointerId !== undefined && resizeRef.current.pointerId !== pointerId)) return
    flushResize()
    resizeRef.current.kind = null
    resizeRef.current.pointerId = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    setResizing(null)
  }, [flushResize])

  const startResize = useCallback((kind: 'main' | 'threads', event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    resizeRef.current.kind = kind
    resizeRef.current.pointerId = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    setResizing(kind)
    applyResize(event.clientX)
  }, [applyResize])

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      if (resizeRef.current.pointerId !== event.pointerId) return
      queueResize(event.clientX)
    }
    const onPointerEnd = (event: PointerEvent) => endResize(event.pointerId)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerEnd)
    window.addEventListener('pointercancel', onPointerEnd)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerEnd)
      window.removeEventListener('pointercancel', onPointerEnd)
      endResize()
    }
  }, [endResize, queueResize])



  return (

    <div className="app" data-overlay-active={overlayOpen} inert={overlayOpen} aria-hidden={overlayOpen}>

      <TitleBar />
      <LinuxWindowResizeHandles />

      <div className="app-content">

        {/* The closed sidebar peeks from its edge strip at once, or after a short rest anywhere on the rail. */}
        <NavigationRail key={`${profileId}:${bootstrapAttempt}`}
          onMouseEnter={threadsPeek.enterRail} onMouseLeave={threadsPeek.leaveRail} onPointerDown={threadsPeek.cancelIntent} />

        {profileReady && <ScheduledPage />}
        {profileReady && usageOpen && <div className="usage-rail-page">
          <SubscriptionUsagePage key={profileId} onClose={() => setUsageOpen(false)} />
        </div>}
        <div className="app-workspace" data-workspace-swap={workspaceSwap ?? undefined} style={{ display: railPageOpen ? 'none' : 'flex', flex: 1, minWidth: 0, minHeight: 0 }}>
        {!profileReady && <WorkspaceLoading
          error={bootstrapError}
          onRetry={retryBootstrap}
          sidebarWidth={threadsSidebarOpen ? threadsSidebarWidth : undefined}
        />}

        {/* Profile-scoped panels need the trusted binding before their mount effects run. */}
        {profileReady && <>
          <SlidingThreadsPane
            open={threadsSidebarOpen}
            width={threadsSidebarWidth}
            paneRef={threadsPaneRef}
            resizing={resizing === 'threads'}
            resizer={<div
              className="resizer resizer-threads"
              onPointerDown={(event) => startResize('threads', event)}
              onKeyDown={onThreadsResizerKey}
              onDoubleClick={() => setThreadsSidebarWidth(Math.min(DEFAULT_THREADS_SIDEBAR_WIDTH, threadsSidebarMaxWidth()))}
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label="Resize threads sidebar"
              aria-valuenow={Math.round(threadsSidebarWidth)}
              aria-valuemin={MIN_THREADS_SIDEBAR_WIDTH}
              aria-valuemax={MAX_THREADS_SIDEBAR_WIDTH}
            />}
          >
            <ThreadsSidebar />
          </SlidingThreadsPane>

        {!threadsSidebarOpen && (
          <>
            <div
              className="threads-sidebar-edge-trigger"
              aria-hidden="true"
              onMouseEnter={threadsPeek.show}
            />
              <SlidingThreadsPane
                open={threadsPeek.open}
                width={threadsSidebarWidth}
                overlay
                onMouseEnter={threadsPeek.show}
                onMouseLeave={threadsPeek.scheduleClose}
              >
                <ThreadsSidebar />
              </SlidingThreadsPane>
          </>
        )}



        <aside
          ref={sidebarRef}
          className={`sidebar${!mainAreaOpen ? ' sidebar-full' : ''}`}
          style={workspaceMode === 'chats' ? { display: 'none' } : undefined}
          inert={workspaceSwap === 'out' || undefined}
        >
          <KeepMounted active={!usageOpen} className="keep-mounted-pane">
          {workspaceReady ? <OrchestratorChat key={profileId} /> : <WorkspaceLoading conversationOnly error={bootstrapError} onRetry={retryBootstrap} />}

          </KeepMounted>
          <ThreadSideCard />
          <QuickActionEditorHost />
        </aside>



        {/* The conversation pane is hidden here, so a failed workspace load shows in this pane's place. */}
        {workspaceMode === 'chats' && <KeepMounted active={!usageOpen} leaving={workspaceSwap === 'out'} className="keep-mounted-pane">
          {bootstrapError
            ? <WorkspaceLoading conversationOnly error={bootstrapError} onRetry={retryBootstrap} />
            : <ChatWorkspace key={profileId} />}
        </KeepMounted>}

        {mainAreaOpen && workspaceMode === 'projects' && (
          <div
            className={`resizer ${resizing === 'main' ? 'active' : ''}`}
            inert={workspaceSwap === 'out' || undefined}
            onPointerDown={(event) => startResize('main', event)}
            onKeyDown={onMainResizerKey}
            onDoubleClick={() => setMainAreaWidth(null)}
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label="Resize panels"
            // The panel area's saved width in pixels (null: the default); the layout clamps it to the window.
            aria-valuenow={mainAreaWidth ?? undefined}
          />
        )}

        {/* Keep terminal PTYs and browser guests mounted when the pane is collapsed. */}
        <KeepMounted as="main" active={mainAreaOpen && workspaceMode === 'projects'} leaving={workspaceSwap === 'out'} preserveLayout className="main-area"
          // Beside it: the threads sidebar and its divider when open, and the 1px divider before it.
          style={mainAreaStyle(mainAreaWidth, (threadsSidebarOpen ? threadsSidebarWidth + 1 : 0) + 1)}>
          <MainViewTabs />
          <MainViewPanel />
        </KeepMounted>
        </>}
        </div>

      </div>

      <CommandPalette />
      <ThreadRenameDialog />
      {/* New bot opens from the Chats sidebar, which can show while the pane is on Projects (after a restart). */}
      {profileReady && <NewBotDialogHost />}

      <ToastHost />

    </div>

  )

}

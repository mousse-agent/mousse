import { useEffect, useRef, useCallback, useState, startTransition, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'

import { ChatWorkspace } from './components/chats/ChatWorkspace'
import { useChatsStore } from './stores/chatsStore'
import { OrchestratorChat } from './components/OrchestratorChat'

import { MainViewTabs } from './components/MainViewTabs'

import { MainViewPanel } from './components/MainViewPanel'
import { KeepMounted } from './components/KeepMounted'

import { ThreadsSidebar } from './components/ThreadsSidebar'
import { SlidingThreadsPane } from './components/SlidingThreadsPane'
import { ScheduledPage } from './components/ScheduledPage'
import { NavigationRail } from './components/NavigationRail'
import { ThreadSideCard } from './components/sideCard/ThreadSideCard'
import { QuickActionEditorHost } from './components/QuickActionEditor'
import { WorkspaceLoading } from './components/WorkspaceLoading'

import { LinuxWindowResizeHandles } from './components/LinuxWindowResizeHandles'
import { TitleBar } from './components/TitleBar'
import { SubscriptionUsagePage } from './components/SubscriptionUsagePage'
import { CommandPalette } from './components/CommandPalette'

import { openSurface } from './lib/surfaces'
import { DEFAULT_SIDEBAR_WIDTH, DEFAULT_THREADS_SIDEBAR_WIDTH, resizerKeyTarget } from './lib/resizerKeys'
import { isSessionClosing } from './lib/errorText'
import { useAppStore } from './stores/appStore'
import { normalizeRunSettings } from '../shared/settings'
import { useAppCommands } from './commands/useAppCommands'
import { useCommandShortcuts } from './commands/useCommandShortcuts'

import './styles/app.css'



const MIN_THREADS_SIDEBAR_WIDTH = 180

const MAX_THREADS_SIDEBAR_WIDTH = 480

// Keep in sync with `.sidebar { min-width }` in app.css
const SIDEBAR_MIN_WIDTH_PX = 280

const threadsSidebarMaxWidth = (): number =>
  Math.max(MIN_THREADS_SIDEBAR_WIDTH, Math.min(MAX_THREADS_SIDEBAR_WIDTH, window.innerWidth * 0.4))

/**
 * The conversation pane's left edge, width and bounds in pixels. `.sidebar { width: N% }` resolves
 * against .app-content, so percentages are computed from that same width; deriving it from
 * window.innerWidth minus the threads sidebar makes the pane outrun the cursor. Dragging measures
 * from the pane's own left edge, so the handle tracks the cursor whatever sits to its left. The
 * bounds match the sidebar CSS (min-width: 280px, max-width: 60%).
 */
function conversationPane(container: HTMLElement | null, sidebar: HTMLElement | null) {
  if (!container || !sidebar) return null
  const containerWidth = container.clientWidth
  if (containerWidth <= 0) return null
  const { left, width } = sidebar.getBoundingClientRect()
  const max = containerWidth * 0.6
  return { containerWidth, left, width, max, min: Math.min(SIDEBAR_MIN_WIDTH_PX, max) }
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
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const profileId = useAppStore((s) => s.profileId)
  const profileReady = useAppStore((s) => s.profileReady)
  const overlayOpen = useAppStore((s) => s.settingsOpen)
  const railPageOpen = useAppStore((s) => s.scheduledOpen)
  const workspaceReady = useAppStore((s) => s.workspaceReady)
  const sidebarMode = useAppStore((s) => s.sidebarMode)
  const threadsSidebarView = useAppStore((s) => s.threadsSidebarView)
  useEffect(() => {
    if (!profileReady) return
    useChatsStore.getState().activate(profileId)
    void useChatsStore.getState().refresh()
    if (sidebarMode !== 'chats' && threadsSidebarView !== 'chats') return
    const timer = setInterval(() => { void useChatsStore.getState().refresh() }, 1000)
    return () => clearInterval(timer)
  }, [profileId, profileReady, sidebarMode, threadsSidebarView])

  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)

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
  const [threadsPeek, setThreadsPeek] = useState(false)
  const [threadsPeekClosing, setThreadsPeekClosing] = useState(false)
  const threadsPeekCloseTimer = useRef<number | null>(null)
  const threadsPeekUnmountTimer = useRef<number | null>(null)
  const resizeRef = useRef<{
    kind: 'main' | 'threads' | null
    pointerId: number | null
    clientX: number | null
    frame: number | null
  }>({ kind: null, pointerId: null, clientX: null, frame: null })
  const appContentRef = useRef<HTMLDivElement>(null)
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

  const cancelThreadsPeekClose = () => {
    if (threadsPeekCloseTimer.current !== null) {
      window.clearTimeout(threadsPeekCloseTimer.current)
      threadsPeekCloseTimer.current = null
    }
    if (threadsPeekUnmountTimer.current !== null) {
      window.clearTimeout(threadsPeekUnmountTimer.current)
      threadsPeekUnmountTimer.current = null
    }
  }

  const openThreadsPeek = () => {
    cancelThreadsPeekClose()
    setThreadsPeekClosing(false)
    setThreadsPeek(true)
  }

  const scheduleThreadsPeekClose = () => {
    cancelThreadsPeekClose()
    // Grace period so moving from the edge strip to the panel doesn't flicker,
    // then slide out before unmounting so close animates like open does.
    threadsPeekCloseTimer.current = window.setTimeout(() => {
      threadsPeekCloseTimer.current = null
      setThreadsPeekClosing(true)
      threadsPeekUnmountTimer.current = window.setTimeout(() => {
        threadsPeekUnmountTimer.current = null
        setThreadsPeek(false)
        setThreadsPeekClosing(false)
      }, 200)
    }, 150)
  }

  useEffect(() => {
    if (threadsSidebarOpen) {
      cancelThreadsPeekClose()
      setThreadsPeek(false)
      setThreadsPeekClosing(false)
      return
    }
  }, [threadsSidebarOpen])

  useEffect(() => () => {
    if (threadsPeekCloseTimer.current !== null) window.clearTimeout(threadsPeekCloseTimer.current)
    if (threadsPeekUnmountTimer.current !== null) window.clearTimeout(threadsPeekUnmountTimer.current)
  }, [])

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
      useAppStore.getState().setWorktreeByDefault(normalizeRunSettings(settings.runs).worktreeByDefault)
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
        useAppStore.getState().setWorktreeByDefault(normalizeRunSettings(settings?.runs).worktreeByDefault)
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
      })
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
      const pane = conversationPane(appContentRef.current, sidebarRef.current)
      if (!pane) return
      setSidebarWidth((Math.min(pane.max, Math.max(pane.min, clientX - pane.left)) / pane.containerWidth) * 100)
    }
  }, [setSidebarWidth, setThreadsSidebarWidth])

  // Both dividers are keyboard separators: Left/Right move 16px, Home/End go to the bounds.
  const onThreadsResizerKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = resizerKeyTarget(event.key, threadsSidebarWidth, MIN_THREADS_SIDEBAR_WIDTH, threadsSidebarMaxWidth())
    if (next === undefined) return
    event.preventDefault()
    setThreadsSidebarWidth(next)
  }

  const onMainResizerKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const pane = conversationPane(appContentRef.current, sidebarRef.current)
    const next = pane && resizerKeyTarget(event.key, pane.width, pane.min, pane.max)
    if (!pane || next == null) return
    event.preventDefault()
    setSidebarWidth((next / pane.containerWidth) * 100)
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

      <div className="app-content" ref={appContentRef}>

        <NavigationRail
          key={`${profileId}:${bootstrapAttempt}`}
          onMouseEnter={!threadsSidebarOpen ? openThreadsPeek : undefined}
          onMouseLeave={!threadsSidebarOpen ? scheduleThreadsPeekClose : undefined}
        />

        {profileReady && <ScheduledPage />}
        <div className="app-workspace" style={{ display: railPageOpen ? 'none' : 'flex', flex: 1, minWidth: 0, minHeight: 0 }}>
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
              onMouseEnter={openThreadsPeek}
            />
              <SlidingThreadsPane
                open={threadsPeek && !threadsPeekClosing}
                width={threadsSidebarWidth}
                overlay
                onMouseEnter={openThreadsPeek}
                onMouseLeave={scheduleThreadsPeekClose}
              >
                <ThreadsSidebar />
              </SlidingThreadsPane>
          </>
        )}



        <aside
          ref={sidebarRef}
          className={`sidebar${!mainAreaOpen ? ' sidebar-full' : ''}`}
          style={sidebarMode === 'chats' && !usageOpen ? { display: 'none' } : mainAreaOpen ? { width: `${sidebarWidth}%` } : undefined}
        >
          {usageOpen && <SubscriptionUsagePage key={profileId} onClose={() => setUsageOpen(false)} />}
          <KeepMounted active={!usageOpen} className="keep-mounted-pane">
          {workspaceReady ? <OrchestratorChat key={profileId} /> : <WorkspaceLoading conversationOnly error={bootstrapError} onRetry={retryBootstrap} />}

          </KeepMounted>
          <ThreadSideCard />
          <QuickActionEditorHost />
        </aside>



        {/* The conversation pane is hidden here, so a failed workspace load shows in this pane's place. */}
        {sidebarMode === 'chats' && <KeepMounted active={!usageOpen} className="keep-mounted-pane">
          {bootstrapError
            ? <WorkspaceLoading conversationOnly error={bootstrapError} onRetry={retryBootstrap} />
            : <ChatWorkspace key={profileId} />}
        </KeepMounted>}

        {mainAreaOpen && sidebarMode === 'projects' && (
          <div
            className={`resizer ${resizing === 'main' ? 'active' : ''}`}
            onPointerDown={(event) => startResize('main', event)}
            onKeyDown={onMainResizerKey}
            onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label="Resize panels"
            // The conversation's share of the workspace, in percent; CSS caps it at 60.
            aria-valuenow={Math.round(sidebarWidth)}
            aria-valuemin={0}
            aria-valuemax={60}
          />
        )}

        {/* Keep terminal PTYs and browser guests mounted when the pane is collapsed. */}
        <KeepMounted as="main" active={mainAreaOpen && sidebarMode === 'projects'} preserveLayout className="main-area">
          <MainViewTabs />
          <MainViewPanel />
        </KeepMounted>
        </>}
        </div>

      </div>

      <CommandPalette />

    </div>

  )

}

import { useEffect, useRef, useCallback, useState, startTransition, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'

import { Server, PanelRightClose, PanelRightOpen } from 'lucide-react'

import { ChatWorkspace } from './components/chats/ChatWorkspace'
import { useChatsStore } from './stores/chatsStore'
import { OrchestratorChat } from './components/OrchestratorChat'

import { MainViewTabs } from './components/MainViewTabs'

import { MainViewPanel } from './components/MainViewPanel'
import { KeepMounted } from './components/KeepMounted'

import { ThreadsSidebar } from './components/ThreadsSidebar'
import { NavigationRail } from './components/NavigationRail'

import { LinuxWindowResizeHandles } from './components/LinuxWindowResizeHandles'
import { TitleBar } from './components/TitleBar'

import { IconButton } from './components/IconButton'

import { QuickActionsButton } from './components/QuickActionsButton'

import { useAppStore } from './stores/appStore'

import './styles/app.css'



const MIN_THREADS_SIDEBAR_WIDTH = 180

const MAX_THREADS_SIDEBAR_WIDTH = 480

// Keep in sync with `.sidebar { min-width }` in app.css
const SIDEBAR_MIN_WIDTH_PX = 280

// Event delivery is primary. This low-frequency reconciliation covers renderer
// reload/subscription races without repainting when the list is unchanged.
const THREAD_LIST_RECONCILE_MS = 2_000



export default function App() {

  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const profileId = useAppStore((s) => s.profileId)
  const profileReady = useAppStore((s) => s.profileReady)
  const sidebarMode = useAppStore((s) => s.sidebarMode)
  const threadsSidebarView = useAppStore((s) => s.threadsSidebarView)
  useEffect(() => {
    useChatsStore.getState().activate(profileId)
    void useChatsStore.getState().refresh()
    if (sidebarMode !== 'chats' && threadsSidebarView !== 'chats') return
    const timer = setInterval(() => { void useChatsStore.getState().refresh() }, 1000)
    return () => clearInterval(timer)
  }, [profileId, sidebarMode, threadsSidebarView])

  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)

  const applyThreadMessages = useAppStore((s) => s.applyThreadMessages)

  const setAgents = useAppStore((s) => s.setAgents)

  const setTasks = useAppStore((s) => s.setTasks)

  const applyThreadView = useAppStore((s) => s.applyThreadView)

  const setAppInfo = useAppStore((s) => s.setAppInfo)

  const addMessage = useAppStore((s) => s.addMessage)
  const updateMessage = useAppStore((s) => s.updateMessage)

  const agents = useAppStore((s) => s.agents)

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
  const [threadsPeek, setThreadsPeek] = useState(false)
  const [threadsPeekClosing, setThreadsPeekClosing] = useState(false)
  const [threadsVisible, setThreadsVisible] = useState(threadsSidebarOpen)
  const [threadsClosing, setThreadsClosing] = useState(false)
  const threadsPeekCloseTimer = useRef<number | null>(null)
  const threadsPeekUnmountTimer = useRef<number | null>(null)
  const threadsCloseTimer = useRef<number | null>(null)
  const resizeRef = useRef<{
    kind: 'main' | 'threads' | null
    pointerId: number | null
    clientX: number | null
    frame: number | null
  }>({ kind: null, pointerId: null, clientX: null, frame: null })
  const appContentRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const threadsPaneRef = useRef<HTMLDivElement>(null)
  const agentsTasksToggleRef = useRef<HTMLButtonElement>(null)

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
      if (threadsCloseTimer.current !== null) {
        window.clearTimeout(threadsCloseTimer.current)
        threadsCloseTimer.current = null
      }
      setThreadsVisible(true)
      setThreadsClosing(false)
      setThreadsPeek(false)
      return
    }
    // Keep the docked sidebar mounted for the slide-out before unmounting.
    if (!threadsVisible) return
    setThreadsClosing(true)
    threadsCloseTimer.current = window.setTimeout(() => {
      threadsCloseTimer.current = null
      setThreadsVisible(false)
      setThreadsClosing(false)
    }, 200)
  }, [threadsSidebarOpen, threadsVisible])

  useEffect(() => () => {
    if (threadsPeekCloseTimer.current !== null) window.clearTimeout(threadsPeekCloseTimer.current)
    if (threadsPeekUnmountTimer.current !== null) window.clearTimeout(threadsPeekUnmountTimer.current)
    if (threadsCloseTimer.current !== null) window.clearTimeout(threadsCloseTimer.current)
  }, [])

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (agentsTasksToggleRef.current?.contains(event.target as Node)) return
      void window.mousse.window.closeAgentsTasks()
    }
    window.addEventListener('mousedown', onMouseDown)
    return () => window.removeEventListener('mousedown', onMouseDown)
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
    window.mousse.app.getInfo().then((info) => {
      if (!isCurrentProfile()) return
      setAppInfo(info)
      const root = document.documentElement
      root.classList.toggle('platform-darwin', info.platform === 'darwin')
      root.classList.toggle('platform-win32', info.platform === 'win32')
    })



    window.mousse.threads.getActivity().then(applyIfCurrent(setThreadActivity))
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
      // Channel activity is emitted for Telegram/Discord/webhook messages. Reconcile
      // immediately as an additional guard around channel-session thread creation.
      window.mousse.channels.onActivity(() => void refreshThreads()),
      // Sidebar already calls switchToThread optimistically; this covers createAndSelect
      // and other main-driven selection without showing the previous transcript.
      window.mousse.threads.onSelected(applyIfCurrent(({ id }) => switchToThread(id))),
      window.mousse.threads.onActivity(applyIfCurrent(setThreadActivity)),
      window.mousse.turn.onTurnState(applyIfCurrent(setTurnState)),
      window.mousse.turn.onTurnSnapshot(applyIfCurrent(setTurnSnapshot)),
      window.mousse.app.onNavigateMainView(setMainView),
      window.mousse.documents.onOpened(({ title, markdown }) => {
        openDocument(title, markdown)
      }),
      window.mousse.agents.onActivated(() => {
        setMainView('agents')
        setMainAreaOpen(true)
      })
    ]

    // Subscribe before requesting the first selected-thread snapshot. Initial
    // hydration belongs to this bound window, rather than the base client.
    void window.mousse.threads.initialize().then(() => {
      hydrationFinished = true
      finishHydration()
    }).catch((error: unknown) => {
      if (isCurrentProfile()) setBootstrapError(error instanceof Error ? error.message : String(error))
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
      const maxWidth = Math.min(MAX_THREADS_SIDEBAR_WIDTH, window.innerWidth * 0.4)
      const paneLeft = threadsPaneRef.current?.getBoundingClientRect().left
      if (paneLeft === undefined) return
      setThreadsSidebarWidth(Math.min(maxWidth, Math.max(MIN_THREADS_SIDEBAR_WIDTH, clientX - paneLeft)))
      return
    }
    if (kind === 'main') {
      const container = appContentRef.current
      const sidebar = sidebarRef.current
      if (!container || !sidebar) return
      // `.sidebar { width: N% }` resolves against its containing block (.app-content),
      // so the percentage must be computed from that same width â€” deriving it from
      // window.innerWidth minus the threads sidebar makes the pane outrun the cursor.
      const containerWidth = container.clientWidth
      if (containerWidth <= 0) return
      // Measure from the sidebar's own left edge so the handle tracks the cursor
      // exactly regardless of what sits to its left (threads sidebar, resizers).
      const sidebarLeft = sidebar.getBoundingClientRect().left
      // Clamp in pixels to match the sidebar CSS bounds (min-width: 280px, max-width: 60%).
      const maxPx = containerWidth * 0.6
      const minPx = Math.min(SIDEBAR_MIN_WIDTH_PX, maxPx)
      const clampedPx = Math.min(maxPx, Math.max(minPx, clientX - sidebarLeft))
      setSidebarWidth((clampedPx / containerWidth) * 100)
    }
  }, [setSidebarWidth, setThreadsSidebarWidth])

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



  const openAgentsTasks = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const viewportScreenX = event.screenX - event.clientX
    const viewportScreenY = event.screenY - event.clientY
    const anchor = {
      x: Math.round(rect.left + viewportScreenX),
      y: Math.round(rect.bottom + viewportScreenY)
    }
    void window.mousse.window.openAgentsTasks(anchor)
  }, [])

  const runningCount = agents.filter(

    (a) => ['running', 'starting', 'ready', 'merging', 'conflict'].includes(a.status)

  ).length



  return (

    <div className="app">

      <TitleBar />
      <LinuxWindowResizeHandles />

      {bootstrapError && <div role="alert" style={{ padding: '8px 16px' }}>
        Could not load workspace: {bootstrapError}{' '}
        <button type="button" onClick={() => setBootstrapAttempt((attempt) => attempt + 1)}>Retry</button>
      </div>}

      <div className="app-content" ref={appContentRef}>

        <NavigationRail
          key={profileId}
          onMouseEnter={!threadsSidebarOpen ? openThreadsPeek : undefined}
          onMouseLeave={!threadsSidebarOpen ? scheduleThreadsPeekClose : undefined}
        />

        {threadsVisible && (
          <div className="threads-sidebar-pane" ref={threadsPaneRef}>
            <ThreadsSidebar className={threadsClosing ? 'threads-sidebar-closing' : ''} />
            <div
              className={`resizer resizer-threads${threadsClosing ? ' resizer-threads-closing' : ''}`}
              onPointerDown={(event) => startResize('threads', event)}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize threads sidebar"
            />
          </div>
        )}

        {!threadsSidebarOpen && (
          <>
            <div
              className="threads-sidebar-edge-trigger"
              aria-hidden="true"
              onMouseEnter={openThreadsPeek}
            />
            {threadsPeek && (
              <div
                className={`threads-sidebar-peek${threadsPeekClosing ? ' threads-sidebar-peek-closing' : ''}`}
                onMouseEnter={openThreadsPeek}
                onMouseLeave={scheduleThreadsPeekClose}
              >
                <ThreadsSidebar />
              </div>
            )}
          </>
        )}



        <aside
          ref={sidebarRef}
          className={`sidebar${!mainAreaOpen ? ' sidebar-full' : ''}`}
          style={sidebarMode === 'chats' ? { display: 'none' } : mainAreaOpen ? { width: `${sidebarWidth}%` } : undefined}
        >
          <div className="header">

            <div className="header-actions">

              <QuickActionsButton />

              <IconButton

                ref={agentsTasksToggleRef}

                icon={Server}

                label={`Agents${runningCount > 0 ? ` (${runningCount})` : ''}`}

                onClick={openAgentsTasks}

              />

              <IconButton

                icon={mainAreaOpen ? PanelRightClose : PanelRightOpen}

                label={mainAreaOpen ? 'Hide app panel' : 'Show app panel'}

                className={mainAreaOpen ? 'header-toggle-active' : undefined}

                onClick={() => setMainAreaOpen(!mainAreaOpen)}

              />

            </div>

          </div>

          <OrchestratorChat key={profileId} />

        </aside>



        {sidebarMode === 'chats' && <ChatWorkspace key={profileId} />}

        {mainAreaOpen && sidebarMode === 'projects' && (
          <div
            className={`resizer ${resizing === 'main' ? 'active' : ''}`}
            onPointerDown={(event) => startResize('main', event)}
          />
        )}

        {/* Keep terminal PTYs and browser guests mounted when the pane is collapsed. */}
        <KeepMounted as="main" active={mainAreaOpen && sidebarMode === 'projects'} preserveLayout className="main-area">
          <div className="header">
            <MainViewTabs />
          </div>
          <MainViewPanel />
        </KeepMounted>

      </div>

    </div>

  )

}

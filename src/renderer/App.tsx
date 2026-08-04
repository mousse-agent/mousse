import { useEffect, useRef, useCallback, useState, startTransition, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'

import { Server, PanelRightClose, PanelRightOpen } from 'lucide-react'

import { OrchestratorChat } from './components/OrchestratorChat'

import { MainViewTabs } from './components/MainViewTabs'

import { MainViewPanel } from './components/MainViewPanel'

import { ThreadsSidebar } from './components/ThreadsSidebar'

import { TitleBar } from './components/TitleBar'

import { IconButton } from './components/IconButton'

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

  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)

  const setMessages = useAppStore((s) => s.setMessages)

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
  const setActiveThreadId = useAppStore((s) => s.setActiveThreadId)
  const switchToThread = useAppStore((s) => s.switchToThread)
  const setThreadActivity = useAppStore((s) => s.setThreadActivity)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const activeThreadIdRef = useRef(activeThreadId)
  activeThreadIdRef.current = activeThreadId

  const [resizing, setResizing] = useState<'main' | 'threads' | null>(null)
  const resizeRef = useRef<{
    kind: 'main' | 'threads' | null
    pointerId: number | null
    clientX: number | null
    frame: number | null
  }>({ kind: null, pointerId: null, clientX: null, frame: null })
  const appContentRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const agentsTasksToggleRef = useRef<HTMLButtonElement>(null)

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

    // Do not let the initial snapshot overwrite newer streaming events that arrive while
    // the IPC request is in flight.
    let messageRevision = 0
    let threadListRevision = 0
    let threadRefreshInFlight = false
    let threadRefreshQueued = false
    let disposed = false

    const applyThreadList = (threads: Awaited<ReturnType<typeof window.mousse.threads.listAll>>) => {
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
        if (!disposed && requestedAtRevision === threadListRevision) {
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
    window.mousse.orchestrator.getMessages().then((messages) => {
      if (messageRevision === 0) setMessages(messages)
    })

    window.mousse.agents.list().then(setAgents)

    window.mousse.tasks.list().then(setTasks)

    window.mousse.app.getInfo().then((info) => {
      setAppInfo(info)
      const root = document.documentElement
      root.classList.toggle('platform-darwin', info.platform === 'darwin')
      root.classList.toggle('platform-win32', info.platform === 'win32')
    })



    window.mousse.projects.list().then(setProjects)
    void refreshThreads()
    window.mousse.threads.active().then(setActiveThreadId)
    window.mousse.threads.getActivity().then(setThreadActivity)

    const isSelectedThread = (threadId: string): boolean => {
      const active = activeThreadIdRef.current
      // Unbound / early-boot messages use a sentinel; accept only when no thread is selected.
      if (threadId === '__unbound__') return active == null
      return active === threadId
    }

    const unsubs = [
      // Thread-scoped streams: ignore background threads so they never mutate the selected store.
      window.mousse.orchestrator.onThreadMessage(({ threadId, message }) => {
        if (!isSelectedThread(threadId)) return
        messageRevision += 1
        addMessage(message)
      }),
      window.mousse.orchestrator.onThreadMessageUpdated(({ threadId, message }) => {
        if (!isSelectedThread(threadId)) return
        messageRevision += 1
        updateMessage(message)
      }),
      // Non-selected or legacy full-sync path (select/resnapshot use thread:view instead).
      window.mousse.orchestrator.onThreadMessages(({ threadId, messages }) => {
        if (!isSelectedThread(threadId)) return
        messageRevision += 1
        startTransition(() => setMessages(messages))
      }),
      // Combined select/resnapshot payload: one store update for messages + agents + tasks.
      window.mousse.threads.onView((view) => {
        if (!isSelectedThread(view.threadId)) return
        messageRevision += 1
        startTransition(() => applyThreadView(view))
      }),
      // Live agent/task registry updates for the selected thread (not the select path).
      window.mousse.agents.onUpdated(setAgents),
      window.mousse.tasks.onUpdated(setTasks),
      window.mousse.projects.onUpdated(setProjects),
      window.mousse.threads.onUpdated(applyThreadList),
      // Channel activity is emitted for Telegram/Discord/webhook messages. Reconcile
      // immediately as an additional guard around channel-session thread creation.
      window.mousse.channels.onActivity(() => void refreshThreads()),
      // Sidebar already calls switchToThread optimistically; this covers createAndSelect
      // and other main-driven selection without showing the previous transcript.
      window.mousse.threads.onSelected(({ id }) => switchToThread(id)),
      window.mousse.threads.onActivity(setThreadActivity),
      window.mousse.app.onNavigateMainView(setMainView),
      window.mousse.documents.onOpened(({ title, markdown }) => {
        openDocument(title, markdown)
      }),
      window.mousse.agents.onActivated(() => {
        setMainView('agents')
        setMainAreaOpen(true)
      })
    ]

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
    setMessages,
    setAgents,
    setTasks,
    applyThreadView,
    setAppInfo,
    addMessage,
    updateMessage,
    setProjects,
    setThreads,
    setActiveThreadId,
    switchToThread,
    setThreadActivity,
    setMainView,
    openDocument,
    setMainAreaOpen
  ])



  const applyResize = useCallback((clientX: number) => {
    const { kind } = resizeRef.current
    if (kind === 'threads') {
      const maxWidth = Math.min(MAX_THREADS_SIDEBAR_WIDTH, window.innerWidth * 0.4)
      setThreadsSidebarWidth(Math.min(maxWidth, Math.max(MIN_THREADS_SIDEBAR_WIDTH, clientX)))
      return
    }
    if (kind === 'main') {
      const container = appContentRef.current
      const sidebar = sidebarRef.current
      if (!container || !sidebar) return
      // `.sidebar { width: N% }` resolves against its containing block (.app-content),
      // so the percentage must be computed from that same width — deriving it from
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

      <div className="app-content" ref={appContentRef}>

        {threadsSidebarOpen && (
          <>
            <ThreadsSidebar />
            <div
              className="resizer resizer-threads"
              onPointerDown={(event) => startResize('threads', event)}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize threads sidebar"
            />
          </>
        )}



        <aside
          ref={sidebarRef}
          className={`sidebar${!mainAreaOpen ? ' sidebar-full' : ''}`}
          style={mainAreaOpen ? { width: `${sidebarWidth}%` } : undefined}
        >
          <div className="header">

            <div className="header-title">

              <h1>Main Agent</h1>

            </div>

            <div className="header-actions">

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

          <OrchestratorChat />

        </aside>



        {mainAreaOpen && (
          <div
            className={`resizer ${resizing === 'main' ? 'active' : ''}`}
            onPointerDown={(event) => startResize('main', event)}
          />
        )}

        {/* Keep terminal PTYs and browser guests mounted when the pane is collapsed. */}
        <main className="main-area" style={mainAreaOpen ? undefined : { display: 'none' }}>
          <div className="header">
            <MainViewTabs />
            {mainView === 'agents' && (
              <span className="badge">{runningCount} active</span>
            )}
          </div>
          <MainViewPanel />
        </main>

      </div>

    </div>

  )

}


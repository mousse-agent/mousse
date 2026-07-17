import { useEffect, useRef, useCallback, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'

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



export default function App() {

  const sidebarWidth = useAppStore((s) => s.sidebarWidth)

  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)

  const setMessages = useAppStore((s) => s.setMessages)

  const setAgents = useAppStore((s) => s.setAgents)

  const setTasks = useAppStore((s) => s.setTasks)

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
  const setThreadActivity = useAppStore((s) => s.setThreadActivity)



  const [resizing, setResizing] = useState<'main' | 'threads' | null>(null)
  const resizeRef = useRef<{
    kind: 'main' | 'threads' | null
    pointerId: number | null
    clientX: number | null
    frame: number | null
  }>({ kind: null, pointerId: null, clientX: null, frame: null })
  const layoutRef = useRef({ threadsSidebarOpen, threadsSidebarWidth })
  const agentsTasksToggleRef = useRef<HTMLButtonElement>(null)

  layoutRef.current = { threadsSidebarOpen, threadsSidebarWidth }

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
    window.mousse.threads.listAll().then(setThreads)
    window.mousse.threads.active().then(setActiveThreadId)
    window.mousse.threads.getActivity().then(setThreadActivity)

    const unsubs = [
      window.mousse.orchestrator.onMessage((message) => {
        messageRevision += 1
        addMessage(message)
      }),
      window.mousse.orchestrator.onMessageUpdated((message) => {
        messageRevision += 1
        updateMessage(message)
      }),
      window.mousse.orchestrator.onMessages((messages) => {
        messageRevision += 1
        setMessages(messages)
      }),
      window.mousse.agents.onUpdated(setAgents),
      window.mousse.tasks.onUpdated(setTasks),
      window.mousse.projects.onUpdated(setProjects),
      window.mousse.threads.onUpdated(setThreads),
      window.mousse.threads.onSelected(({ id }) => setActiveThreadId(id)),
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

    return () => unsubs.forEach((u) => u())
  }, [
    setMessages,
    setAgents,
    setTasks,
    setAppInfo,
    addMessage,
    updateMessage,
    setProjects,
    setThreads,
    setActiveThreadId,
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
      const { threadsSidebarOpen, threadsSidebarWidth } = layoutRef.current
      const threadsOffset = threadsSidebarOpen ? threadsSidebarWidth : 0
      const availableWidth = Math.max(1, window.innerWidth - threadsOffset)
      // Clamp in pixels so the handle tracks the cursor exactly and matches
      // the sidebar CSS bounds (min-width: 280px, max-width: 60%).
      const minPx = Math.min(SIDEBAR_MIN_WIDTH_PX, availableWidth * 0.6)
      const maxPx = availableWidth * 0.6
      const desiredPx = clientX - threadsOffset
      const clampedPx = Math.min(maxPx, Math.max(minPx, desiredPx))
      setSidebarWidth((clampedPx / availableWidth) * 100)
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

      <div className="app-content">

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
          <>
            <div

              className={`resizer ${resizing === 'main' ? 'active' : ''}`}

              onPointerDown={(event) => startResize('main', event)}

            />

            <main className="main-area">

              <div className="header">

                <MainViewTabs />

                {mainView === 'agents' && (
                  <span className="badge">{runningCount} active</span>
                )}

              </div>

              <MainViewPanel />

            </main>
          </>
        )}

      </div>

    </div>

  )

}


import { useEffect, useRef, useCallback, type MouseEvent as ReactMouseEvent } from 'react'

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



  const dragging = useRef(false)

  const draggingThreads = useRef(false)
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

    window.mousse.orchestrator.getMessages().then(setMessages)

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
      window.mousse.orchestrator.onMessage(addMessage),
      window.mousse.orchestrator.onMessageUpdated(updateMessage),
      window.mousse.orchestrator.onMessages(setMessages),
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



  const onMouseDown = useCallback(() => {

    dragging.current = true

    document.body.style.cursor = 'col-resize'

    document.body.style.userSelect = 'none'

  }, [])



  const onThreadsResizerMouseDown = useCallback(() => {
    draggingThreads.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])



  useEffect(() => {

    const onMouseMove = (e: MouseEvent) => {

      if (draggingThreads.current) {
        const maxWidth = Math.min(MAX_THREADS_SIDEBAR_WIDTH, window.innerWidth * 0.4)
        setThreadsSidebarWidth(
          Math.min(maxWidth, Math.max(MIN_THREADS_SIDEBAR_WIDTH, e.clientX))
        )
        return
      }

      if (!dragging.current) return

      const threadsOffset = threadsSidebarOpen ? threadsSidebarWidth : 0

      const pct = ((e.clientX - threadsOffset) / (window.innerWidth - threadsOffset)) * 100

      setSidebarWidth(Math.min(60, Math.max(20, pct)))

    }

    const onMouseUp = () => {

      if (draggingThreads.current) {
        draggingThreads.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        return
      }

      if (!dragging.current) return

      dragging.current = false

      document.body.style.cursor = ''

      document.body.style.userSelect = ''

    }

    window.addEventListener('mousemove', onMouseMove)

    window.addEventListener('mouseup', onMouseUp)

    return () => {

      window.removeEventListener('mousemove', onMouseMove)

      window.removeEventListener('mouseup', onMouseUp)

    }

  }, [setSidebarWidth, setThreadsSidebarWidth, threadsSidebarOpen, threadsSidebarWidth])



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

    (a) => a.status === 'running' || a.status === 'starting'

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
              onMouseDown={onThreadsResizerMouseDown}
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

              className={`resizer ${dragging.current ? 'active' : ''}`}

              onMouseDown={onMouseDown}

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



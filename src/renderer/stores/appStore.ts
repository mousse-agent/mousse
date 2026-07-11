import { create } from 'zustand'
import type {
  Agent,
  ChatMessage,
  DocumentTab,
  MainView,
  Project,
  ProjectTerminalTab,
  Task,
  Thread,
  ThreadActivitySnapshot
} from '../../shared/types'
import type { ChatMode } from '../../shared/types'
import { DEFAULT_CHAT_MODE } from '../../shared/types'

interface AppState {
  messages: ChatMessage[]
  agents: Agent[]
  tasks: Task[]
  activePtyId: string | null
  activeAgentId: string | null
  sidebarWidth: number
  threadsSidebarWidth: number
  settingsOpen: boolean
  scheduledOpen: boolean
  channelsOpen: boolean
  loading: boolean
  appInfo: { platform: string; repoRoot: string; llmProvider: string } | null
  threadsSidebarOpen: boolean
  mainAreaOpen: boolean
  activeThreadId: string | null
  projects: Project[]
  threads: Thread[]
  threadActivity: ThreadActivitySnapshot
  mainView: MainView
  projectTerminalTabs: ProjectTerminalTab[]
  activeProjectTerminalTabId: string | null
  documentTabs: DocumentTab[]
  activeDocumentTabId: string | null
  documentsTabVisible: boolean
  chatMode: ChatMode

  setMessages: (messages: ChatMessage[]) => void
  addMessage: (message: ChatMessage) => void
  updateMessage: (message: ChatMessage) => void
  setAgents: (agents: Agent[]) => void
  setTasks: (tasks: Task[]) => void
  setActivePtyId: (ptyId: string | null) => void
  setActiveAgentId: (agentId: string | null) => void
  setSidebarWidth: (width: number) => void
  setThreadsSidebarWidth: (width: number) => void
  setSettingsOpen: (open: boolean) => void
  setScheduledOpen: (open: boolean) => void
  setChannelsOpen: (open: boolean) => void
  setLoading: (loading: boolean) => void
  setAppInfo: (info: AppState['appInfo']) => void
  setThreadsSidebarOpen: (open: boolean) => void
  setMainAreaOpen: (open: boolean) => void
  setActiveThreadId: (id: string | null) => void
  setProjects: (projects: Project[]) => void
  setThreads: (threads: Thread[]) => void
  setThreadActivity: (activity: ThreadActivitySnapshot) => void
  setMainView: (view: MainView) => void
  addProjectTerminalTab: () => string
  closeProjectTerminalTab: (tabId: string) => void
  setActiveProjectTerminalTab: (tabId: string | null) => void
  updateProjectTerminalTab: (
    tabId: string,
    patch: Partial<Pick<ProjectTerminalTab, 'ptyId' | 'exited'>>
  ) => void
  clearProjectTerminalTabs: () => void
  openDocument: (title: string, markdown: string) => string
  closeDocumentTab: (tabId: string) => void
  setActiveDocumentTab: (tabId: string | null) => void
  setChatMode: (mode: ChatMode) => void
}

export const useAppStore = create<AppState>((set) => ({
  messages: [],
  agents: [],
  tasks: [],
  activePtyId: null,
  activeAgentId: null,
  sidebarWidth: 30,
  threadsSidebarWidth: 260,
  settingsOpen: false,
  scheduledOpen: false,
  channelsOpen: false,
  loading: false,
  appInfo: null,
  threadsSidebarOpen: true,
  mainAreaOpen: true,
  activeThreadId: null,
  projects: [],
  threads: [],
  threadActivity: {},
  mainView: 'agents',
  projectTerminalTabs: [],
  activeProjectTerminalTabId: null,
  documentTabs: [],
  activeDocumentTabId: null,
  documentsTabVisible: false,
  chatMode: DEFAULT_CHAT_MODE,

  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
  updateMessage: (message) =>
    set((s) => ({
      messages: s.messages.map((existing) => (existing.id === message.id ? message : existing))
    })),
  setAgents: (agents) => set({ agents }),
  setTasks: (tasks) => set({ tasks }),
  setActivePtyId: (activePtyId) => set({ activePtyId }),
  setActiveAgentId: (activeAgentId) => set({ activeAgentId }),
  setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
  setThreadsSidebarWidth: (threadsSidebarWidth) => set({ threadsSidebarWidth }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setScheduledOpen: (scheduledOpen) => set({ scheduledOpen }),
  setChannelsOpen: (channelsOpen) => set({ channelsOpen }),
  setLoading: (loading) => set({ loading }),
  setAppInfo: (appInfo) => set({ appInfo }),
  setThreadsSidebarOpen: (threadsSidebarOpen) => set({ threadsSidebarOpen }),
  setMainAreaOpen: (mainAreaOpen) => set({ mainAreaOpen }),
  setActiveThreadId: (activeThreadId) => set({ activeThreadId }),
  setProjects: (projects) => set({ projects }),
  setThreads: (threads) => set({ threads }),
  setThreadActivity: (threadActivity) => set({ threadActivity }),
  setMainView: (mainView) => set({ mainView }),
  addProjectTerminalTab: () => {
    const id = crypto.randomUUID()
    set((s) => {
      const title = `Terminal ${s.projectTerminalTabs.length + 1}`
      return {
        projectTerminalTabs: [
          ...s.projectTerminalTabs,
          { id, ptyId: null, title, exited: false }
        ],
        activeProjectTerminalTabId: id
      }
    })
    return id
  },
  closeProjectTerminalTab: (tabId) =>
    set((s) => {
      const index = s.projectTerminalTabs.findIndex((tab) => tab.id === tabId)
      if (index === -1) return s
      const projectTerminalTabs = s.projectTerminalTabs.filter((tab) => tab.id !== tabId)
      let activeProjectTerminalTabId = s.activeProjectTerminalTabId
      if (s.activeProjectTerminalTabId === tabId) {
        activeProjectTerminalTabId =
          projectTerminalTabs[Math.min(index, projectTerminalTabs.length - 1)]?.id ?? null
      }
      return { projectTerminalTabs, activeProjectTerminalTabId }
    }),
  setActiveProjectTerminalTab: (activeProjectTerminalTabId) => set({ activeProjectTerminalTabId }),
  updateProjectTerminalTab: (tabId, patch) =>
    set((s) => ({
      projectTerminalTabs: s.projectTerminalTabs.map((tab) =>
        tab.id === tabId ? { ...tab, ...patch } : tab
      )
    })),
  clearProjectTerminalTabs: () =>
    set({ projectTerminalTabs: [], activeProjectTerminalTabId: null }),
  openDocument: (title, markdown) => {
    const id = crypto.randomUUID()
    set((s) => ({
      documentTabs: [...s.documentTabs, { id, title, markdown }],
      activeDocumentTabId: id,
      documentsTabVisible: true,
      mainView: 'documents'
    }))
    return id
  },
  closeDocumentTab: (tabId) =>
    set((s) => {
      const index = s.documentTabs.findIndex((tab) => tab.id === tabId)
      if (index === -1) return s
      const documentTabs = s.documentTabs.filter((tab) => tab.id !== tabId)
      let activeDocumentTabId = s.activeDocumentTabId
      if (s.activeDocumentTabId === tabId) {
        activeDocumentTabId = documentTabs[Math.min(index, documentTabs.length - 1)]?.id ?? null
      }
      return {
        documentTabs,
        activeDocumentTabId,
        documentsTabVisible: documentTabs.length > 0,
        mainView: documentTabs.length === 0 && s.mainView === 'documents' ? 'agents' : s.mainView
      }
    }),
  setActiveDocumentTab: (activeDocumentTabId) => set({ activeDocumentTabId }),
  setChatMode: (chatMode) => set({ chatMode })
}))

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
  ThreadActivitySnapshot,
  BrowserElementAttachment,
  BrowserTabState
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
  activeProjectTerminalTabByThread: Record<string, string>
  documentTabs: DocumentTab[]
  activeDocumentTabId: string | null
  documentsTabVisible: boolean
  chatMode: ChatMode
  browserTabs: BrowserTabState[]
  browserActiveTabByThread: Record<string, string>
  browserElementAttachmentsByThread: Record<string, BrowserElementAttachment[]>

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
  addProjectTerminalTab: (ownerThreadId: string | null) => string
  closeProjectTerminalTab: (tabId: string) => void
  setActiveProjectTerminalTab: (threadId: string | null, tabId: string) => void
  updateProjectTerminalTab: (
    tabId: string,
    patch: Partial<Pick<ProjectTerminalTab, 'ownerThreadId' | 'ptyId' | 'exited' | 'title'>>
  ) => void
  clearProjectTerminalTabs: () => void
  openDocument: (title: string, markdown: string) => string
  closeDocumentTab: (tabId: string) => void
  setActiveDocumentTab: (tabId: string | null) => void
  setChatMode: (mode: ChatMode) => void
  addBrowserTab: (ownerThreadId: string | null) => string
  /** Create a default tab only when none are visible for this thread (incl. pinned). Idempotent. */
  ensureBrowserTab: (ownerThreadId: string | null) => string
  closeBrowserTab: (id: string) => void
  updateBrowserTab: (id: string, patch: Partial<Omit<BrowserTabState, 'id'>>) => void
  setActiveBrowserTab: (threadId: string | null, id: string) => void
  addBrowserElementAttachment: (threadId: string | null, attachment: BrowserElementAttachment) => void
  removeBrowserElementAttachment: (threadId: string | null, id: string) => void
  clearBrowserElementAttachments: (threadId: string | null) => void
}

/**
 * Message events and message-update events travel over separate IPC channels. Treat both
 * as upserts so a fast stream completion cannot be lost when its initial event is delayed.
 */
export function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((existing) => existing.id === message.id)
  if (index === -1) return [...messages, message]
  // A delayed "message added" event must not roll a completed stream back to its empty
  // streaming placeholder.
  if (!messages[index].streaming && message.streaming) return messages
  return messages.map((existing) => (existing.id === message.id ? message : existing))
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
  activeProjectTerminalTabByThread: {},
  documentTabs: [],
  activeDocumentTabId: null,
  documentsTabVisible: false,
  chatMode: DEFAULT_CHAT_MODE,
  browserTabs: [],
  browserActiveTabByThread: {},
  browserElementAttachmentsByThread: {},

  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((s) => ({ messages: upsertMessage(s.messages, message) })),
  updateMessage: (message) => set((s) => ({ messages: upsertMessage(s.messages, message) })),
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
  addProjectTerminalTab: (ownerThreadId) => {
    const id = crypto.randomUUID()
    const key = ownerThreadId ?? '__standalone__'
    set((s) => {
      const title = `Terminal ${s.projectTerminalTabs.length + 1}`
      return {
        projectTerminalTabs: [
          ...s.projectTerminalTabs,
          { id, ownerThreadId, ptyId: null, title, exited: false }
        ],
        activeProjectTerminalTabByThread: {
          ...s.activeProjectTerminalTabByThread,
          [key]: id
        }
      }
    })
    return id
  },
  closeProjectTerminalTab: (tabId) =>
    set((s) => {
      const projectTerminalTabs = s.projectTerminalTabs.filter((tab) => tab.id !== tabId)
      const activeProjectTerminalTabByThread = { ...s.activeProjectTerminalTabByThread }
      for (const [key, activeId] of Object.entries(activeProjectTerminalTabByThread)) {
        if (activeId !== tabId) continue
        const owner = key === '__standalone__' ? null : key
        activeProjectTerminalTabByThread[key] =
          projectTerminalTabs.find(
            (tab) => tab.ownerThreadId === owner || tab.ownerThreadId === null
          )?.id ?? ''
      }
      return { projectTerminalTabs, activeProjectTerminalTabByThread }
    }),
  setActiveProjectTerminalTab: (threadId, tabId) =>
    set((s) => ({
      activeProjectTerminalTabByThread: {
        ...s.activeProjectTerminalTabByThread,
        [threadId ?? '__standalone__']: tabId
      }
    })),
  updateProjectTerminalTab: (tabId, patch) =>
    set((s) => ({
      projectTerminalTabs: s.projectTerminalTabs.map((tab) =>
        tab.id === tabId ? { ...tab, ...patch } : tab
      )
    })),
  clearProjectTerminalTabs: () =>
    set({ projectTerminalTabs: [], activeProjectTerminalTabByThread: {} }),
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
  setChatMode: (chatMode) => set({ chatMode }),
  addBrowserTab: (ownerThreadId) => {
    const id = crypto.randomUUID()
    const key = ownerThreadId ?? '__standalone__'
    set((s) => ({
      browserTabs: [...s.browserTabs, {
        id,
        ownerThreadId,
        url: 'about:blank',
        title: 'New tab',
        zoomFactor: 1,
        deviceToolbarOpen: false,
        devicePreset: 'responsive'
      }],
      browserActiveTabByThread: { ...s.browserActiveTabByThread, [key]: id }
    }))
    return id
  },
  ensureBrowserTab: (ownerThreadId) => {
    // Atomic check-and-add so React Strict Mode double-effects cannot create two blanks.
    let ensuredId = ''
    set((s) => {
      const existing = s.browserTabs.find(
        (tab) => tab.ownerThreadId === ownerThreadId || tab.ownerThreadId === null
      )
      if (existing) {
        ensuredId = existing.id
        const key = ownerThreadId ?? '__standalone__'
        if (s.browserActiveTabByThread[key] === existing.id) return s
        return {
          browserActiveTabByThread: { ...s.browserActiveTabByThread, [key]: existing.id }
        }
      }
      const id = crypto.randomUUID()
      ensuredId = id
      const key = ownerThreadId ?? '__standalone__'
      return {
        browserTabs: [
          ...s.browserTabs,
          {
            id,
            ownerThreadId,
            url: 'about:blank',
            title: 'New tab',
            zoomFactor: 1,
            deviceToolbarOpen: false,
            devicePreset: 'responsive'
          }
        ],
        browserActiveTabByThread: { ...s.browserActiveTabByThread, [key]: id }
      }
    })
    return ensuredId
  },
  closeBrowserTab: (id) =>
    set((s) => {
      const browserTabs = s.browserTabs.filter((tab) => tab.id !== id)
      const browserActiveTabByThread = { ...s.browserActiveTabByThread }
      for (const [key, activeId] of Object.entries(browserActiveTabByThread)) {
        if (activeId !== id) continue
        const owner = key === '__standalone__' ? null : key
        browserActiveTabByThread[key] =
          browserTabs.find((tab) => tab.ownerThreadId === owner || tab.ownerThreadId === null)?.id ?? ''
      }
      return { browserTabs, browserActiveTabByThread }
    }),
  updateBrowserTab: (id, patch) =>
    set((s) => {
      const index = s.browserTabs.findIndex((tab) => tab.id === id)
      if (index === -1) return s
      const current = s.browserTabs[index]
      const next = { ...current, ...patch }
      const unchanged = (Object.keys(patch) as Array<keyof typeof patch>).every(
        (key) => Object.is(current[key], next[key])
      )
      if (unchanged) return s
      const browserTabs = s.browserTabs.slice()
      browserTabs[index] = next
      return { browserTabs }
    }),
  setActiveBrowserTab: (threadId, id) =>
    set((s) => ({
      browserActiveTabByThread: {
        ...s.browserActiveTabByThread,
        [threadId ?? '__standalone__']: id
      }
    })),
  addBrowserElementAttachment: (threadId, attachment) =>
    set((s) => {
      const key = threadId ?? '__standalone__'
      return {
        browserElementAttachmentsByThread: {
          ...s.browserElementAttachmentsByThread,
          [key]: [...(s.browserElementAttachmentsByThread[key] ?? []), attachment]
        }
      }
    }),
  removeBrowserElementAttachment: (threadId, id) =>
    set((s) => {
      const key = threadId ?? '__standalone__'
      return {
        browserElementAttachmentsByThread: {
          ...s.browserElementAttachmentsByThread,
          [key]: (s.browserElementAttachmentsByThread[key] ?? []).filter((item) => item.id !== id)
        }
      }
    }),
  clearBrowserElementAttachments: (threadId) =>
    set((s) => ({
      browserElementAttachmentsByThread: {
        ...s.browserElementAttachmentsByThread,
        [threadId ?? '__standalone__']: []
      }
    }))
}))

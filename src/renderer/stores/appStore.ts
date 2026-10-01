import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type {
  Agent,
  ChatMessage,
  ThreadMessagesSnapshot,
  DocumentTab,
  MainView,
  Project,
  ProjectTerminalTab,
  Task,
  Thread,
  ThreadActivitySnapshot,
  TurnState,
  TurnStateSnapshot,
  BrowserElementAttachment,
  BrowserTabState
} from '../../shared/types'
import { parseChatReference, type ChatReference } from '../../shared/chatReferences'
import type { ChatMode } from '../../shared/types'
import { DEFAULT_CHAT_MODE } from '../../shared/types'

/** In-memory transcript cache so re-visiting a thread paints instantly (not in Zustand). */
// Each entry is a fully hydrated transcript. Keeping sixteen live-sized threads
// pins large tool payloads and markdown strings in the renderer heap.
const MESSAGE_CACHE_MAX = 3
const messageCache = new Map<string, ChatMessage[]>()
const messageCacheOrder: string[] = []

function rememberMessages(threadId: string, messages: ChatMessage[]): void {
  if (messageCache.has(threadId)) {
    const idx = messageCacheOrder.indexOf(threadId)
    if (idx >= 0) messageCacheOrder.splice(idx, 1)
  }
  messageCache.set(threadId, messages)
  messageCacheOrder.push(threadId)
  while (messageCacheOrder.length > MESSAGE_CACHE_MAX) {
    const evict = messageCacheOrder.shift()
    if (evict) messageCache.delete(evict)
  }
}

function takeCachedMessages(threadId: string): ChatMessage[] | undefined {
  return messageCache.get(threadId)
}

/** Cheap identity check to skip identical snapshot applies after a cache hit. */
export function sameMessageSnapshot(a: ChatMessage[], b: ChatMessage[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]
    const right = b[i]
    if (
      left.id !== right.id ||
      left.content !== right.content ||
      left.streaming !== right.streaming ||
      left.kind !== right.kind
    ) {
      return false
    }
  }
  return true
}

/** Skip sidebar updates when a protocol event/reconciliation returns the same list. */
export function sameThreadSnapshot(a: Thread[], b: Thread[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]
    const right = b[i]
    if (
      left.id !== right.id ||
      left.name !== right.name ||
      left.projectId !== right.projectId ||
      left.updatedAt !== right.updatedAt ||
      left.order !== right.order ||
      left.pinnedAt !== right.pinnedAt ||
      left.settledAt !== right.settledAt ||
      left.startedAt !== right.startedAt ||
      left.worktreeEnabled !== right.worktreeEnabled ||
      left.modelOverride?.llmProvider !== right.modelOverride?.llmProvider ||
      left.modelOverride?.model !== right.modelOverride?.model
    ) {
      return false
    }
  }
  return true
}

export interface ThreadViewSnapshot {
  threadId: string
  messages: ChatMessage[]
  agents?: Agent[]
  tasks?: Task[]
}

interface AppState {
  /** Trusted daemon profile id whose personal renderer state is loaded. */
  profileId: string
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
  /** @deprecated use turnStates[threadId]?.phase instead — kept for compat */
  loading: boolean
  appInfo: { platform: string; repoRoot: string; llmProvider: string; deviceName?: string } | null
  sidebarMode: 'projects' | 'chats'
  setSidebarMode: (sidebarMode: 'projects' | 'chats') => void
  threadsSidebarOpen: boolean
  mainAreaOpen: boolean
  activeThreadId: string | null
  projects: Project[]
  threads: Thread[]
  threadActivity: ThreadActivitySnapshot
  turnStates: TurnStateSnapshot
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
  /** Workspace choices for each new-chat draft, isolated by profile. */
  composerWorkspaceDrafts: Record<string, { projectId?: string; worktreeEnabled: boolean }>
  setComposerWorkspaceDraft: (threadId: string | null, workspace?: { projectId?: string; worktreeEnabled: boolean }) => void
  /** Text drafts keyed by their hidden or started thread id. */
  composerDrafts: Record<string, string>
  /** Durable rich references staged in each composer. */
  composerReferences: Record<string, ChatReference[]>

  setMessages: (messages: ChatMessage[]) => void
  applyThreadMessages: (snapshot: ThreadMessagesSnapshot, profileId: string | null) => void
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
  /**
   * Optimistic thread switch in one store update: highlight immediately and restore a
   * cached transcript when available so the chat does not flash empty on re-visits.
   */
  switchToThread: (id: string) => void
  /** Apply daemon snapshot for the selected thread in a single paint. */
  applyThreadView: (view: ThreadViewSnapshot) => void
  setProjects: (projects: Project[]) => void
  setThreads: (threads: Thread[]) => void
  /** Merge one thread meta into the sidebar list (model/rename/pin without full rescan). */
  upsertThread: (thread: Thread) => void
  setThreadActivity: (activity: ThreadActivitySnapshot) => void
  setTurnState: (state: TurnState) => void
  setTurnSnapshot: (snap: TurnStateSnapshot) => void
  setMainView: (view: MainView) => void
  addProjectTerminalTab: (ownerThreadId: string | null) => string
  closeProjectTerminalTab: (tabId: string) => void
  setActiveProjectTerminalTab: (threadId: string | null, tabId: string) => void
  updateProjectTerminalTab: (
    tabId: string,
    patch: Partial<Pick<ProjectTerminalTab, 'ownerThreadId' | 'ptyId' | 'cwd' | 'exited' | 'title'>>
  ) => void
  openDocument: (title: string, markdown: string) => string
  closeDocumentTab: (tabId: string) => void
  setActiveDocumentTab: (tabId: string | null) => void
  setChatMode: (mode: ChatMode) => void
  activateProfile: (profileId: string) => void
  addBrowserTab: (ownerThreadId: string | null) => string
  /** Create a default tab only when none are visible for this thread (incl. pinned). Idempotent. */
  ensureBrowserTab: (ownerThreadId: string | null) => string
  closeBrowserTab: (id: string) => void
  updateBrowserTab: (id: string, patch: Partial<Omit<BrowserTabState, 'id'>>) => void
  setActiveBrowserTab: (threadId: string | null, id: string) => void
  addBrowserElementAttachment: (threadId: string | null, attachment: BrowserElementAttachment) => void
  removeBrowserElementAttachment: (threadId: string | null, id: string) => void
  clearBrowserElementAttachments: (threadId: string | null) => void
  setComposerDraft: (threadId: string | null, value: string) => void
  clearComposerDraft: (threadId: string | null) => void
  addComposerReference: (threadId: string | null, reference: ChatReference) => void
  removeComposerReference: (threadId: string | null, id: string) => void
  clearComposerReferences: (threadId: string | null) => void
}

/** Stable timestamp ordering — prevents out-of-order delivery when IPC channels race. */
export function sortMessagesDeterministic(messages: ChatMessage[]): ChatMessage[] {
  // Already sorted fast path.
  let sorted = true
  for (let i = 1; i < messages.length; i += 1) {
    if (messages[i - 1].timestamp > messages[i].timestamp) { sorted = false; break }
    if (messages[i - 1].timestamp === messages[i].timestamp && messages[i - 1].id > messages[i].id) { sorted = false; break }
  }
  if (sorted) return messages
  return [...messages].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1
    // Stable tie-break: turnId preserves causality, then lexicographic id.
    if ((a.turnId ?? '') !== (b.turnId ?? '')) return (a.turnId ?? '') < (b.turnId ?? '') ? -1 : 1
    return a.id < b.id ? -1 : 1
  })
}

/** Prefer the message version that cannot regress visible streaming progress. */
function newerMessageVersion(current: ChatMessage, incoming: ChatMessage): ChatMessage {
  // A delayed initial event/snapshot must not roll a completed stream back to its placeholder.
  if (!current.streaming && incoming.streaming) return current
  // While both versions stream, snapshots can lag behind token events. Content is append-only.
  if (
    current.streaming &&
    incoming.streaming &&
    current.content.length > incoming.content.length &&
    current.content.startsWith(incoming.content)
  ) return current
  return incoming
}

/**
 * Message events and message-update events travel over separate IPC channels. Treat both
 * as upserts so a fast stream completion cannot be lost when its initial event is delayed.
 * Result is always deterministically sorted so late-arriving chunks never appear out of order.
 */
export function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((existing) => existing.id === message.id)
  if (index === -1) return sortMessagesDeterministic([...messages, message])
  const replacement = newerMessageVersion(messages[index], message)
  if (replacement === messages[index]) return messages
  const next = messages.map((existing) => (existing.id === message.id ? replacement : existing))
  return sortMessagesDeterministic(next)
}

/**
 * Merge a full/paginated snapshot with live renderer state. Transcripts are append-only during
 * a session, so entries absent from an older snapshot are retained. This is important on long
 * threads where hydration can finish after user and streaming events have already arrived.
 */
export function reconcileMessageSnapshot(
  current: ChatMessage[],
  incoming: ChatMessage[]
): ChatMessage[] {
  if (current.length === 0) return sortMessagesDeterministic(incoming)
  const merged = new Map(current.map((message) => [message.id, message]))
  for (const message of incoming) {
    const existing = merged.get(message.id)
    merged.set(message.id, existing ? newerMessageVersion(existing, message) : message)
  }
  return sortMessagesDeterministic([...merged.values()])
}

const workspaceStorage = createJSONStorage(() =>
  typeof window !== 'undefined'
    ? window.localStorage
    : {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined
      }
)

const personalWorkspaceKeys = [
  'projectTerminalTabs', 'activeProjectTerminalTabByThread', 'browserTabs',
  'browserActiveTabByThread', 'browserElementAttachmentsByThread', 'mainView',
  'sidebarMode', 'sidebarWidth', 'threadsSidebarWidth', 'threadsSidebarOpen', 'mainAreaOpen', 'chatMode',
  'composerDrafts', 'composerReferences', 'composerWorkspaceDrafts'
] as const
let profileActivated = false

function savePersonalWorkspace(state: AppState): void {
  if (typeof window === 'undefined') return
  try {
    const workspace = Object.fromEntries(personalWorkspaceKeys.map((key) => [key, state[key]]))
    window.localStorage.setItem(`mousse-profile-${state.profileId}-workspace`, JSON.stringify(workspace))
  } catch { /* quota/private mode */ }
}

export const useAppStore = create<AppState>()(persist((set) => ({
  profileId: 'default',
  sidebarMode: 'projects',
  setSidebarMode: (sidebarMode) => set({ sidebarMode }),
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
  mainAreaOpen: false,
  activeThreadId: null,
  projects: [],
  threads: [],
  threadActivity: {},
  turnStates: {},
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
  composerWorkspaceDrafts: {},
  composerDrafts: {},
  composerReferences: {},

  setMessages: (messages) =>
    set((s) => {
      const sorted = sortMessagesDeterministic(messages)
      if (s.activeThreadId) rememberMessages(s.activeThreadId, sorted)
      return { messages: sorted }
    }),
  applyThreadMessages: (snapshot, profileId) =>
    set((s) => {
      if (s.profileId !== profileId) return s
      const selected = snapshot.threadId === s.activeThreadId
        || (snapshot.threadId === '__unbound__' && s.activeThreadId === null)
      if (!selected) {
        // A background undo must also retire cached rows before a later selection.
        if (snapshot.replace) rememberMessages(snapshot.threadId, sortMessagesDeterministic(snapshot.messages))
        return s
      }
      const messages = snapshot.replace
        ? sortMessagesDeterministic(snapshot.messages)
        : reconcileMessageSnapshot(s.messages, snapshot.messages)
      if (s.activeThreadId) rememberMessages(s.activeThreadId, messages)
      return { messages }
    }),
  addMessage: (message) =>
    set((s) => {
      const messages = upsertMessage(s.messages, message)
      if (s.activeThreadId) rememberMessages(s.activeThreadId, messages)
      return { messages }
    }),
  updateMessage: (message) =>
    set((s) => {
      const messages = upsertMessage(s.messages, message)
      if (s.activeThreadId) rememberMessages(s.activeThreadId, messages)
      return { messages }
    }),
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
  setTurnState: (state) => set((s) => ({ turnStates: { ...s.turnStates, [state.threadId]: state } })),
  setTurnSnapshot: (snap) => set({ turnStates: snap }),
  setActiveThreadId: (activeThreadId) => set({ activeThreadId }),
  switchToThread: (id) =>
    set((s) => {
      if (s.activeThreadId === id) return { sidebarMode: 'projects' }
      if (s.activeThreadId && s.messages.length > 0) {
        rememberMessages(s.activeThreadId, s.messages)
      }
      const cached = takeCachedMessages(id)
      return {
        sidebarMode: 'projects',
        activeThreadId: id,
        messages: cached ?? [],
        // Agents/tasks are always re-fetched with the snapshot (small, thread-scoped).
        agents: [],
        tasks: [],
        loading: false
      }
    }),
  applyThreadView: (view) =>
    set((s) => {
      if (s.activeThreadId !== view.threadId) return s
      const reconciled = reconcileMessageSnapshot(s.messages, view.messages)
      rememberMessages(view.threadId, reconciled)
      const messagesUnchanged = sameMessageSnapshot(s.messages, reconciled)
      const agents = view.agents ?? s.agents
      const tasks = view.tasks ?? s.tasks
      if (messagesUnchanged && agents === s.agents && tasks === s.tasks) return s
      return {
        messages: messagesUnchanged ? s.messages : reconciled,
        agents,
        tasks
      }
    }),
  setProjects: (projects) => set({ projects }),
  setThreads: (threads) =>
    set((state) => (sameThreadSnapshot(state.threads, threads) ? state : { threads })),
  upsertThread: (thread) =>
    set((s) => {
      const idx = s.threads.findIndex((entry) => entry.id === thread.id)
      if (idx === -1) return { threads: [...s.threads, thread] }
      const threads = s.threads.slice()
      threads[idx] = thread
      return { threads }
    }),
  setThreadActivity: (threadActivity) => set({ threadActivity }),
  setMainView: (mainView) => set({ mainView, sidebarMode: 'projects' }),
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
  activateProfile: (profileId) => set((state) => {
    if (!profileId) return state
    if (profileActivated && profileId === state.profileId) return state
    if (profileActivated) savePersonalWorkspace(state)
    profileActivated = true
    let next = {
      projectTerminalTabs: [],
      activeProjectTerminalTabByThread: {},
      browserTabs: [],
      browserActiveTabByThread: {},
      browserElementAttachmentsByThread: {},
      composerWorkspaceDrafts: {},
      composerDrafts: {},
      composerReferences: {},
      sidebarMode: 'projects' as 'projects' | 'chats',
      mainView: 'agents' as MainView,
      sidebarWidth: 30,
      threadsSidebarWidth: 260,
      threadsSidebarOpen: true,
      mainAreaOpen: false,
      chatMode: DEFAULT_CHAT_MODE
    }
    if (typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(`mousse-profile-${profileId}-workspace`)
        if (raw) next = { ...next, ...JSON.parse(raw) }
      } catch { /* malformed profile-local state is discarded */ }
    }
    messageCache.clear()
    messageCacheOrder.splice(0)
    return {
      ...state,
      profileId,
      ...next,
      messages: [],
      agents: [],
      tasks: [],
      activePtyId: null,
      activeAgentId: null,
      activeThreadId: null,
      projects: [],
      threads: [],
      threadActivity: {},
      turnStates: {},
      documentTabs: [],
      activeDocumentTabId: null,
      documentsTabVisible: false,
      loading: false
    }
  }),
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
    })),
  setComposerWorkspaceDraft: (threadId, workspace) => set((state) => {
    const key = threadId ?? '__blank__'
    const composerWorkspaceDrafts = { ...state.composerWorkspaceDrafts }
    if (workspace) composerWorkspaceDrafts[key] = workspace
    else delete composerWorkspaceDrafts[key]
    return { composerWorkspaceDrafts }
  }),
  setComposerDraft: (threadId, value) =>
    set((s) => {
      const key = threadId ?? '__blank__'
      if ((s.composerDrafts[key] ?? '') === value) return s
      return {
        composerDrafts: {
          ...s.composerDrafts,
          [key]: value
        }
      }
    }),
  clearComposerDraft: (threadId) =>
    set((s) => {
      const key = threadId ?? '__blank__'
      if (!(key in s.composerDrafts)) return s
      const composerDrafts = { ...s.composerDrafts }
      delete composerDrafts[key]
      return { composerDrafts }
    }),
  addComposerReference: (threadId, candidate) =>
    set((s) => {
      const reference = parseChatReference(candidate)
      if (!reference) return s
      const key = threadId ?? '__blank__'
      const current = s.composerReferences[key] ?? []
      if (current.some((item) => item.id === reference.id)) return s
      return { composerReferences: { ...s.composerReferences, [key]: [...current, reference] } }
    }),
  removeComposerReference: (threadId, id) =>
    set((s) => {
      const key = threadId ?? '__blank__'
      return { composerReferences: { ...s.composerReferences, [key]: (s.composerReferences[key] ?? []).filter((item) => item.id !== id) } }
    }),
  clearComposerReferences: (threadId) =>
    set((s) => {
      const key = threadId ?? '__blank__'
      if (!(key in s.composerReferences)) return s
      const composerReferences = { ...s.composerReferences }
      delete composerReferences[key]
      return { composerReferences }
    })
}), {
  name: 'mousse-workspace-state',
  version: 1,
  storage: workspaceStorage,
  partialize: (state) => ({
    // Personal workspace state is written under mousse-profile-<id>-workspace
    // after profile activation; keeping it out of this installation-wide key prevents
    // a stale profile's tabs/drafts from being hydrated before daemon binding.
  })
}))

// Persist active workspace changes immediately, including before a normal app exit.
// The bootstrap profile is only a placeholder; never write it before daemon binding.
useAppStore.subscribe((state, previous) => {
  if (!profileActivated) return
  if (state.profileId !== previous.profileId || personalWorkspaceKeys.some((key) => state[key] !== previous[key])) {
    savePersonalWorkspace(state)
  }
})

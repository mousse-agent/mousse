import { create } from 'zustand'
import type { ComposerWorkspace } from '../lib/newThread'
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
import type { SubagentSummary } from '../../shared/subagents'
import type { ChatMode } from '../../shared/types'
import { DEFAULT_CHAT_MODE } from '../../shared/types'
import { workspacePendingKey } from '../lib/newThread'
import type { ShortcutOverrides } from '../../shared/commands'

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
      left.kind !== right.kind ||
      JSON.stringify(left.presentationParts) !== JSON.stringify(right.presentationParts)
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
      // A thread of another computer going offline (or coming back) changes its row.
      left.node !== right.node ||
      left.offline !== right.offline ||
      left.notShared !== right.notShared ||
      left.modelOverride?.instanceId !== right.modelOverride?.instanceId ||
      left.modelOverride?.llmProvider !== right.modelOverride?.llmProvider ||
      left.modelOverride?.model !== right.modelOverride?.model ||
      left.modelOverride?.effort !== right.modelOverride?.effort ||
      left.modelOverride?.name !== right.modelOverride?.name
    ) {
      return false
    }
  }
  return true
}

/** What is left before the oldest message a window was given of a long thread: load it from `before`. */
export interface EarlierMessages {
  before: string
  count: number
}

export interface ThreadViewSnapshot {
  threadId: string
  messages: ChatMessage[]
  agents?: Agent[]
  tasks?: Task[]
  /** Set when a long thread of another computer was sent as its newest part. */
  earlier?: EarlierMessages
}

interface AppState {
  /** Trusted daemon profile id whose personal renderer state is loaded. */
  profileId: string
  profileReady: boolean
  workspaceReady: boolean
  messages: ChatMessage[]
  agents: Agent[]
  tasks: Task[]
  sidebarWidth: number
  threadsSidebarWidth: number
  usageOpen: boolean
  setUsageOpen: (open: boolean) => void
  settingsOpen: boolean
  scheduledOpen: boolean
  /** @deprecated use turnStates[threadId]?.phase instead â€” kept for compat */
  loading: boolean
  appInfo: { platform: string; repoRoot: string; llmProvider: string; deviceName?: string } | null
  /** Review and Git diffs ignore leading/trailing whitespace when highlighting. View only: counts stay total. */
  reviewIgnoreWhitespace: boolean
  setReviewIgnoreWhitespace: (ignore: boolean) => void
  /** The bound profile's shortcut overrides (`settings.shortcuts`). Not persisted here; the daemon owns them. */
  shortcuts: ShortcutOverrides
  setShortcuts: (shortcuts: ShortcutOverrides) => void
  /** The Search threads dialog, opened from the threads sidebar, the command palette and its shortcut. */
  threadSearchOpen: boolean
  setThreadSearchOpen: (open: boolean) => void
  /** The command palette. Not persisted. */
  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
  threadsSidebarView: 'projects' | 'threads' | 'chats'
  setThreadsSidebarView: (view: 'projects' | 'threads' | 'chats') => void
  sidebarMode: 'projects' | 'chats'
  setSidebarMode: (sidebarMode: 'projects' | 'chats') => void
  threadsSidebarOpen: boolean
  mainAreaOpen: boolean
  /** Thread side card preference. On at every launch; deliberately kept out of the per-profile workspace. */
  sideCardOn: boolean
  setSideCardOn: (sideCardOn: boolean) => void
  /** Whether the full-width thread area measured wide enough for the side card. Null until measured. */
  sideCardFits: boolean | null
  setSideCardFits: (sideCardFits: boolean | null) => void
  /** The side card is open as an overlay in a narrow thread area. Temporary: not persisted, closed again by `shouldCloseSideCardOverlay`. */
  sideCardOverlayOpen: boolean
  setSideCardOverlayOpen: (sideCardOverlayOpen: boolean) => void
  /** Side card sections the user collapsed (true) or expanded (false) by hand, by section key; a missing key uses the section's default. */
  sideCardCollapsed: Record<string, boolean>
  setSideCardSectionCollapsed: (key: string, collapsed: boolean) => void
  activeThreadId: string | null
  projects: Project[]
  threads: Thread[]
  threadActivity: ThreadActivitySnapshot
  /** Each thread's subagents as the daemon last reported them, by parent thread id. Not persisted. */
  subagentsByParent: Record<string, SubagentSummary[]>
  setSubagents: (parentThreadId: string, subagents: SubagentSummary[]) => void
  turnStates: TurnStateSnapshot
  mainView: MainView
  /** Surfaces the user opened in the side panel. Agents is added on its own. */
  openedSurfaceKinds: MainView[]
  openSurfaceKind: (kind: MainView) => void
  closeSurfaceKind: (kind: MainView) => void
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
  composerWorkspaceDrafts: Record<string, ComposerWorkspace>
  /** The profile's "Start new chats in a worktree" setting: the worktree choice of a draft that has not made one. */
  worktreeByDefault: boolean
  setWorktreeByDefault: (worktreeByDefault: boolean) => void
  setComposerWorkspaceDraft: (threadId: string | null, workspace?: ComposerWorkspace) => void
  /**
   * New threads or blank drafts whose workspace a send is preparing, keyed by
   * `workspacePendingKey`. Not persisted; the composer and quick actions both set it.
   */
  workspacePending: Record<string, true>
  setWorkspacePending: (profileId: string, threadId: string | null, pending: boolean) => void
  /** Text drafts keyed by their hidden or started thread id. */
  composerDrafts: Record<string, string>
  /** Durable rich references staged in each composer. */
  composerReferences: Record<string, ChatReference[]>

  /** Threads whose transcript is only its newest part: the older messages are loaded on request. */
  earlierByThread: Record<string, EarlierMessages>
  /** Puts a page of older messages in front of the shown transcript and records what is still left. */
  applyEarlierMessages: (threadId: string, messages: ChatMessage[], earlier: EarlierMessages | undefined) => void
  setMessages: (messages: ChatMessage[]) => void
  applyThreadMessages: (snapshot: ThreadMessagesSnapshot, profileId: string | null) => void
  addMessage: (message: ChatMessage) => void
  updateMessage: (message: ChatMessage) => void
  setAgents: (agents: Agent[]) => void
  setTasks: (tasks: Task[]) => void
  setSidebarWidth: (width: number) => void
  setThreadsSidebarWidth: (width: number) => void
  setSettingsOpen: (open: boolean) => void
  setScheduledOpen: (open: boolean) => void
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

/** Stable timestamp ordering â€” prevents out-of-order delivery when IPC channels race. */
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

/**
 * The incoming message with the image bytes this window already fetched. A thread of another computer sends its
 * older images by name and type; a later snapshot (Retry, a reconnect, reopening the thread) must not take them away.
 */
function keepFetchedImages(current: ChatMessage, incoming: ChatMessage): ChatMessage {
  if (!incoming.images?.length || !current.images?.length) return incoming
  let changed = false
  const images = incoming.images.map((image, index) => {
    const had = current.images![index]
    if (image.data || !had?.data || had.name !== image.name) return image
    changed = true
    return { ...image, data: had.data }
  })
  return changed ? { ...incoming, images } : incoming
}

/** Prefer the message version that cannot regress visible streaming progress. */
function newerMessageVersion(current: ChatMessage, incoming: ChatMessage): ChatMessage {
  return keepFetchedImages(current, chooseMessageVersion(current, incoming))
}

function chooseMessageVersion(current: ChatMessage, incoming: ChatMessage): ChatMessage {
  // A delayed initial event/snapshot must not roll a completed stream back to its placeholder.
  if (!current.streaming && incoming.streaming) return current
  // While both versions stream, snapshots can lag behind token events. Content is append-only.
  if (
    current.streaming &&
    incoming.streaming &&
    current.content.length > incoming.content.length &&
    current.content.startsWith(incoming.content)
  ) return current
  if (current.presentationParts && !incoming.presentationParts && current.content === incoming.content && !incoming.incomplete) return { ...incoming, presentationParts: current.presentationParts }
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
  'openedSurfaceKinds', 'sideCardCollapsed',
  'composerDrafts', 'composerReferences', 'composerWorkspaceDrafts', 'threadsSidebarView',
  'reviewIgnoreWhitespace'
] as const
let profileActivated = false

/** The view a fresh profile starts on; the empty main area shows the surface picker until one opens. */
const DEFAULT_MAIN_VIEW: MainView = 'browser'

/** Workspaces saved before the Agents tab was removed still name it as the view or an open surface,
 * and ones saved before the composer mode picker was removed may hold Plan or Build with no way back. */
export function sanitizeSavedWorkspace<T extends { mainView: MainView; openedSurfaceKinds: MainView[]; chatMode?: ChatMode }>(workspace: T): T {
  const retired = (view: unknown) => view === 'agents'
  const openedSurfaceKinds = Array.isArray(workspace.openedSurfaceKinds)
    ? workspace.openedSurfaceKinds.filter((kind) => !retired(kind))
    : []
  const mainView = retired(workspace.mainView) ? openedSurfaceKinds[0] ?? DEFAULT_MAIN_VIEW : workspace.mainView
  return { ...workspace, mainView, openedSurfaceKinds, ...('chatMode' in workspace ? { chatMode: DEFAULT_CHAT_MODE } : {}) }
}

function savePersonalWorkspace(state: AppState): void {
  if (typeof window === 'undefined') return
  try {
    const workspace = Object.fromEntries(personalWorkspaceKeys.map((key) => [key, state[key]]))
    window.localStorage.setItem(`mousse-profile-${state.profileId}-workspace`, JSON.stringify(workspace))
  } catch { /* quota/private mode */ }
}

export const useAppStore = create<AppState>()(persist((set) => ({
  profileId: 'default',
  profileReady: false,
  workspaceReady: false,
  sidebarMode: 'projects',
  setSidebarMode: (sidebarMode) => set({ sidebarMode }),
  messages: [],
  agents: [],
  tasks: [],
  sidebarWidth: 30,
  threadsSidebarWidth: 260,
  usageOpen: false,
  setUsageOpen: (usageOpen) => set(usageOpen ? { usageOpen, settingsOpen: false, scheduledOpen: false } : { usageOpen }),
  settingsOpen: false,
  scheduledOpen: false,
  loading: false,
  appInfo: null,
  shortcuts: {},
  // Settings events repeat the same map; keep the old object so nothing re-resolves for no change.
  setShortcuts: (shortcuts) => set((s) => (JSON.stringify(s.shortcuts) === JSON.stringify(shortcuts) ? s : { shortcuts })),
  threadSearchOpen: false,
  setThreadSearchOpen: (threadSearchOpen) => set({ threadSearchOpen }),
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  threadsSidebarOpen: true,
  mainAreaOpen: false,
  sideCardOn: true,
  sideCardFits: null,
  sideCardOverlayOpen: false,
  sideCardCollapsed: {},
  activeThreadId: null,
  projects: [],
  threads: [],
  threadActivity: {},
  subagentsByParent: {},
  setSubagents: (parentThreadId, subagents) =>
    set((s) => ({ subagentsByParent: { ...s.subagentsByParent, [parentThreadId]: subagents } })),
  turnStates: {},
  mainView: DEFAULT_MAIN_VIEW,
  openedSurfaceKinds: [],
  openSurfaceKind: (kind) => set((state) => ({
    openedSurfaceKinds: state.openedSurfaceKinds.includes(kind)
      ? state.openedSurfaceKinds
      : [...state.openedSurfaceKinds, kind],
    mainView: kind,
    mainAreaOpen: true,
    sidebarMode: 'projects'
  })),
  closeSurfaceKind: (kind) => set((state) => {
    const openedSurfaceKinds = state.openedSurfaceKinds.filter((entry) => entry !== kind)
    const mainView = state.mainView === kind
      ? openedSurfaceKinds[0] ?? state.mainView
      : state.mainView
    return { openedSurfaceKinds, mainView }
  }),
  projectTerminalTabs: [],
  activeProjectTerminalTabByThread: {},
  documentTabs: [],
  activeDocumentTabId: null,
  documentsTabVisible: false,
  chatMode: DEFAULT_CHAT_MODE,
  browserTabs: [],
  browserActiveTabByThread: {},
  browserElementAttachmentsByThread: {},
  reviewIgnoreWhitespace: true,
  setReviewIgnoreWhitespace: (reviewIgnoreWhitespace) => set({ reviewIgnoreWhitespace }),
  threadsSidebarView: 'projects',
  setThreadsSidebarView: (threadsSidebarView) => set({ threadsSidebarView }),
  composerWorkspaceDrafts: {},
  worktreeByDefault: true,
  setWorktreeByDefault: (worktreeByDefault) => set({ worktreeByDefault }),
  workspacePending: {},
  setWorkspacePending: (profileId, threadId, pending) => set((state) => {
    const key = workspacePendingKey(profileId, threadId)
    if (Boolean(state.workspacePending[key]) === pending) return state
    const workspacePending = { ...state.workspacePending }
    if (pending) workspacePending[key] = true
    else delete workspacePending[key]
    return { workspacePending }
  }),
  composerDrafts: {},
  composerReferences: {},
  earlierByThread: {},
  applyEarlierMessages: (threadId, messages, earlier) =>
    set((s) => {
      const earlierByThread = { ...s.earlierByThread }
      if (earlier) earlierByThread[threadId] = earlier
      else delete earlierByThread[threadId]
      if (s.activeThreadId !== threadId) return { earlierByThread }
      const have = new Set(s.messages.map((message) => message.id))
      const merged = sortMessagesDeterministic([...messages.filter((message) => !have.has(message.id)), ...s.messages])
      rememberMessages(threadId, merged)
      return { messages: merged, earlierByThread }
    }),

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
  setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
  setThreadsSidebarWidth: (threadsSidebarWidth) => set({ threadsSidebarWidth }),
  setSettingsOpen: (settingsOpen) => set(settingsOpen ? { settingsOpen, scheduledOpen: false } : { settingsOpen }),
  setScheduledOpen: (scheduledOpen) => set(scheduledOpen ? { scheduledOpen, settingsOpen: false } : { scheduledOpen }),
  setLoading: (loading) => set({ loading }),
  setAppInfo: (appInfo) => set({ appInfo }),
  setThreadsSidebarOpen: (threadsSidebarOpen) => set({ threadsSidebarOpen }),
  setMainAreaOpen: (mainAreaOpen) => set({ mainAreaOpen }),
  setSideCardOn: (sideCardOn) => set({ sideCardOn }),
  setSideCardFits: (sideCardFits) => set({ sideCardFits }),
  setSideCardOverlayOpen: (sideCardOverlayOpen) => set({ sideCardOverlayOpen }),
  setSideCardSectionCollapsed: (key, collapsed) => set((s) => ({ sideCardCollapsed: { ...s.sideCardCollapsed, [key]: collapsed } })),
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
      // A view with older messages left out says so; one without them has the whole transcript.
      const had = s.earlierByThread[view.threadId]
      // Older messages this window already loaded stay: a view that stops at the same boundary again
      // (a reconnect) does not bring the "load earlier" prompt back for them.
      const loadedBeyond = Boolean(
        had && view.earlier && s.messages.length > 0 && s.messages[0].id !== view.earlier.before && s.messages.some((message) => message.id === view.earlier!.before)
      )
      const next = loadedBeyond ? had : view.earlier
      let earlierByThread = s.earlierByThread
      if (had?.before !== next?.before || had?.count !== next?.count) {
        earlierByThread = { ...s.earlierByThread }
        if (next) earlierByThread[view.threadId] = next
        else delete earlierByThread[view.threadId]
      }
      if (messagesUnchanged && agents === s.agents && tasks === s.tasks && earlierByThread === s.earlierByThread) return s
      return {
        messages: messagesUnchanged ? s.messages : reconciled,
        agents,
        tasks,
        earlierByThread
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
        mainView: documentTabs.length === 0 && s.mainView === 'documents'
          ? s.openedSurfaceKinds[0] ?? DEFAULT_MAIN_VIEW
          : s.mainView
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
      threadsSidebarView: 'projects' as 'projects' | 'threads' | 'chats',
      composerWorkspaceDrafts: {},
      composerDrafts: {},
      composerReferences: {},
      reviewIgnoreWhitespace: true,
      sidebarMode: 'projects' as 'projects' | 'chats',
      mainView: DEFAULT_MAIN_VIEW as MainView,
      openedSurfaceKinds: [] as MainView[],
      sidebarWidth: 30,
      threadsSidebarWidth: 260,
      threadsSidebarOpen: true,
      mainAreaOpen: false,
      sideCardCollapsed: {} as Record<string, boolean>,
      chatMode: DEFAULT_CHAT_MODE
    }
    if (typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(`mousse-profile-${profileId}-workspace`)
        if (raw) next = sanitizeSavedWorkspace({ ...next, ...JSON.parse(raw) })
      } catch { /* malformed profile-local state is discarded */ }
    }
    messageCache.clear()
    messageCacheOrder.splice(0)
    return {
      ...state,
      profileId,
      usageOpen: false,
      profileReady: true,
      workspaceReady: false,
      // Another profile's shortcuts must not stay bound until its own settings arrive.
      shortcuts: {},
      threadSearchOpen: false,
      paletteOpen: false,
      ...next,
      messages: [],
      agents: [],
      tasks: [],
      activeThreadId: null,
      projects: [],
      threads: [],
      threadActivity: {},
      subagentsByParent: {},
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

/**
 * The side card overlay is temporary: it closes when the thread area widens
 * enough to dock the card (the card's switch stays on), when the thread changes,
 * when the app panel opens, and when a view without a thread replaces the
 * conversation. A narrow window therefore never opens it by itself.
 */
export function shouldCloseSideCardOverlay(state: AppState, previous: AppState): boolean {
  if (!state.sideCardOverlayOpen) return false
  return state.sideCardFits !== false
    || state.mainAreaOpen
    || state.activeThreadId !== previous.activeThreadId
    || state.settingsOpen
    || state.usageOpen
    || state.scheduledOpen
    || state.sidebarMode === 'chats'
}

useAppStore.subscribe((state, previous) => {
  if (shouldCloseSideCardOverlay(state, previous)) state.setSideCardOverlayOpen(false)
})

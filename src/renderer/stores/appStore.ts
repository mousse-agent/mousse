import { create } from 'zustand'
import type { WarmStartView } from '../../shared/warmStart'
import type { ProfilePublicDto } from '../../shared/profiles/types'
import type { ExpiryPreset } from '../../shared/threadExpiry'
import type { RunSettings } from '../../shared/settings'
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
  ThreadRowPayload,
  TurnState,
  TurnStateSnapshot,
  BrowserElementAttachment,
  BrowserTabState
} from '../../shared/types'
import { parseChatReference, type ChatReference } from '../../shared/chatReferences'
import { queueEditDraftsForStorage, queueEditDraftsFromStorage, type QueueEditDraft } from '../lib/queuedContent'
import { isQualifiedId } from '../../shared/threadRef'
import type { SubagentSummary } from '../../shared/subagents'
import type { ThreadBackgroundWork } from '../../shared/backgroundWork'
import type { AppletReference } from '../../shared/applets'
import type { ChatMode } from '../../shared/types'
import { DEFAULT_CHAT_MODE } from '../../shared/types'
import { workspacePendingKey } from '../lib/newThread'
import { applyDaemonTurnState, stoppedAtClick, type StopRequest } from '../lib/optimisticStop'
import { DEFAULT_THREADS_SIDEBAR_WIDTH } from '../lib/resizerKeys'
import { savedMainAreaWidth } from '../lib/panelSplit'
import type { ShortcutOverrides } from '../../shared/commands'
import { parseCursor } from '../../shared/pageCursor'
import { isThreadStarted } from '../../shared/threadTitle'
import { withHeldModelPicks } from '../lib/modelPicks'
import { tabAgreement, type SidebarTab, type ThreadListTab, type WorkspaceMode } from './sidebarTabAgreement'
import { threadPanels, type SavedThreadPanel } from './threadPanels'

/** What the command palette leads with when it opens. */
export type PaletteMode = 'all' | 'messages'

/** In-memory transcript cache so re-visiting a thread paints instantly (not in Zustand). */
// Each entry is a hydrated transcript: a thread opens at its newest page (at most 200 messages), plus any older
// pages the person loaded. Sixteen whole transcripts pinned large tool payloads and markdown strings in the
// renderer heap; eight newest pages keep the threads someone moves between ready without that.
const MESSAGE_CACHE_MAX = 8
const messageCache = new Map<string, ChatMessage[]>()
const messageCacheOrder: string[] = []

/**
 * Keeps a thread's transcript for its next visit. An empty one is not kept: a thread opened from it would show at once
 * as known to be empty (the new-thread page) instead of waiting for its view, and a failed read of it (a computer that
 * is offline) would not be shown.
 */
function rememberMessages(threadId: string, messages: ChatMessage[]): void {
  if (messageCache.has(threadId)) {
    const idx = messageCacheOrder.indexOf(threadId)
    if (idx >= 0) messageCacheOrder.splice(idx, 1)
  }
  if (messages.length === 0) {
    messageCache.delete(threadId)
    return
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

/**
 * Messages of the thread being opened (`openingThreadId`) that arrived before its view. The view can be older than
 * them, so they join its transcript as live messages would (`reconcileMessageSnapshot`).
 */
let openingEarly: { threadId: string; messages: ChatMessage[] } | null = null

/**
 * The messages the warm start showed (`showWarmView`), by identity. The thread's first view replaces them; messages
 * that arrived live meanwhile are joined to it as usual.
 */
let warmTranscript: { threadId: string; messages: WeakSet<ChatMessage> } | null = null

/** A warm start's thread states: only a finished or waiting thread's, never Working (`WarmStartView.activity`). */
function warmActivity(activity: unknown): ThreadActivitySnapshot {
  const settled: ThreadActivitySnapshot = {}
  if (!activity || typeof activity !== 'object') return settled
  for (const [threadId, state] of Object.entries(activity)) {
    if (state === 'completed' || state === 'awaiting_input') settled[threadId] = state
  }
  return settled
}

function isWarmAppInfo(info: unknown): info is NonNullable<AppState['appInfo']> {
  const value = info as Record<string, unknown> | null | undefined
  return Boolean(value && typeof value.platform === 'string' && typeof value.repoRoot === 'string' && typeof value.llmProvider === 'string')
}

/** A warm start's transcript as last known: nothing in it shows as still being written. */
export function settleWarmMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const thinking = message.thinking?.status === 'processing' ? { ...message.thinking, status: 'complete' as const } : message.thinking
    const toolCall = message.toolCall?.status === 'processing' ? { ...message.toolCall, status: 'complete' as const } : message.toolCall
    if (!message.streaming && thinking === message.thinking && toolCall === message.toolCall) return message
    return { ...message, streaming: false, ...(thinking ? { thinking } : {}), ...(toolCall ? { toolCall } : {}) }
  })
}

/**
 * The store update that shows thread `id`: its cached transcript when there is one, otherwise an empty one that
 * waits for its view (`transcriptPending`) unless the thread never started. Remembers the transcript left behind.
 * `carry` moves messages shown here to `id`: they leave the transcript left behind and join the one shown.
 */
function switchPatch(s: Pick<AppState, 'activeThreadId' | 'messages' | 'threads' | 'openingCueThreadId'>, id: string, carry: readonly ChatMessage[] = []): Partial<AppState> {
  const carried = new Set(carry.map((message) => message.id))
  const left = carried.size ? s.messages.filter((message) => !carried.has(message.id)) : s.messages
  // The warm start's transcript is its newest part only: it is not kept as the thread's transcript.
  const leftWarm = warmTranscript?.threadId === s.activeThreadId
  if (leftWarm) warmTranscript = null
  if (s.activeThreadId && !leftWarm && (left.length > 0 || carried.size > 0)) rememberMessages(s.activeThreadId, left)
  const cached = takeCachedMessages(id)
  const early = openingEarly?.threadId === id ? openingEarly.messages : []
  openingEarly = null
  // Nothing cached: a thread that never started is known to be empty; any other one waits for its view.
  const target = s.threads.find((thread) => thread.id === id)
  return {
    activeThreadId: id,
    openingThreadId: null,
    // The cue stays with the thread it was shown for (a held one shown while its view is still coming).
    ...(s.openingCueThreadId !== null && s.openingCueThreadId !== id ? { openingCueThreadId: null } : {}),
    transcriptFailed: null,
    messages: carry.reduce(upsertMessage, early.reduce(upsertMessage, withoutLandedCopies(cached ?? [], early))),
    // A carried message is the thread's newest: the view that comes joins what it holds.
    transcriptPending: !cached && !carried.size && !(target && !isThreadStarted(target)),
    // Agents/tasks are always re-fetched with the snapshot (small, thread-scoped).
    agents: [],
    tasks: [],
    loading: false
  }
}

/**
 * Whether switching to `id` would show a listed, started thread with no messages while its view loads (see
 * `openThreadWhenReady`). A thread this window does not list yet is shown at once, as before.
 */
function opensFromCache(s: Pick<AppState, 'threads'>, id: string): boolean {
  if (!messageCache.has(id)) return false
  const target = s.threads.find((thread) => thread.id === id)
  return Boolean(target && isThreadStarted(target))
}

function opensEmpty(s: Pick<AppState, 'threads'>, id: string): boolean {
  if (messageCache.has(id)) return false
  const target = s.threads.find((thread) => thread.id === id)
  return Boolean(target && isThreadStarted(target))
}

/**
 * The thread whose row and title show that it is opening: asked for over `OPENING_CUE_MS` ago and still held
 * (`openingThreadId`), or shown and still waiting for its transcript. Null while nothing is slow to open.
 */
export function openingCueOf(s: Pick<AppState, 'openingCueThreadId' | 'openingThreadId' | 'activeThreadId' | 'transcriptPending'>): string | null {
  const id = s.openingCueThreadId
  if (id === null) return null
  if (s.openingThreadId !== null) return s.openingThreadId === id ? id : null
  return s.activeThreadId === id && s.transcriptPending ? id : null
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
      // A thought streams outside the transcript (liveTextStore): a cached copy can lag the view's text.
      left.thinking?.content !== right.thinking?.content ||
      left.thinking?.status !== right.thinking?.status ||
      JSON.stringify(left.presentationParts) !== JSON.stringify(right.presentationParts)
    ) {
      return false
    }
  }
  return true
}

/** Plain data (what a push carries: strings, numbers, arrays, objects) equal by value. */
export function samePlainData(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keysA = Object.keys(a)
  if (keysA.length !== Object.keys(b).length) return false
  return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) &&
    samePlainData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

/**
 * `next`, keeping each entry of `held` it repeats as the same object, or `held` itself when `next` says nothing new.
 * Pushes carry whole maps of fresh objects (every thread's activity, every thread's turn); kept this way, what reads
 * one thread's entry renders only when that entry changes.
 */
export function sharedEntries<T>(held: Record<string, T>, next: Record<string, T>): Record<string, T> {
  if (held === next) return held
  const keys = Object.keys(next)
  let same = keys.length === Object.keys(held).length
  const out: Record<string, T> = {}
  for (const key of keys) {
    const value = next[key] as T
    const kept = Object.prototype.hasOwnProperty.call(held, key) ? held[key] : undefined
    if (kept !== undefined && samePlainData(kept, value)) out[key] = kept
    else {
      out[key] = value
      same = false
    }
  }
  return same ? held : out
}

/** `activity` without its idle threads: idle and not listed are the same state. */
function withoutIdleThreads(activity: ThreadActivitySnapshot): ThreadActivitySnapshot {
  if (!Object.values(activity).includes('idle')) return activity
  return Object.fromEntries(Object.entries(activity).filter(([, state]) => state !== 'idle'))
}

/** `next`, keeping each message of `held` it repeats as the same object, or `held` itself when nothing changed. */
function sharedMessages(held: ChatMessage[], next: ChatMessage[]): ChatMessage[] {
  if (held === next) return held
  const byId = new Map(held.map((message) => [message.id, message]))
  let same = held.length === next.length
  const out = next.map((message, index) => {
    const kept = byId.get(message.id)
    if (kept && samePlainData(kept, message)) {
      if (held[index] !== kept) same = false
      return kept
    }
    same = false
    return message
  })
  return same ? held : out
}

/**
 * A whole thread list with each row's time no older than the one this window holds for it. Touches
 * (`threads.touched`) move times without a new list version, so a list read or pushed before a touch can land
 * after it; taking it as it is would move "Needs me" and recent order back until the next change.
 */
export function withNewerTimes(incoming: Thread[], held: readonly Thread[]): Thread[] {
  if (held.length === 0) return incoming
  const heldTimes = new Map(held.map((entry) => [entry.id, entry.updatedAt]))
  let out: Thread[] | undefined
  incoming.forEach((entry, index) => {
    const heldAt = heldTimes.get(entry.id)
    if (!heldAt || !(Date.parse(heldAt) > Date.parse(entry.updatedAt))) return
    out ??= incoming.slice()
    out[index] = { ...entry, updatedAt: heldAt }
  })
  return out ?? incoming
}

/**
 * The list with one thread's row put in (`threads.row`): replacing the row of the same id, or added; or without the
 * thread when it left the list. The sidebar sorts rows itself, so where a new row goes does not matter.
 */
export function withThreadRow(threads: readonly Thread[], row: Pick<ThreadRowPayload, 'thread' | 'removed'>): Thread[] {
  if (row.thread) {
    const thread = row.thread
    const index = threads.findIndex((entry) => entry.id === thread.id)
    if (index < 0) return [...threads, thread]
    const next = threads.slice()
    next[index] = thread
    return next
  }
  return row.removed ? threads.filter((entry) => entry.id !== row.removed) : threads.slice()
}

/** Whether two rows count the same pull requests, each in the same state. */
function samePullRequestRows(left: Thread, right: Thread): boolean {
  if (left.pullRequest?.url !== right.pullRequest?.url) return false
  const a = left.pullRequests ?? []
  const b = right.pullRequests ?? []
  return a.length === b.length && a.every((entry, index) =>
    entry.url === b[index].url && entry.state === b[index].state && entry.isDraft === b[index].isDraft && entry.title === b[index].title)
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
      // A provisional title becomes `auto` without a new name or `updatedAt`, and its row stops being dimmed.
      left.titleSource !== right.titleSource ||
      left.projectId !== right.projectId ||
      left.updatedAt !== right.updatedAt ||
      left.order !== right.order ||
      left.pinnedAt !== right.pinnedAt ||
      left.archivedAt !== right.archivedAt ||
      left.startedAt !== right.startedAt ||
      left.worktreeEnabled !== right.worktreeEnabled ||
      // Saved without touching `updatedAt`, so it is compared on its own (a new thread gets its project's mode so).
      left.permissionMode !== right.permissionMode ||
      left.settingsRevision !== right.settingsRevision ||
      left.firstSendPending !== right.firstSendPending ||
      // Why its last message did not start: saved without touching `updatedAt`; each failure has its own time.
      left.setupFailure?.at !== right.setupFailure?.at ||
      // A thread of another computer going offline (or coming back) changes its row.
      left.node !== right.node ||
      left.offline !== right.offline ||
      left.notShared !== right.notShared ||
      left.modelOverride?.instanceId !== right.modelOverride?.instanceId ||
      left.modelOverride?.llmProvider !== right.modelOverride?.llmProvider ||
      left.modelOverride?.model !== right.modelOverride?.model ||
      left.modelOverride?.effort !== right.modelOverride?.effort ||
      left.modelOverride?.name !== right.modelOverride?.name ||
      // The goal (`/goal`) is saved without touching `updatedAt`; each change of it moves its own time.
      left.goal?.setAt !== right.goal?.setAt ||
      left.goal?.updatedAt !== right.goal?.updatedAt ||
      // Hidden or shown again (`Thread.hidden`) is saved without touching `updatedAt` too.
      left.hidden !== right.hidden ||
      // So are the reply preview and the pull requests a row shows (`Thread.lastReply`, `Thread.pullRequests`).
      left.lastReply !== right.lastReply ||
      // And how its latest run ended, which its links show (`Thread.lastRun`).
      left.lastRun !== right.lastRun ||
      !samePullRequestRows(left, right)
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
  /**
   * What this window's profile showed last time (`showWarmView`), on screen until the workspace is ready. Display
   * only: its profile id is never sent anywhere, and a binding to another profile drops it.
   */
  warmView: { profileId: string; profile?: ProfilePublicDto } | null
  /** A message sent from the warm view: the thread whose draft is sent once the window is connected. */
  warmSendThreadId: string | null
  showWarmView: (view: WarmStartView) => void
  holdWarmSend: (threadId: string) => void
  /** Whether a send held for `threadId` was waiting; it is no longer held after this. */
  takeWarmSend: (threadId: string | null) => boolean
  messages: ChatMessage[]
  agents: Agent[]
  tasks: Task[]
  /** The panel area's width in pixels, or null for the default; clamped to the window where it is laid out. */
  mainAreaWidth: number | null
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
  /**
   * The bound profile's `notifications.botThreads`: threads a bot keeps out of the sidebar count in Needs me and the
   * app badge like any thread. Off until the profile's settings say otherwise.
   */
  notifyBotThreads: boolean
  setNotifyBotThreads: (on: boolean) => void
  /** The command palette, which also searches threads and messages. Not persisted. */
  paletteOpen: boolean
  /** What the palette leads with: `messages` is Search everything, with commands last (the rail's search opens it so). Kept on close. */
  paletteMode: PaletteMode
  setPaletteOpen: (open: boolean, mode?: PaletteMode) => void
  /** New project (the title bar's Add project): clone, make or add a project. Not persisted. */
  newProjectOpen: boolean
  setNewProjectOpen: (open: boolean) => void
  /** Where New project puts new and cloned projects, once chosen; unset: the folder most projects here are in. */
  newProjectParent: string | null
  setNewProjectParent: (path: string | null) => void
  /** The sidebar's tab. It and `sidebarMode` always agree (`agreeWithTab`): setting either moves the other. */
  threadsSidebarView: SidebarTab
  setThreadsSidebarView: (view: SidebarTab) => void
  /** Projects or Threads, whichever the sidebar showed last: where it goes when something opens a thread from Chats. */
  lastThreadListView: ThreadListTab
  /** The order the Threads tab's rows were last dragged into (thread ids, top first); see `sortThreadFeed`. */
  threadFeedOrder: string[]
  setThreadFeedOrder: (ids: string[]) => void
  /** The active profile's animation and composer preferences from Labs. */
  sidebarAnimations: boolean
  newChatAnimations: boolean
  shimmerAnimations: boolean
  hidePermissionsWhileRunning: boolean
  /** The workspace beside the sidebar: the thread workspace, or `ChatWorkspace` under the Chats tab. */
  sidebarMode: WorkspaceMode
  setSidebarMode: (sidebarMode: WorkspaceMode) => void
  threadsSidebarOpen: boolean
  mainAreaOpen: boolean
  /** Each thread's side panel (open, and its tab in front), saved as the thread is left (`threadPanels`). */
  panelByThread: Record<string, SavedThreadPanel>
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
  /** Chats sidebar sections (Bots, Groups, Recent) the user folded (true) or opened (false); a missing key is open. */
  chatsSidebarCollapsed: Record<string, boolean>
  setChatsSidebarSectionCollapsed: (key: string, collapsed: boolean) => void
  activeThreadId: string | null
  projects: Project[]
  threads: Thread[]
  threadActivity: ThreadActivitySnapshot
  /** Each thread's subagents as the daemon last reported them, by parent thread id. Not persisted. */
  subagentsByParent: Record<string, SubagentSummary[]>
  /** Each thread's subagents whose thread is gone (`removed`), kept apart: only the transcript's cards read them. Not persisted. */
  removedSubagentsByParent: Record<string, SubagentSummary[]>
  /** Takes a thread's list as the daemon sent it: removed subagents go to `removedSubagentsByParent`, the rest to `subagentsByParent`. */
  setSubagents: (parentThreadId: string, subagents: SubagentSummary[]) => void
  /** What each thread runs in the background besides its subagents, as the daemon last pushed it (`thread.backgroundWork`). Not persisted. */
  backgroundWorkByThread: Record<string, ThreadBackgroundWork>
  setBackgroundWork: (work: ThreadBackgroundWork) => void
  turnStates: TurnStateSnapshot
  /** Stops shown before the daemon confirmed them, by thread (`lib/optimisticStop`). Not persisted. */
  stopRequests: Record<string, StopRequest>
  mainView: MainView
  /** Surfaces the user opened in the side panel. Agents is added on its own. */
  openedSurfaceKinds: MainView[]
  openSurfaceKind: (kind: MainView) => void
  closeSurfaceKind: (kind: MainView) => void
  projectTerminalTabs: ProjectTerminalTab[]
  activeProjectTerminalTabByThread: Record<string, string>
  /** Every thread's Documents tabs; a thread's panel shows only its own (`documentTabsForThread`). Not persisted. */
  documentTabs: DocumentTab[]
  /** The Documents tab last selected in each thread (`'__standalone__'` without one). */
  activeDocumentTabByThread: Record<string, string>
  chatMode: ChatMode
  browserTabs: BrowserTabState[]
  browserActiveTabByThread: Record<string, string>
  browserElementAttachmentsByThread: Record<string, BrowserElementAttachment[]>
  /** Workspace choices for each new-chat draft, isolated by profile. */
  composerWorkspaceDrafts: Record<string, ComposerWorkspace>
  /** The project last picked for a new thread here (none: no project), so New thread opens in it again. */
  lastNewThreadProjectId: string | null
  setLastNewThreadProjectId: (projectId: string | null) => void
  /** Settings → Runs: when a new private chat archives itself; `never`: it does not. */
  privateThreadExpiry: ExpiryPreset | 'never'
  /** Where a new thread in a project with no remembered checkout starts (`runs.newThreadWorktree`). */
  newThreadWorktree: boolean
  /** Whether the title bar's New thread asks for the project first (`runs.newThreadPicker`, absent counts as on). */
  newThreadPicker: boolean
  /** The new-chat defaults from Settings → Runs. */
  setRunDefaults: (runs: Pick<RunSettings, 'privateThreadExpiry' | 'newThreadWorktree' | 'newThreadPicker'>) => void
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
  /** Open edits of queued messages, by thread; saved with the workspace without images or a save in flight. */
  queueEditDrafts: Record<string, QueueEditDraft>
  /** Threads where an unsaved edit of a queued message went to the composer, for its notice. Not persisted. */
  queueDraftNotices: Record<string, true>
  /** Changes the thread's open edit of `itemId` (null closes it); nothing when another edit is open there. */
  updateQueueEditDraft: (threadId: string, itemId: string, change: (draft: QueueEditDraft) => QueueEditDraft | null) => void
  setQueueEditDraft: (threadId: string, draft: QueueEditDraft) => void
  /** Removes and returns the thread's open edit of `itemId` at once, so only one caller ever recovers it. */
  takeQueueEditDraft: (threadId: string, itemId: string) => QueueEditDraft | undefined
  setQueueDraftNotice: (threadId: string, shown: boolean) => void
  /** Forgets the open edits and notices of deleted threads. */
  forgetQueueEdits: (threadIds: readonly string[]) => void

  /** Threads whose transcript is only its newest part: the older messages are loaded on request. */
  earlierByThread: Record<string, EarlierMessages>
  /** Puts a page of older messages in front of the shown transcript and records what is still left. */
  applyEarlierMessages: (threadId: string, messages: ChatMessage[], earlier: EarlierMessages | undefined) => void
  /**
   * The selected thread's transcript is still on its way: the switch found nothing cached and the thread has
   * started, so an empty `messages` does not mean an empty thread. The chat holds back its empty page until it lands.
   */
  transcriptPending: boolean
  /**
   * A thread being opened whose transcript is not here yet (`openThreadWhenReady`). The window goes on showing the
   * thread it shows until the opened thread's view arrives, then shows it with its messages in one update, so no
   * frame shows it without them. Only its row in the sidebar is highlighted meanwhile.
   */
  openingThreadId: string | null
  /**
   * A thread asked for whose transcript has not shown within `OPENING_CUE_MS` (`showOpeningCue`). Read it through
   * `openingCueOf`, which also checks the thread is still opening (held, or shown and waiting for its view).
   */
  openingCueThreadId: string | null
  /** The selected thread's transcript could not be read (its select failed): the chat says so, with Retry. */
  transcriptFailed: { threadId: string; reason?: string } | null
  /** Marks a thread still opening after `OPENING_CUE_MS`, so its row and the title say it is opening. */
  showOpeningCue: (threadId: string) => void
  /**
   * Reads a failed thread again: the chat waits for its view as it did when it was opened. False (nothing changes)
   * when it is not the shown failed thread, or another thread is being opened.
   */
  retryTranscript: (threadId: string) => boolean
  /**
   * Opens a thread the person asked for. A never-started thread is shown at once (`switchToThread`). A started one is
   * held in `openingThreadId`, so its row shows as chosen at once while the chat goes on showing the thread before:
   * one with its messages cached (`'cached'`) until the next frame has been drawn (`showOpeningThread`), so the click
   * is answered before the transcript is drawn; one with nothing cached (`'held'`) until its view arrives.
   * `keepWorkspace`: the workspace stays as it is (a bot's thread opened in its chat pane keeps Chats on screen).
   */
  openThreadWhenReady: (id: string, options?: { keepWorkspace?: boolean }) => 'cached' | 'held' | false
  /**
   * Shows the held thread now: a cached one once the frame that highlights its row has been drawn, or one whose view is
   * slow (another computer, a busy service), which then waits with an empty transcript.
   */
  showOpeningThread: (threadId: string) => void
  /** A message (or a change to one) of the thread being opened, which arrived before its view. */
  holdOpeningMessage: (threadId: string, message: ChatMessage) => void
  /** The selected (or held) thread's transcript will not arrive (its select failed): stop waiting for it. */
  settleTranscript: (threadId: string, reason?: string) => void
  setMessages: (messages: ChatMessage[]) => void
  applyThreadMessages: (snapshot: ThreadMessagesSnapshot, profileId: string | null) => void
  addMessage: (message: ChatMessage) => void
  /**
   * Takes message `id` out of thread `threadId`'s transcript, shown or kept for a later visit (`null`: the chat
   * with no thread). For a copy painted at send whose send did not go ahead.
   */
  dropMessage: (threadId: string | null, id: string) => void
  updateMessage: (message: ChatMessage) => void
  /** Several updates of the selected thread in one store write (one frame of a stream). */
  updateMessages: (messages: ChatMessage[]) => void
  setAgents: (agents: Agent[]) => void
  setTasks: (tasks: Task[]) => void
  setMainAreaWidth: (width: number | null) => void
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
   * Without one, `transcriptPending` holds back the empty page until the thread's view arrives.
   * It shows the thread workspace, which moves the sidebar off Chats (`agreeWithTab`), unless `keepWorkspace`:
   * the main process's echo of a selection (and the thread it restores at launch) is not a request to open it.
   * That echo also leaves a held thread (`openingThreadId`) waiting for its view.
   */
  switchToThread: (id: string, options?: { keepWorkspace?: boolean; carry?: readonly ChatMessage[] }) => void
  /** Apply daemon snapshot for the selected thread in a single paint. */
  applyThreadView: (view: ThreadViewSnapshot) => void
  setProjects: (projects: Project[]) => void
  setThreads: (threads: Thread[]) => void
  /** Merge one thread meta into the sidebar list (model/rename/pin without full rescan). */
  upsertThread: (thread: Thread) => void
  /** Moves listed threads' `updatedAt` forward (`threads.touched`); an older or unknown one changes nothing. */
  applyThreadTouches: (touches: ReadonlyArray<{ id: string; updatedAt: string }>) => void
  setThreadActivity: (activity: ThreadActivitySnapshot) => void
  setTurnState: (state: TurnState) => void
  setTurnSnapshot: (snap: TurnStateSnapshot) => void
  /**
   * Shows the thread's turn stopped at once, until the daemon confirms or contradicts it. Returns the request's
   * `requestedAt`, or undefined when nothing runs.
   */
  markStopRequested: (threadId: string) => number | undefined
  /**
   * The Stop stopped nothing, or was never confirmed: the daemon's latest state of the thread is shown again. With
   * `requestedAt`, only that request is reverted, not a later Stop's.
   */
  revertStopRequest: (threadId: string, requestedAt?: number) => void
  setMainView: (view: MainView) => void
  addProjectTerminalTab: (ownerThreadId: string | null) => string
  closeProjectTerminalTab: (tabId: string) => void
  setActiveProjectTerminalTab: (threadId: string | null, tabId: string) => void
  updateProjectTerminalTab: (
    tabId: string,
    patch: Partial<Pick<ProjectTerminalTab, 'ownerThreadId' | 'ptyId' | 'cwd' | 'exited' | 'title' | 'quickAction'>>
  ) => void
  openDocument: (title: string, markdown: string) => string
  /** Shows a thread's applet in the side panel's Documents tab, reusing its tab when it is already open. */
  openAppletDocument: (threadId: string, reference: AppletReference) => string
  /** Shows a file a thread's agent wrote as a diff in the Documents tab, reusing its tab when it is already open. */
  openTurnFileDiff: (threadId: string, path: string, title: string) => string
  closeDocumentTab: (tabId: string) => void
  /** Selects a Documents tab in the active thread. */
  setActiveDocumentTab: (tabId: string) => void
  setChatMode: (mode: ChatMode) => void
  activateProfile: (profileId: string) => void
  addBrowserTab: (ownerThreadId: string | null) => string
  /** Create a default tab only when none are visible for this thread (incl. pinned). Idempotent. */
  ensureBrowserTab: (ownerThreadId: string | null) => string
  closeBrowserTab: (id: string) => void
  /** Closes the tabs these threads own; tabs kept in every thread stay. */
  closeThreadBrowserTabs: (threadIds: readonly string[]) => void
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

/**
 * Timestamp ordering that prevents out-of-order delivery when IPC channels race. Messages with the same
 * timestamp keep the order they arrived in (the sort is stable): a reply's text and the tool call after it
 * often share a millisecond, and ordering them by id would put the tool call above the text it followed.
 */
export function sortMessagesDeterministic(messages: ChatMessage[]): ChatMessage[] {
  // Already sorted fast path.
  let sorted = true
  for (let i = 1; i < messages.length; i += 1) {
    if (messages[i - 1].timestamp > messages[i].timestamp) { sorted = false; break }
  }
  if (sorted) return messages
  return [...messages].sort((a, b) => (a.timestamp === b.timestamp ? 0 : a.timestamp < b.timestamp ? -1 : 1))
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
  const next = messages.slice()
  next[index] = replacement
  // A streamed update keeps its timestamp, so the order cannot change.
  return replacement.timestamp === messages[index].timestamp ? next : sortMessagesDeterministic(next)
}

/**
 * `messages` with one update of the selected thread. A change to a message in a part of the thread
 * this window has not loaded stays there; it arrives with that page, instead of appearing out of
 * place among the loaded ones.
 */
function applyMessageUpdate(
  s: { activeThreadId: string | null; earlierByThread: Record<string, unknown> },
  messages: ChatMessage[],
  message: ChatMessage
): ChatMessage[] {
  if (s.activeThreadId && s.earlierByThread[s.activeThreadId] && !messages.some((existing) => existing.id === message.id)) {
    const first = messages[0]
    if (first && sortMessagesDeterministic([message, first])[0] === message) return messages
  }
  return upsertMessage(messages, message)
}

/** How far another computer's clock may lag this one's when it saves a message sent from here. */
const COPY_CLOCK_SLACK_MS = 60_000

/**
 * `current` without the copy painted at send (an `optimistic:` id) of each user message in `incoming` that `current`
 * does not hold yet: the saved message takes its place. One copy per saved message, and only one saved after the copy
 * was painted (give or take another computer's clock), so the same text sent earlier never takes a new copy's place.
 */
export function withoutLandedCopies(current: ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  if (!current.some((message) => message.id.startsWith('optimistic:'))) return current
  const held = new Set(current.map((message) => message.id))
  const dropped = new Set<string>()
  for (const message of incoming) {
    if (message.role !== 'user' || held.has(message.id) || message.id.startsWith('optimistic:')) continue
    const savedAt = Date.parse(message.timestamp)
    const copy = current.find((entry) =>
      entry.id.startsWith('optimistic:') && !dropped.has(entry.id) && entry.role === 'user' && entry.content === message.content &&
      savedAt >= Date.parse(entry.timestamp) - COPY_CLOCK_SLACK_MS)
    if (copy) dropped.add(copy.id)
  }
  return dropped.size === 0 ? current : current.filter((message) => !dropped.has(message.id))
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
  const merged = new Map(withoutLandedCopies(current, incoming).map((message) => [message.id, message]))
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

const STANDALONE_KEY = '__standalone__'

/** The thread a Documents tab belongs to: the thread of its applet or changed file, or none for plain Markdown. */
export function documentTabThread(tab: DocumentTab): string | null {
  return tab.applet?.threadId ?? tab.turnFile?.threadId ?? null
}

/** The Documents tabs a thread's panel shows: its own, and those of no thread. */
export function documentTabsForThread(tabs: DocumentTab[], threadId: string | null): DocumentTab[] {
  return tabs.filter((tab) => {
    const owner = documentTabThread(tab)
    return owner === null || owner === threadId
  })
}

/** The Documents tab a thread's panel shows in front: the one it last selected, else its first. */
export function shownDocumentTab(state: Pick<AppState, 'documentTabs' | 'activeDocumentTabByThread' | 'activeThreadId'>): DocumentTab | undefined {
  const tabs = documentTabsForThread(state.documentTabs, state.activeThreadId)
  const selected = state.activeDocumentTabByThread[state.activeThreadId ?? STANDALONE_KEY]
  return tabs.find((tab) => tab.id === selected) ?? tabs[0]
}

const personalWorkspaceKeys = [
  'projectTerminalTabs', 'activeProjectTerminalTabByThread', 'browserTabs',
  'browserActiveTabByThread', 'browserElementAttachmentsByThread', 'mainView',
  'sidebarMode', 'mainAreaWidth', 'threadsSidebarWidth', 'threadsSidebarOpen', 'mainAreaOpen', 'panelByThread', 'chatMode',
  'openedSurfaceKinds', 'sideCardCollapsed', 'chatsSidebarCollapsed',
  'composerDrafts', 'composerReferences', 'composerWorkspaceDrafts', 'threadsSidebarView', 'lastThreadListView', 'threadFeedOrder',
  'reviewIgnoreWhitespace', 'queueEditDrafts', 'lastNewThreadProjectId', 'newProjectParent'
] as const
let profileActivated = false

/** The view a fresh profile starts on; the empty main area shows the surface picker until one opens. */
const DEFAULT_MAIN_VIEW: MainView = 'browser'

/** Workspaces saved before the Agents tab was removed still name it as the view or an open surface,
 * ones saved before Diff and Review became the Changes tab may name Review (now Changes, `git`),
 * and ones saved before the composer mode picker was removed may hold Plan or Build with no way back. */
export function sanitizeSavedWorkspace<T extends { mainView: MainView; openedSurfaceKinds: MainView[]; chatMode?: ChatMode }>(workspace: T): T {
  const retired = (view: unknown) => view === 'agents'
  const renamed = (view: MainView): MainView => ((view as string) === 'review' ? 'git' : view)
  const openedSurfaceKinds = Array.isArray(workspace.openedSurfaceKinds)
    ? [...new Set(workspace.openedSurfaceKinds.filter((kind) => !retired(kind)).map(renamed))]
    : []
  const mainView = retired(workspace.mainView) ? openedSurfaceKinds[0] ?? DEFAULT_MAIN_VIEW : renamed(workspace.mainView)
  // Older workspaces kept the conversation's share in percent (`sidebarWidth`); the panel area now keeps
  // its own width, so that share is dropped and a saved width that is not a usable number becomes the default.
  const { sidebarWidth: _legacyShare, ...rest } = workspace as T & { sidebarWidth?: unknown }
  return {
    ...rest,
    mainView,
    openedSurfaceKinds,
    ...('chatMode' in workspace ? { chatMode: DEFAULT_CHAT_MODE } : {}),
    ...('mainAreaWidth' in workspace ? { mainAreaWidth: savedMainAreaWidth((workspace as { mainAreaWidth?: unknown }).mainAreaWidth) } : {})
  } as T
}

const DRAFT_PERSIST_THROTTLE_MS = 300
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null
let draftSaveState: AppState | null = null
let lastDraftSaveAt = 0

function flushPersonalWorkspaceSave(): void {
  if (draftSaveTimer !== null) {
    clearTimeout(draftSaveTimer)
    draftSaveTimer = null
  }
  const pending = draftSaveState
  draftSaveState = null
  if (pending) {
    savePersonalWorkspace(pending)
    lastDraftSaveAt = Date.now()
  }
}

function scheduleDraftWorkspaceSave(state: AppState): void {
  const now = Date.now()
  // Leading + trailing throttle: the first edit after idle persists immediately (preserving drafts on abrupt
  // exit), while rapid typing batches into one write per window instead of blocking every keystroke.
  if (draftSaveTimer === null && now - lastDraftSaveAt >= DRAFT_PERSIST_THROTTLE_MS) {
    savePersonalWorkspace(state)
    lastDraftSaveAt = now
    return
  }
  draftSaveState = state
  if (draftSaveTimer !== null) return
  const wait = Math.max(0, DRAFT_PERSIST_THROTTLE_MS - (now - lastDraftSaveAt))
  draftSaveTimer = setTimeout(flushPersonalWorkspaceSave, wait)
}

function savePersonalWorkspace(state: AppState): void {
  if (draftSaveTimer !== null) {
    clearTimeout(draftSaveTimer)
    draftSaveTimer = null
  }
  draftSaveState = null
  if (typeof window === 'undefined') return
  try {
    // Open edits are saved without their images, which could be too large for this storage.
    const workspace = Object.fromEntries(personalWorkspaceKeys.map((key) => [key, key === 'queueEditDrafts' ? queueEditDraftsForStorage(state.queueEditDrafts) : state[key]]))
    window.localStorage.setItem(`mousse-profile-${state.profileId}-workspace`, JSON.stringify(workspace))
  } catch { /* quota/private mode */ }
}

/** A profile's own layout and drafts in this window (`savePersonalWorkspace`); defaults where none are saved. */
function personalWorkspaceOf(profileId: string) {
  let next = {
    projectTerminalTabs: [],
    activeProjectTerminalTabByThread: {},
    browserTabs: [],
    browserActiveTabByThread: {},
    browserElementAttachmentsByThread: {},
    // A saved tab and workspace that disagree are repaired as this update is applied: the workspace follows the tab.
    threadsSidebarView: 'projects' as SidebarTab,
    lastThreadListView: 'projects' as ThreadListTab,
    threadFeedOrder: [] as string[],
    sidebarAnimations: true,
    newChatAnimations: true,
    shimmerAnimations: true,
    hidePermissionsWhileRunning: true,
    composerWorkspaceDrafts: {},
    lastNewThreadProjectId: null as string | null,
    newProjectParent: null as string | null,
    composerDrafts: {},
    composerReferences: {},
    queueEditDrafts: {} as Record<string, QueueEditDraft>,
    reviewIgnoreWhitespace: false,
    sidebarMode: 'projects' as WorkspaceMode,
    mainView: DEFAULT_MAIN_VIEW as MainView,
    openedSurfaceKinds: [] as MainView[],
    mainAreaWidth: null as number | null,
    threadsSidebarWidth: DEFAULT_THREADS_SIDEBAR_WIDTH,
    threadsSidebarOpen: true,
    mainAreaOpen: false,
    panelByThread: {} as Record<string, SavedThreadPanel>,
    sideCardCollapsed: {} as Record<string, boolean>,
    chatsSidebarCollapsed: {} as Record<string, boolean>,
    chatMode: DEFAULT_CHAT_MODE
  }
  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(`mousse-profile-${profileId}-workspace`)
      if (raw) next = sanitizeSavedWorkspace({ ...next, ...JSON.parse(raw) })
      if (!Array.isArray(next.threadFeedOrder)) next.threadFeedOrder = []
      if (typeof next.lastNewThreadProjectId !== 'string') next.lastNewThreadProjectId = null
      if (typeof next.newProjectParent !== 'string') next.newProjectParent = null
      if (!next.panelByThread || typeof next.panelByThread !== 'object' || Array.isArray(next.panelByThread)) next.panelByThread = {}
      next.queueEditDrafts = queueEditDraftsFromStorage(next.queueEditDrafts)
    } catch { /* malformed profile-local state is discarded */ }
  }
  return next
}

/**
 * Browser tabs opened since the window started. Tabs restored from an earlier session are not in it: their pages
 * load when first shown (BrowserPanel), so restored tabs do not each start a page renderer at launch.
 */
export const browserTabsOpenedThisSession = new Set<string>()

export const useAppStore = create<AppState>()(persist(tabAgreement(threadPanels((set, get) => ({
  profileId: 'default',
  profileReady: false,
  workspaceReady: false,
  warmView: null,
  warmSendThreadId: null,
  showWarmView: (view) => set((state) => {
    // Only before this window's profile is known; once it is, the service's lists are the ones shown.
    if (profileActivated || state.profileReady || state.warmView || !view || typeof view.profileId !== 'string' || !Array.isArray(view.threads)) return state
    const messages = settleWarmMessages(Array.isArray(view.messages) ? view.messages : [])
    warmTranscript = view.activeThreadId ? { threadId: view.activeThreadId, messages: new WeakSet(messages) } : null
    return {
      ...state,
      // The person's layout of that profile (sidebar, panel, drafts), as `activateProfile` would load it.
      ...personalWorkspaceOf(view.profileId),
      warmView: { profileId: view.profileId, ...(view.profile ? { profile: view.profile } : {}) },
      threads: view.threads,
      projects: Array.isArray(view.projects) ? view.projects : [],
      activeThreadId: view.activeThreadId ?? null,
      messages,
      transcriptPending: false,
      // The rows' Done and Input badges and provider marks, as they were: the live ones then change only what changed.
      threadActivity: warmActivity(view.activity),
      ...(isWarmAppInfo(view.appInfo) && !state.appInfo ? { appInfo: view.appInfo } : {})
    }
  }),
  holdWarmSend: (threadId) => set((state) => (state.warmView && !state.workspaceReady ? { warmSendThreadId: threadId } : state)),
  takeWarmSend: (threadId) => {
    const held = get().warmSendThreadId
    if (held === null) return false
    set({ warmSendThreadId: null })
    return held === threadId
  },
  sidebarMode: 'projects',
  setSidebarMode: (sidebarMode) => set({ sidebarMode }),
  messages: [],
  transcriptPending: false,
  openingThreadId: null,
  openingCueThreadId: null,
  transcriptFailed: null,
  showOpeningCue: (threadId) =>
    set((s) => {
      const opening = s.openingThreadId === threadId || (s.openingThreadId === null && s.activeThreadId === threadId && s.transcriptPending)
      return opening && s.openingCueThreadId !== threadId ? { openingCueThreadId: threadId } : s
    }),
  retryTranscript: (threadId) => {
    const s = get()
    if (s.activeThreadId !== threadId || s.transcriptFailed?.threadId !== threadId || s.openingThreadId !== null) return false
    set({ transcriptFailed: null, transcriptPending: true, openingCueThreadId: threadId })
    return true
  },
  openThreadWhenReady: (id, options) => {
    // Every open starts without a cue: one that is still opening after a moment gets it again (`showOpeningCue`).
    if (get().openingCueThreadId !== null) set({ openingCueThreadId: null })
    const s = get()
    const workspace = options?.keepWorkspace ? {} : { sidebarMode: 'projects' as const }
    if (s.activeThreadId === id) {
      // Back to the thread on screen while another was being opened: stop opening that one.
      if (s.openingThreadId) set({ openingThreadId: null })
      return false
    }
    if (s.turnStates[id]?.phase === 'queued') {
      set((current) => ({ ...workspace, ...switchPatch(current, id) }))
      return false
    }
    if (opensFromCache(s, id)) {
      // Its row shows as chosen in this update; its transcript, which takes a while to draw, comes in the next.
      openingEarly = null
      set({ openingThreadId: id, ...workspace })
      return 'cached'
    }
    if (!opensEmpty(s, id)) {
      set((current) => ({ ...workspace, ...(current.openingThreadId ? { openingThreadId: null } : {}), ...switchPatch(current, id) }))
      return false
    }
    openingEarly = null
    set({ openingThreadId: id, ...workspace })
    return 'held'
  },
  showOpeningThread: (threadId) =>
    set((s) => (s.openingThreadId === threadId ? switchPatch(s, threadId) : s)),
  holdOpeningMessage: (threadId, message) => {
    if (get().openingThreadId !== threadId) return
    const held = openingEarly?.threadId === threadId ? openingEarly.messages : []
    openingEarly = { threadId, messages: upsertMessage(held, message) }
  },
  settleTranscript: (threadId, reason) =>
    set((s) => {
      // A thread that was waiting for its transcript shows that it could not be read, never an empty thread.
      const failed = { transcriptFailed: { threadId, ...(reason ? { reason } : {}) }, openingCueThreadId: null }
      if (s.openingThreadId === threadId) {
        const shown = switchPatch(s, threadId)
        return { ...shown, ...(shown.transcriptPending ? failed : {}), transcriptPending: false }
      }
      return s.transcriptPending && s.activeThreadId === threadId ? { transcriptPending: false, ...failed } : s
    }),
  agents: [],
  tasks: [],
  mainAreaWidth: null,
  threadsSidebarWidth: DEFAULT_THREADS_SIDEBAR_WIDTH,
  usageOpen: false,
  setUsageOpen: (usageOpen) => set(usageOpen ? { usageOpen, settingsOpen: false, scheduledOpen: false } : { usageOpen }),
  settingsOpen: false,
  scheduledOpen: false,
  loading: false,
  appInfo: null,
  shortcuts: {},
  // Settings events repeat the same map; keep the old object so nothing re-resolves for no change.
  setShortcuts: (shortcuts) => set((s) => (JSON.stringify(s.shortcuts) === JSON.stringify(shortcuts) ? s : { shortcuts })),
  notifyBotThreads: false,
  setNotifyBotThreads: (notifyBotThreads) => set((s) => (s.notifyBotThreads === notifyBotThreads ? s : { notifyBotThreads })),
  paletteOpen: false,
  paletteMode: 'all',
  // Closing keeps the mode, so the fading palette keeps its rows; each opening sets it again.
  setPaletteOpen: (paletteOpen, mode = 'all') => set(paletteOpen ? { paletteOpen, paletteMode: mode } : { paletteOpen }),
  newProjectOpen: false,
  setNewProjectOpen: (newProjectOpen) => set({ newProjectOpen }),
  newProjectParent: null,
  setNewProjectParent: (newProjectParent) => set({ newProjectParent }),
  threadsSidebarOpen: true,
  mainAreaOpen: false,
  panelByThread: {},
  sideCardOn: true,
  sideCardFits: null,
  sideCardOverlayOpen: false,
  sideCardCollapsed: {},
  chatsSidebarCollapsed: {},
  activeThreadId: null,
  projects: [],
  threads: [],
  threadActivity: {},
  subagentsByParent: {},
  removedSubagentsByParent: {},
  backgroundWorkByThread: {},
  setBackgroundWork: (work) => {
    set((s) => {
      const empty = work.items.length === 0 && !work.providerWork
      const held = s.backgroundWorkByThread[work.threadId]
      if (empty && !held) return s
      if (!empty && held && samePlainData(held, work)) return s
      const next = { ...s.backgroundWorkByThread }
      if (empty) delete next[work.threadId]
      else next[work.threadId] = work
      return { backgroundWorkByThread: next }
    })
  },
  setSubagents: (parentThreadId, subagents) => {
    const live = subagents.filter((row) => !row.removed)
    const removed = subagents.filter((row) => row.removed)
    set((s) => {
      const heldLive = s.subagentsByParent[parentThreadId]
      const heldRemoved = s.removedSubagentsByParent[parentThreadId]
      const liveUnchanged = heldLive !== undefined && samePlainData(heldLive, live)
      const wantRemoved = removed.length > 0 || heldRemoved !== undefined
      const removedUnchanged = !wantRemoved || (heldRemoved !== undefined && samePlainData(heldRemoved, removed))
      if (liveUnchanged && removedUnchanged) return s
      return {
        ...(!liveUnchanged ? { subagentsByParent: { ...s.subagentsByParent, [parentThreadId]: live } } : {}),
        ...(!removedUnchanged ? { removedSubagentsByParent: { ...s.removedSubagentsByParent, [parentThreadId]: removed } } : {})
      }
    })
  },
  turnStates: {},
  stopRequests: {},
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
  activeDocumentTabByThread: {},
  chatMode: DEFAULT_CHAT_MODE,
  browserTabs: [],
  browserActiveTabByThread: {},
  browserElementAttachmentsByThread: {},
  reviewIgnoreWhitespace: false,
  setReviewIgnoreWhitespace: (reviewIgnoreWhitespace) => set({ reviewIgnoreWhitespace }),
  threadsSidebarView: 'projects',
  setThreadsSidebarView: (threadsSidebarView) => set({ threadsSidebarView }),
  lastThreadListView: 'projects',
  threadFeedOrder: [],
  setThreadFeedOrder: (threadFeedOrder) => set({ threadFeedOrder }),
  sidebarAnimations: true,
  newChatAnimations: true,
  shimmerAnimations: true,
  hidePermissionsWhileRunning: true,
  composerWorkspaceDrafts: {},
  lastNewThreadProjectId: null,
  setLastNewThreadProjectId: (lastNewThreadProjectId) => set({ lastNewThreadProjectId }),
  privateThreadExpiry: 'never',
  newThreadWorktree: true,
  newThreadPicker: true,
  setRunDefaults: ({ privateThreadExpiry, newThreadWorktree, newThreadPicker }) => set({ privateThreadExpiry, newThreadWorktree, newThreadPicker: newThreadPicker !== false }),
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
  queueEditDrafts: {},
  queueDraftNotices: {},
  updateQueueEditDraft: (threadId, itemId, change) =>
    set((s) => {
      const draft = s.queueEditDrafts[threadId]
      if (!draft || draft.itemId !== itemId) return s
      const changed = change(draft)
      const queueEditDrafts = { ...s.queueEditDrafts }
      if (changed) queueEditDrafts[threadId] = changed
      else delete queueEditDrafts[threadId]
      return { queueEditDrafts }
    }),
  setQueueEditDraft: (threadId, draft) => set((s) => ({ queueEditDrafts: { ...s.queueEditDrafts, [threadId]: draft } })),
  takeQueueEditDraft: (threadId, itemId) => {
    let taken: QueueEditDraft | undefined
    set((s) => {
      const draft = s.queueEditDrafts[threadId]
      if (!draft || draft.itemId !== itemId) return s
      taken = draft
      const queueEditDrafts = { ...s.queueEditDrafts }
      delete queueEditDrafts[threadId]
      return { queueEditDrafts }
    })
    return taken
  },
  setQueueDraftNotice: (threadId, shown) =>
    set((s) => {
      if (Boolean(s.queueDraftNotices[threadId]) === shown) return s
      const queueDraftNotices = { ...s.queueDraftNotices }
      if (shown) queueDraftNotices[threadId] = true
      else delete queueDraftNotices[threadId]
      return { queueDraftNotices }
    }),
  forgetQueueEdits: (threadIds) =>
    set((s) => {
      const queueEditDrafts = { ...s.queueEditDrafts }
      const queueDraftNotices = { ...s.queueDraftNotices }
      for (const threadId of threadIds) {
        delete queueEditDrafts[threadId]
        delete queueDraftNotices[threadId]
      }
      return { queueEditDrafts, queueDraftNotices }
    }),
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
      const earlier = snapshot.replace ? snapshot.earlier : undefined
      const had = s.activeThreadId ? s.earlierByThread[s.activeThreadId] : undefined
      // A replacement of a long thread's newest part (a resync) keeps the older pages this window loaded:
      // the rows before its boundary are not part of it, and the prompt stays where those pages left it.
      const boundary = earlier ? parseCursor(earlier.before).id : undefined
      const startsAtBoundary = boundary !== undefined && snapshot.messages.some((message) => message.id === boundary)
      const boundaryAt = startsAtBoundary ? s.messages.findIndex((message) => message.id === boundary) : -1
      const kept = boundaryAt > 0 ? s.messages.slice(0, boundaryAt) : []
      // A snapshot that repeats the transcript (a hydration or resync while a reply streams) keeps it as it is.
      const messages = sharedMessages(s.messages, snapshot.replace
        ? sortMessagesDeterministic([...kept, ...snapshot.messages.filter((message) => !kept.some((row) => row.id === message.id))])
        : reconcileMessageSnapshot(s.messages, snapshot.messages))
      if (s.activeThreadId) rememberMessages(s.activeThreadId, messages)
      // A replacement is the whole transcript unless it says what is left before it to load.
      const next = kept.length > 0 ? had : earlier
      if (snapshot.replace && s.activeThreadId && (had?.before !== next?.before || had?.count !== next?.count)) {
        const earlierByThread = { ...s.earlierByThread }
        if (next) earlierByThread[s.activeThreadId] = next
        else delete earlierByThread[s.activeThreadId]
        return { messages, earlierByThread, transcriptPending: false }
      }
      if (messages === s.messages && !s.transcriptPending) return s
      return { messages, transcriptPending: false }
    }),
  addMessage: (message) =>
    set((s) => {
      const messages = upsertMessage(s.messages, message)
      if (s.activeThreadId) rememberMessages(s.activeThreadId, messages)
      return { messages }
    }),
  dropMessage: (threadId, id) => {
    const kept = threadId ? messageCache.get(threadId) : undefined
    if (threadId && kept?.some((message) => message.id === id)) {
      const rest = kept.filter((message) => message.id !== id)
      // Nothing left is not a transcript to open from (see rememberMessages).
      if (rest.length > 0) messageCache.set(threadId, rest)
      else rememberMessages(threadId, rest)
    }
    set((s) => {
      if (s.activeThreadId !== threadId || !s.messages.some((message) => message.id === id)) return s
      const messages = s.messages.filter((message) => message.id !== id)
      if (s.activeThreadId) rememberMessages(s.activeThreadId, messages)
      return { messages }
    })
  },
  updateMessage: (message) =>
    set((s) => {
      const messages = applyMessageUpdate(s, s.messages, message)
      if (messages === s.messages) return s
      if (s.activeThreadId) rememberMessages(s.activeThreadId, messages)
      return { messages }
    }),
  updateMessages: (updates) =>
    set((s) => {
      let messages = s.messages
      for (const message of updates) messages = applyMessageUpdate(s, messages, message)
      if (messages === s.messages) return s
      if (s.activeThreadId) rememberMessages(s.activeThreadId, messages)
      return { messages }
    }),
  // Pushed again with each change of the thread's run, mostly as they were: a repeat changes nothing.
  setAgents: (agents) => set((s) => (samePlainData(s.agents, agents) ? s : { agents })),
  setTasks: (tasks) => set((s) => (samePlainData(s.tasks, tasks) ? s : { tasks })),
  setMainAreaWidth: (width) => set({ mainAreaWidth: savedMainAreaWidth(width) }),
  setThreadsSidebarWidth: (threadsSidebarWidth) => set({ threadsSidebarWidth }),
  setSettingsOpen: (settingsOpen) => set(settingsOpen ? { settingsOpen, scheduledOpen: false, usageOpen: false } : { settingsOpen }),
  setScheduledOpen: (scheduledOpen) => set(scheduledOpen ? { scheduledOpen, settingsOpen: false, usageOpen: false } : { scheduledOpen }),
  setLoading: (loading) => set({ loading }),
  setAppInfo: (appInfo) => set({ appInfo }),
  setThreadsSidebarOpen: (threadsSidebarOpen) => set({ threadsSidebarOpen }),
  setMainAreaOpen: (mainAreaOpen) => set({ mainAreaOpen }),
  setSideCardOn: (sideCardOn) => set({ sideCardOn }),
  setSideCardFits: (sideCardFits) => set({ sideCardFits }),
  setSideCardOverlayOpen: (sideCardOverlayOpen) => set({ sideCardOverlayOpen }),
  setSideCardSectionCollapsed: (key, collapsed) => set((s) => ({ sideCardCollapsed: { ...s.sideCardCollapsed, [key]: collapsed } })),
  setChatsSidebarSectionCollapsed: (key, collapsed) => set((s) => ({ chatsSidebarCollapsed: { ...s.chatsSidebarCollapsed, [key]: collapsed } })),
  setTurnState: (state) => set((s) => {
    const request = s.stopRequests[state.threadId]
    if (!request) {
      // The same state again (it also comes with each whole-map push): nothing that reads it renders.
      const held = s.turnStates[state.threadId]
      if (held && samePlainData(held, state)) return s
      return { turnStates: { ...s.turnStates, [state.threadId]: state } }
    }
    const next = applyDaemonTurnState(request, state)
    const stopRequests = { ...s.stopRequests }
    if (next.request) stopRequests[state.threadId] = next.request
    else delete stopRequests[state.threadId]
    return next.shown ? { stopRequests, turnStates: { ...s.turnStates, [state.threadId]: next.shown } } : { stopRequests }
  }),
  setTurnSnapshot: (snap) => set((s) => {
    const turnStates = { ...snap }
    const stopRequests: Record<string, StopRequest> = {}
    for (const [threadId, request] of Object.entries(s.stopRequests)) {
      const state = snap[threadId]
      if (!state) continue
      const next = applyDaemonTurnState(request, state)
      if (next.request) {
        stopRequests[threadId] = next.request
        turnStates[threadId] = s.turnStates[threadId] ?? state
      }
    }
    // Each push is every thread's turn: threads whose turn did not change keep their state object.
    const sharedTurns = sharedEntries(s.turnStates, turnStates)
    const sharedStops = sharedEntries(s.stopRequests, stopRequests)
    if (sharedTurns === s.turnStates && sharedStops === s.stopRequests) return s
    return { turnStates: sharedTurns, stopRequests: sharedStops }
  }),
  markStopRequested: (threadId) => {
    const current = get().turnStates[threadId]
    const shown = stoppedAtClick(current)
    if (!current || !shown) return undefined
    const requestedAt = Date.now()
    set((s) => ({
      turnStates: { ...s.turnStates, [threadId]: shown },
      stopRequests: { ...s.stopRequests, [threadId]: { turnId: current.turnId, daemon: current, requestedAt } }
    }))
    return requestedAt
  },
  revertStopRequest: (threadId, requestedAt) => set((s) => {
    const request = s.stopRequests[threadId]
    if (!request || (requestedAt !== undefined && request.requestedAt !== requestedAt)) return {}
    const stopRequests = { ...s.stopRequests }
    delete stopRequests[threadId]
    return { stopRequests, turnStates: { ...s.turnStates, [threadId]: request.daemon } }
  }),
  setActiveThreadId: (activeThreadId) => set({ activeThreadId }),
  switchToThread: (id, options) =>
    set((s) => {
      const workspace = options?.keepWorkspace ? {} : { sidebarMode: 'projects' as const }
      // The main process's echo of the thread being opened: it is still held for its view.
      if (options?.keepWorkspace && s.openingThreadId === id) return s
      const opening = s.openingThreadId ? { openingThreadId: null } : {}
      if (s.activeThreadId === id) return options?.keepWorkspace && !s.openingThreadId ? s : { ...workspace, ...opening }
      return { ...workspace, ...switchPatch(s, id, options?.carry) }
    }),
  applyThreadView: (view) =>
    set((current) => {
      // The held thread's view shows it, with its messages, in this one update.
      const opened = current.openingThreadId === view.threadId ? switchPatch(current, view.threadId) : null
      const s = opened ? { ...current, ...opened } : current
      if (s.activeThreadId !== view.threadId) return current
      // The first view of the warm start's thread replaces what it showed, keeping only what arrived live since.
      const warm = warmTranscript?.threadId === view.threadId ? warmTranscript.messages : null
      if (warm) warmTranscript = null
      const reconciled = reconcileMessageSnapshot(warm ? s.messages.filter((message) => !warm.has(message)) : s.messages, view.messages)
      rememberMessages(view.threadId, reconciled)
      const messagesUnchanged = sameMessageSnapshot(s.messages, reconciled)
      const agents = view.agents && !samePlainData(view.agents, s.agents) ? view.agents : s.agents
      const tasks = view.tasks && !samePlainData(view.tasks, s.tasks) ? view.tasks : s.tasks
      // A view with older messages left out says so; one without them has the whole transcript.
      const had = s.earlierByThread[view.threadId]
      // Older messages this window already loaded stay: a view that stops at the same boundary again
      // (a reconnect) does not bring the "load earlier" prompt back for them.
      // This window keeps one message per id (`reconcileMessageSnapshot`), so the boundary is found by the cursor's id.
      const boundary = view.earlier ? parseCursor(view.earlier.before).id : undefined
      const loadedBeyond = Boolean(had && boundary !== undefined && s.messages.findIndex((message) => message.id === boundary) > 0)
      const next = loadedBeyond ? had : view.earlier
      let earlierByThread = s.earlierByThread
      if (had?.before !== next?.before || had?.count !== next?.count) {
        earlierByThread = { ...s.earlierByThread }
        if (next) earlierByThread[view.threadId] = next
        else delete earlierByThread[view.threadId]
      }
      const settled = s.openingCueThreadId === view.threadId || s.transcriptFailed?.threadId === view.threadId
      if (!opened && !settled && messagesUnchanged && agents === s.agents && tasks === s.tasks && earlierByThread === s.earlierByThread && !s.transcriptPending) return s
      return {
        ...opened,
        ...(settled ? { openingCueThreadId: null, transcriptFailed: null } : {}),
        messages: messagesUnchanged ? s.messages : reconciled,
        agents,
        tasks,
        earlierByThread,
        transcriptPending: false
      }
    }),
  setProjects: (projects) => set({ projects }),
  setThreads: (incoming) =>
    set((state) => {
      // A model pick still being saved stays as picked: a list read or pushed before it must not undo it.
      const threads = withHeldModelPicks(incoming)
      return sameThreadSnapshot(state.threads, threads) ? state : { threads }
    }),
  upsertThread: (thread) =>
    set((s) => {
      const idx = s.threads.findIndex((entry) => entry.id === thread.id)
      if (idx === -1) return { threads: [...s.threads, thread] }
      const threads = s.threads.slice()
      threads[idx] = thread
      return { threads }
    }),
  applyThreadTouches: (touches) =>
    set((s) => {
      let threads: Thread[] | undefined
      for (const touch of touches) {
        const index = s.threads.findIndex((entry) => entry.id === touch.id)
        const current = index === -1 ? undefined : (threads ?? s.threads)[index]
        if (!current || !(Date.parse(touch.updatedAt) > Date.parse(current.updatedAt))) continue
        threads ??= s.threads.slice()
        threads[index] = { ...current, updatedAt: touch.updatedAt }
      }
      return threads ? { threads } : s
    }),
  // Each push is every thread's activity: one that repeats the map held changes nothing. An idle thread and one not
  // listed read the same everywhere, and the window gets both forms of each change (its own tracker's map, which
  // leaves idle threads out, then the service's, which lists them), so idle threads are left out here too.
  setThreadActivity: (activity) => set((s) => {
    const threadActivity = sharedEntries(s.threadActivity, withoutIdleThreads(activity))
    return threadActivity === s.threadActivity ? s : { threadActivity }
  }),
  setMainView: (mainView) => set({ mainView, sidebarMode: 'projects' }),
  addProjectTerminalTab: (ownerThreadId) => {
    const id = crypto.randomUUID()
    const key = ownerThreadId ?? '__standalone__'
    // The tab strip numbers plain terminals by position (`surfaceTabItems`).
    set((s) => ({
      projectTerminalTabs: [
        ...s.projectTerminalTabs,
        { id, ownerThreadId, ptyId: null, title: 'Terminal', exited: false }
      ],
      activeProjectTerminalTabByThread: {
        ...s.activeProjectTerminalTabByThread,
        [key]: id
      }
    }))
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
      activeDocumentTabByThread: { ...s.activeDocumentTabByThread, [s.activeThreadId ?? STANDALONE_KEY]: id },
      mainView: 'documents'
    }))
    return id
  },
  openAppletDocument: (threadId, reference) => {
    const state = get()
    const open = state.documentTabs.find((tab) =>
      tab.applet?.threadId === threadId &&
      tab.applet.profileId === state.profileId &&
      tab.applet.reference.revisionId === reference.revisionId)
    const id = open?.id ?? crypto.randomUUID()
    set((s) => ({
      documentTabs: open
        ? s.documentTabs
        : [...s.documentTabs, { id, title: reference.title, markdown: '', applet: { threadId, profileId: s.profileId, reference } }],
      activeDocumentTabByThread: { ...s.activeDocumentTabByThread, [threadId]: id },
      mainView: 'documents',
      mainAreaOpen: true
    }))
    return id
  },
  openTurnFileDiff: (threadId, path, title) => {
    const state = get()
    const open = state.documentTabs.find((tab) =>
      tab.turnFile?.threadId === threadId && tab.turnFile.profileId === state.profileId && tab.turnFile.path === path)
    const id = open?.id ?? crypto.randomUUID()
    set((s) => ({
      documentTabs: open
        ? s.documentTabs
        : [...s.documentTabs, { id, title, markdown: '', turnFile: { threadId, profileId: s.profileId, path } }],
      activeDocumentTabByThread: { ...s.activeDocumentTabByThread, [threadId]: id },
      mainView: 'documents',
      mainAreaOpen: true
    }))
    return id
  },
  closeDocumentTab: (tabId) =>
    set((s) => {
      if (!s.documentTabs.some((tab) => tab.id === tabId)) return s
      // The next tab comes from the same thread's tabs, as the panel shows them.
      const shown = documentTabsForThread(s.documentTabs, s.activeThreadId)
      const index = shown.findIndex((tab) => tab.id === tabId)
      const documentTabs = s.documentTabs.filter((tab) => tab.id !== tabId)
      const remaining = shown.filter((tab) => tab.id !== tabId)
      const key = s.activeThreadId ?? STANDALONE_KEY
      const activeDocumentTabByThread = Object.fromEntries(
        Object.entries(s.activeDocumentTabByThread).filter(([, id]) => id !== tabId)
      )
      if (s.activeDocumentTabByThread[key] === tabId && index !== -1) {
        const next = remaining[Math.min(index, remaining.length - 1)]
        if (next) activeDocumentTabByThread[key] = next.id
      }
      return {
        documentTabs,
        activeDocumentTabByThread,
        mainView: remaining.length === 0 && s.mainView === 'documents'
          ? s.openedSurfaceKinds[0] ?? DEFAULT_MAIN_VIEW
          : s.mainView
      }
    }),
  setActiveDocumentTab: (tabId) => set((s) => ({
    activeDocumentTabByThread: { ...s.activeDocumentTabByThread, [s.activeThreadId ?? STANDALONE_KEY]: tabId }
  })),
  setChatMode: (chatMode) => set({ chatMode }),
  activateProfile: (profileId) => set((state) => {
    if (!profileId) return state
    if (profileActivated && profileId === state.profileId) return state
    // The trusted binding names the profile the warm start showed: what is on screen stays, and the service's
    // lists and transcript replace it as they arrive.
    const keepsWarmView = !profileActivated && state.warmView?.profileId === profileId
    if (profileActivated) savePersonalWorkspace(state)
    profileActivated = true
    messageCache.clear()
    messageCacheOrder.splice(0)
    openingEarly = null
    if (keepsWarmView) {
      return {
        ...state,
        profileId,
        usageOpen: false,
        profileReady: true,
        workspaceReady: false,
        shortcuts: {},
        notifyBotThreads: false,
        paletteOpen: false,
        newProjectOpen: false
      }
    }
    warmTranscript = null
    return {
      ...state,
      profileId,
      usageOpen: false,
      profileReady: true,
      workspaceReady: false,
      warmView: null,
      warmSendThreadId: null,
      // Another profile's shortcuts must not stay bound until its own settings arrive.
      shortcuts: {},
      notifyBotThreads: false,
      paletteOpen: false,
      newProjectOpen: false,
      ...personalWorkspaceOf(profileId),
      queueDraftNotices: {},
      messages: [],
      transcriptPending: false,
      openingThreadId: null,
      openingCueThreadId: null,
      transcriptFailed: null,
      agents: [],
      tasks: [],
      activeThreadId: null,
      projects: [],
      threads: [],
      threadActivity: {},
      subagentsByParent: {},
      removedSubagentsByParent: {},
      backgroundWorkByThread: {},
      turnStates: {},
      stopRequests: {},
      documentTabs: [],
      activeDocumentTabByThread: {},
      loading: false
    }
  }),
  addBrowserTab: (ownerThreadId) => {
    const id = crypto.randomUUID()
    browserTabsOpenedThisSession.add(id)
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
      browserTabsOpenedThisSession.add(id)
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
  closeThreadBrowserTabs: (threadIds) =>
    set((s) => {
      const owners = new Set(threadIds)
      const browserTabs = s.browserTabs.filter((tab) => tab.ownerThreadId === null || !owners.has(tab.ownerThreadId))
      if (browserTabs.length === s.browserTabs.length) return s
      const browserActiveTabByThread = { ...s.browserActiveTabByThread }
      for (const threadId of owners) delete browserActiveTabByThread[threadId]
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
}))), {
  name: 'mousse-workspace-state',
  version: 1,
  storage: workspaceStorage,
  partialize: (state) => ({
    // Personal workspace state is written under mousse-profile-<id>-workspace
    // after profile activation; keeping it out of this installation-wide key prevents
    // a stale profile's tabs/drafts from being hydrated before daemon binding.
  })
}))

// Persist active workspace changes, debouncing only keystroke edits to `composerDrafts` so typing
// never blocks the main thread with a synchronous JSON.stringify + localStorage.setItem per key.
// Clearing a draft (e.g. on send), profile switches, other workspace edits, and window close/hide flush immediately.
useAppStore.subscribe((state, previous) => {
  if (!profileActivated) return
  if (state.profileId !== previous.profileId) {
    savePersonalWorkspace(state)
    return
  }
  let otherChanged = false
  for (const key of personalWorkspaceKeys) {
    if (key !== 'composerDrafts' && state[key] !== previous[key]) {
      otherChanged = true
      break
    }
  }
  if (otherChanged) {
    savePersonalWorkspace(state)
    return
  }
  if (state.composerDrafts === previous.composerDrafts) return
  const cleared = Object.keys(previous.composerDrafts).some(
    (key) => !(key in state.composerDrafts) || (previous.composerDrafts[key] && !state.composerDrafts[key])
  )
  if (cleared) {
    savePersonalWorkspace(state)
    lastDraftSaveAt = 0
  } else scheduleDraftWorkspaceSave(state)
})

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', flushPersonalWorkspaceSave)
  window.addEventListener('pagehide', flushPersonalWorkspaceSave)
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) flushPersonalWorkspaceSave()
    })
  }
}

/**
 * This computer's threads that left the thread list (deleted for good). A list that becomes empty, one of
 * another profile, and threads of the user's other computers (which leave the list while that computer is
 * away) are not taken for deletions.
 */
export function deletedThreadIds(previous: AppState, state: AppState): string[] {
  if (state.threads === previous.threads || state.profileId !== previous.profileId || state.threads.length === 0) return []
  const kept = new Set(state.threads.map((thread) => thread.id))
  return previous.threads.map((thread) => thread.id).filter((id) => !kept.has(id) && !isQualifiedId(id))
}

// A deleted thread's open edit of a queued message and its notice go with it.
useAppStore.subscribe((state, previous) => {
  const gone = deletedThreadIds(previous, state).filter((id) => id in state.queueEditDrafts || id in state.queueDraftNotices)
  if (gone.length) state.forgetQueueEdits(gone)
})

/** Threads archived since the last list: they were listed without `archivedAt` and now have it. */
export function newlyArchivedThreadIds(previous: AppState, state: AppState): string[] {
  if (state.threads === previous.threads || state.profileId !== previous.profileId) return []
  const wasOpen = new Set(previous.threads.filter((thread) => !thread.archivedAt).map((thread) => thread.id))
  return state.threads.filter((thread) => thread.archivedAt && wasOpen.has(thread.id)).map((thread) => thread.id)
}

// An archived or deleted thread's browser tabs close, so their pages stop using memory.
useAppStore.subscribe((state, previous) => {
  const gone = [...deletedThreadIds(previous, state), ...newlyArchivedThreadIds(previous, state)]
  if (gone.length && state.browserTabs.some((tab) => tab.ownerThreadId !== null && gone.includes(tab.ownerThreadId))) {
    state.closeThreadBrowserTabs(gone)
  }
})

/**
 * The side card overlay is temporary: it closes when the thread area widens
 * enough to dock the card (the card's switch stays on), when the thread changes,
 * when the app panel opens, and when a view without a thread replaces the
 * conversation (Chats counts as one unless a bot's thread shows in its pane,
 * `botThreadShown`, the same test the card's visibility uses). A narrow window
 * therefore never opens it by itself. The store subscriptions that apply this
 * live in sideCardLogic.ts, which can read the bot's pane.
 */
export function shouldCloseSideCardOverlay(state: AppState, previous: AppState, botThreadShown = false): boolean {
  if (!state.sideCardOverlayOpen) return false
  return state.sideCardFits !== false
    || state.mainAreaOpen
    || state.activeThreadId !== previous.activeThreadId
    || state.settingsOpen
    || state.usageOpen
    || state.scheduledOpen
    || (state.sidebarMode === 'chats' && !botThreadShown)
}

// The Automations inbox in the window: what the daemon says (the automations, the runs, the Needs you queue, Tuning
// notes, this month's usage, the project dots) and what the page shows (the filter, the open run, the pane).
import { create } from 'zustand'
import type { AutomationIndex } from '../../../../shared/automations'
import type { AutomationInbox, InboxCounts, InboxRun, TuningNote } from '../../../../shared/automationInbox'
import type { TurnPhase, TurnState } from '../../../../shared/types'
import { createAutomationsClient, type AutomationsClient } from '../../../services/automationsClient'
import { useAppStore } from '../../../stores/appStore'

/** What narrows the Runs list: one automation, one project group, words. */
export interface InboxFilter {
  automationId?: string
  /** A project group of the Chats sidebar: its name and the ids of this computer's projects in it. */
  project?: { name: string; projectIds: string[] }
  text?: string
}

/** What the pane beside the list shows: a run's thread (in the workspace), Manage, Edit details or the drafts. */
export type InboxPane = 'run' | 'manage' | 'edit' | 'drafts'

interface InboxState {
  index: AutomationIndex | null
  inbox: AutomationInbox | null
  counts: InboxCounts | null
  loadError: string | null
  /** When the daemon was last read, to read again only when the copy is old. */
  loadedAt: number
  filter: InboxFilter
  openRunId: string | null
  pane: InboxPane
  /** The Manage row showing its Tuning notes. */
  manageExpanded: string | null
  /** The automation Edit details shows. */
  editJobId: string | null
  folds: { bots: boolean; quiet: boolean }
  actionError: string | null
  /** The person's last words to a manager, and how its answer is going (the Drafts pane shows it). */
  composing: ManagerRequest | null
}

/**
 * Words sent to a manager (the Automation manager, or a bot). The manager's turn can take minutes, so the send is
 * watched here instead of awaited by the composer: `working` until the turn ends, then `done`, `failed` or `stopped`.
 */
export interface ManagerRequest {
  at: number
  /** The manager's hidden thread; absent for a bot. */
  threadId?: string
  /** The run the send committed (`await: 'ack'`): the turn whose outcome this request waits for. */
  runId?: string
  /** The queued message, when the send waits behind an earlier turn: Stop takes it out of the queue. */
  queueItemId?: string
  /** The profile it was sent from: it is kept, and brought back, under that profile only. */
  profileId?: string
  /** Held by a usage limit: its turn goes on when the limit resets. */
  waiting?: boolean
  botId?: string
  /** What was sent, for Retry and Edit. */
  text: string
  projectId?: string
  projectName?: string
  who?: string
  /** The draft the words were about (an answer to its question): no new draft is expected. */
  draftId?: string
  status: 'working' | 'done' | 'failed' | 'stopped'
  error?: string
  /** The drafts there were when the words went out; any other draft is the one this request made. */
  known: string[]
}

export const useInboxStore = create<InboxState>(() => ({
  index: null,
  inbox: null,
  counts: null,
  loadError: null,
  loadedAt: 0,
  filter: {},
  openRunId: null,
  pane: 'run',
  manageExpanded: null,
  editJobId: null,
  folds: { bots: false, quiet: false },
  actionError: null,
  composing: null
}))

let client: AutomationsClient | null = null
function inboxClient(): AutomationsClient {
  client ??= createAutomationsClient(window.mousse.platformRequest)
  return client
}

/** For tests: a client that does not go through the window's bridge. */
export function setInboxClient(next: AutomationsClient | null): void {
  client = next
}

export const errorText = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (cause && typeof cause === 'object' && typeof (cause as { message?: unknown }).message === 'string') return (cause as { message: string }).message
  return String(cause)
}

let reading: Promise<void> | null = null

/** Reads the automations, the runs and the dots again; reads in flight are shared. */
export function refreshInbox(): Promise<void> {
  if (reading) return reading
  const api = inboxClient()
  reading = Promise.all([api.list(), api.inbox(), api.counts()])
    .then(([index, inbox, counts]) => {
      useInboxStore.setState({ index, inbox, counts, loadError: null, loadedAt: Date.now() })
      // A bot answers in its own chat, with no turn to watch here: its request is done once its draft shows.
      const request = useInboxStore.getState().composing
      if (request?.status === 'working' && request.botId && newDrafts(request, index).length) updateRequest(request.at, { status: 'done' })
    })
    .catch((cause) => {
      useInboxStore.setState({ loadError: errorText(cause) })
    })
    .finally(() => {
      reading = null
    })
  return reading
}

/** Only the project dots: the Chats sidebar reads them without the rest. */
export async function refreshCounts(): Promise<void> {
  try {
    useInboxStore.setState({ counts: await inboxClient().counts() })
  } catch {
    // The dots keep their last numbers.
  }
}

/** Reads again unless the copy is newer than `maxAgeMs`. */
export function refreshIfOld(maxAgeMs = 10_000): Promise<void> {
  return Date.now() - useInboxStore.getState().loadedAt > maxAgeMs ? refreshInbox() : Promise.resolve()
}

async function act(work: (api: AutomationsClient) => Promise<unknown>): Promise<void> {
  useInboxStore.setState({ actionError: null })
  try {
    await work(inboxClient())
  } catch (cause) {
    useInboxStore.setState({ actionError: errorText(cause) })
  }
  await refreshInbox()
}

/** The drafts a request made: the drafts now that were not there when its words went out. */
export function newDrafts(request: Pick<ManagerRequest, 'known'> | null, index: AutomationIndex | null): string[] {
  if (!request || !index) return []
  return index.items.filter((item) => item.kind === 'job' && item.draft && !request.known.includes(item.id)).map((item) => item.id)
}

/** Changes the request sent at `at`, unless newer words replaced it. */
export function updateRequest(at: number, patch: Partial<ManagerRequest>): void {
  useInboxStore.setState((state) => (state.composing?.at === at ? { composing: { ...state.composing, ...patch } } : {}))
}

/**
 * The manager's turn ended: with an error, or done. The list is read first, so a draft it wrote (even one written
 * before it failed) is there when the pending line goes. A Stop the person pressed stays a Stop.
 */
export async function settleRequest(at: number, error?: string): Promise<void> {
  await refreshInbox()
  const request = useInboxStore.getState().composing
  if (request?.at !== at || request.status !== 'working') return
  if (error) updateRequest(at, { status: 'failed', error })
  else if (request.draftId) useInboxStore.setState({ composing: null })
  else updateRequest(at, { status: 'done' })
}

/**
 * Stop: only this request's run. A send still queued behind an earlier turn is taken out of the queue; one whose turn
 * runs is aborted (a thread runs one turn at a time, so that turn is its). When neither can be confirmed, the request
 * keeps showing as working rather than claiming a Stop that did not happen.
 */
export async function stopRequest(): Promise<void> {
  const request = useInboxStore.getState().composing
  if (!request || request.status !== 'working' || !request.threadId) return
  const { at, threadId } = request
  try {
    if (request.queueItemId && await window.mousse.queue.remove(threadId, request.queueItemId)) return updateRequest(at, { status: 'stopped' })
    const turn = request.runId ? await inboxClient().managerTurn(request.runId) : undefined
    if (turn && turn.status !== 'working' && turn.status !== 'paused') return void await checkRequest(at)
    if (turn || !request.runId) {
      await window.mousse.orchestrator.abort(threadId)
      updateRequest(at, { status: 'stopped' })
    }
  } catch {
    // Not stopped: it still shows as working, and the watch reads how it ends.
  }
}

export function dismissRequest(): void {
  useInboxStore.setState({ composing: null })
}

// ── Watching the manager's turn ──────────────────────────────────────────────────────────────────────
// The send answers once its run is committed (`await: 'ack'`), so the turn's outcome comes from the thread's turn
// events. The run is also read when the watch starts (a turn that ended before it subscribed), every few seconds
// as a safety net (a turn that failed before it showed a phase), and when the page opens again after a reload.

/** How often a working request reads its run, in case no turn event says it ended. */
export const REQUEST_POLL_MS = 5_000
/** After this many failed reads of the run in a row, the watch asks only whether the thread still works. */
export const REQUEST_READ_FAILURES = 3
/** A request older than this is given up on (a hung run), and not brought back after a reload. */
export const REQUEST_KEEP_MS = 2 * 60 * 60 * 1000
const ENDED_PHASES = new Set<TurnPhase>(['completed', 'failed', 'stopped'])

/** A turn's error as the person reads it: without the `[code]` the engine puts in front. */
export function turnErrorText(error: string | undefined): string {
  return error?.replace(/^\[[a-z0-9_.-]+\]\s*/i, '').trim() || 'The Automation manager stopped with an error.'
}

let offTurnState: (() => void) | null = null
let pollTimer: ReturnType<typeof setTimeout> | null = null
let watching: number | null = null
let readFailures = 0

function stopWatching(): void {
  offTurnState?.()
  offTurnState = null
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  watching = null
  readFailures = 0
}

/** The turn of the request (its run), from one turn event: ended or not. Another turn of the thread is not its. */
function onTurnState(state: TurnState): void {
  const request = useInboxStore.getState().composing
  if (!request || request.status !== 'working' || state.threadId !== request.threadId) return
  if (request.runId && state.turnId !== request.runId) return
  // A usage limit holds the turn: it goes on when the limit resets, so the request waits with it.
  if (state.phase === 'paused') return updateRequest(request.at, { waiting: true })
  if (!ENDED_PHASES.has(state.phase)) return void (request.waiting ? updateRequest(request.at, { waiting: false }) : undefined)
  if (state.phase === 'stopped') updateRequest(request.at, { status: 'stopped' })
  else void settleRequest(request.at, state.phase === 'failed' ? turnErrorText(state.error) : undefined)
}

/** Whether the thread still works, for a request with no run to read: done once it is idle. */
async function checkThread(at: number, threadId: string): Promise<void> {
  const active = await window.mousse.orchestrator.isTurnActive(threadId).catch(() => true)
  if (!active) await settleRequest(at)
}

/**
 * Reads the request's run once and settles it if it ended. A run that cannot be read (an older service, say) is read
 * a few times, then the watch asks only whether the thread still works. A request that outlived its keep is given up.
 */
export async function checkRequest(at: number): Promise<void> {
  const request = useInboxStore.getState().composing
  if (!request || request.at !== at || request.status !== 'working' || !request.threadId) return
  if (Date.now() - at > REQUEST_KEEP_MS) return void await settleRequest(at, 'No answer from the Automation manager. Open its chat to see where it stopped.')
  if (!request.runId || readFailures >= REQUEST_READ_FAILURES) return checkThread(at, request.threadId)
  let turn
  try {
    turn = await inboxClient().managerTurn(request.runId)
    readFailures = 0
  } catch {
    readFailures += 1
    return
  }
  if (turn.status === 'working' || turn.status === 'queued') return void (request.waiting ? updateRequest(at, { waiting: false }) : undefined)
  if (turn.status === 'paused') return updateRequest(at, { waiting: true })
  if (turn.status === 'completed') return void await settleRequest(at)
  if (turn.status === 'failed') return void await settleRequest(at, turnErrorText(turn.error))
  if (turn.status === 'stopped') return updateRequest(at, { status: 'stopped' })
  // Unknown to the service (it restarted): done once the thread is idle.
  await checkThread(at, request.threadId)
}

/** Watches the working request: its turn events, one read now, and a read every few seconds until it ends. */
export function watchRequest(): void {
  const request = useInboxStore.getState().composing
  if (!request || request.status !== 'working' || !request.threadId) { stopWatching(); return }
  if (watching === request.at) return
  stopWatching()
  watching = request.at
  offTurnState = window.mousse.orchestrator.onTurnState?.(onTurnState) ?? null
  const at = request.at
  const poll = () => {
    pollTimer = setTimeout(() => {
      if (watching !== at) return
      void checkRequest(at).finally(() => { if (watching === at && useInboxStore.getState().composing?.status === 'working') poll() })
    }, REQUEST_POLL_MS)
  }
  void checkRequest(at)
  poll()
}

/** Starts a request: shown at once, kept across a reload for the profile it was sent from, and watched until it ends. */
export function startRequest(request: ManagerRequest): void {
  useInboxStore.setState({ composing: { ...request, profileId: request.profileId ?? useAppStore.getState().profileId } })
  watchRequest()
}

const requestKey = (profileId: string) => `mousse.automations.request.${profileId}`

/** The request a reload left, for this profile: still working, or failed (its error is not lost). */
export function loadRequest(profileId: string): ManagerRequest | null {
  try {
    const raw = globalThis.localStorage?.getItem(requestKey(profileId))
    const request = raw ? JSON.parse(raw) as ManagerRequest : null
    if (!request || typeof request.at !== 'number' || Date.now() - request.at > REQUEST_KEEP_MS) return null
    if (request.profileId && request.profileId !== profileId) return null
    return request.status === 'working' || request.status === 'failed' ? request : null
  } catch {
    return null
  }
}

function saveRequest(profileId: string, request: ManagerRequest | null): void {
  try {
    if (request && (request.status === 'working' || request.status === 'failed')) globalThis.localStorage?.setItem(requestKey(profileId), JSON.stringify(request))
    else globalThis.localStorage?.removeItem(requestKey(profileId))
  } catch {
    // A request that cannot be kept is only lost on a reload.
  }
}

/** The page opened for a profile: its request comes back from before a reload, and is watched again. */
let switchingProfile = false
export function restoreRequest(profileId: string): void {
  // The other profile's request stays saved under its own key: only this page's view of it goes.
  switchingProfile = true
  try { useInboxStore.setState({ composing: loadRequest(profileId) }) } finally { switchingProfile = false }
  watchRequest()
}

// A request is kept under the profile it was sent from, whatever profile is current when it changes or ends.
useInboxStore.subscribe((state, previous) => {
  if (state.composing === previous.composing) return
  const next = state.composing
  const last = previous.composing
  if (last?.profileId && last.at !== next?.at && !switchingProfile) saveRequest(last.profileId, null)
  const owner = next?.profileId ?? (switchingProfile ? undefined : last?.profileId)
  if (owner) saveRequest(owner, next)
  if (next?.status !== 'working') stopWatching()
})

export function setInboxFilter(filter: InboxFilter): void {
  useInboxStore.setState({ filter, pane: 'run', manageExpanded: null })
}

/** The threads the inbox opened, so leaving the page can give Chats back the thread it had. */
const openedByInbox = new Set<string>()
let before: { threadId: string | null; sidebarMode: 'projects' | 'chats' } | null = null

/** The page opened: remember what Chats showed. */
export function inboxPageOpened(): void {
  const app = useAppStore.getState()
  before = { threadId: app.activeThreadId, sidebarMode: app.sidebarMode }
}

/** The page closed: a run's thread the inbox opened gives way to the thread Chats had. */
export function inboxPageClosed(): void {
  const app = useAppStore.getState()
  const saved = before
  before = null
  if (!saved || !app.activeThreadId || !openedByInbox.has(app.activeThreadId)) return
  openedByInbox.clear()
  if (saved.threadId && saved.threadId !== app.activeThreadId) {
    app.switchToThread(saved.threadId)
    void window.mousse.threads.select(saved.threadId).catch(() => undefined)
  }
  if (saved.sidebarMode !== useAppStore.getState().sidebarMode) useAppStore.getState().setSidebarMode(saved.sidebarMode)
}

/** Opens a run: its thread shows in the workspace beside the list, as the ordinary thread view. Nothing is resolved. */
export function openRun(run: Pick<InboxRun, 'id' | 'threadId'>): void {
  useInboxStore.setState({ openRunId: run.id, pane: 'run', manageExpanded: null })
  if (!run.threadId) return
  const app = useAppStore.getState()
  if (app.activeThreadId === run.threadId) return
  openedByInbox.add(run.threadId)
  app.switchToThread(run.threadId)
  void window.mousse.threads.select(run.threadId).catch(() => undefined)
}

export function openManage(expanded: string | null = null): void {
  useInboxStore.setState({ pane: 'manage', manageExpanded: expanded })
}

export function toggleTuning(jobId: string): void {
  useInboxStore.setState((state) => ({ pane: 'manage', manageExpanded: state.manageExpanded === jobId ? null : jobId }))
}

export function openEdit(jobId: string): void {
  useInboxStore.setState({ pane: 'edit', editJobId: jobId })
}

export function openDrafts(): void {
  useInboxStore.setState({ pane: 'drafts' })
}

export function closePane(): void {
  useInboxStore.setState({ pane: 'run', manageExpanded: null, editJobId: null })
}

export function toggleFold(fold: 'bots' | 'quiet'): void {
  useInboxStore.setState((state) => ({ folds: { ...state.folds, [fold]: !state.folds[fold] } }))
}

export const resolveRun = (runId: string) => act((api) => api.resolve(runId))
export const undoResolve = () => act((api) => api.undo())
export const calibrateRun = (runId: string, kind: TuningNote['kind']) => act((api) => api.calibrate(runId, kind))
export const removeTuning = (noteId: string) => act((api) => api.removeTuning(noteId))
export const runAutomationNow = (jobId: string) => act(() => window.mousse.scheduled.run(jobId))

/** The Chats sidebar's project dot: the Runs list, filtered to the project group. */
export function openProjectRuns(project: { name: string; projectIds: string[] }): void {
  setInboxFilter({ project })
  useAppStore.getState().setScheduledOpen(true)
}

/** Opens the inbox filtered to one automation (a chat card's Open). */
export function openAutomationRuns(jobId: string): void {
  setInboxFilter({ automationId: jobId })
  useAppStore.getState().setScheduledOpen(true)
}

/** Whether the workspace shows the open run's thread beside the list (the App lays itself out by it). */
export function useInboxShowsThread(): boolean {
  return useInboxStore((state) => {
    if (state.pane !== 'run' || !state.openRunId) return false
    return Boolean(state.inbox?.runs.find((run) => run.id === state.openRunId)?.threadId)
  })
}

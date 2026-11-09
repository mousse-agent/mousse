// The Automations inbox in the window: what the daemon says (the automations, the runs, the Needs you queue, Tuning
// notes, this month's usage, the project dots) and what the page shows (the filter, the open run, the pane).
import { create } from 'zustand'
import type { AutomationIndex } from '../../../../shared/automations'
import type { AutomationInbox, InboxCounts, InboxRun, TuningNote } from '../../../../shared/automationInbox'
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
  /** The composer's words went to a manager: when, and the manager's hidden thread (absent for a bot). */
  composing: { at: number; threadId?: string } | null
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

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

let reading: Promise<void> | null = null

/** Reads the automations, the runs and the dots again; reads in flight are shared. */
export function refreshInbox(): Promise<void> {
  if (reading) return reading
  const api = inboxClient()
  reading = Promise.all([api.list(), api.inbox(), api.counts()])
    .then(([index, inbox, counts]) => {
      useInboxStore.setState({ index, inbox, counts, loadError: null, loadedAt: Date.now() })
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

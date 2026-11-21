import type { StartPullRequestThreadInput } from '../../shared/pullRequests'
import type { NodeId } from '../../shared/net'
import { expiryPresetMs } from '../../shared/threadExpiry'
import { composerWorkspaceFor, newThreadWorktree, rememberedChoiceOf, workspacePendingKey, workspaceWithPrivate } from './newThread'
import { openSubagentParentRow, visibleThreads } from '../../shared/threadLineage'
import { findUnstartedThread, isThreadStarted } from '../../shared/threadTitle'
import { isTurnActivePhase, type NewThreadChoice, type Project, type Thread } from '../../shared/types'
import { confirmNavigation } from '../services/navigationGuards'
import { useAppStore } from '../stores/appStore'
import { useChatsStore } from '../stores/chatsStore'
import { orderedThreadIds, threadAfterArchive } from './threadOrder'
import { afterNextPaint, newChatHeld, startingThreadIds } from './pendingThreadRows'
import { runWithToast } from './actionToast'
import { showProjectInSidebar } from './sidebarReveal'
import { markPendingArchive } from './archiveMotion'
import { loadProviderSnapshots, pickerListsModel, pickerProviders, projectScope, scopeKey, useProviderSnapshotsStore } from './providerSnapshots'

/**
 * How long a thread being opened waits for its view before it is shown without it. The service answers a thread's
 * newest page in a few milliseconds, but a busy computer can take a few hundred before main and this window get to
 * it; a thread on another computer can take seconds, and then shows waiting for its messages.
 */
export const OPEN_THREAD_HOLD_MS = 1000

/** Opens a thread in the main workspace after the navigation guards agree. */
export async function selectThread(threadId: string): Promise<void> {
  if (!await confirmNavigation()) return
  const store = useAppStore.getState()
  store.setSidebarMode('projects')
  // A page opened from the rail covers the workspace; the thread has to be visible.
  store.setScheduledOpen(false)
  store.setUsageOpen(false)
  await openAndSelect(threadId)
}

/**
 * Shows a thread and asks main to select it. Its row shows as chosen at once. A cached thread shows with its messages
 * once that frame has been drawn; a started one with nothing cached stays held until its view arrives
 * (`openThreadWhenReady`), so it never shows without them. `keepWorkspace`: Chats stays on screen (a bot's thread in its pane).
 */
export async function openAndSelect(threadId: string, options?: { keepWorkspace?: boolean }): Promise<void> {
  const store = useAppStore.getState()
  if (threadId === store.activeThreadId && !store.openingThreadId && !store.transcriptPending) {
    const thread = store.threads.find((entry) => entry.id === threadId)
    // A failed read can leave the row selected with an empty transcript. Opening it again asks the service again.
    if (store.messages.length > 0 || (thread && !isThreadStarted(thread))) return
  }
  const opening = store.openThreadWhenReady(threadId, options)
  if (opening === 'held') setTimeout(() => useAppStore.getState().showOpeningThread(threadId), OPEN_THREAD_HOLD_MS)
  if (opening === 'cached') void afterNextPaint().then(() => useAppStore.getState().showOpeningThread(threadId))
  await selectOrSettle(threadId)
}

let selectionRequest = 0

/** Asks main to select a thread the store already switched to. A failed select sends no view, so the chat stops waiting for one. */
export async function selectOrSettle(threadId: string): Promise<void> {
  const request = ++selectionRequest
  const { profileId } = useAppStore.getState()
  try {
    await window.mousse.threads.select(threadId)
  } catch (error) {
    const store = useAppStore.getState()
    if (selectionRequest === request && store.profileId === profileId) store.settleTranscript(threadId)
    throw error
  }
}

/**
 * Opens the newest empty draft thread, or creates one, and selects it, in the project last picked for a new thread
 * (`lastNewThreadProjectId`) while it is still listed. The sidebar stays on its tab. A private draft is never reused for it.
 */
export async function createAndSelectThread(): Promise<void> {
  const store = useAppStore.getState()
  // The project last picked for a new thread, while this computer still lists it.
  const remembered = store.lastNewThreadProjectId
  if (remembered && store.projects.some((project) => project.id === remembered && !project.node)) {
    await createAndSelectProjectThread(remembered)
    return
  }
  await openNoProjectThread()
}

/** The New thread picker's "No project": a thread on this computer without a project, remembered for the next new thread. */
export async function createAndSelectNoProjectThread(): Promise<void> {
  useAppStore.getState().setLastNewThreadProjectId(null)
  await openNoProjectThread()
}

async function openNoProjectThread(): Promise<void> {
  const store = useAppStore.getState()
  const thread = findUnstartedThread(draftCandidates(store).filter((entry) => !entry.localOnly)) ?? await window.mousse.threads.create()
  store.upsertThread(thread)
  await selectThread(thread.id)
}

/** Opens the newest empty private draft (`Thread.localOnly`), or creates one on this computer, and selects it. */
export async function createAndSelectPrivateThread(): Promise<void> {
  const store = useAppStore.getState()
  const thread =
    findUnstartedThread(draftCandidates(store).filter((entry) => entry.localOnly && !entry.node)) ??
    await window.mousse.threads.create(undefined, undefined, { localOnly: true })
  store.upsertThread(thread)
  // The command means private, with the private-chat expiry from Settings unless one was picked; a reused draft
  // may have had Private turned off in its composer.
  const draft = store.composerWorkspaceDrafts[thread.id]
  if (!draft?.localOnly) {
    const defaultMs = store.privateThreadExpiry === 'never' ? undefined : expiryPresetMs(store.privateThreadExpiry)
    const base = draft ?? composerWorkspaceFor(undefined, thread, store.projects)
    store.setComposerWorkspaceDraft(thread.id, workspaceWithPrivate(base, true, store.projects.filter((entry) => !entry.node), defaultMs))
  }
  await selectThread(thread.id)
}

/**
 * Whether an empty thread already starts with what its project remembers (`Project.newThread`), so reusing it gives the
 * same new thread a fresh one would. A field the project never picked, or the thread leaves to the default, matches.
 */
export function matchesRememberedChoices(thread: Pick<Thread, 'modelOverride' | 'permissionMode' | 'worktreeEnabled'>, remembered: NewThreadChoice | undefined): boolean {
  if (!remembered) return true
  const model = remembered.model
  return (
    (remembered.permissionMode === undefined || thread.permissionMode === remembered.permissionMode) &&
    (thread.worktreeEnabled === undefined || remembered.worktreeEnabled === undefined || thread.worktreeEnabled === remembered.worktreeEnabled) &&
    (model === undefined || (thread.modelOverride?.instanceId === model.instanceId && thread.modelOverride?.model === model.model && (thread.modelOverride?.effort ?? '') === (model.effort ?? '')))
  )
}

/**
 * The remembered choices a new thread in `projectId` would really start with: a remembered model the picker does not list
 * (hidden, or its instance turned off) is left out, because a create falls back to the profile's default for it. A
 * listing not loaded yet is loaded first; one that still cannot be read says nothing about the model, so it is kept
 * (an empty thread on another model is not reused as if the remembered one were unusable).
 */
function usableRemembered(remembered: NewThreadChoice | undefined, projectId: string): NewThreadChoice | undefined {
  if (!remembered?.model) return remembered
  const scope = projectScope(projectId)
  const snapshots = useProviderSnapshotsStore.getState().scopes[scopeKey(scope)]?.snapshots
  // Navigation never waits for provider checks (a first listing can wait on them for half a minute): without a listing
  // yet the model is unknown, so it is kept, and the listing is fetched for next time.
  if (!snapshots) {
    void loadProviderSnapshots(scope).catch(() => undefined)
    return remembered
  }
  if (pickerListsModel(remembered.model, pickerProviders(snapshots, []))) return remembered
  const { model: _unusable, ...rest } = remembered
  return rest
}

/**
 * The threads New thread may open as an empty draft. Never one a send is starting or has started: a Send holding it
 * (`holdNewChat`), preparing it (`workspacePending`), listed as its pending row, or with a turn admitted. Each of those
 * is a thread of its own already, even before the service lists it started.
 */
function draftCandidates(store: ReturnType<typeof useAppStore.getState>): Thread[] {
  const { profileId, threads, workspacePending, turnStates } = store
  const starting = startingThreadIds(profileId)
  return visibleThreads(threads).filter((entry) =>
    !starting.has(entry.id) &&
    !newChatHeld(profileId, entry.id) &&
    !workspacePending[workspacePendingKey(profileId, entry.id)] &&
    !isTurnActivePhase(turnStates[entry.id]?.phase ?? 'idle'))
}

/**
 * Opens the newest empty draft thread of a project, or creates one there with the project's remembered choices, and
 * selects it. An empty thread is reused only while it matches those choices; otherwise a new one is made with them
 * (setting them on the old one would also make its model the profile's last-used one).
 */
export async function createAndSelectProjectThread(projectId: string): Promise<void> {
  // Decided from the store as it is now, with nothing awaited first.
  const store = useAppStore.getState()
  const profileId = store.profileId
  store.setLastNewThreadProjectId(projectId)
  const node = store.projects.find((project) => project.id === projectId)?.node
  if (node) return openRemoteProjectDraft(projectId, node as NodeId)
  // A project just added (Add project) may not be listed in this window yet when the create answers.
  const listedBefore = store.projects.some((project) => project.id === projectId)
  const empty = findUnstartedThread(draftCandidates(store).filter((entry) => !entry.localOnly), projectId)
  const remembered = usableRemembered(rememberedChoiceOf(store.projects, projectId), projectId)
  if (empty && matchesRememberedChoices(empty, remembered)) {
    await selectThread(empty.id)
    return
  }
  const thread = await window.mousse.threads.create(undefined, projectId, { rememberedChoices: true })
  // Read again after the create: another profile shown meanwhile gets nothing from this one, a project removed meanwhile
  // gets nothing either, and a newer copy of the thread the service already pushed is kept (the push can come before
  // the reply, or after the first message). A project not listed yet when this began is not taken as removed.
  const current = useAppStore.getState()
  if (current.profileId !== profileId) return
  if (listedBefore && !current.projects.some((project) => project.id === projectId)) return
  if (!current.threads.some((entry) => entry.id === thread.id)) current.upsertThread(thread)
  await selectThread(thread.id)
}

/**
 * A new chat in a project of another computer: an empty draft here whose composer runs on that computer, in that
 * project, as if both were picked in it. The thread is made there when its first message is sent.
 */
async function openRemoteProjectDraft(projectId: string, node: NodeId): Promise<void> {
  const store = useAppStore.getState()
  const profileId = store.profileId
  const thread = findUnstartedThread(draftCandidates(store).filter((entry) => !entry.localOnly && !entry.node)) ?? await window.mousse.threads.create()
  const current = useAppStore.getState()
  if (current.profileId !== profileId) return
  current.upsertThread(thread)
  current.setComposerWorkspaceDraft(thread.id, { projectId, node, worktreeEnabled: newThreadWorktree(current.projects, projectId) })
  await selectThread(thread.id)
}

/**
 * Asks for a project folder, then opens a new thread in it. The project is listed at once, and an open sidebar shows
 * its group. Nothing happens when the picker is cancelled.
 */
export async function addProjectAndStartThread(): Promise<void> {
  const project = await window.mousse.projects.open()
  if (!project) return
  await listProjectAndStartThread(project)
}

/** A project just added (opened, cloned, made, or on another computer): listed at once, and a new thread opened in it. */
export async function listProjectAndStartThread(project: Project): Promise<void> {
  const store = useAppStore.getState()
  // The service also pushes the list, but that can come after the new thread is open.
  if (!store.projects.some((entry) => entry.id === project.id)) store.setProjects([...store.projects, project])
  if (store.threadsSidebarOpen) showProjectInSidebar(project.id)
  await createAndSelectProjectThread(project.id)
}

/** The open thread when it has a sidebar row (started); a draft has nothing to rename, pin or archive yet. */
export function openStartedThread(): Thread | null {
  const { activeThreadId, threads } = useAppStore.getState()
  const thread = activeThreadId ? threads.find((candidate) => candidate.id === activeThreadId) : undefined
  return thread && isThreadStarted(thread) ? thread : null
}

/** Pins the open thread, or unpins it when it is pinned. */
export async function togglePinOpenThread(): Promise<void> {
  const thread = openStartedThread()
  if (!thread) return
  await window.mousse.threads.pin(thread.id, !thread.pinnedAt)
}

/**
 * Show in sidebar: a thread one of the owner's bots keeps out of the sidebar (`Thread.hidden`) is listed there again
 * (`hidden: true` hides it again). A failure shows as a toast with Retry. Resolves to whether it went through.
 */
export function setThreadHidden(threadId: string, hidden: boolean): Promise<boolean> {
  return runWithToast(hidden ? 'hide the thread' : 'show the thread in the sidebar', async () => {
    const result = await window.mousse.platformRequest.request<{ thread?: Thread }>('threads.setHidden', { threadId, hidden })
    // At once, before the list's push arrives.
    if (result?.thread) useAppStore.getState().upsertThread(result.thread)
  }, { retry: true })
}

/**
 * Hide bot threads, Hide all bot threads: takes threads the owner's bots started out of the sidebar at once. Each bot's
 * chat still lists them, with Show in sidebar. A failure shows as one toast with Retry. Resolves to whether all went through.
 */
export function hideThreads(threadIds: readonly string[]): Promise<boolean> {
  return runWithToast(threadIds.length === 1 ? 'hide the thread' : 'hide the threads', async () => {
    const results = await Promise.allSettled(threadIds.map((threadId) =>
      window.mousse.platformRequest.request<{ thread?: Thread }>('threads.setHidden', { threadId, hidden: true })))
    const store = useAppStore.getState()
    for (const result of results) if (result.status === 'fulfilled' && result.value?.thread) store.upsertThread(result.value.thread)
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  }, { retry: true })
}

/** Archives the open thread, and opens the next one in its project (see `archiveThread`). */
export async function archiveOpenThread(): Promise<void> {
  const thread = openStartedThread()
  if (!thread || thread.settledAt) return
  await archiveThread(thread.id)
}

/** How long a confirmed archive is still shown from here when the thread's update has not arrived. */
const ARCHIVE_UPDATE_WAIT_MS = 3000

/**
 * Archives (or unarchives) a thread through the service, and shows it so in the sidebar from the call on
 * (`markPendingArchive`): its row starts to move at once. A failure throws, and the row moves back.
 */
export async function setThreadArchived(threadId: string, archived: boolean): Promise<void> {
  const release = markPendingArchive(threadId, archived)
  try {
    await window.mousse.threads.settle(threadId, archived)
  } catch (error) {
    release()
    throw error
  }
  // Shown from here until the thread's update arrives, so the row does not move back and forth meanwhile.
  const arrived = () => Boolean(useAppStore.getState().threads.find((thread) => thread.id === threadId)?.settledAt) === archived
  if (arrived()) return release()
  const finish = () => {
    clearTimeout(timer)
    unsubscribe()
    release()
  }
  const timer = setTimeout(finish, ARCHIVE_UPDATE_WAIT_MS)
  const unsubscribe = useAppStore.subscribe(() => { if (arrived()) finish() })
}

/**
 * Archives a thread. When it is the thread open in the pane (or the parent of the open subagent thread), the pane then
 * opens the next thread in its project, or the one before it when it was the last; a project's only thread stays
 * open. A failed archive throws and changes nothing. The sidebar's rows start to move at the call
 * (`setThreadArchived`); an archive from anywhere else moves them when its update arrives (`useArchiveMoves`).
 */
export async function archiveThread(threadId: string): Promise<void> {
  const { projects, threads, activeThreadId } = useAppStore.getState()
  const openRow = activeThreadId ? (openSubagentParentRow(activeThreadId, threads) ?? activeThreadId) : null
  const excluded = new Set(useChatsStore.getState().snapshot.chats.flatMap((chat) => (chat.threadId ? [chat.threadId] : [])))
  const next = openRow === threadId ? threadAfterArchive({ projects, threads, threadId, excluded }) : null
  await setThreadArchived(threadId, true)
  // Only when the person has not moved on to another thread in the meantime.
  const now = useAppStore.getState().activeThreadId
  const stillOpen = now ? (openSubagentParentRow(now, useAppStore.getState().threads) ?? now) === threadId : false
  if (next && stillOpen) await selectThread(next)
}

/**
 * Starts a thread from a pull request, opens it, and puts the pull request's title, description and review comments in
 * its composer for the person to send or edit. The daemon has already created the worktree at the pull request's head.
 */
export async function openThreadFromPullRequest(input: StartPullRequestThreadInput): Promise<void> {
  const store = useAppStore.getState()
  const result = await window.mousse.pullRequests.startThread(input)
  // The daemon's threads:updated broadcast can arrive after the thread is selected.
  store.upsertThread(result.thread)
  store.setComposerDraft(result.thread.id, result.seed)
  await selectThread(result.thread.id)
}

/** Moves to the next (1) or previous (-1) thread in the sidebar's order, wrapping at the ends. */
export async function selectAdjacentThread(direction: 1 | -1): Promise<void> {
  const { projects, threads, threadsSidebarView, threadFeedOrder, activeThreadId } = useAppStore.getState()
  const excluded = new Set(useChatsStore.getState().snapshot.chats.flatMap((chat) => (chat.threadId ? [chat.threadId] : [])))
  const ids = orderedThreadIds({ projects, threads, view: threadsSidebarView, excluded, arranged: threadFeedOrder })
  if (ids.length === 0) return
  // A subagent thread has no row of its own; its parent's row is the one that is highlighted.
  const current = activeThreadId ? (openSubagentParentRow(activeThreadId, threads) ?? activeThreadId) : null
  const index = current ? ids.indexOf(current) : -1
  const next = index === -1
    ? (direction === 1 ? 0 : ids.length - 1)
    : (index + direction + ids.length) % ids.length
  if (ids[next] === current) return
  await selectThread(ids[next]!)
}

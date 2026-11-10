import type { StartPullRequestThreadInput } from '../../shared/pullRequests'
import { expiryPresetMs } from '../../shared/threadExpiry'
import { composerWorkspaceFor, rememberedChoiceOf, workspaceWithPrivate } from './newThread'
import { openSubagentParentRow, visibleThreads } from '../../shared/threadLineage'
import { findUnstartedThread, isThreadStarted } from '../../shared/threadTitle'
import type { NewThreadChoice, Thread } from '../../shared/types'
import { confirmNavigation } from '../services/navigationGuards'
import { useAppStore } from '../stores/appStore'
import { useChatsStore } from '../stores/chatsStore'
import { orderedThreadIds } from './threadOrder'

/** Opens a thread in the main workspace after the navigation guards agree. */
export async function selectThread(threadId: string): Promise<void> {
  if (!await confirmNavigation()) return
  const store = useAppStore.getState()
  store.setSidebarMode('projects')
  // A page opened from the rail covers the workspace; the thread has to be visible.
  store.setScheduledOpen(false)
  store.setUsageOpen(false)
  if (threadId === store.activeThreadId) return
  // One store update: highlight + restore cached transcript (if any) while
  // the daemon snapshot loads. Main also broadcasts thread:selected early.
  store.switchToThread(threadId)
  await window.mousse.threads.select(threadId)
}

/** Opens the newest empty draft thread, or creates one, and selects it. The sidebar stays on its tab. A private draft is never reused for it. */
export async function createAndSelectThread(): Promise<void> {
  const store = useAppStore.getState()
  const thread = findUnstartedThread(visibleThreads(store.threads).filter((entry) => !entry.localOnly)) ?? await window.mousse.threads.create()
  store.upsertThread(thread)
  await selectThread(thread.id)
}

/** Opens the newest empty private draft (`Thread.localOnly`), or creates one on this computer, and selects it. */
export async function createAndSelectPrivateThread(): Promise<void> {
  const store = useAppStore.getState()
  const thread =
    findUnstartedThread(visibleThreads(store.threads).filter((entry) => entry.localOnly && !entry.node)) ??
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
 * Opens the newest empty draft thread of a project, or creates one there with the project's remembered choices, and
 * selects it. An empty thread is reused only while it matches those choices; otherwise a new one is made with them
 * (setting them on the old one would also make its model the profile's last-used one).
 */
export async function createAndSelectProjectThread(projectId: string): Promise<void> {
  const store = useAppStore.getState()
  const empty = findUnstartedThread(visibleThreads(store.threads).filter((entry) => !entry.localOnly), projectId)
  const remembered = rememberedChoiceOf(store.projects, projectId)
  const thread = empty && matchesRememberedChoices(empty, remembered) ? empty : await window.mousse.threads.create(undefined, projectId, { rememberedChoices: true })
  // The daemon's threads:updated broadcast can arrive after the first message is sent.
  store.upsertThread(thread)
  await selectThread(thread.id)
}

/** Asks for a project folder, then opens a new thread in it. Nothing happens when the picker is cancelled. */
export async function addProjectAndStartThread(): Promise<void> {
  const project = await window.mousse.projects.open()
  if (!project) return
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

/** Archives the open thread; it stays open. */
export async function archiveOpenThread(): Promise<void> {
  const thread = openStartedThread()
  if (!thread || thread.settledAt) return
  await window.mousse.threads.settle(thread.id, true)
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

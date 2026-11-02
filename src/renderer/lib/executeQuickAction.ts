import type { QuickAction } from './quickActions'
import { useAppStore } from '../stores/appStore'
import { composerThreadActions } from './composerThreadActions'
import { prepareComposerThread } from './createComposerThread'
import { isNewEmptyThread, isWorkspacePending, localWorkspaceFor } from './newThread'

const TERMINAL_SPAWN_TIMEOUT_MS = 15_000
const TERMINAL_SPAWN_POLL_MS = 150

/** The new chat is already being prepared by another send; nothing was started. */
export class WorkspaceBusyError extends Error {
  constructor() {
    super('Busy: the new chat is still being prepared.')
    this.name = 'WorkspaceBusyError'
  }
}

function requireActiveProfile(profileId: string): ReturnType<typeof useAppStore.getState> {
  const current = useAppStore.getState()
  if (!profileId || current.profileId !== profileId) {
    throw new Error('Profile changed while the quick action was running.')
  }
  return current
}

/**
 * On a new chat, applies the workspace picked in the composer or the side card
 * (project, new worktree) before the first send, like the composer does.
 * Returns the thread to send to, or null if the user moved away meanwhile.
 */
async function threadForSend(profileId: string): Promise<string | null> {
  const store = requireActiveProfile(profileId)
  const startId = store.activeThreadId
  const thread = store.threads.find((entry) => entry.id === startId)
  if (!isNewEmptyThread(startId, thread, store.messages.length)) return startId
  // One preparation at a time: a composer send or another action already owns this thread.
  if (isWorkspacePending(store)) throw new WorkspaceBusyError()
  let targetId = startId
  // Marked before the first await, so the composer and the side card see it at once.
  store.setWorkspacePending(profileId, startId, true)
  const stillVisible = () => {
    const current = useAppStore.getState()
    return current.profileId === profileId && current.activeThreadId === targetId
  }
  try {
    return await prepareComposerThread({
      thread,
      workspace: localWorkspaceFor(store.composerWorkspaceDrafts[startId ?? '__blank__'], thread, store.worktreeByDefault),
      ...composerThreadActions(),
      stillVisible,
      activate: (created) => {
        const current = useAppStore.getState()
        current.upsertThread(created)
        current.setComposerWorkspaceDraft(startId)
        targetId = created.id
        current.setWorkspacePending(profileId, created.id, true)
        current.switchToThread(created.id)
      }
    })
  } finally {
    const current = useAppStore.getState()
    current.setWorkspacePending(profileId, startId, false)
    current.setWorkspacePending(profileId, targetId, false)
  }
}

async function sendToActiveThread(content: string, profileId: string): Promise<void> {
  const mode = requireActiveProfile(profileId).chatMode
  const trimmed = content.trim()
  if (!trimmed) return
  let activeThreadId: string | null
  try {
    activeThreadId = await threadForSend(profileId)
  } catch (error) {
    if (error instanceof WorkspaceBusyError) throw error
    requireActiveProfile(profileId)
    throw new Error('Failed to send message.')
  }
  if (!activeThreadId) return
  // Selecting a thread resets loading, so it is set only once the thread is chosen.
  const store = requireActiveProfile(profileId)
  store.setLoading(true)
  // Promote drafts immediately so switching away mid-title still lists the thread.
  const current = store.threads.find((t) => t.id === activeThreadId)
  if (current && !current.startedAt) {
    store.upsertThread({
      ...current,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
  }
  try {
    const result = await window.mousse.orchestrator.sendToThread(activeThreadId, {
      content: trimmed,
      mode
    })
    requireActiveProfile(profileId)
    if (result.queued) {
      const stillActive = await window.mousse.orchestrator.isTurnActive(activeThreadId)
      requireActiveProfile(profileId).setLoading(stillActive)
      return
    }
    const stillActive = await window.mousse.orchestrator.isTurnActive(activeThreadId)
    requireActiveProfile(profileId).setLoading(stillActive)
  } catch {
    requireActiveProfile(profileId)
    const stillActive = await window.mousse.orchestrator
      .isTurnActive(activeThreadId)
      .catch(() => true)
    requireActiveProfile(profileId).setLoading(stillActive)
    throw new Error('Failed to send message.')
  }
}

/** Type 1: send the payload in the current chat (queues when a turn is active). */
export async function executeSendInCurrentChat(action: QuickAction, profileId: string): Promise<void> {
  await sendToActiveThread(action.payload, profileId)
}

/** Type 2: create a new chat, select it, then send the payload there. */
export async function executeSendInNewChat(action: QuickAction, profileId: string): Promise<void> {
  const store = requireActiveProfile(profileId)
  const mode = store.chatMode
  const trimmed = action.payload.trim()
  if (!trimmed) return
  store.setLoading(true)
  try {
    const thread = await window.mousse.threads.createAndSelect(action.label.slice(0, 60))
    const current = requireActiveProfile(profileId)
    // createAndSelect broadcasts selection; mirror it locally for instant feedback.
    current.switchToThread(thread.id)
    await window.mousse.orchestrator.sendToThread(thread.id, { content: trimmed, mode })
    requireActiveProfile(profileId)
    const stillActive = await window.mousse.orchestrator
      .isTurnActive(thread.id)
      .catch(() => true)
    requireActiveProfile(profileId).setLoading(stillActive)
  } catch {
    requireActiveProfile(profileId)
    const stillActive = await window.mousse.orchestrator
      .isTurnActive(requireActiveProfile(profileId).activeThreadId ?? undefined)
      .catch(() => false)
    requireActiveProfile(profileId).setLoading(stillActive)
    throw new Error('Failed to create chat / send message.')
  }
}

/**
 * Type 3: open a new Mousse terminal tab, focus it, and run the command there.
 * The new tab becomes the thread's active tab (`addProjectTerminalTab`) and the
 * terminal surface opens. `ProjectTerminalPanel` spawns the shell when that view
 * is shown. We then wait for the live PTY and type the command.
 */
export async function executeBashInNewTerminal(action: QuickAction, profileId: string): Promise<void> {
  const command = action.payload.trim()
  if (!command) throw new Error('Empty command.')
  const store = requireActiveProfile(profileId)
  const tabId = store.addProjectTerminalTab(store.activeThreadId)
  store.updateProjectTerminalTab(tabId, { title: action.label.slice(0, 40) || 'Terminal' })
  store.openSurfaceKind('terminal')

  const deadline = Date.now() + TERMINAL_SPAWN_TIMEOUT_MS
  for (;;) {
    const tab = requireActiveProfile(profileId).projectTerminalTabs.find((entry) => entry.id === tabId)
    if (tab?.ptyId) {
      const alive = await window.mousse.pty.isAlive(tab.ptyId, tab.ownerThreadId ?? undefined).catch(() => false)
      requireActiveProfile(profileId)
      if (alive) {
        await window.mousse.pty.write(tab.ptyId, `${command}\n`, tab.ownerThreadId ?? undefined)
        requireActiveProfile(profileId)
        return
      }
    }
    if (Date.now() > deadline) throw new Error('Terminal did not start in time.')
    await new Promise((resolve) => setTimeout(resolve, TERMINAL_SPAWN_POLL_MS))
  }
}

export async function executeQuickAction(action: QuickAction, profileId: string): Promise<void> {
  if (action.kind === 'send-new-chat') return executeSendInNewChat(action, profileId)
  if (action.kind === 'bash') return executeBashInNewTerminal(action, profileId)
  return executeSendInCurrentChat(action, profileId)
}

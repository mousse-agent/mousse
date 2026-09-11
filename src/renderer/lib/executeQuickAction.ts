import type { QuickAction } from './quickActions'
import { useAppStore } from '../stores/appStore'

const TERMINAL_SPAWN_TIMEOUT_MS = 15_000
const TERMINAL_SPAWN_POLL_MS = 150

function requireActiveProfile(profileId: string): ReturnType<typeof useAppStore.getState> {
  const current = useAppStore.getState()
  if (!profileId || current.profileId !== profileId) {
    throw new Error('Profile changed while the quick action was running.')
  }
  return current
}

async function sendToActiveThread(content: string, profileId: string): Promise<void> {
  const store = requireActiveProfile(profileId)
  const activeThreadId = store.activeThreadId
  const mode = store.chatMode
  const trimmed = content.trim()
  if (!trimmed) return
  store.setLoading(true)
  // Promote drafts immediately so switching away mid-title still lists the thread.
  if (activeThreadId) {
    const current = store.threads.find((t) => t.id === activeThreadId)
    if (current && !current.startedAt) {
      store.upsertThread({
        ...current,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })
    }
  }
  try {
    const result = activeThreadId
      ? await window.mousse.orchestrator.sendToThread(activeThreadId, {
          content: trimmed,
          mode
        })
      : await window.mousse.orchestrator.send({ content: trimmed, mode })
    requireActiveProfile(profileId)
    if (result.queued) {
      const stillActive = await window.mousse.orchestrator.isTurnActive(
        activeThreadId ?? undefined
      )
      requireActiveProfile(profileId).setLoading(stillActive)
      return
    }
    const stillActive = await window.mousse.orchestrator.isTurnActive(
      activeThreadId ?? undefined
    )
    requireActiveProfile(profileId).setLoading(stillActive)
  } catch {
    requireActiveProfile(profileId)
    const stillActive = await window.mousse.orchestrator
      .isTurnActive(activeThreadId ?? undefined)
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
 * The new tab becomes the thread's active tab (`addProjectTerminalTab`), the main
 * area switches to the terminal view, and `ProjectTerminalPanel` auto-spawns the
 * shell + focuses it. We then wait for the live PTY and type the command.
 */
export async function executeBashInNewTerminal(action: QuickAction, profileId: string): Promise<void> {
  const command = action.payload.trim()
  if (!command) throw new Error('Empty command.')
  const store = requireActiveProfile(profileId)
  const tabId = store.addProjectTerminalTab(store.activeThreadId)
  store.updateProjectTerminalTab(tabId, { title: action.label.slice(0, 40) || 'Terminal' })
  store.setMainAreaOpen(true)
  store.setMainView('terminal')

  const deadline = Date.now() + TERMINAL_SPAWN_TIMEOUT_MS
  for (;;) {
    const tab = requireActiveProfile(profileId).projectTerminalTabs.find((entry) => entry.id === tabId)
    if (tab?.ptyId) {
      const alive = await window.mousse.pty.isAlive(tab.ptyId).catch(() => false)
      requireActiveProfile(profileId)
      if (alive) {
        await window.mousse.pty.write(tab.ptyId, `${command}\n`)
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

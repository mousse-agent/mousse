import type { QuickAction } from './quickActions'
import { useAppStore } from '../stores/appStore'

const TERMINAL_SPAWN_TIMEOUT_MS = 15_000
const TERMINAL_SPAWN_POLL_MS = 150

async function sendToActiveThread(content: string): Promise<void> {
  const store = useAppStore.getState()
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
    if (result.queued) {
      const stillActive = await window.mousse.orchestrator.isTurnActive(
        activeThreadId ?? undefined
      )
      store.setLoading(stillActive)
      return
    }
    const stillActive = await window.mousse.orchestrator.isTurnActive(
      activeThreadId ?? undefined
    )
    store.setLoading(stillActive)
  } catch {
    const stillActive = await window.mousse.orchestrator
      .isTurnActive(activeThreadId ?? undefined)
      .catch(() => true)
    store.setLoading(stillActive)
    throw new Error('Failed to send message.')
  }
}

/** Type 1: send the payload in the current chat (queues when a turn is active). */
export async function executeSendInCurrentChat(action: QuickAction): Promise<void> {
  await sendToActiveThread(action.payload)
}

/** Type 2: create a new chat, select it, then send the payload there. */
export async function executeSendInNewChat(action: QuickAction): Promise<void> {
  const store = useAppStore.getState()
  const mode = store.chatMode
  const trimmed = action.payload.trim()
  if (!trimmed) return
  store.setLoading(true)
  try {
    const thread = await window.mousse.threads.createAndSelect(action.label.slice(0, 60))
    // createAndSelect broadcasts selection; mirror it locally for instant feedback.
    store.switchToThread(thread.id)
    await window.mousse.orchestrator.sendToThread(thread.id, { content: trimmed, mode })
    const stillActive = await window.mousse.orchestrator
      .isTurnActive(thread.id)
      .catch(() => true)
    store.setLoading(stillActive)
  } catch {
    const stillActive = await window.mousse.orchestrator
      .isTurnActive(useAppStore.getState().activeThreadId ?? undefined)
      .catch(() => false)
    store.setLoading(stillActive)
    throw new Error('Failed to create chat / send message.')
  }
}

/**
 * Type 3: open a new Mousse terminal tab, focus it, and run the command there.
 * The new tab becomes the thread's active tab (`addProjectTerminalTab`), the main
 * area switches to the terminal view, and `ProjectTerminalPanel` auto-spawns the
 * shell + focuses it. We then wait for the live PTY and type the command.
 */
export async function executeBashInNewTerminal(action: QuickAction): Promise<void> {
  const command = action.payload.trim()
  if (!command) throw new Error('Empty command.')
  const store = useAppStore.getState()
  const tabId = store.addProjectTerminalTab(store.activeThreadId)
  store.updateProjectTerminalTab(tabId, { title: action.label.slice(0, 40) || 'Terminal' })
  store.setMainAreaOpen(true)
  store.setMainView('terminal')

  const deadline = Date.now() + TERMINAL_SPAWN_TIMEOUT_MS
  for (;;) {
    const tab = useAppStore.getState().projectTerminalTabs.find((entry) => entry.id === tabId)
    if (tab?.ptyId) {
      const alive = await window.mousse.pty.isAlive(tab.ptyId).catch(() => false)
      if (alive) {
        await window.mousse.pty.write(tab.ptyId, `${command}\n`)
        return
      }
    }
    if (Date.now() > deadline) throw new Error('Terminal did not start in time.')
    await new Promise((resolve) => setTimeout(resolve, TERMINAL_SPAWN_POLL_MS))
  }
}

export async function executeQuickAction(action: QuickAction): Promise<void> {
  if (action.kind === 'send-new-chat') return executeSendInNewChat(action)
  if (action.kind === 'bash') return executeBashInNewTerminal(action)
  return executeSendInCurrentChat(action)
}

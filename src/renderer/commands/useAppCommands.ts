import { openSurface } from '../lib/surfaces'
import { createAndSelectThread, selectAdjacentThread } from '../lib/threadActions'
import { useAppStore } from '../stores/appStore'
import { useCommand } from './commandRegistry'

/**
 * Registers the commands that act on app-wide state. Commands that belong to one component
 * (Stop run, Focus composer) register in that component, next to what they call.
 */
export function useAppCommands(): void {
  useCommand('thread.new', () => void createAndSelectThread())
  useCommand('thread.next', () => void selectAdjacentThread(1))
  useCommand('thread.previous', () => void selectAdjacentThread(-1))
  useCommand('threads.search', () => useAppStore.getState().setThreadSearchOpen(true))
  useCommand('sideCard.toggle', () => {
    const { sideCardOn, setSideCardOn } = useAppStore.getState()
    setSideCardOn(!sideCardOn)
  })
  useCommand('terminal.open', () => openSurface('terminal'))
}

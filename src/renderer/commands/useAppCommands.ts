import { applySideCardToggle, deriveSideCardState, nextSideCardToggleState } from '../components/sideCard/sideCardLogic'
import { openThreadRenameDialog } from '../components/ThreadRenameDialog'
import { openRailPage } from '../lib/railPages'
import { SURFACE_CHOICES, openSurface } from '../lib/surfaces'
import {
  addProjectAndStartThread,
  archiveOpenThread,
  createAndSelectPrivateThread,
  createAndSelectThread,
  openStartedThread,
  selectAdjacentThread,
  togglePinOpenThread
} from '../lib/threadActions'
import { useAppStore } from '../stores/appStore'
import { useCommand, useCommands } from './commandRegistry'
import { openPalette, togglePalette } from './paletteActions'

const logFailure = (what: string) => (error: unknown) => console.error(`${what} failed`, error)

/** Every surface, for the palette and the menu. The letters stay with the empty panel's picker, which registers its own. */
const SURFACE_COMMANDS = SURFACE_CHOICES.map((choice) => ({ id: choice.commandId, run: () => openSurface(choice.id) }))

/**
 * Registers the commands that act on app-wide state. Commands that belong to one component
 * (Stop run, Focus composer) register in that component, next to what they call.
 */
export function useAppCommands(): void {
  // The settings page makes the rest of the app inert; a palette opened over it could not be used.
  useCommand('palette.open', togglePalette, () => !useAppStore.getState().settingsOpen)
  useCommand('thread.new', () => void createAndSelectThread())
  useCommand('thread.newPrivate', () => void createAndSelectPrivateThread())
  useCommand('thread.next', () => void selectAdjacentThread(1))
  useCommand('thread.previous', () => void selectAdjacentThread(-1))
  useCommand('threads.search', () => openPalette('messages'))
  useCommand('thread.rename', () => {
    const thread = openStartedThread()
    if (thread) openThreadRenameDialog(thread.id)
  }, () => openStartedThread() !== null)
  useCommand('thread.pin', () => void togglePinOpenThread().catch(logFailure('Pinning the thread')), () => openStartedThread() !== null)
  useCommand(
    'thread.archive',
    () => void archiveOpenThread().catch(logFailure('Archiving the thread')),
    () => Boolean(openStartedThread() && !openStartedThread()!.settledAt)
  )
  useCommand('project.open', () => void addProjectAndStartThread().catch(logFailure('Adding the project')))
  useCommand('sideCard.toggle', () => {
    const state = useAppStore.getState()
    const { visible, mode } = deriveSideCardState(state)
    // In a narrow window the card is an overlay: the command opens or closes it, and leaves the switch alone.
    if (mode === 'overlay') applySideCardToggle(nextSideCardToggleState(visible, state, mode))
    else state.setSideCardOn(!state.sideCardOn)
  })
  useCommand('sidebar.toggle', () => {
    const state = useAppStore.getState()
    state.setThreadsSidebarOpen(!state.threadsSidebarOpen)
  })
  useCommand('mainArea.toggle', () => {
    const state = useAppStore.getState()
    state.setMainAreaOpen(!state.mainAreaOpen)
  })
  useCommand('terminal.open', () => openSurface('terminal'))
  useCommand('settings.open', () => void openRailPage('settings'))
  useCommand('automations.open', () => void openRailPage('automations'))
  useCommand('usage.open', () => void openRailPage('usage'))
  useCommands(SURFACE_COMMANDS, { keys: false })
}

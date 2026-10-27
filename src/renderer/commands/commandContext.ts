import type { CommandContext, OverlayScope } from '../../shared/commands'
import { isTurnActivePhase } from '../../shared/types'
import type { useAppStore } from '../stores/appStore'

type AppSnapshot = ReturnType<typeof useAppStore.getState>

/** The part of the store the command rules read. */
export type CommandStateSlice = Pick<AppSnapshot, 'activeThreadId' | 'turnStates' | 'mainAreaOpen' | 'sidebarMode' | 'appInfo'>

/** What a `Node`-like target must answer: monaco and xterm both focus a textarea, so `closest` finds them. */
export interface ClosestTarget {
  closest(selector: string): unknown
}

export interface OverlayState {
  /** Whether a Modal dialog is open. A dialog always sits above the other overlays. */
  modalOpen: boolean
  /** Open overlays, last opened on top. */
  stack: readonly OverlayScope[]
  /** A scope to leave out, such as the palette when it runs a command of its own. */
  ignore?: OverlayScope
}

/**
 * The one place a `CommandContext` is built. Pure: it reads only what it is given. `target` is the
 * focused element of a key press, or null for a run that did not come from the keyboard.
 */
export function commandContextFromDom(
  target: ClosestTarget | null,
  state: CommandStateSlice,
  overlays: OverlayState
): CommandContext {
  const stack = overlays.ignore ? overlays.stack.filter((scope) => scope !== overlays.ignore) : overlays.stack
  const phase = state.activeThreadId ? state.turnStates[state.activeThreadId]?.phase : undefined
  return {
    platform: state.appInfo?.platform ?? '',
    inTextInput: Boolean(target?.closest('input, textarea, [contenteditable="true"]')),
    inTerminal: Boolean(target?.closest('.xterm')),
    overlay: overlays.modalOpen ? 'modal' : (stack[stack.length - 1] ?? null),
    threadOpen: state.activeThreadId !== null,
    runActive: phase !== undefined && isTurnActivePhase(phase),
    mainAreaOpen: state.mainAreaOpen,
    projectsMode: state.sidebarMode === 'projects',
    inFilesPanel: Boolean(target?.closest('.files-panel'))
  }
}

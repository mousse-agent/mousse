import { useAppStore } from '../../stores/appStore'

/**
 * Narrowest thread area (px) that still shows the side card. Below this the
 * card would crowd the 680px conversation column, so it stays hidden.
 */
export const SIDE_CARD_MIN_THREAD_WIDTH = 1000

export interface SideCardVisibilityInput {
  sideCardOn: boolean
  mainAreaOpen: boolean
  settingsOpen: boolean
  usageOpen: boolean
  scheduledOpen: boolean
  channelsOpen: boolean
  sidebarMode: 'projects' | 'chats'
  /** The measured full-width thread area has room for the card. Null until the first measurement. */
  sideCardFits: boolean | null
}

/** Why the card cannot appear right now, as opposed to merely being switched off. */
export type SideCardUnavailableReason = 'view' | 'narrow'

export interface SideCardState {
  visible: boolean
  /** Set when the title-bar button has nothing to bring back; null when a click can show or hide the card. */
  unavailable: SideCardUnavailableReason | null
}

/**
 * One answer for the card and its title-bar button. The card needs a view that
 * shows a thread (not Settings, Usage, Scheduled, Channels or Chats) and a
 * thread area wide enough for it. Within those, it shows when switched on and
 * the app panel is closed. An open app panel does not make the card
 * unavailable: the button closes the panel and brings the card back. Until the
 * width is measured the card stays hidden, but the button is not disabled for it:
 * only a measurement that came up short does that.
 */
export function deriveSideCardState(input: SideCardVisibilityInput): SideCardState {
  const viewBlocked = input.settingsOpen
    || input.usageOpen
    || input.scheduledOpen
    || input.channelsOpen
    || input.sidebarMode === 'chats'
  if (viewBlocked) return { visible: false, unavailable: 'view' }
  if (input.sideCardFits === false) return { visible: false, unavailable: 'narrow' }
  // Unmeasured never flashes the card; the first measurement lands before the first paint.
  if (input.sideCardFits === null) return { visible: false, unavailable: null }
  return { visible: input.sideCardOn && !input.mainAreaOpen, unavailable: null }
}

/** Whether a thread area of this width has room for the card beside the conversation. */
export function sideCardFitsThreadWidth(width: number): boolean {
  return width >= SIDE_CARD_MIN_THREAD_WIDTH
}

/** The threads sidebar's 1px resizer sits inside its reserved width. */
const THREADS_SIDEBAR_RESIZER_WIDTH = 1

/** Width the threads sidebar takes beside the thread view while it is open; it slides, so this is the end state. */
export function threadsSidebarReservedWidth(open: boolean, width: number): number {
  return open ? width + THREADS_SIDEBAR_RESIZER_WIDTH : 0
}

/**
 * Width the thread view has when the app panel is closed: the whole workspace
 * less what stays beside it. Null when the workspace is hidden (zero width, as
 * under a rail page) or nothing would be left, which says nothing about fit.
 */
export function threadViewWidth(workspaceWidth: number, reservedBesideThread: number): number | null {
  const width = workspaceWidth - reservedBesideThread
  return workspaceWidth > 0 && width > 0 ? width : null
}

/** Tooltip for the title-bar button; explains a disabled button, otherwise just names it. */
export function sideCardButtonTitle(unavailable: SideCardUnavailableReason | null): string {
  if (unavailable === 'narrow') return 'Widen the window to show thread details'
  if (unavailable === 'view') return 'Open a thread to show thread details'
  return 'Thread details'
}

export interface SideCardToggleState {
  sideCardOn: boolean
  mainAreaOpen: boolean
}

/**
 * Title-bar button click. When the card is not showing, the click brings it
 * back (closing the app panel that was in its place); when it is showing, the
 * click switches it off and leaves the panel state alone.
 */
export function nextSideCardToggleState(visible: boolean, current: SideCardToggleState): SideCardToggleState {
  if (visible) return { sideCardOn: false, mainAreaOpen: current.mainAreaOpen }
  return { sideCardOn: true, mainAreaOpen: false }
}

/** Store-backed visibility, shared by the card and its title-bar button. */
export function useSideCardVisible(): boolean {
  return useAppStore((state) => deriveSideCardState(state).visible)
}

/** Store-backed reason the title-bar button is disabled, or null while it works. */
export function useSideCardUnavailable(): SideCardUnavailableReason | null {
  return useAppStore((state) => deriveSideCardState(state).unavailable)
}

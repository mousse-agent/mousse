import { useAppStore } from '../../stores/appStore'

/**
 * Narrowest thread area (px) that still docks the side card beside the
 * conversation. Below this the card would crowd the 680px conversation column,
 * so it opens as an overlay instead.
 */
export const SIDE_CARD_MIN_THREAD_WIDTH = 1000

/**
 * Thread area width (px) at which the centered 680px column leaves the docked
 * card its own gutter on both sides (the card is 272px with 12px gutters); the
 * column makes room for the card only below this.
 */
export const SIDE_CARD_CLEARANCE_WIDTH = 680 + 2 * (272 + 2 * 12)

export interface SideCardVisibilityInput {
  sideCardOn: boolean
  mainAreaOpen: boolean
  settingsOpen: boolean
  usageOpen: boolean
  scheduledOpen: boolean
  sidebarMode: 'projects' | 'chats'
  /** The overlay is open. Only counts in overlay mode; it is never persisted. */
  sideCardOverlayOpen: boolean
  /** The measured full-width thread area has room for the card. Null until the first measurement. */
  sideCardFits: boolean | null
}

/** Why the card cannot appear right now, as opposed to merely being switched off. */
export type SideCardUnavailableReason = 'view'

/** How the card shows: beside the conversation, or over it when the thread area is too narrow. */
export type SideCardMode = 'docked' | 'overlay'

export interface SideCardState {
  visible: boolean
  mode: SideCardMode
  /** Set when the title-bar button has nothing to bring back; null when a click can show or hide the card. */
  unavailable: SideCardUnavailableReason | null
}

/**
 * One answer for the card and its title-bar button. The card needs a view that
 * shows a thread (not Settings, Usage, Scheduled or Chats). Within
 * that, a thread area wide enough docks it: it shows when switched on and the
 * app panel is closed. A narrower one opens it as an overlay, which shows only
 * while `sideCardOverlayOpen` is set, so a narrow window never opens it by
 * itself. An open app panel does not make the card unavailable: the button
 * closes the panel and brings the card back. Until the width is measured the
 * card stays hidden and docked, and the button is not disabled for it.
 */
export function deriveSideCardState(input: SideCardVisibilityInput): SideCardState {
  const mode: SideCardMode = input.sideCardFits === false ? 'overlay' : 'docked'
  const viewBlocked = input.settingsOpen
    || input.usageOpen
    || input.scheduledOpen
    || input.sidebarMode === 'chats'
  if (viewBlocked) return { visible: false, mode, unavailable: 'view' }
  // Unmeasured never flashes the card; the first measurement lands before the first paint.
  if (input.sideCardFits === null) return { visible: false, mode, unavailable: null }
  const wanted = mode === 'overlay' ? input.sideCardOverlayOpen : input.sideCardOn
  return { visible: wanted && !input.mainAreaOpen, mode, unavailable: null }
}

/** Whether a thread area of this width has room for the card beside the conversation. */
export function sideCardFitsThreadWidth(width: number): boolean {
  return width >= SIDE_CARD_MIN_THREAD_WIDTH
}

/**
 * Width (px) the conversation column gives up on the right for the docked card:
 * none once the thread area leaves the card its own gutter, growing as the area
 * narrows. The overlay reserves nothing.
 */
export function sideCardReservedWidth(threadWidth: number): number {
  return Math.max(0, SIDE_CARD_CLEARANCE_WIDTH - threadWidth)
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
  if (unavailable === 'view') return 'Open a thread to show thread details'
  return 'Thread details'
}

export interface SideCardToggleState {
  sideCardOn: boolean
  mainAreaOpen: boolean
  sideCardOverlayOpen: boolean
}

/**
 * Title-bar button click. When the card is not showing, the click brings it
 * back (closing the app panel that was in its place); when it is showing, the
 * click hides it and leaves the panel state alone. Docked, that switches the
 * card off; as an overlay it only closes the overlay and leaves the switch
 * alone, so the card docks again when the window widens.
 */
export function nextSideCardToggleState(
  visible: boolean,
  current: SideCardToggleState,
  mode: SideCardMode = 'docked'
): SideCardToggleState {
  if (mode === 'overlay') {
    return visible
      ? { ...current, sideCardOverlayOpen: false }
      : { sideCardOn: current.sideCardOn, mainAreaOpen: false, sideCardOverlayOpen: true }
  }
  if (visible) return { sideCardOn: false, mainAreaOpen: current.mainAreaOpen, sideCardOverlayOpen: false }
  return { sideCardOn: true, mainAreaOpen: false, sideCardOverlayOpen: false }
}

/** Writes a toggle result to the store. The app panel closes first: opening it is what clears the overlay. */
export function applySideCardToggle(next: SideCardToggleState): void {
  const state = useAppStore.getState()
  if (next.mainAreaOpen !== state.mainAreaOpen) state.setMainAreaOpen(next.mainAreaOpen)
  if (next.sideCardOn !== state.sideCardOn) state.setSideCardOn(next.sideCardOn)
  if (next.sideCardOverlayOpen !== state.sideCardOverlayOpen) state.setSideCardOverlayOpen(next.sideCardOverlayOpen)
}

/** Store-backed visibility, shared by the card and its title-bar button. */
export function useSideCardVisible(): boolean {
  return useAppStore((state) => deriveSideCardState(state).visible)
}

/** Store-backed mode: docked beside the conversation, or an overlay in a narrow thread area. */
export function useSideCardMode(): SideCardMode {
  return useAppStore((state) => deriveSideCardState(state).mode)
}

/** Store-backed reason the title-bar button is disabled, or null while it works. */
export function useSideCardUnavailable(): SideCardUnavailableReason | null {
  return useAppStore((state) => deriveSideCardState(state).unavailable)
}

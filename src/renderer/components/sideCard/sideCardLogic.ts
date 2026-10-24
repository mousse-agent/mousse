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
}

/** The card shows only over a full-width thread view: switched on, app panel closed, no page covering the thread, not in Chats. */
export function isSideCardVisible(input: SideCardVisibilityInput): boolean {
  return input.sideCardOn
    && !input.mainAreaOpen
    && !input.settingsOpen
    && !input.usageOpen
    && !input.scheduledOpen
    && !input.channelsOpen
    && input.sidebarMode !== 'chats'
}

/** Whether a thread area of this width has room for the card beside the conversation. */
export function sideCardFitsThreadWidth(width: number): boolean {
  return width >= SIDE_CARD_MIN_THREAD_WIDTH
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
  return useAppStore((state) => isSideCardVisible(state))
}

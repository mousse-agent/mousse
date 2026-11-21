import type { WarmStartView } from '../../shared/warmStart'
import { useAppStore } from '../stores/appStore'
import { releaseProjectIconReads, seedProjectIcons } from './projectIcons'

/**
 * The warm start (`showWarmView`) and its handover to the live window: what the warm view leaves for the real chat to
 * continue from, so nothing on screen moves or plays again when it takes the warm view's place.
 */

/**
 * Puts what this window's profile showed last time in the store, before the first render: main hands it to the
 * preload synchronously (`app.warmStartView`), so the first frame the window draws already shows it.
 */
export function showSavedView(): void {
  let view: WarmStartView | null | undefined
  try {
    view = window.mousse?.app?.warmStartView?.()
  } catch {
    return
  }
  if (!view || typeof view !== 'object') return
  useAppStore.getState().showWarmView(view)
  const shown = useAppStore.getState()
  if (!shown.warmView || shown.profileReady) return
  // The projects' icons as they were; none is read until the window's profile is known.
  seedProjectIcons(shown.projects, view.projectIcons && typeof view.projectIcons === 'object' ? view.projectIcons : undefined)
  const unsubscribe = useAppStore.subscribe((state) => {
    if (!state.profileReady) return
    unsubscribe()
    releaseProjectIconReads()
  })
}

/** Where the warm transcript was read: at its end, or with a turn at a distance from the top of the list. */
export interface WarmScroll {
  threadId: string
  pinned: boolean
  /** The first turn (`data-turn-key`) on screen, and its top's distance from the list's top, in pixels. */
  turnKey?: string
  offset?: number
}

let warmScroll: WarmScroll | null = null

/** The warm transcript's place, kept as it scrolls (WarmChat). */
export function noteWarmScroll(scroll: WarmScroll | null): void {
  warmScroll = scroll
}

/** The place the warm transcript of `threadId` was left at, once: the real transcript opens there (MessageList). */
export function takeWarmScroll(threadId: string | null | undefined): WarmScroll | null {
  if (!threadId || warmScroll?.threadId !== threadId) return null
  const scroll = warmScroll
  warmScroll = null
  return scroll
}

/** How far the list is from its end, below which it counts as at the end (as the list's own follow does). */
const PINNED_SLACK_PX = 2

/** Reads where `list` is scrolled: at its end, or which turn is at its top and where. */
export function readWarmScroll(threadId: string, list: HTMLElement): WarmScroll {
  if (list.scrollHeight - list.scrollTop - list.clientHeight <= PINNED_SLACK_PX) return { threadId, pinned: true }
  const top = list.getBoundingClientRect().top
  for (const turn of list.querySelectorAll<HTMLElement>('[data-turn-key]')) {
    const rect = turn.getBoundingClientRect()
    if (rect.bottom > top) return { threadId, pinned: false, turnKey: turn.dataset.turnKey, offset: rect.top - top }
  }
  return { threadId, pinned: true }
}

/** The empty chat the warm view showed (its greeting, logo and glow), and when its glow started. */
let warmEmpty: { threadKey: string; since: number } | null = null

/** The warm view shows `threadKey` as an empty chat; its glow's loop starts now unless it already did. */
export function noteWarmEmptyView(threadKey: string): number {
  if (warmEmpty?.threadKey !== threadKey) warmEmpty = { threadKey, since: performance.now() }
  return warmEmpty.since
}

/** The warm view's empty chat, when the real chat opens on the same one: it continues it instead of playing it in. */
export function warmEmptyViewOf(threadKey: string): { threadKey: string; since: number } | null {
  return warmEmpty?.threadKey === threadKey ? warmEmpty : null
}

/** The real chat has taken the warm view's place. */
export function endWarmEmptyView(): void {
  warmEmpty = null
}

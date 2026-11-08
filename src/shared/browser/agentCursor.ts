import type { BrowserAction, BrowserPoint } from './types'

/**
 * The agent cursor: where an agent acts in a Mousse browser tab, so a person watching sees a pointer
 * move to the element before the click, the typing or the scroll lands. The executors (the managed
 * browser's worker and the in-app tab's session in main) set it from the element they resolved;
 * Mousse draws it above the page (over the in-app webview, over a bot's frames), never in it, so it
 * can't change a page or show up in what an agent observes. Browser-safe.
 */
export interface BrowserAgentCursor {
  /** Viewport CSS pixels of the tab, at the target's actionable point. */
  x: number
  y: number
  /** What the agent does there. */
  action: BrowserAction['type']
  /** When the agent reached the point (ms since the epoch); a new value plays the click ripple again. */
  at: number
  /** The page's viewport, so a view of another size can scale the point. */
  viewport: { width: number; height: number }
  /** The session's tab the agent acts in. */
  tabId?: string
}

/** How long the cursor glides to its target before the action is sent, so a watcher sees it arrive. */
export const AGENT_CURSOR_GLIDE_MS = 220
/** After this long without a new action the cursor fades out. */
export const AGENT_CURSOR_IDLE_MS = 4_000

const POINTER_ACTIONS: ReadonlySet<BrowserAction['type']> = new Set(['click', 'double-click', 'hover', 'fill', 'type', 'key', 'select', 'check', 'scroll', 'drag', 'upload'])

/** The actions whose clicks show a ripple where they land. */
export function agentCursorClicks(action: BrowserAction['type']): boolean {
  return action === 'click' || action === 'double-click' || action === 'check' || action === 'fill' || action === 'type'
}

/**
 * The cursor for an action whose target resolved to `point` (a drag's start), or undefined when the
 * action has no place on the page (navigate, back, a key with no target). A scroll with no target
 * sits in the middle of the viewport.
 */
export function agentCursorFor(action: BrowserAction, point: BrowserPoint | undefined, viewport: { width: number; height: number }, at: number, tabId?: string): BrowserAgentCursor | undefined {
  if (!POINTER_ACTIONS.has(action.type)) return undefined
  const place = point ?? (action.type === 'scroll' ? { x: viewport.width / 2, y: viewport.height / 2 } : undefined)
  if (!place || !Number.isFinite(place.x) || !Number.isFinite(place.y) || !(viewport.width > 0) || !(viewport.height > 0)) return undefined
  return {
    x: Math.max(0, Math.min(viewport.width, place.x)),
    y: Math.max(0, Math.min(viewport.height, place.y)),
    action: action.type,
    at,
    viewport: { width: viewport.width, height: viewport.height },
    ...(tabId ? { tabId } : {})
  }
}

/** Whether a cursor is still worth showing at `now`. */
export function agentCursorLive(cursor: BrowserAgentCursor | undefined, now: number): cursor is BrowserAgentCursor {
  return Boolean(cursor) && now - cursor!.at < AGENT_CURSOR_IDLE_MS
}

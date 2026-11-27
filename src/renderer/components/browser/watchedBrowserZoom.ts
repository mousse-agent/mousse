import { useCallback, useState } from 'react'
import { watchedBrowserPageSize, type WatchedBrowserPageSize } from '../../../shared/browser/watched'

/**
 * The zoom of a browser without a window as a person watches it (a bot's, a thread agent's): the page is laid out at
 * the view's size divided by the zoom, and drawn at the screen's pixel ratio times it, so zooming out shows more of
 * the page, smaller, as a browser's zoom does. The thread browser's steps and bounds (10%, from 50% to 200%).
 *
 * Its default is under 100%: the view sits in a side panel, far narrower than a browser window, and at 100% a page
 * there is laid out for a phone and reads as zoomed in. One zoom for every such view, kept across launches.
 */
export const WATCHED_BROWSER_ZOOM = { default: 0.8, min: 0.5, max: 2, step: 0.1 } as const

const ZOOM_KEY = 'mousse:watched-browser-zoom'

/** A zoom within the bounds, at whole percents (0.1 steps never drift to 0.7999…). */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return WATCHED_BROWSER_ZOOM.default
  return Math.round(Math.min(WATCHED_BROWSER_ZOOM.max, Math.max(WATCHED_BROWSER_ZOOM.min, value)) * 100) / 100
}

function storedZoom(): number {
  try {
    const stored = Number.parseFloat(window.localStorage.getItem(ZOOM_KEY) ?? '')
    return Number.isFinite(stored) ? clampZoom(stored) : WATCHED_BROWSER_ZOOM.default
  } catch {
    return WATCHED_BROWSER_ZOOM.default
  }
}

/** The zoom, and a change of it: `in` and `out` by a step, `reset` back to the default. */
export function useWatchedBrowserZoom(): [number, (change: 'in' | 'out' | 'reset') => void] {
  const [zoom, setZoom] = useState(storedZoom)
  const change = useCallback((how: 'in' | 'out' | 'reset') => {
    setZoom((current) => {
      const next = how === 'reset' ? WATCHED_BROWSER_ZOOM.default : clampZoom(current + (how === 'in' ? 1 : -1) * WATCHED_BROWSER_ZOOM.step)
      try {
        window.localStorage.setItem(ZOOM_KEY, String(next))
      } catch {
        // Kept for this window only.
      }
      return next
    })
  }, [])
  return [zoom, change]
}

/**
 * The page's size for a view of `stage` (its CSS pixels and the screen's pixel ratio) at `zoom`: laid out at the
 * stage's size over the zoom, at a pixel ratio of at least the screen's times the zoom (rounded up to the quarter the
 * service keeps), so the picture is never coarser than the screen it is drawn on.
 */
export function pageAtZoom(stage: WatchedBrowserPageSize, zoom: number): WatchedBrowserPageSize {
  if (zoom === 1) return stage
  return watchedBrowserPageSize({ width: stage.width / zoom, height: stage.height / zoom, scale: Math.ceil(stage.scale * zoom * 4) / 4 })
}

/** The zoom keys: Control (Command on a Mac) with + or =, with -, or with 0. */
export function zoomKey(event: { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, mac: boolean): 'in' | 'out' | 'reset' | undefined {
  if (!(mac ? event.metaKey : event.ctrlKey) || event.altKey) return undefined
  if (event.code === 'Equal' || event.code === 'NumpadAdd' || event.key === '+' || event.key === '=') return 'in'
  if (event.code === 'Minus' || event.code === 'NumpadSubtract' || event.key === '-') return 'out'
  if (event.code === 'Digit0' || event.code === 'Numpad0' || event.key === '0') return 'reset'
  return undefined
}

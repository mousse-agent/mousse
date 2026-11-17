import { useCallback } from 'react'
import '../styles/offscreen-motion.css'

/**
 * Looping indicators (a running call's pulse, the thinking icon, the live row's dots, a shimmering label, a spinner)
 * stop while no one can see them: when they are scrolled out of view, or when the window is hidden or minimised. A
 * stopped CSS animation still costs a compositor frame per step, and React's root listener for `animationiteration`
 * wakes the main thread at every loop, so a turn left running below the fold kept paying for motion nobody saw.
 *
 * Each watched element gets `data-offscreen` while it cannot be seen, and offscreen-motion.css pauses its animation
 * (`animation-play-state`), so it stays where it is, keeps its layout and its frame, and carries on from there when it
 * comes back. Nothing is unmounted. A Web Animation (lib/turning.tsx) is paused through `onChange`.
 *
 * One IntersectionObserver serves every watched element, and one `visibilitychange` listener the document; both exist
 * only while something is watched. Where there is no IntersectionObserver, only the window's visibility counts.
 */

type Watched = { intersecting: boolean; offscreen: boolean | undefined; onChange?: (offscreen: boolean) => void }

const watched = new Map<Element, Watched>()
let observer: IntersectionObserver | null = null

function windowHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function apply(element: Element, entry: Watched): void {
  const offscreen = windowHidden() || !entry.intersecting
  if (offscreen === entry.offscreen) return
  entry.offscreen = offscreen
  element.toggleAttribute('data-offscreen', offscreen)
  entry.onChange?.(offscreen)
}

function onVisibility(): void {
  for (const [element, entry] of watched) apply(element, entry)
}

function onIntersect(entries: IntersectionObserverEntry[]): void {
  for (const change of entries) {
    const entry = watched.get(change.target)
    if (!entry) continue
    entry.intersecting = change.isIntersecting
    apply(change.target, entry)
  }
}

/**
 * Watches `element` until the returned function is called: `data-offscreen` is set on it while it is out of view or
 * the window is hidden, and `onChange` hears each change.
 */
export function watchOffscreen(element: Element, onChange?: (offscreen: boolean) => void): () => void {
  if (watched.size === 0) {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    if (typeof IntersectionObserver !== 'undefined') observer = new IntersectionObserver(onIntersect)
  }
  // Seen until the observer's first report, which comes at once.
  const entry: Watched = { intersecting: true, offscreen: undefined, onChange }
  watched.set(element, entry)
  observer?.observe(element)
  apply(element, entry)
  return () => {
    if (watched.get(element) !== entry) return
    watched.delete(element)
    observer?.unobserve(element)
    element.removeAttribute('data-offscreen')
    if (watched.size > 0) return
    observer?.disconnect()
    observer = null
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
  }
}

/** For tests: how many elements are watched, and whether the observer is up. */
export function offscreenWatchForTests(): { elements: number; observing: boolean } {
  return { elements: watched.size, observing: observer !== null }
}

/** A ref for an element whose animation loops while `active`: it pauses while no one can see it (watchOffscreen). */
export function useOffscreenPause<T extends Element>(active: boolean): (element: T | null) => (() => void) | undefined {
  return useCallback((element: T | null) => {
    if (!element || !active) return undefined
    return watchOffscreen(element)
  }, [active])
}

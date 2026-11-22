import { useEffect, useState, useSyncExternalStore } from 'react'
import { ANIMATION_SPEED_SCALE, isAnimationSpeed, type AnimationSpeed } from '../../shared/settings'

// Mirrors Settings > Appearance > Advanced > Animation speed. useTheme feeds it from the open
// profile's settings; it stays at Normal until they load. The OS reduced-motion setting turns
// motion off whatever the speed.
//
// CSS reads the result from <html>: `--ui-motion-scale` multiplies the `--ui-dur*` tokens in
// polish.css and `data-motion="off"` zeroes every other transition and animation (global.css).
// Motion timed in script reads motionScale() or scaleMotionMs().

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

let speed: AnimationSpeed = 'normal'
let watchingOs = false
let scale = ANIMATION_SPEED_SCALE.normal
const listeners = new Set<() => void>()

function osReducesMotion(): boolean {
  const matchMedia = globalThis.matchMedia
  if (typeof matchMedia !== 'function') return false
  const query = matchMedia.call(globalThis, REDUCED_MOTION_QUERY)
  if (!watchingOs) {
    watchingOs = true
    query.addEventListener?.('change', update)
  }
  return query.matches === true
}

function currentScale(): number {
  return osReducesMotion() ? 0 : ANIMATION_SPEED_SCALE[speed]
}

function update(): void {
  const next = currentScale()
  if (typeof document !== 'undefined') {
    const root = document.documentElement
    root.style.setProperty('--ui-motion-scale', String(next))
    if (next === 0) root.setAttribute('data-motion', 'off')
    else root.removeAttribute('data-motion')
  }
  if (next === scale) return
  scale = next
  for (const listener of listeners) listener()
}

/** Applies a speed to the document. Unknown values fall back to Normal. */
export function setAnimationSpeed(next: AnimationSpeed | undefined): void {
  speed = isAnimationSpeed(next) ? next : 'normal'
  update()
}

/** The multiplier on UI motion: 0 when off (by the setting or the OS), else 0.6, 1 or 1.6. */
export function motionScale(): number {
  return currentScale()
}

/** Whether UI motion is off, by the setting or the OS reduced-motion setting. */
export function motionOff(): boolean {
  return motionScale() === 0
}

/** A script-timed motion duration at the current speed. */
export function scaleMotionMs(ms: number): number {
  return Math.round(ms * motionScale())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** motionScale() for components; re-renders when the speed or the OS setting changes. */
export function useMotionScale(): number {
  return useSyncExternalStore(subscribe, motionScale, motionScale)
}

/** How long a view swap's settle runs, before the speed scale (sidebar tabs, the workspace beside them). */
export const VIEW_SWAP_IN_MS = 180

export type ViewSwapPhase = 'in' | null

/**
 * A view that follows `target` at once: the new view shows in the same update as the change, fully drawn, and
 * `phase` is 'in' while it settles into place (a short lift, sidebar-view-motion.css). Nothing waits for the old
 * view to fade out first, and the new one never starts transparent, so a swap shows no empty frames. With motion
 * off (the setting, the OS, or no renderer) `phase` stays null.
 */
export function useViewSwap<T>(target: T, animate = true): { shown: T; phase: ViewSwapPhase } {
  const scale = useMotionScale()
  const instant = !animate || scale === 0 || typeof globalThis.matchMedia !== 'function'
  const [swap, setSwap] = useState({ target, entering: 0 })
  // Set while rendering, so the change and its settle reach the screen in the same commit.
  if (!Object.is(swap.target, target) || (instant && swap.entering > 0)) setSwap({ target, entering: instant ? 0 : Math.abs(swap.entering) + 1 })
  const entering = Object.is(swap.target, target) ? swap.entering : 0
  useEffect(() => {
    if (entering <= 0) return
    // A little past the settle, so its transitions finish before the swap's rules go.
    const timer = setTimeout(() => setSwap((current) => (current.entering === entering ? { ...current, entering: -entering } : current)), scaleMotionMs(VIEW_SWAP_IN_MS) + 40)
    return () => clearTimeout(timer)
  }, [entering])
  return { shown: target, phase: !instant && entering > 0 ? 'in' : null }
}

interface Glide {
  /** Where this module last put the scroller, unrounded, so fractional trackpad deltas add up. */
  position: number
  /** The scrollTop that write produced; any other value means something else moved the scroller. */
  written: number
  /** Distance a notched wheel step still has to travel. */
  remaining: number
  frame: number
  last: number
}
const glides = new WeakMap<HTMLElement, Glide>()
/** A notched wheel step eases out over about 150 ms, like Chromium's own wheel animation. */
const EASE_MS = 50

/**
 * Scrolls the conversation by a wheel turn the applet over it could not use (see `appletDocument`), as if the wheel
 * had turned over the host itself. The turn is first replayed as a wheel event on the host, so the transcript's
 * listeners (following the end, loading earlier messages, hiding the native view while it scrolls) see the same
 * input as over any other part of a reply. Trackpad deltas apply at once; notched wheel steps ease.
 */
export function forwardAppletWheel(scroller: HTMLElement, origin: Element, deltaY: number, discrete: boolean): void {
  if (!Number.isFinite(deltaY) || !deltaY) return
  const replay = new WheelEvent('wheel', { deltaY, deltaMode: 0, bubbles: true, cancelable: true })
  origin.dispatchEvent(replay)
  if (replay.defaultPrevented) return
  let glide = glides.get(scroller)
  if (!glide) {
    glide = { position: scroller.scrollTop, written: scroller.scrollTop, remaining: 0, frame: 0, last: 0 }
    glides.set(scroller, glide)
  }
  if (!discrete) {
    move(scroller, glide, deltaY)
    return
  }
  // A turn the other way drops what is left of the previous step, as a native wheel does.
  if (Math.sign(glide.remaining) !== Math.sign(deltaY)) glide.remaining = 0
  glide.remaining += deltaY
  if (glide.frame) return
  glide.last = performance.now()
  const step = (now: number) => {
    const current = glide!
    const elapsed = Math.max(0, now - current.last)
    current.last = now
    const share = Math.abs(current.remaining) < 1 ? current.remaining : current.remaining * (1 - Math.exp(-elapsed / EASE_MS))
    current.remaining -= share
    const blocked = !move(scroller, current, share)
    if (blocked || !scroller.isConnected || Math.abs(current.remaining) < 0.01) {
      current.remaining = 0
      current.frame = 0
      return
    }
    current.frame = requestAnimationFrame(step)
  }
  glide.frame = requestAnimationFrame(step)
}

/** Moves the scroller by `delta` within its range; false once it is at that end. */
function move(scroller: HTMLElement, glide: Glide, delta: number): boolean {
  const top = scroller.scrollTop
  if (Math.abs(top - glide.written) > 1) glide.position = top
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  const next = Math.min(max, Math.max(0, glide.position + delta))
  if (next === glide.position && (next === 0 || next === max)) return delta === 0
  glide.position = next
  scroller.scrollTop = next
  glide.written = scroller.scrollTop
  return true
}

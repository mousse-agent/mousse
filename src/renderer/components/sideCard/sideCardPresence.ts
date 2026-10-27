/** Keep in sync with the opacity/transform transitions on `.thread-side-card` and the scrim, and the column transition in sideCard.css. */
export const SIDE_CARD_FADE_MS = 180

/**
 * Where the card is in its life:
 * - `unmounted`: not in the layout
 * - `entering`: mounted and still faded out, waiting for that to paint so the fade-in runs as a transition
 * - `shown`: faded in
 * - `exiting`: fading out, still mounted until the fade has finished
 */
export type SideCardPhase = 'unmounted' | 'entering' | 'shown' | 'exiting'

export type SideCardPresenceEvent =
  /** The card should be showing. `animate: false` skips the fade-in (first appearance at launch). */
  | { type: 'present'; animate: boolean }
  | { type: 'absent' }
  /** The faded-out card has painted, so it can fade in. */
  | { type: 'painted' }
  /** The fade-out has finished. */
  | { type: 'faded' }

export function nextSideCardPhase(phase: SideCardPhase, event: SideCardPresenceEvent): SideCardPhase {
  switch (event.type) {
    case 'present':
      if (phase === 'unmounted') return event.animate ? 'entering' : 'shown'
      // Coming back mid-fade reverses the transition from wherever it got to.
      return phase === 'exiting' ? 'shown' : phase
    case 'absent':
      // A card that never faded in has nothing to fade out.
      if (phase === 'entering') return 'unmounted'
      return phase === 'shown' ? 'exiting' : phase
    case 'painted':
      return phase === 'entering' ? 'shown' : phase
    case 'faded':
      return phase === 'exiting' ? 'unmounted' : phase
  }
}

export interface SideCardPresenceView {
  /** The card is in the layout. */
  mounted: boolean
  /** The card is faded in; drives `data-shown`. */
  shown: boolean
  /**
   * The thread view keeps room for the card on its right. Starts with the
   * card's fade-in and ends when its fade-out starts, so the transcript and the
   * card move together.
   */
  reserved: boolean
}

export function sideCardPresenceView(phase: SideCardPhase): SideCardPresenceView {
  return {
    mounted: phase !== 'unmounted',
    shown: phase === 'shown',
    reserved: phase === 'entering' || phase === 'shown'
  }
}

export interface SideCardScheduler {
  /** Runs `callback` once the current frame has painted and the next has started; returns a canceller. */
  afterPaint: (callback: () => void) => () => void
  after: (ms: number, callback: () => void) => () => void
}

const FRAME_MS = 16

/**
 * Two frames let the faded-out styles paint once. Reduced motion changes how
 * the card looks (opacity only), not these timings: it still fades in and waits
 * for the fade-out.
 */
export const browserSideCardScheduler: SideCardScheduler = {
  afterPaint(callback) {
    if (typeof requestAnimationFrame === 'undefined') {
      const timer = setTimeout(callback, 2 * FRAME_MS)
      return () => clearTimeout(timer)
    }
    let inner: number | undefined
    const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(callback) })
    return () => {
      cancelAnimationFrame(outer)
      if (inner !== undefined) cancelAnimationFrame(inner)
    }
  },
  after(ms, callback) {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  }
}

export interface SideCardPresence {
  readonly phase: SideCardPhase
  setPresent: (present: boolean, animate?: boolean) => void
  /** Cancels pending timers. */
  dispose: () => void
}

/**
 * Drives the phases with timers: `entering` becomes `shown` after a paint,
 * `exiting` becomes `unmounted` after the fade. `onChange` fires on every phase change.
 */
export function createSideCardPresence(
  onChange: (phase: SideCardPhase) => void,
  initial: SideCardPhase = 'unmounted',
  scheduler: SideCardScheduler = browserSideCardScheduler
): SideCardPresence {
  let phase = initial
  let cancel: (() => void) | null = null

  const schedule = () => {
    cancel?.()
    cancel = null
    if (phase === 'entering') cancel = scheduler.afterPaint(() => move({ type: 'painted' }))
    else if (phase === 'exiting') cancel = scheduler.after(SIDE_CARD_FADE_MS, () => move({ type: 'faded' }))
  }

  function move(event: SideCardPresenceEvent) {
    const next = nextSideCardPhase(phase, event)
    if (next === phase) return
    phase = next
    schedule()
    onChange(phase)
  }

  // Resume a fade that was in flight when a previous controller was disposed.
  schedule()

  return {
    get phase() { return phase },
    setPresent(present, animate = true) {
      move(present ? { type: 'present', animate } : { type: 'absent' })
    },
    dispose() {
      cancel?.()
      cancel = null
    }
  }
}

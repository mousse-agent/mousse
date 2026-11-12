// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COLLAPSE_MS,
  QUEUED_TURN_HOLD_MS,
  collapsedReserve,
  heldReserve,
  heldTotalReserve
} from '../../src/renderer/chat/components/agent-elements/virtual/end-follow'

// The Animation speed multiplier the follower reads: 1 is Normal, 0 is Off or the system reducing motion.
const motion = vi.hoisted(() => ({ scale: 1 }))
vi.mock('../../src/renderer/lib/motion', () => ({ motionScale: () => motion.scale }))

const { createEndFollower } = await import('../../src/renderer/chat/components/agent-elements/virtual/end-follower')
type FollowMode = 'following-end' | 'free'

describe('the space under the content', () => {
  it('keeps only the part of the space the view stands on', () => {
    // A reader far above the end: none of it is in view.
    expect(heldReserve({ reserve: 500, scrollTop: 1000, clientHeight: 800, contentHeight: 4000 })).toBe(0)
    // A reader at the end of a short reply: all of it is.
    expect(heldReserve({ reserve: 500, scrollTop: 3700, clientHeight: 800, contentHeight: 4000 })).toBe(500)
    // Partly scrolled up: what is left below the viewport goes.
    expect(heldReserve({ reserve: 500, scrollTop: 3500, clientHeight: 800, contentHeight: 4000 })).toBe(300)
    // A thread that fits the viewport, not scrolled: nothing would move without it.
    expect(heldReserve({ reserve: 500, scrollTop: 0, clientHeight: 800, contentHeight: 300 })).toBe(0)
    // Never grows.
    expect(heldReserve({ reserve: 100, scrollTop: 3900, clientHeight: 800, contentHeight: 4000 })).toBe(100)
  })

  it('closes with an ease out and ends at zero', () => {
    const steps = [0, 40, 80, 130, 200, 259, 260].map(t => collapsedReserve(400, t, COLLAPSE_MS))
    for (let index = 1; index < steps.length; index++) expect(steps[index]!).toBeLessThanOrEqual(steps[index - 1]!)
    expect(steps[0]).toBe(400)
    expect(steps.at(-1)).toBe(0)
    // Fast at first: the first quarter covers more than half of it.
    expect(collapsedReserve(400, COLLAPSE_MS / 4, COLLAPSE_MS)).toBeLessThan(200)
    expect(collapsedReserve(400, 0, 0)).toBe(0)
  })
})

describe('holding the end while something near it is replaced', () => {
  it('fills what left until the content grows back, then nothing', () => {
    expect(heldTotalReserve({ total: 3000, contentHeight: 2940 })).toBe(60)
    expect(heldTotalReserve({ total: 3000, contentHeight: 3000 })).toBe(0)
    expect(heldTotalReserve({ total: 3000, contentHeight: 3080 })).toBe(0)
  })
})

/**
 * A transcript with layout done by hand: content of a given height, a viewport of 800 px, rows
 * at given offsets. The scroll position clamps as the browser does.
 */
function transcript(options: { content: number; mode?: FollowMode; scrollTop?: number }) {
  const clientHeight = 800
  // `queue`: where the queued messages start, in scroll space; null when nothing is queued.
  const state = { content: options.content, mode: (options.mode ?? 'following-end') as FollowMode, scrollTop: 0, writes: 0, queue: null as number | null }
  const reserveEl = document.createElement('div')
  const reserve = () => Number.parseFloat(reserveEl.style.height || '0')
  const scrollHeight = () => Math.max(clientHeight, state.content + reserve())
  const clamp = () => { state.scrollTop = Math.max(0, Math.min(state.scrollTop, scrollHeight() - clientHeight)) }
  const container = {
    get scrollHeight() { return scrollHeight() },
    clientHeight,
    clientTop: 0,
    get scrollTop() { clamp(); return state.scrollTop },
    set scrollTop(value: number) { state.scrollTop = Math.round(value); clamp() },
    getBoundingClientRect: () => ({ top: 0 })
  } as unknown as HTMLElement
  reserveEl.getBoundingClientRect = () => ({ top: state.content - container.scrollTop }) as DOMRect
  const after = {
    get childElementCount() { return state.queue === null ? 0 : 1 },
    getBoundingClientRect: () => ({ top: (state.queue ?? state.content) - container.scrollTop })
  } as unknown as HTMLElement
  const follower = createEndFollower({
    container: () => container,
    after: () => after,
    mode: () => state.mode,
    onProgrammaticScroll: () => { state.writes += 1 }
  })
  follower.reserveRef(reserveEl)
  state.scrollTop = options.scrollTop ?? scrollHeight() - clientHeight
  const end = () => scrollHeight() - clientHeight
  return { state, container, follower, reserve, end, clientHeight }
}

/** Sends a prompt at the end of the thread: its row is 100 px with the gaps. */
function send(t: ReturnType<typeof transcript>) {
  t.state.content += 100
  t.follower.setLive(true)
  t.follower.turnStarted()
}

const frame = () => vi.advanceTimersByTime(16)

describe('the transcript while a reply streams', () => {
  beforeEach(() => {
    motion.scale = 1
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'clearTimeout'] })
  })
  afterEach(() => vi.useRealTimers())

  it('keeps the prompt at the bottom on send, with no space under it, and the reply grows from there', () => {
    const t = transcript({ content: 3000 })
    send(t)
    // The prompt is the last thing on screen: the view is on the end of the content.
    expect(t.reserve()).toBe(0)
    expect(t.container.scrollTop).toBe(t.state.content - t.clientHeight)
    for (let step = 0; step < 6; step++) {
      t.state.content += 100
      t.follower.follow()
      expect(t.reserve()).toBe(0)
      expect(t.container.scrollTop).toBe(t.state.content - t.clientHeight)
    }
  })

  it('drops a space left under the last reply when the next prompt is sent, so the prompt sits on the bottom', () => {
    const t = transcript({ content: 3000 })
    send(t)
    t.state.content += 1200
    t.follower.follow()
    t.state.content -= 60
    t.follower.follow()
    t.follower.turnEnded()
    frame()
    expect(t.reserve()).toBeGreaterThan(0)
    send(t)
    expect(t.reserve()).toBe(0)
    expect(t.container.scrollTop).toBe(t.state.content - t.clientHeight)
    for (let index = 0; index < 20; index++) frame()
    expect(t.container.scrollTop).toBe(t.state.content - t.clientHeight)
  })

  it('follows the end in the same frame once the reply outgrows the screen, on every update', () => {
    const t = transcript({ content: 3000 })
    send(t)
    t.state.content += 1200
    t.follower.follow()
    expect(t.reserve()).toBe(0)
    // Before paint: no frame shows the view short of the end.
    expect(t.container.scrollTop).toBe(t.end())
    for (let step = 0; step < 10; step++) {
      t.state.content += 40 + step * 13
      t.follower.follow()
      expect(t.container.scrollTop).toBe(t.end())
      const at = t.container.scrollTop
      frame()
      frame()
      // Nothing moves between updates.
      expect(t.container.scrollTop).toBe(at)
    }
  })

  it('holds the end when something near it leaves mid-turn, so the view does not drop and come back', () => {
    const t = transcript({ content: 3000 })
    send(t)
    t.state.content += 1200
    t.follower.follow()
    const at = t.container.scrollTop
    // Send now: the queued message leaves the list (60 px) a commit before the reply shows it (70 px).
    t.state.content -= 60
    t.follower.follow()
    expect(t.container.scrollTop).toBe(at)
    expect(t.reserve()).toBe(60)
    t.state.content += 70
    t.follower.follow()
    expect(t.reserve()).toBe(0)
    expect(t.container.scrollTop).toBe(at + 10)
    expect(t.follower.holding()).toBe(false)
  })

  it('closes a held space after the turn ends, if nothing grew into it', () => {
    const t = transcript({ content: 3000 })
    send(t)
    t.state.content += 1200
    t.follower.follow()
    t.state.content -= 60
    t.follower.follow()
    expect(t.reserve()).toBe(60)
    t.follower.turnEnded()
    for (let index = 0; index < 30 && t.reserve() > 0; index++) frame()
    expect(t.reserve()).toBe(0)
    expect(t.container.scrollTop).toBe(t.end())
  })

  it('keeps the end in place until the next queued turn starts, then lands on its prompt at the end', () => {
    const t = transcript({ content: 3000 })
    send(t)
    t.state.content += 300
    t.follower.follow()
    expect(t.container.scrollTop).toBe(t.end())
    // The turn ends with a message still queued; it leaves the queue (80 px) before its turn shows.
    t.follower.turnEnded(true)
    const positions = [t.container.scrollTop]
    t.state.content -= 80
    t.follower.follow()
    positions.push(t.container.scrollTop)
    for (let index = 0; index < 20; index++) {
      frame()
      positions.push(t.container.scrollTop)
    }
    // Nothing slides while the next turn is on its way.
    expect(new Set(positions).size).toBe(1)
    // Its turn shows at the end: the prompt is on the bottom, with no space under it.
    send(t)
    expect(t.reserve()).toBe(0)
    expect(t.follower.holding()).toBe(false)
    expect(t.container.scrollTop).toBe(t.state.content - t.clientHeight)
    expect(t.container.scrollTop).toBeGreaterThanOrEqual(positions[0]!)
  })

  it('holds the end as painted when the turn ends and its live line leaves in the same commit', () => {
    const t = transcript({ content: 3000 })
    send(t)
    t.state.content += 1200
    t.follower.follow()
    const at = t.container.scrollTop
    expect(at).toBe(t.end())
    // The turn ends with a message still queued; its live line (32 px) leaves in the same commit, and
    // the browser clamps the view to the shorter end before the follower hears of the turn's end.
    t.state.content -= 32
    t.follower.turnEnded(true)
    t.follower.follow()
    const positions = [t.container.scrollTop]
    for (let index = 0; index < 20; index++) {
      frame()
      positions.push(t.container.scrollTop)
    }
    expect(new Set(positions)).toEqual(new Set([at]))
    expect(t.reserve()).toBe(32)
    // The next turn shows at the end and fills what was held.
    send(t)
    expect(t.reserve()).toBe(0)
    expect(t.container.scrollTop).toBe(t.state.content - t.clientHeight)
    expect(t.container.scrollTop).toBeGreaterThan(at)
  })

  /** A long reply at the end, 2 queued messages under it (150 px, then 40 px of gap to the end). */
  function longTurnWithQueue() {
    const t = transcript({ content: 3000 })
    send(t)
    t.state.content += 1200
    t.follower.follow()
    t.state.content += 190
    t.state.queue = t.state.content - 190
    t.follower.follow()
    expect(t.container.scrollTop).toBe(t.end())
    return t
  }
  const queueOnScreen = (t: ReturnType<typeof transcript>) => t.state.queue! - t.container.scrollTop

  it('keeps the queue where it was when the turn ends and its work folds away above it, with no space under it', () => {
    const t = longTurnWithQueue()
    const painted = queueOnScreen(t)
    // The turn ends: its work folds into "Worked for" (480 px) and its live line (32 px) leaves, both above the queue.
    t.state.content -= 512
    t.state.queue! -= 512
    t.follower.turnEnded(true)
    t.follower.follow()
    expect(queueOnScreen(t)).toBe(painted)
    // Nothing blank opens under the queue: the view is on the end of the content.
    expect(t.reserve()).toBe(0)
    for (let index = 0; index < 20; index++) frame()
    expect(queueOnScreen(t)).toBe(painted)
    // The next turn shows at the end, with no space under it.
    t.state.queue = null
    send(t)
    expect(t.reserve()).toBe(0)
    expect(t.container.scrollTop).toBe(t.state.content - t.clientHeight)
  })

  it('keeps the queue where it was when the work folds away a commit after the turn ended', () => {
    const t = longTurnWithQueue()
    const painted = queueOnScreen(t)
    t.state.content -= 32
    t.state.queue! -= 32
    t.follower.turnEnded(true)
    t.follower.follow()
    expect(queueOnScreen(t)).toBe(painted)
    t.state.content -= 480
    t.state.queue! -= 480
    t.follower.follow()
    expect(queueOnScreen(t)).toBe(painted)
    expect(t.reserve()).toBe(0)
  })

  it('holds what leaves under the queue when the turn ends (the gap under a reply)', () => {
    const t = longTurnWithQueue()
    const painted = queueOnScreen(t)
    t.state.content -= 40
    t.follower.turnEnded(true)
    t.follower.follow()
    expect(queueOnScreen(t)).toBe(painted)
    expect(t.reserve()).toBe(40)
  })

  it('closes the space as after any turn when the queued turn does not start', () => {
    const t = transcript({ content: 3000 })
    send(t)
    t.state.content += 1200
    t.follower.follow()
    // The turn's live line (32 px) leaves as it ends with a message queued: held for the next turn.
    t.state.content -= 32
    t.follower.turnEnded(true)
    t.follower.follow()
    expect(t.reserve()).toBe(32)
    vi.advanceTimersByTime(QUEUED_TURN_HOLD_MS)
    for (let index = 0; index < 30 && t.reserve() > 0; index++) frame()
    expect(t.reserve()).toBe(0)
    expect(t.container.scrollTop).toBe(t.state.content - t.clientHeight)
  })

  it('lets a reader scroll away from a held end', () => {
    const t = transcript({ content: 3000 })
    send(t)
    t.state.content += 300
    t.follower.follow()
    t.follower.turnEnded(true)
    t.state.mode = 'free'
    t.container.scrollTop -= 200
    t.follower.settle()
    expect(t.follower.holding()).toBe(false)
  })

  it('never moves a reader who scrolled up', () => {
    const t = transcript({ content: 3000 })
    send(t)
    t.state.mode = 'free'
    t.container.scrollTop = 1200
    const writes = t.state.writes
    for (let step = 0; step < 20; step++) {
      t.state.content += 150
      t.follower.follow()
      frame()
      expect(t.container.scrollTop).toBe(1200)
    }
    expect(t.state.writes).toBe(writes)
  })

  it('lands at once when no turn runs', () => {
    const t = transcript({ content: 3000 })
    t.follower.setLive(false)
    t.state.content += 500
    t.follower.follow()
    expect(t.container.scrollTop).toBe(t.end())
  })

  it('leaves no space under a short finished reply, and nothing moves when the turn ends', () => {
    const t = transcript({ content: 3000 })
    send(t)
    t.state.content += 200
    t.follower.follow()
    const at = t.container.scrollTop
    expect(at).toBe(t.state.content - t.clientHeight)
    expect(t.reserve()).toBe(0)
    t.follower.turnEnded()
    for (let index = 0; index < 30; index++) {
      frame()
      expect(t.container.scrollTop).toBe(at)
    }
    expect(t.reserve()).toBe(0)
  })

  /** A long reply that lost 60 px near its end, the turn not ended yet: 60 px held under it. */
  function heldSpace() {
    const t = transcript({ content: 3000 })
    send(t)
    t.state.content += 1200
    t.follower.follow()
    t.state.content -= 60
    t.follower.follow()
    expect(t.reserve()).toBe(60)
    return t
  }
  const settleFrames = (t: ReturnType<typeof transcript>) => {
    for (let index = 0; index < 40 && t.reserve() > 0; index++) frame()
  }

  it('leaves a reader who scrolled up where they are when the turn ends, and drops the space as they scroll', () => {
    const t = heldSpace()
    t.state.mode = 'free'
    t.container.scrollTop -= 30
    const at = t.container.scrollTop
    t.follower.settle()
    t.follower.turnEnded()
    for (let index = 0; index < 20; index++) frame()
    expect(t.container.scrollTop).toBe(at)
    expect(t.reserve()).toBe(30)
    // What they can reach below them shrinks as they scroll up; it never comes back.
    t.container.scrollTop = at - 300
    t.follower.settle()
    expect(t.reserve()).toBe(0)
  })

  it('closes the space once a reader who scrolled up comes back down after the turn', () => {
    const t = heldSpace()
    t.state.mode = 'free'
    t.container.scrollTop -= 30
    t.follower.settle()
    t.follower.turnEnded()
    for (let index = 0; index < 20; index++) frame()
    expect(t.reserve()).toBeGreaterThan(0)
    // Back at the end: the browser reads it as following again, and the space closes.
    t.container.scrollTop = t.end()
    t.state.mode = 'following-end'
    t.follower.settle()
    settleFrames(t)
    expect(t.reserve()).toBe(0)
    expect(t.container.scrollTop).toBe(t.state.content - t.clientHeight)
  })

  it('finishes closing after an End key or a wheel down in the middle of it', () => {
    const t = heldSpace()
    t.follower.turnEnded()
    frame()
    frame()
    const partway = t.reserve()
    expect(partway).toBeGreaterThan(0)
    // End (or a wheel down): any input stops our motion; the mode stays at the end.
    t.follower.cancel()
    t.follower.settle()
    settleFrames(t)
    expect(t.reserve()).toBe(0)
    expect(t.container.scrollTop).toBe(t.state.content - t.clientHeight)
  })

  it('keeps a wheel up in the middle of closing where it is, and closes once back at the end', () => {
    const t = heldSpace()
    t.follower.turnEnded()
    frame()
    frame()
    t.follower.cancel()
    t.state.mode = 'free'
    t.container.scrollTop -= 20
    const at = t.container.scrollTop
    t.follower.settle()
    for (let index = 0; index < 20; index++) frame()
    expect(t.container.scrollTop).toBe(at)
    t.container.scrollTop = t.end()
    t.state.mode = 'following-end'
    t.follower.settle()
    settleFrames(t)
    expect(t.reserve()).toBe(0)
  })

  it('leaves no gap in a short thread that fits the screen', () => {
    const t = transcript({ content: 0 })
    t.state.content = 124
    t.follower.setLive(true)
    t.follower.turnStarted()
    expect(t.container.scrollTop).toBe(0)
    t.state.content += 200
    t.follower.follow()
    expect(t.container.scrollTop).toBe(0)
    t.follower.turnEnded()
    expect(t.reserve()).toBe(0)
    expect(t.container.scrollTop).toBe(0)
  })
})

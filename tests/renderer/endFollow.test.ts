// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COLLAPSE_MS,
  PIN_TOP,
  collapsedReserve,
  glideStep,
  heldReserve,
  pinnedReserve
} from '../../src/renderer/chat/components/agent-elements/virtual/end-follow'

// The Animation speed multiplier the follower reads: 1 is Normal, 0 is Off or the system reducing motion.
const motion = vi.hoisted(() => ({ scale: 1 }))
vi.mock('../../src/renderer/lib/motion', () => ({ motionScale: () => motion.scale }))

const { createEndFollower } = await import('../../src/renderer/chat/components/agent-elements/virtual/end-follower')
type FollowMode = 'following-end' | 'free'

describe('the space under a pinned prompt', () => {
  it('lets the prompt sit near the top and shrinks as the reply grows, so the end stays put', () => {
    const clientHeight = 800
    const rowTop = 2000
    let content = rowTop + 100
    const reserve = pinnedReserve({ rowTop, clientHeight, contentHeight: content })
    const end = content + reserve - clientHeight
    expect(end).toBe(rowTop - PIN_TOP)
    // The reply grows a paragraph at a time: the end, and with it the view, does not move.
    for (let step = 0; step < 6; step++) {
      content += 100
      const next = pinnedReserve({ rowTop, clientHeight, contentHeight: content })
      expect(content + next - clientHeight).toBe(end)
    }
    // Once the reply reaches the bottom of the viewport there is no space left: the end is followed from there.
    expect(pinnedReserve({ rowTop, clientHeight, contentHeight: rowTop - PIN_TOP + clientHeight })).toBe(0)
    expect(pinnedReserve({ rowTop, clientHeight, contentHeight: rowTop + 5000 })).toBe(0)
  })

  it('asks for no scrolling for the first prompt of a thread', () => {
    // The first turn starts at the list's top padding: the end the space makes is 0.
    const reserve = pinnedReserve({ rowTop: PIN_TOP, clientHeight: 800, contentHeight: 300 })
    expect(300 + reserve - 800).toBe(0)
  })

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

describe('gliding to the end', () => {
  it('eases toward the target a share at a time and never overshoots', () => {
    let position = 0
    const target = 600
    const steps: number[] = []
    for (let frame = 0; frame < 60 && position !== target; frame++) {
      const next = glideStep(position, target, 16.7, 1)
      expect(next).toBeGreaterThan(position)
      expect(next).toBeLessThanOrEqual(target)
      steps.push(next - position)
      position = next
    }
    expect(position).toBe(target)
    // Eased: big steps first, small ones last; about a quarter of a second at 60 frames a second.
    expect(steps[0]!).toBeGreaterThan(steps.at(-1)!)
    expect(steps.length).toBeGreaterThan(8)
    expect(steps.length).toBeLessThan(40)
  })

  it('aims again at a target that moved, from where it is', () => {
    const first = glideStep(0, 600, 16.7, 1)
    const second = glideStep(first, 900, 16.7, 1)
    expect(second - first).toBeGreaterThan(first)
  })

  it('lands at once with motion off, and goes slower at Slow', () => {
    expect(glideStep(0, 600, 16.7, 0)).toBe(600)
    expect(glideStep(0, 600, 16.7, 1.6)).toBeLessThan(glideStep(0, 600, 16.7, 0.6))
    // A long stall does not turn into a leap.
    expect(glideStep(0, 600, 2000, 1)).toBeLessThan(600)
  })
})

/**
 * A transcript with layout done by hand: content of a given height, a viewport of 800 px, rows
 * at given offsets. The scroll position clamps as the browser does.
 */
function transcript(options: { content: number; mode?: FollowMode; scrollTop?: number }) {
  const clientHeight = 800
  const state = { content: options.content, mode: (options.mode ?? 'following-end') as FollowMode, scrollTop: 0, writes: 0 }
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
  const rowTops = new Map<string, number>()
  const rows = {
    querySelector(selector: string) {
      const key = /data-turn-key="([^"]+)"/.exec(selector)?.[1]
      const top = key === undefined ? undefined : rowTops.get(key)
      return top === undefined ? null : { getBoundingClientRect: () => ({ top: top - container.scrollTop }) }
    }
  } as unknown as HTMLElement
  const follower = createEndFollower({
    container: () => container,
    rows: () => rows,
    mode: () => state.mode,
    onProgrammaticScroll: () => { state.writes += 1 }
  })
  follower.reserveRef(reserveEl)
  state.scrollTop = options.scrollTop ?? scrollHeight() - clientHeight
  const end = () => scrollHeight() - clientHeight
  return { state, container, follower, rowTops, reserve, end, clientHeight }
}

/** Sends a prompt at the end of a thread of `before` px: its row is 100 px with the gaps. */
function send(t: ReturnType<typeof transcript>, key = 'turn') {
  const rowTop = t.state.content
  t.rowTops.set(key, rowTop)
  t.state.content += 100
  t.follower.setLive(true)
  t.follower.pin(key)
  return rowTop
}

const frame = () => vi.advanceTimersByTime(16)

describe('the transcript while a reply streams', () => {
  beforeEach(() => {
    motion.scale = 1
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'clearTimeout'] })
  })
  afterEach(() => vi.useRealTimers())

  it('pins the prompt near the top on send and does not scroll while the reply fits', () => {
    const t = transcript({ content: 3000 })
    const rowTop = send(t)
    expect(t.container.scrollTop).toBe(rowTop - PIN_TOP)
    const landed = t.state.writes
    // Six paragraphs arrive, each followed by layout: nothing scrolls, the space shrinks.
    for (let step = 0; step < 6; step++) {
      t.state.content += 100
      t.follower.follow()
      frame()
      expect(t.container.scrollTop).toBe(rowTop - PIN_TOP)
    }
    expect(t.state.writes).toBe(landed)
    expect(t.reserve()).toBe(t.clientHeight - PIN_TOP - 100 - 600)
    expect(t.follower.pinned()).toBe('turn')
  })

  it('starts following, with a glide, once the reply outgrows the screen', () => {
    const t = transcript({ content: 3000 })
    const rowTop = send(t)
    t.state.content += 1200
    t.follower.follow()
    expect(t.follower.pinned()).toBeNull()
    expect(t.reserve()).toBe(0)
    // Not in the same frame: the glide moves one step a frame.
    expect(t.container.scrollTop).toBe(rowTop - PIN_TOP)
    const positions: number[] = []
    for (let index = 0; index < 40 && t.container.scrollTop < t.end(); index++) {
      const writes = t.state.writes
      frame()
      expect(t.state.writes - writes).toBeLessThanOrEqual(1)
      positions.push(t.container.scrollTop)
    }
    expect(t.container.scrollTop).toBe(t.end())
    expect(positions.length).toBeGreaterThan(5)
    for (let index = 1; index < positions.length; index++) expect(positions[index]!).toBeGreaterThan(positions[index - 1]!)
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

  it('stops gliding the moment the person scrolls', () => {
    const t = transcript({ content: 3000 })
    send(t)
    t.state.content += 1000
    t.follower.follow()
    frame()
    frame()
    const at = t.container.scrollTop
    expect(at).toBeLessThan(t.end())
    t.follower.cancel()
    t.state.mode = 'free'
    const writes = t.state.writes
    for (let index = 0; index < 20; index++) frame()
    expect(t.container.scrollTop).toBe(at)
    expect(t.state.writes).toBe(writes)
  })

  it('lands at once on every update with motion off', () => {
    motion.scale = 0
    const t = transcript({ content: 3000 })
    send(t)
    t.state.content += 1500
    t.follower.follow()
    expect(t.container.scrollTop).toBe(t.end())
  })

  it('lands at once when no turn runs', () => {
    const t = transcript({ content: 3000 })
    t.follower.setLive(false)
    t.state.content += 500
    t.follower.follow()
    expect(t.container.scrollTop).toBe(t.end())
  })

  it('closes the space under a short finished reply smoothly, the view riding it down', () => {
    const t = transcript({ content: 3000 })
    const rowTop = send(t)
    t.state.content += 200
    t.follower.follow()
    const start = t.container.scrollTop
    expect(start).toBe(rowTop - PIN_TOP)
    t.follower.turnEnded()
    const positions: number[] = [t.container.scrollTop]
    for (let index = 0; index < 30 && t.reserve() > 0; index++) {
      frame()
      positions.push(t.container.scrollTop)
    }
    expect(t.reserve()).toBe(0)
    // The end of the reply now sits at the bottom, as at the end of any thread.
    expect(t.container.scrollTop).toBe(t.state.content - t.clientHeight)
    expect(positions.length).toBeGreaterThan(5)
    // Each frame moves a part of the way: no jump.
    const total = start - t.container.scrollTop
    for (let index = 1; index < positions.length; index++) {
      expect(positions[index]!).toBeLessThanOrEqual(positions[index - 1]!)
      expect(positions[index - 1]! - positions[index]!).toBeLessThan(total * 0.5)
    }
  })

  it('leaves a reader who scrolled up where they are when the turn ends, and drops the space as they scroll', () => {
    const t = transcript({ content: 3000 })
    send(t)
    t.state.content += 200
    t.follower.follow()
    t.state.mode = 'free'
    t.container.scrollTop -= 200
    const at = t.container.scrollTop
    t.follower.turnEnded()
    for (let index = 0; index < 20; index++) frame()
    expect(t.container.scrollTop).toBe(at)
    // What they can reach below them shrinks as they scroll up; it never comes back.
    t.container.scrollTop = at - 300
    t.follower.settle()
    expect(t.reserve()).toBeLessThanOrEqual(Math.max(0, at - 300 + t.clientHeight - t.state.content))
  })

  it('lands at once when the end is more than a screen away', () => {
    const t = transcript({ content: 3000 })
    send(t)
    t.state.content += 2500
    t.follower.follow()
    expect(t.container.scrollTop).toBe(t.end())
  })

  /** A short reply under a pinned prompt, the turn not ended yet: 476 px of space under it. */
  function shortReply() {
    const t = transcript({ content: 3000 })
    const rowTop = send(t)
    t.state.content += 200
    t.follower.follow()
    expect(t.reserve()).toBe(476)
    return { t, rowTop }
  }
  const settleFrames = (t: ReturnType<typeof transcript>) => {
    for (let index = 0; index < 40 && t.reserve() > 0; index++) frame()
  }

  it('closes the space once a reader who scrolled up comes back down after the turn', () => {
    const { t } = shortReply()
    t.state.mode = 'free'
    t.container.scrollTop -= 100
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
    const { t } = shortReply()
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
    const { t } = shortReply()
    t.follower.turnEnded()
    frame()
    frame()
    t.follower.cancel()
    t.state.mode = 'free'
    t.container.scrollTop -= 120
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

  it('ends the pin when the reader jumps to the prompt mid-stream, so Go to latest lands on the reply', () => {
    const { t, rowTop } = shortReply()
    // A prompt-rail jump to the current prompt: the mode goes free and the view moves to it.
    t.state.mode = 'free'
    t.container.scrollTop = rowTop - 16
    t.follower.settle()
    expect(t.follower.pinned()).toBeNull()
    // The reply goes on while they read, then they ask for the latest.
    t.state.content += 150
    t.follower.follow()
    t.state.mode = 'following-end'
    t.container.scrollTop = t.end()
    t.follower.settle()
    settleFrames(t)
    t.follower.follow()
    for (let index = 0; index < 40; index++) frame()
    expect(t.reserve()).toBe(0)
    expect(t.container.scrollTop).toBe(Math.max(0, t.state.content - t.clientHeight))
  })

  it('leaves no gap in a short thread that fits the screen', () => {
    const t = transcript({ content: 0 })
    t.rowTops.set('first', PIN_TOP)
    t.state.content = PIN_TOP + 100
    t.follower.setLive(true)
    t.follower.pin('first')
    expect(t.container.scrollTop).toBe(0)
    t.state.content += 200
    t.follower.follow()
    expect(t.container.scrollTop).toBe(0)
    t.follower.turnEnded()
    expect(t.reserve()).toBe(0)
    expect(t.container.scrollTop).toBe(0)
  })
})

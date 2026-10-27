import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import {
  MAX_WINDOW_ROWS,
  ROW_GAP,
  SETTLE_MAX_FRAMES,
  INITIAL_SETTLE,
  anchorDelta,
  buildLayout,
  computeWindow,
  estimateTurnHeight,
  indexAtOffset,
  isSettled,
  keyTargetScrollTop,
  lastIndexAtOrBefore,
  nextScrollTop,
  offsetDeltaAbove,
  pickAnchor,
  reconcileWindow,
  resolveTurnKey,
  shouldGlide,
  stepSettle,
  windowRowItems,
  windowSpacers,
  type AnchorNode,
  type SettleState,
  type TurnLayout
} from '../src/renderer/chat/components/agent-elements/virtual/turn-window'
import {
  classifyIntent,
  reduceFollow,
  type FollowMode,
  type IntentInput
} from '../src/renderer/chat/components/agent-elements/virtual/follow-mode'

const uniform = (count: number, height: number, prefix = 'k') =>
  buildLayout(
    Array.from({ length: count }, (_, index) => `${prefix}${index}`),
    new Map(),
    () => height
  )

/** Height of everything the window renders, spacers and gaps included. */
function renderedTotal(layout: TurnLayout, window: { start: number; end: number }): number {
  const n = layout.keys.length
  const items = windowRowItems(n, window)
  const { topSpacer, bottomSpacer } = windowSpacers(layout, window.start, window.end)
  let sum = 0
  for (const item of items) {
    if (item.kind === 'row') sum += layout.heights[item.index]!
    else sum += item.kind === 'top-spacer' ? topSpacer : bottomSpacer
  }
  return sum + layout.gap * (items.length - 1)
}

describe('buildLayout', () => {
  it('stacks measured heights and estimates with a gap between rows', () => {
    const layout = buildLayout(['a', 'b', 'c'], new Map([['a', 100]]), () => 50)
    expect(layout.heights).toEqual([100, 50, 50])
    expect(layout.offsets).toEqual([0, 124, 198])
    expect(layout.total).toBe(100 + 50 + 50 + 2 * ROW_GAP)
  })

  it('uses the measured gap, which is 1.5rem and not 24px at the app\'s 14px root size', () => {
    const layout = buildLayout(['a', 'b', 'c'], new Map([['a', 100]]), () => 50, 21)
    expect(layout.gap).toBe(21)
    expect(layout.offsets).toEqual([0, 121, 192])
    expect(layout.total).toBe(100 + 50 + 50 + 2 * 21)
    // Spacers are sized with the same gap, so spacers plus rows still add up to the total.
    const many = buildLayout(Array.from({ length: 100 }, (_, index) => `k${index}`), new Map(), () => 200, 21)
    const window = computeWindow(many, 9_000, 800, 600)
    expect(renderedTotal(many, window)).toBeCloseTo(many.total, 6)
  })

  it('is empty for no rows', () => {
    const layout = buildLayout([], new Map(), () => 50)
    expect(layout.total).toBe(0)
    expect(layout.offsets).toEqual([])
  })
})

describe('indexAtOffset', () => {
  const layout = uniform(5, 100)
  it('finds the row containing an offset, clamped at both ends', () => {
    expect(indexAtOffset(layout, -50)).toBe(0)
    expect(indexAtOffset(layout, 0)).toBe(0)
    expect(indexAtOffset(layout, 99)).toBe(0)
    expect(indexAtOffset(layout, 124)).toBe(1)
    expect(indexAtOffset(layout, 123)).toBe(0)
    expect(indexAtOffset(layout, 10_000)).toBe(4)
  })

  it('assigns a gap to the row above it', () => {
    expect(indexAtOffset(layout, 110)).toBe(0)
  })
})

describe('lastIndexAtOrBefore', () => {
  it('is a binary search over sorted offsets', () => {
    expect(lastIndexAtOrBefore([], 5)).toBe(-1)
    expect(lastIndexAtOrBefore([10, 20, 30], 5)).toBe(-1)
    expect(lastIndexAtOrBefore([10, 20, 30], 20)).toBe(1)
    expect(lastIndexAtOrBefore([10, 20, 30], 29)).toBe(1)
    expect(lastIndexAtOrBefore([10, 20, 30], 99)).toBe(2)
  })
})

describe('computeWindow', () => {
  const layout = uniform(200, 300)

  it('always renders rows 0 and n-1 and keeps spacers plus rows equal to the total', () => {
    for (const top of [0, 1_000, 30_000, 64_000, layout.total - 800, layout.total]) {
      const window = computeWindow(layout, top, 800, 600)
      expect(window.start).toBeGreaterThanOrEqual(1)
      expect(window.end).toBeLessThanOrEqual(layout.keys.length - 1)
      expect(window.end - window.start).toBeLessThanOrEqual(MAX_WINDOW_ROWS)
      const items = windowRowItems(layout.keys.length, window)
      expect(items[0]).toEqual({ kind: 'row', index: 0 })
      expect(items[items.length - 1]).toEqual({ kind: 'row', index: layout.keys.length - 1 })
      expect(renderedTotal(layout, window)).toBeCloseTo(layout.total, 6)
    }
  })

  it('mounts the rows around the viewport', () => {
    const top = layout.offsets[50]! + 10
    const window = computeWindow(layout, top, 800, 600)
    expect(window.start).toBeLessThanOrEqual(50)
    expect(window.end).toBeGreaterThan(52)
    expect(window.topSpacer).toBeGreaterThan(0)
    expect(window.bottomSpacer).toBeGreaterThan(0)
  })

  it('has no spacer where the window reaches the first or last row', () => {
    const atTop = computeWindow(layout, 0, 800, 600)
    expect(atTop.start).toBe(1)
    expect(atTop.topSpacer).toBe(0)
    expect(atTop.bottomSpacer).toBeGreaterThan(0)
    const atEnd = computeWindow(layout, layout.total - 800, 800, 600)
    expect(atEnd.end).toBe(layout.keys.length - 1)
    expect(atEnd.bottomSpacer).toBe(0)
    expect(atEnd.topSpacer).toBeGreaterThan(0)
  })

  it('shrinks the overscan symmetrically when too many small rows fit', () => {
    const tiny = uniform(500, 0)
    const window = computeWindow(tiny, 6_000, 800, 600)
    expect(window.end - window.start).toBeLessThanOrEqual(MAX_WINDOW_ROWS)
    const viewportRow = indexAtOffset(tiny, 6_000)
    expect(window.start).toBeLessThanOrEqual(viewportRow)
    expect(window.end).toBeGreaterThan(viewportRow)
    expect(renderedTotal(tiny, window)).toBeCloseTo(tiny.total, 6)
  })

  it('leaves the middle empty when the viewport sits inside a huge first or last row', () => {
    const big = buildLayout(['a', 'b', 'c', 'd'], new Map([['a', 50_000], ['d', 50_000]]), () => 100)
    const inFirst = computeWindow(big, 20_000, 800, 600)
    expect(inFirst.start).toBe(inFirst.end)
    expect(renderedTotal(big, inFirst)).toBeCloseTo(big.total, 6)
    const inLast = computeWindow(big, big.offsets[3]! + 20_000, 800, 600)
    expect(inLast.start).toBe(inLast.end)
    expect(inLast.end).toBe(3)
    expect(renderedTotal(big, inLast)).toBeCloseTo(big.total, 6)
  })

  it('renders everything for two rows or fewer', () => {
    for (const count of [0, 1, 2]) {
      const small = uniform(count, 100)
      const window = computeWindow(small, 0, 800)
      expect(window.topSpacer).toBe(0)
      expect(window.bottomSpacer).toBe(0)
      expect(windowRowItems(count, window).filter((item) => item.kind !== 'row')).toEqual([])
      expect(windowRowItems(count, window)).toHaveLength(count)
    }
  })
})

describe('reconcileWindow', () => {
  it('keeps a window that reached the last row reaching it when a turn is added', () => {
    expect(reconcileWindow({ start: 90, end: 99, n: 100 }, 101)).toEqual({ start: 90, end: 100 })
  })

  it('leaves a window in the middle alone', () => {
    expect(reconcileWindow({ start: 40, end: 50, n: 100 }, 101)).toEqual({ start: 40, end: 50 })
  })

  it('clamps when rows were removed and respects the row cap', () => {
    expect(reconcileWindow({ start: 90, end: 99, n: 100 }, 60)).toEqual({ start: 59, end: 59 })
    expect(reconcileWindow({ start: 1, end: 59, n: 60 }, 61, 58)).toEqual({ start: 2, end: 60 })
  })
})

describe('windowRowItems', () => {
  it('orders row 0, top spacer, the window, bottom spacer, the last row', () => {
    expect(windowRowItems(10, { start: 4, end: 6 })).toEqual([
      { kind: 'row', index: 0 },
      { kind: 'top-spacer' },
      { kind: 'row', index: 4 },
      { kind: 'row', index: 5 },
      { kind: 'bottom-spacer' },
      { kind: 'row', index: 9 }
    ])
  })

  it('omits a spacer at the ends', () => {
    expect(windowRowItems(5, { start: 1, end: 4 }).map((item) => item.kind)).toEqual(['row', 'row', 'row', 'row', 'row'])
  })
})

type TestNode = AnchorNode & { name: string; children: TestNode[] }
const node = (name: string, top: number, bottom: number, children: TestNode[] = []): TestNode => ({
  name,
  top,
  bottom,
  children
})

describe('pickAnchor', () => {
  it('chooses a fully visible first child', () => {
    const row = node('row', -100, 400, [node('above', -100, -10), node('p1', 20, 60), node('p2', 70, 100)])
    expect(pickAnchor(row, 0).map((entry) => entry.name)).toEqual(['p1'])
  })

  it('descends into a straddling blockquote and picks its first visible paragraph', () => {
    const row = node('row', -500, 600, [
      node('quote', -400, 500, [node('fence', -400, -100), node('p1', 100, 140), node('p2', 150, 190)]),
      node('after', 520, 560)
    ])
    expect(pickAnchor(row, 0).map((entry) => entry.name)).toEqual(['quote', 'p1'])
  })

  it('descends through a straddling list item', () => {
    const row = node('row', -300, 300, [
      node('list', -300, 300, [
        node('item', -250, 250, [node('code', -250, -50), node('text', 60, 90)])
      ])
    ])
    expect(pickAnchor(row, 0).map((entry) => entry.name)).toEqual(['list', 'item', 'text'])
  })

  it('stops at a straddling leaf', () => {
    const row = node('row', -300, 300, [node('long-paragraph', -200, 400)])
    expect(pickAnchor(row, 0).map((entry) => entry.name)).toEqual(['long-paragraph'])
  })

  it('stops at a straddling node with nothing visible inside it', () => {
    const row = node('row', -300, 300, [node('box', -200, 100, [node('inner', -200, -50)])])
    expect(pickAnchor(row, 0).map((entry) => entry.name)).toEqual(['box'])
  })

  it('returns the row itself when nothing reaches below the edge', () => {
    const row = node('row', -300, -10, [node('a', -300, -100), node('b', -90, -10)])
    expect(pickAnchor(row, 0)).toEqual([])
  })
})

/**
 * Position in scroll-content space of an element at `contentY`, measured the way
 * the hook does: `rect.top - containerRect.top + scrollTop`.
 */
const position = (contentY: number, scrollTop: number, containerTop = 80) => {
  const rectTop = containerTop + contentY - scrollTop
  return rectTop - containerTop + scrollTop
}

describe('anchorDelta', () => {
  it('is the growth above the anchor, inside its row or inside the same blockquote', () => {
    const before = position(1_000, 500)
    expect(anchorDelta({ posBefore: before, posAfter: position(1_000 + 90, 500) })).toBe(90)
  })

  it('is zero for growth below the anchor', () => {
    expect(anchorDelta({ posBefore: position(1_000, 500), posAfter: position(1_000, 500) })).toBe(0)
  })

  it('is zero when only scrollTop changed', () => {
    expect(anchorDelta({ posBefore: position(1_000, 500), posAfter: position(1_000, 900) })).toBe(0)
  })

  it('is exactly the shift when the content moved while scrollTop also changed', () => {
    expect(anchorDelta({ posBefore: position(1_000, 500), posAfter: position(1_030, 900) })).toBe(30)
    expect(anchorDelta({ posBefore: position(1_000, 900), posAfter: position(940, 100) })).toBe(-60)
  })

  describe('a window transition with wrong estimates', () => {
    const count = 30
    const keys = Array.from({ length: count }, (_, index) => `r${index}`)
    const estimate = 300
    const real = keys.map((_, index) => (index === 8 ? 900 : index === 9 ? 120 : 400))

    /** Where row `index` sits in the rows wrapper for a window, with the given spacer heights. */
    function rowTop(
      window: { start: number; end: number },
      spacers: { top: number; bottom: number },
      index: number,
      heights: readonly number[] = real
    ) {
      let cursor = 0
      for (const item of windowRowItems(count, window)) {
        if (item.kind === 'row') {
          if (item.index === index) return cursor
          cursor += heights[item.index]! + ROW_GAP
        } else {
          cursor += (item.kind === 'top-spacer' ? spacers.top : spacers.bottom) + ROW_GAP
        }
      }
      throw new Error('row not rendered')
    }

    const layoutWith = (
      measuredIndices: number[],
      heights: readonly number[] = real,
      guess: number = estimate
    ) => buildLayout(keys, new Map(measuredIndices.map((index) => [keys[index]!, heights[index]!])), () => guess)
    const spacersOf = (layout: TurnLayout, window: { start: number; end: number }) => {
      const { topSpacer, bottomSpacer } = windowSpacers(layout, window.start, window.end)
      return { top: topSpacer, bottom: bottomSpacer }
    }

    const before = { start: 10, end: 20 }
    const after = { start: 8, end: 20 }
    const measuredBefore = [0, ...Array.from({ length: 10 }, (_, i) => 10 + i), count - 1]
    const prevLayout = layoutWith(measuredBefore)
    const oldSpacers = spacersOf(prevLayout, before)
    const anchorRow = 10
    const posBefore = rowTop(before, oldSpacers, anchorRow)

    it('corrects by the sum of real heights minus the sum of estimates once the spacers are written', () => {
      // Commit: rows 8 and 9 appear while the spacer still carries their estimates.
      const posAtCommit = rowTop(after, oldSpacers, anchorRow)
      // Transaction: measure, rebuild, write the spacers.
      const nextLayout = layoutWith([...measuredBefore, 8, 9])
      const posAfterSpacers = rowTop(after, spacersOf(nextLayout, after), anchorRow)

      const correct = anchorDelta({ posBefore, posAfter: posAfterSpacers })
      expect(correct).toBe(real[8]! + real[9]! - 2 * estimate)

      // Correcting before the spacer shrinks would add the gaps and the estimates on top.
      const early = anchorDelta({ posBefore, posAfter: posAtCommit })
      expect(early).toBe(real[8]! + real[9]! + 2 * ROW_GAP)
      expect(early - correct).toBe(2 * estimate + 2 * ROW_GAP)
    })

    it('is zero when the rows come back at their estimates', () => {
      const exact = keys.map(() => 400)
      const prev = layoutWith(measuredBefore, exact, 400)
      const next = layoutWith([...measuredBefore, 8, 9], exact, 400)
      const posA = rowTop(before, spacersOf(prev, before), anchorRow, exact)
      const posB = rowTop(after, spacersOf(next, after), anchorRow, exact)
      expect(anchorDelta({ posBefore: posA, posAfter: posB })).toBe(0)
    })
  })

  describe('row-prefix fallback', () => {
    const keys = ['a', 'b', 'c', 'd', 'e']
    const prev = buildLayout(keys, new Map(), () => 100)
    const grown = (index: number, by: number) =>
      buildLayout(keys, new Map([[keys[index]!, 100 + by]]), () => 100)

    it('moves with growth above the anchor row', () => {
      expect(anchorDelta({ fallback: { prev, next: grown(1, 70), anchorKey: 'd' } })).toBe(70)
      expect(offsetDeltaAbove(prev, grown(0, 25), 'b')).toBe(25)
    })

    it('ignores growth in the anchor row or below it', () => {
      expect(anchorDelta({ fallback: { prev, next: grown(3, 70), anchorKey: 'd' } })).toBe(0)
      expect(anchorDelta({ fallback: { prev, next: grown(4, 70), anchorKey: 'd' } })).toBe(0)
    })

    it('is zero when the anchor row is gone', () => {
      expect(anchorDelta({ fallback: { prev, next: grown(1, 70), anchorKey: 'zzz' } })).toBe(0)
    })
  })
})

describe('nextScrollTop', () => {
  it('goes to the end while following and applies the delta while free', () => {
    expect(nextScrollTop({ mode: 'following-end', scrollTop: 100, delta: 40, end: 5_000 })).toBe(5_000)
    expect(nextScrollTop({ mode: 'free', scrollTop: 100, delta: 40, end: 5_000 })).toBe(140)
    expect(nextScrollTop({ mode: 'free', scrollTop: 100, delta: -30, end: 5_000 })).toBe(70)
  })
})

describe('keyTargetScrollTop', () => {
  const layout = uniform(10, 200)
  it('adds the origin of the rows wrapper', () => {
    expect(keyTargetScrollTop(layout, 24, 'k3', 'start', 800, 16)).toBe(24 + 3 * 224 - 16)
    expect(keyTargetScrollTop(layout, 0, 'k3', 'start', 800, 16)).toBe(3 * 224 - 16)
  })

  it('centers and end-aligns', () => {
    expect(keyTargetScrollTop(layout, 24, 'k5', 'center', 800)).toBe(24 + 5 * 224 + 100 - 400)
    expect(keyTargetScrollTop(layout, 24, 'k5', 'end', 800, 16)).toBe(24 + 5 * 224 + 200 - 800 + 16)
  })

  it('never goes above the top, and reports an unknown key', () => {
    expect(keyTargetScrollTop(layout, 0, 'k0', 'start', 800, 16)).toBe(0)
    expect(keyTargetScrollTop(layout, 0, 'nope', 'start', 800)).toBeNull()
  })
})

describe('settling', () => {
  it('counts positions within one pixel as settled', () => {
    expect(isSettled(100, 101)).toBe(true)
    expect(isSettled(100, 101.5)).toBe(false)
  })

  it('converges within 8 frames while estimates are replaced one row per frame', () => {
    const keys = Array.from({ length: 8 }, (_, index) => `r${index}`)
    const real = [210, 520, 160, 640, 380, 90, 300, 300]
    const measured = new Map<string, number>()
    let state: SettleState = INITIAL_SETTLE
    let scrollTop = 0
    let frames = 0
    let done = false
    let stable = false
    while (!done && frames < SETTLE_MAX_FRAMES) {
      // One more row reports its real height each frame (rows 0-4 before the target).
      if (frames < 5) measured.set(keys[frames]!, real[frames]!)
      const layout = buildLayout(keys, measured, () => 300)
      const target = keyTargetScrollTop(layout, 24, 'r6', 'start', 800, 16)!
      const step = stepSettle(state, { target, scrollTop })
      state = step.state
      if (step.write !== null) scrollTop = step.write
      done = step.done
      stable = step.stable
      frames += 1
    }
    expect(stable).toBe(true)
    expect(frames).toBeLessThanOrEqual(8)
    const final = buildLayout(keys, measured, () => 300)
    expect(scrollTop).toBe(keyTargetScrollTop(final, 24, 'r6', 'start', 800, 16))
  })

  it('stops after 60 frames when the target never stops moving', () => {
    let state: SettleState = INITIAL_SETTLE
    let scrollTop = 0
    let stable = true
    for (let frame = 0; frame < 200; frame += 1) {
      const step = stepSettle(state, { target: 100 * (frame + 1), scrollTop })
      state = step.state
      stable = step.stable
      if (step.write !== null) scrollTop = step.write
      if (step.done) break
    }
    expect(stable).toBe(false)
    expect(state.frames).toBe(SETTLE_MAX_FRAMES)
  })

  it('does not write when already on target', () => {
    const first = stepSettle(INITIAL_SETTLE, { target: 500, scrollTop: 500 })
    expect(first.write).toBeNull()
    expect(first.done).toBe(false)
    const second = stepSettle(first.state, { target: 500, scrollTop: 500 })
    expect(second.write).toBeNull()
    expect(second.done).toBe(false)
    const third = stepSettle(second.state, { target: 500.5, scrollTop: 500 })
    expect(third.done).toBe(true)
  })
})

describe('shouldGlide', () => {
  it('glides up to three viewports in either direction', () => {
    expect(shouldGlide(2_400, 800)).toBe(true)
    expect(shouldGlide(-2_400, 800)).toBe(true)
    expect(shouldGlide(2_401, 800)).toBe(false)
  })
})

describe('estimateTurnHeight', () => {
  const message = (role: 'user' | 'assistant', parts: unknown[]) =>
    ({ id: `${role}-1`, role, parts }) as unknown as UIMessage

  it('starts at the base plus the toolbar', () => {
    expect(estimateTurnHeight({ assistantMsgs: [] })).toBe(96 + 48)
  })

  it('adds a line per 90 characters of the prompt and a row per attached image', () => {
    const turn = {
      userMsg: message('user', [
        { type: 'text', text: 'x'.repeat(180) },
        { type: 'file', mediaType: 'image/png', data: 'AAAA' },
        { type: 'file', mediaType: 'application/pdf', data: 'AAAA' }
      ]),
      assistantMsgs: []
    }
    expect(estimateTurnHeight(turn)).toBe(96 + 48 + 2 * 24 + 136)
  })

  it('counts assistant lines, tool rows and capped code blocks', () => {
    const code = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const turn = {
      assistantMsgs: [
        message('assistant', [
          { type: 'text', text: 'one\ntwo\nthree' },
          { type: 'tool-Bash', toolCallId: 't1', state: 'output-available' },
          { type: 'tool-Read', toolCallId: 't2', state: 'output-available' },
          { type: 'text', text: '```ts\nconst a = 1\nconst b = 2\n```' },
          { type: 'text', text: '```ts\n' + code + '\n```' }
        ])
      ]
    }
    expect(estimateTurnHeight(turn)).toBe(96 + 48 + 3 * 24 + 2 * 44 + (2 * 20 + 56) + (400 + 56))
  })

  it('treats an unclosed fence as code and clamps huge turns', () => {
    const open = { assistantMsgs: [message('assistant', [{ type: 'text', text: '```ts\na\nb' }])] }
    expect(estimateTurnHeight(open)).toBe(96 + 48 + 2 * 20 + 56)
    const huge = { assistantMsgs: [message('assistant', [{ type: 'text', text: 'line\n'.repeat(5_000) }])] }
    expect(estimateTurnHeight(huge)).toBe(20_000)
  })
})

describe('resolveTurnKey', () => {
  it('keeps the optimistic key after the saved id replaces it', () => {
    const alias = new Map([['saved-1', 'optimistic:abc']])
    expect(resolveTurnKey({ userMsg: { id: 'saved-1' } }, 3, alias)).toBe('optimistic:abc')
    expect(resolveTurnKey({ userMsg: { id: 'other' } }, 3, alias)).toBe('other')
  })

  it('falls back to the index for a turn without a prompt', () => {
    expect(resolveTurnKey({}, 0, new Map())).toBe('turn-0')
  })
})

describe('classifyIntent', () => {
  const wheel = (deltaY: number, extra: Partial<Extract<IntentInput, { type: 'wheel' }>> = {}): IntentInput => ({
    type: 'wheel',
    deltaY,
    ctrlKey: false,
    metaKey: false,
    overflowing: true,
    ...extra
  })
  const key = (name: string, extra: Partial<Extract<IntentInput, { type: 'keydown' }>> = {}): IntentInput => ({
    type: 'keydown',
    key: name,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    focus: 'body',
    overflowing: true,
    ...extra
  })

  it('treats wheel up over overflowing content as scroll-away and wheel down as scroll-toward', () => {
    expect(classifyIntent(wheel(-120))).toBe('scroll-away')
    expect(classifyIntent(wheel(120))).toBe('scroll-toward')
    expect(classifyIntent(wheel(0))).toBeNull()
  })

  it('ignores wheel over content that fits and zoom gestures', () => {
    expect(classifyIntent(wheel(-120, { overflowing: false }))).toBeNull()
    expect(classifyIntent(wheel(-120, { ctrlKey: true }))).toBeNull()
    expect(classifyIntent(wheel(120, { metaKey: true }))).toBeNull()
  })

  it('counts a press on the scrollbar but not in the gutter or on a child', () => {
    const press = (offsetX: number, onContainer = true): IntentInput => ({
      type: 'pointerdown',
      onContainer,
      offsetX,
      clientWidth: 985,
      overflowing: true
    })
    expect(classifyIntent(press(990))).toBe('scroll-away')
    expect(classifyIntent(press(-3))).toBe('scroll-away')
    expect(classifyIntent(press(500))).toBeNull()
    expect(classifyIntent(press(990, false))).toBeNull()
  })

  it('reads paging keys only from the container or the page, without modifiers', () => {
    expect(classifyIntent(key('PageUp'))).toBe('scroll-away')
    expect(classifyIntent(key('Home', { focus: 'container' }))).toBe('scroll-away')
    expect(classifyIntent(key('ArrowUp'))).toBe('scroll-away')
    expect(classifyIntent(key('PageDown'))).toBe('scroll-toward')
    expect(classifyIntent(key('End'))).toBe('scroll-toward')
    expect(classifyIntent(key('ArrowDown'))).toBe('scroll-toward')
    expect(classifyIntent(key('PageUp', { focus: 'editable' }))).toBeNull()
    expect(classifyIntent(key('ArrowUp', { focus: 'other' }))).toBeNull()
    expect(classifyIntent(key('PageUp', { ctrlKey: true }))).toBeNull()
    expect(classifyIntent(key('Home', { shiftKey: true }))).toBeNull()
    expect(classifyIntent(key('a'))).toBeNull()
    expect(classifyIntent(key('PageUp', { overflowing: false }))).toBeNull()
  })

  it('treats a touch drag away from the bottom as scroll-away', () => {
    expect(classifyIntent({ type: 'touchmove', atBottom: false, overflowing: true })).toBe('scroll-away')
    expect(classifyIntent({ type: 'touchmove', atBottom: true, overflowing: true })).toBeNull()
    expect(classifyIntent({ type: 'touchmove', atBottom: false, overflowing: false })).toBeNull()
  })
})

describe('reduceFollow', () => {
  it('leaves following on scroll-away only', () => {
    expect(reduceFollow('following-end', { type: 'intent', intent: 'scroll-away' })).toBe('free')
    expect(reduceFollow('following-end', { type: 'intent', intent: 'scroll-toward' })).toBe('following-end')
    expect(reduceFollow('following-end', { type: 'intent', intent: null })).toBe('following-end')
    expect(reduceFollow('free', { type: 'intent', intent: 'scroll-toward' })).toBe('free')
  })

  it('never lets a programmatic scroll change the mode, through a whole settle sequence', () => {
    for (const start of ['following-end', 'free'] as FollowMode[]) {
      let mode = start
      for (const atBottom of [false, false, true, false, true, false]) {
        mode = reduceFollow(mode, { type: 'scroll', atBottom, programmatic: true })
      }
      expect(mode).toBe(start)
    }
  })

  it('re-arms on reaching the bottom by a user scroll and disarms away from it', () => {
    expect(reduceFollow('free', { type: 'scroll', atBottom: true, programmatic: false })).toBe('following-end')
    expect(reduceFollow('free', { type: 'scroll', atBottom: false, programmatic: false })).toBe('free')
    expect(reduceFollow('following-end', { type: 'scroll', atBottom: false, programmatic: false })).toBe('free')
  })

  it('follows on a new turn, a jump and a thread opened at the bottom', () => {
    expect(reduceFollow('free', { type: 'new-turn' })).toBe('following-end')
    expect(reduceFollow('free', { type: 'jump-to-latest' })).toBe('following-end')
    expect(reduceFollow('free', { type: 'thread-open', initial: 'bottom' })).toBe('following-end')
  })

  it('frees on navigation and on a thread opened at the top', () => {
    expect(reduceFollow('following-end', { type: 'navigate' })).toBe('free')
    expect(reduceFollow('following-end', { type: 'thread-open', initial: 'top' })).toBe('free')
  })
})

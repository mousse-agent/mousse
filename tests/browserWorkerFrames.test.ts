/**
 * Frames from other sites, as the browser worker reads and acts on them:
 * - an image point on an `<iframe>` is carried into the frame through the `<iframe>`'s box as drawn
 *   (scaled, rotated), and a box that cannot be mapped reliably is refused;
 * - only the attached frame an `<iframe>` shows, by its exact id, is entered: never a frame behind it;
 * - a frame from another site whose `<iframe>` sits in a same-site frame of another frame from another
 *   site is placed and scoped through the session that attached it, not its immediate parent frame;
 * - a frame that went away while it was read is skipped, while a browser that is gone fails the read.
 */
import { describe, expect, it } from 'vitest'
import { frameStepAt, pointInFrame } from '../src/browser-worker/action/framePoint'
import { CdpDisconnectedError, isCdpTargetGoneError } from '../src/browser-worker/cdp/connection'
import { framesInside, placeAttachedFrame, type FrameTreeNode } from '../src/browser-worker/session/frameTree'

/** The four corners (top-left, top-right, bottom-right, bottom-left) of a box at (x, y), drawn at its size times `scale`. */
const box = (x: number, y: number, width: number, height: number, scale = 1) =>
  [x, y, x + width * scale, y, x + width * scale, y + height * scale, x, y + height * scale]

describe('an image point is carried into a frame through its <iframe> as drawn', () => {
  const size = { width: 300, height: 200 }
  it.each([
    ['an <iframe> drawn at its size', box(100, 100, 300, 200), { x: 160, y: 130 }, { x: 60, y: 30 }],
    // 60px right of the visible left edge of a frame drawn twice its size is 30px into the frame, not 60.
    ['an <iframe> scaled by 2', box(100, 100, 300, 200, 2), { x: 160, y: 160 }, { x: 30, y: 30 }],
    ['an <iframe> scaled by 0.5', box(100, 100, 300, 200, 0.5), { x: 130, y: 110 }, { x: 60, y: 20 }],
    // Turned a quarter clockwise about its top-left at (500, 100): its x axis points down, its y axis left.
    ['an <iframe> rotated by 90°', [500, 100, 500, 400, 300, 400, 300, 100], { x: 470, y: 160 }, { x: 60, y: 30 }]
  ])('%s', (_case, quad, point, inFrame) => {
    const mapped = pointInFrame(quad, size, point)
    expect(mapped.kind).toBe('inside')
    if (mapped.kind !== 'inside') return
    expect(mapped.point.x).toBeCloseTo(inFrame.x, 6)
    expect(mapped.point.y).toBeCloseTo(inFrame.y, 6)
  })

  it.each([
    ['left of it (on its border)', { x: 99, y: 150 }],
    ['below a scaled one', { x: 200, y: 501 }],
    ['at its right edge', { x: 700, y: 150 }]
  ])('a point %s is outside the frame', (_case, point) => {
    expect(pointInFrame(box(100, 100, 300, 200, 2), size, point)).toEqual({ kind: 'outside' })
  })

  it.each([
    ['flattened to a line', [100, 100, 400, 100, 400, 100, 100, 100]],
    ['collapsed to a point', [100, 100, 100, 100, 100, 100, 100, 100]],
    ['in perspective (not a parallelogram)', [100, 100, 400, 120, 380, 300, 120, 280]],
    ['with a corner missing', [100, 100, 400, 100, 400, 300]]
  ])('an <iframe> %s cannot be mapped reliably and is refused', (_case, quad) => {
    expect(() => pointInFrame(quad, size, { x: 150, y: 150 })).toThrow(expect.objectContaining({ code: 'invalid_geometry' }))
  })

  it('a frame that could not be measured is refused', () => {
    expect(() => pointInFrame(box(100, 100, 300, 200), { width: 0, height: 200 }, { x: 150, y: 150 })).toThrow(expect.objectContaining({ code: 'invalid_geometry' }))
  })
})

describe('only the attached frame an <iframe> shows is entered', () => {
  // Two frames from another site, siblings under the page's frame "main"; the overlay is drawn over "covered".
  const covered = { frameId: 'covered', parentFrameId: 'main', sessionId: 's-covered' }
  const overlay = { frameId: 'overlay', parentFrameId: 'main', sessionId: 's-overlay' }
  it.each([
    ['the <iframe> shows an attached frame', 'overlay', [covered, overlay], new Set(['main']), { kind: 'enter', frame: overlay }],
    // A sibling with the same parent, behind it, is never taken for it.
    ['the <iframe> shows a frame with no attachment: its sibling behind is not entered', 'unattached', [covered], new Set(['main']), { kind: 'refuse' }],
    ['the frame tree could not be read: no guess is made', 'unattached', [covered], undefined, { kind: 'refuse' }],
    ['the <iframe> is a same-site overlay of this process: it is acted on itself', 'same-site', [covered], new Set(['main', 'same-site']), { kind: 'stay' }],
    ['two attachments claim the frame: neither is entered', 'overlay', [overlay, { ...covered, frameId: 'overlay' }], new Set(['main']), { kind: 'refuse' }]
  ])('%s', (_case, contentFrameId, attached, inProcess, step) => {
    expect(frameStepAt(contentFrameId, attached, inProcess)).toEqual(step)
  })
})

/**
 * The tab "main" holds a frame from another site, "outer" (session s-outer). Inside it, a frame of its
 * own site, "middle", which has no session: each process lists only its own frames. Inside "middle",
 * a frame from a third site, "inner" (session s-inner), attached by s-outer. A same-site frame of the
 * tab, "aside", holds nothing.
 */
const tabTree: FrameTreeNode = { frame: { id: 'main' }, childFrames: [{ frame: { id: 'outer', parentId: 'main' } }, { frame: { id: 'aside', parentId: 'main' } }] }
const outerTree: FrameTreeNode = { frame: { id: 'outer', parentId: 'main' }, childFrames: [{ frame: { id: 'middle', parentId: 'outer' }, childFrames: [{ frame: { id: 'inner', parentId: 'middle' } }] }] }
const innerTree: FrameTreeNode = { frame: { id: 'inner', parentId: 'middle' } }
const outer = { frameId: 'outer', parentFrameId: 'main', sessionId: 's-outer', ownerSessionId: 'tab' }
const inner = { frameId: 'inner', parentFrameId: 'middle', sessionId: 's-inner', ownerSessionId: 's-outer' }

describe('a frame inside a same-site frame of a frame from another site', () => {
  it.each([
    ['the frame from another site holds the same-site frame and the frame inside it', 'outer', [tabTree, outerTree, innerTree], ['outer', 'middle', 'inner']],
    ['the same-site frame, known only to its own process, holds the frame inside it', 'middle', [tabTree, outerTree, innerTree], ['middle', 'inner']],
    ['the tab holds every frame', 'main', [tabTree, outerTree, innerTree], ['main', 'outer', 'aside', 'middle', 'inner']],
    // Without the outer frame's tree, how "inner" was attached still links it to "middle", but nothing links "middle" to "outer".
    ['the outer frame\'s tree could not be read: what is known is kept, nothing guessed', 'outer', [tabTree, undefined, innerTree], ['outer']]
  ])('%s', (_case, scope, trees, within) => {
    expect([...framesInside(scope, trees, [outer, inner])].sort()).toEqual([...within].sort())
  })

  /** Boxes of `<iframe>`s, by the session asked and the frame: "outer" at (100, 50) of the tab; "inner" at (30, 40) of the outer frame's viewport. */
  const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {
    'tab/outer': { x: 100, y: 50, width: 600, height: 400 },
    's-outer/inner': { x: 30, y: 40, width: 200, height: 100 }
  }
  const place = async (frames: Array<typeof outer>) => {
    const asked: string[] = []
    const placed = await placeAttachedFrame(inner, 'tab', (sessionId) => frames.find((frame) => frame.sessionId === sessionId), async (frame, ownerSessionId) => {
      asked.push(`${ownerSessionId}/${frame.frameId}`)
      return boxes[`${ownerSessionId}/${frame.frameId}`] ?? null
    })
    return { placed, asked }
  }

  it('is placed by asking the session that attached it for its <iframe>, inside where that session\'s frame sits', async () => {
    const { placed, asked } = await place([outer, inner])
    expect(placed).toEqual({ x: 130, y: 90, width: 200, height: 100 })
    // Never the tab, nor a session for "middle", which has none.
    expect(asked.sort()).toEqual(['s-outer/inner', 'tab/outer'])
  })

  it('is not placed once the frame that attached it is gone', async () => {
    expect((await place([inner])).placed).toBeNull()
  })
})

/** An error as `CdpConnection` rejects a command Chromium answered with an error. */
const chromiumError = (message: string, code = -32000) => Object.assign(new Error(message), { cdpCode: code })

describe('a frame that went away is told apart from a browser that went away', () => {
  it.each([
    ['its session detached', chromiumError('Session with given id not found.', -32001), true],
    ['its target closed', chromiumError('No target with given id found'), true],
    ['it navigated or closed during the command', chromiumError('Inspected target navigated or closed'), true],
    ['its frame is gone from the page', chromiumError('Frame with the given id was not found.'), true],
    ['the pipe to the browser closed', new CdpDisconnectedError('CDP pipe ended'), false],
    ['a command Chromium refused for another reason', chromiumError('Could not compute content quads.'), false],
    ['an error that is not Chromium\'s answer', new Error('Session with given id not found.'), false]
  ])('%s', (_case, error, gone) => {
    expect(isCdpTargetGoneError(error)).toBe(gone)
  })
})

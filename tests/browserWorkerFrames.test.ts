/**
 * Frames from other sites, as the browser worker reads and acts on them:
 * - a frame from another site whose `<iframe>` sits in a same-site frame of another frame from another
 *   site is placed and scoped through the session that attached it, not its immediate parent frame;
 * - a frame that went away while it was read is skipped, while a browser that is gone fails the read.
 */
import { describe, expect, it } from 'vitest'
import { CdpDisconnectedError, isCdpTargetGoneError } from '../src/browser-worker/cdp/connection'
import { framesInside, placeAttachedFrame, type FrameTreeNode } from '../src/browser-worker/session/frameTree'

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

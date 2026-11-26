/**
 * Where the browser worker reads and acts on a page, with Chromium scripted:
 * - a viewport screenshot of a scrolled page is the viewport, not the top of the page;
 * - an image point inside a tall element is hit-tested where it is, not at the element's middle;
 * - a page whose layout could not be read keeps its form controls and says so, without calling them
 *   visible or reading out a text control whose input type it cannot see;
 * - an observation narrowed to part of the page spends its element budget only on that part.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { prepareActionableTarget } from '../src/browser-worker/action/actionability'
import type { CdpTransport } from '../src/browser-worker/cdp/transport'
import { collectStructuredObservation } from '../src/browser-worker/observation/collect'
import { captureViewportScreenshot } from '../src/browser-worker/observation/screenshot'
import type { BrowserViewport } from '../src/shared/browser/types'

type Handler = (params: Record<string, unknown>) => unknown

/** Answers each CDP method with its handler (an empty answer otherwise) and records what was sent. */
class ScriptedCdp extends EventEmitter implements CdpTransport {
  connected = true
  sent: Array<{ method: string; params: Record<string, unknown> }> = []
  constructor(private readonly handlers: Record<string, Handler> = {}) { super() }
  async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.sent.push({ method, params })
    const handler = this.handlers[method]
    return (handler ? await handler(params) : {}) as T
  }
  params(method: string): Array<Record<string, unknown>> {
    return this.sent.filter((entry) => entry.method === method).map((entry) => entry.params)
  }
}

/** The first bytes of a PNG: enough for its width and height. */
function pngHeader(width: number, height: number): string {
  const bytes = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes.toString('base64')
}

describe('a viewport screenshot is the part of the page the viewport shows', () => {
  const viewport = (scrollX: number, scrollY: number): BrowserViewport => ({ cssWidth: 1280, cssHeight: 720, deviceScaleFactor: 1, scrollX, scrollY })
  const capture = async (view: BrowserViewport, clip?: { x: number; y: number; width: number; height: number }) => {
    const cdp = new ScriptedCdp({ 'Page.captureScreenshot': () => ({ data: pngHeader(clip?.width ?? view.cssWidth, clip?.height ?? view.cssHeight) }) })
    const captured = await captureViewportScreenshot(cdp, 'tab', view, clip)
    return { clip: cdp.params('Page.captureScreenshot')[0]?.clip, cropOriginCss: captured.screenshot.cropOriginCss }
  }

  it.each([
    ['a page scrolled down and right', viewport(120, 600), undefined, { x: 120, y: 600, width: 1280, height: 720 }, undefined],
    ['a clip of a scrolled page', viewport(120, 600), { x: 40, y: 30, width: 120, height: 80 }, { x: 160, y: 630, width: 120, height: 80 }, { x: 40, y: 30 }],
    ['a page not scrolled', viewport(0, 0), undefined, { x: 0, y: 0, width: 1280, height: 720 }, undefined]
  ])('%s: Chromium is asked for the page region under the viewport; image points stay in viewport pixels', async (_case, view, clip, pageRegion, cropOriginCss) => {
    const captured = await capture(view, clip)
    expect(captured.clip).toMatchObject(pageRegion)
    expect(captured.cropOriginCss).toEqual(cropOriginCss)
  })

  it('checks a clip against the viewport, never against the scrolled page', async () => {
    // 650 + 80 is past the 720px viewport, though it is well inside a page scrolled by 600.
    await expect(capture(viewport(0, 600), { x: 0, y: 650, width: 120, height: 80 })).rejects.toMatchObject({ code: 'invalid_geometry' })
  })
})

describe('an element is made ready at the image point asked for', () => {
  const VIEWPORT_HEIGHT = 720
  /** An element at `box` in a 720px-high viewport: a hit test answers only for points inside the viewport. */
  const page = (box: { x: number; y: number; width: number; height: number }) => {
    const quad = [box.x, box.y, box.x + box.width, box.y, box.x + box.width, box.y + box.height, box.x, box.y + box.height]
    return new ScriptedCdp({
      'DOM.getContentQuads': () => ({ quads: [quad] }),
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': (params) => {
        const args = params.arguments as Array<{ value: number }> | undefined
        if (!args) return { result: { value: { tag: 'IFRAME', type: '', disabled: false, readOnly: false, hidden: false, valueLength: 0 } } }
        // elementFromPoint is null outside the viewport.
        const [x, y] = args.map((arg) => arg.value)
        const inside = y >= 0 && y < VIEWPORT_HEIGHT && x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height
        return { result: { value: inside ? { ok: true, occluded: false, hitTag: 'IFRAME', hitText: '' } : { ok: false, occluded: true, hitTag: '', hitText: '' } } }
      }
    })
  }
  const node = { backendNodeId: 7, frameRef: 'frame_main', cdpSessionId: 'tab', fingerprint: 'image-point' }
  const hitPoints = (cdp: ScriptedCdp) => cdp.params('Runtime.callFunctionOn').filter((params) => params.arguments).map((params) => (params.arguments as Array<{ value: number }>).map((arg) => arg.value))
  // A 2,670px-high frame from y=0: its middle (y=1335) is far below a 720px viewport.
  const tall = { x: 0, y: 0, width: 1280, height: 2670 }

  it('hit-tests a tall element at the point, without scrolling it, and acts there', async () => {
    const cdp = page(tall)
    const target = await prepareActionableTarget(cdp, 'tab', node, undefined, { point: { x: 640, y: 504 } })
    expect(target.point).toEqual({ x: 640, y: 504 })
    expect(hitPoints(cdp)).toEqual([[640, 504]])
    expect(cdp.params('DOM.scrollIntoViewIfNeeded')).toHaveLength(0)
  })

  it('without a point, still scrolls the element into view and hit-tests its middle', async () => {
    const cdp = page({ x: 100, y: 100, width: 200, height: 50 })
    const target = await prepareActionableTarget(cdp, 'tab', node)
    expect(target.point).toEqual({ x: 200, y: 125 })
    expect(hitPoints(cdp)).toEqual([[200, 125]])
    expect(cdp.params('DOM.scrollIntoViewIfNeeded')).toHaveLength(1)
  })

  it('without a point, a tall element whose middle is off screen is still refused (the case the point is for)', async () => {
    await expect(prepareActionableTarget(page(tall), 'tab', node)).rejects.toMatchObject({ code: 'not_actionable', message: expect.stringMatching(/intercepted by overlay/) })
  })
})

describe('a page whose layout could not be read keeps its form controls', () => {
  const axNodes = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Sign in' }, backendDOMNodeId: 1 },
    { nodeId: '2', role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 2 },
    { nodeId: '3', role: { value: 'button' }, name: { value: 'Continue' }, backendDOMNodeId: 3 },
    // An <input type=password> whose name does not say so: only its layout box gives its type.
    { nodeId: '4', role: { value: 'textbox' }, name: { value: 'Passcode' }, value: { value: 'hunter2' }, description: { value: 'hint: hunter2' }, backendDOMNodeId: 4 }
  ]
  /** A layout snapshot with a box for each of these nodes (by backend id). */
  const snapshot = (boxes: Record<number, [number, number, number, number]>) => {
    const ids = Object.keys(boxes).map(Number)
    return {
      strings: ['visible', 'block', '1', 'auto', 'DIV'],
      documents: [{
        nodes: { backendNodeId: ids, nodeName: ids.map(() => 4), attributes: ids.map(() => []) },
        layout: { nodeIndex: ids.map((_, index) => index), bounds: ids.map((id) => boxes[id]), styles: ids.map(() => [0, 1, 2, 3]) }
      }]
    }
  }
  const observe = (captureSnapshot: Handler, options: Parameters<typeof collectStructuredObservation>[2] = {}) => collectStructuredObservation(new ScriptedCdp({
    'Page.getLayoutMetrics': () => ({ cssLayoutViewport: { clientWidth: 1280, clientHeight: 720, pageX: 0, pageY: 0 } }),
    'Runtime.evaluate': (params) => ({ result: { value: params.expression === 'window.devicePixelRatio' ? 1 : 'Sign in' } }),
    'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'main', loaderId: 'loader', url: 'https://fixture.test/sign-in' } } }),
    'Accessibility.getFullAXTree': () => ({ nodes: axNodes }),
    'DOMSnapshot.captureSnapshot': captureSnapshot
  }), 'tab', options)
  const controls = (elements: Array<{ role?: string; name?: string }>) => elements.filter((element) => element.role === 'textbox' || element.role === 'button').map((element) => `${element.role}:${element.name}`)

  it.each([
    ['the snapshot failed', () => { throw new Error('DOMSnapshot failed') }],
    ['the snapshot came back with no layout boxes', () => ({ strings: [], documents: [] })]
  ])('%s: the textbox and button are kept and the reader is told', async (_case, captureSnapshot) => {
    const observed = await observe(captureSnapshot)
    expect(controls(observed.elements)).toEqual(['textbox:Email', 'button:Continue', 'textbox:Passcode'])
    expect(observed.warnings).toContain('layout-snapshot-unavailable')
  })

  it.each([
    ['the snapshot failed', () => { throw new Error('DOMSnapshot failed') }],
    ['the snapshot came back with no layout boxes', () => ({ strings: [], documents: [] })]
  ])('%s: a text control of unknown input type never reads out its value, and no control is called visible', async (_case, captureSnapshot) => {
    const observed = await observe(captureSnapshot)
    const passcode = observed.elements.find((element) => element.name === 'Passcode')
    expect(passcode).toBeDefined()
    expect(JSON.stringify(observed.elements)).not.toContain('hunter2')
    for (const element of observed.elements) expect(element.states).not.toContain('visible')
  })

  it('with layout, a laid-out text control that is not a password field keeps its value and is visible', async () => {
    const observed = await observe(() => snapshot({ 1: [0, 0, 1280, 720], 4: [40, 80, 300, 32] }))
    const passcode = observed.elements.find((element) => element.name === 'Passcode')
    expect(passcode?.text).toBe('hunter2')
    expect(passcode?.states).toContain('visible')
  })

  it('with layout, a control that has no box is not on screen and is left out, without the warning', async () => {
    const observed = await observe(() => snapshot({ 1: [0, 0, 1280, 720], 2: [40, 40, 300, 32] }))
    expect(controls(observed.elements)).toEqual(['textbox:Email'])
    expect(observed.warnings).not.toContain('layout-snapshot-unavailable')
  })

  it.each([
    // Email (2) and Passcode (4) come before or after Continue (3): left out, they never use up the one element asked for.
    ['only the button is in scope', (node: { backendNodeId: number }) => node.backendNodeId === 3, ['button:Continue'], false],
    ['two controls are in scope', (node: { backendNodeId: number }) => node.backendNodeId === 3 || node.backendNodeId === 4, ['button:Continue'], true]
  ])('narrowed by include, %s: the element budget counts only what is in scope', async (_case, include, kept, truncated) => {
    const observed = await observe(() => snapshot({ 1: [0, 0, 1280, 720], 2: [40, 40, 300, 32], 3: [40, 120, 120, 32], 4: [40, 80, 300, 32] }), { maxElements: 1, include })
    expect(controls(observed.elements)).toEqual(kept)
    expect(observed.truncated).toBe(truncated)
  })
})

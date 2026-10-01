import { describe, expect, it } from 'vitest'
import { BrowserReferenceStore, type ReferenceIdentity } from '../src/browser-worker/observation/ReferenceStore'
import { imagePointToViewport } from '../src/shared/browser/geometry'
import { browserNavigationUrl, validateBrowserActionRequest, validateBrowserAction } from '../src/shared/browser/validation'

const identity: ReferenceIdentity = { profileId: 'a', sessionId: 'session', generation: 1, tabId: 'tab', documentId: 'document', observationId: 'observation' }
const node = { backendNodeId: 3, frameRef: 'frame', fingerprint: 'button:Save' }
const image = { artifactId: 'image', pixelWidth: 400, pixelHeight: 200, cssToImageScaleX: 2, cssToImageScaleY: 2, cropOriginCss: { x: 100, y: 50 } }
const viewport = { cssWidth: 1000, cssHeight: 800, deviceScaleFactor: 1.5, scrollX: 0, scrollY: 700 }

describe('browser grounding contracts', () => {
  it('maps the exact image crop and scale independently of screen DPI or page scrolling', () => {
    expect(imagePointToViewport({ x: 40, y: 20 }, image, viewport)).toEqual({ x: 120, y: 60 })
    expect(() => imagePointToViewport({ x: 400, y: 20 }, image, viewport)).toThrow('invalid_geometry')
    expect(() => imagePointToViewport({ x: 40, y: 20 }, { ...image, cssToImageScaleX: 0 }, viewport)).toThrow('invalid_geometry')
    expect(() => imagePointToViewport({ x: 40, y: 20 }, { ...image, cropOriginCss: { x: 950, y: 0 } }, viewport)).toThrow('invalid_geometry')
  })
  it('makes references usable only in the exact observed profile, session, document and generation', () => {
    const store = new BrowserReferenceStore(identity)
    const [ref] = store.observe(identity, [node])
    expect(ref).not.toContain('button')
    expect(store.resolve(identity, ref).backendNodeId).toBe(3)
    for (const patch of [{ profileId: 'b' }, { sessionId: 'other' }, { generation: 2 }, { tabId: 'other' }, { documentId: 'rerendered' }, { observationId: 'later' }]) {
      expect(() => store.resolve({ ...identity, ...patch }, ref)).toThrow()
    }
    store.invalidateTab('tab')
    expect(() => store.resolve(identity, ref)).toThrow('stale_ref')
  })
  it('evicts observations with a bounded reference budget and refuses forged refs', () => {
    const store = new BrowserReferenceStore(identity, 1, 2)
    const [ref] = store.observe(identity, [node])
    store.observe({ ...identity, observationId: 'new' }, [node])
    expect(() => store.resolve(identity, ref)).toThrow('stale_ref')
    expect(() => store.resolve({ ...identity, observationId: 'new' }, 'forged')).toThrow('stale_ref')
    expect(() => store.observe({ ...identity, observationId: 'large' }, [node, node, node])).toThrow('limit')
  })
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'https://user:password@example.com'])('rejects unsafe navigation URL %s', (url) => {
    expect(() => browserNavigationUrl(url)).toThrow()
  })
  it('accepts only typed actions and artifact references, never arbitrary page code or local file paths', () => {
    expect(validateBrowserAction({ type: 'fill', target: { kind: 'ref', ref: 'el_1' }, text: '' })).toEqual({ type: 'fill', target: { kind: 'ref', ref: 'el_1' }, text: '' })
    expect(() => validateBrowserAction({ type: 'evaluate', code: 'document.cookie' })).toThrow('unsupported action')
    expect(() => validateBrowserAction({ type: 'click', target: { kind: 'ref', ref: 'el_1', selector: '#unobserved' } })).toThrow('unexpected field')
    expect(() => validateBrowserAction({ type: 'upload', target: { kind: 'ref', ref: 'el_1' }, artifactIds: ['C:\\secret.txt'] })).toThrow('invalid identifier')
  })
  it('requires observation, lease and bounded timeout on action transactions', () => {
    const request = { requestId: 'req', sessionId: 'session', tabId: 'tab', generation: 1, observationId: 'obs', controlLeaseId: 'lease', action: { type: 'reload' }, timeoutMs: 1000 }
    expect(validateBrowserActionRequest(request).action.type).toBe('reload')
    expect(() => validateBrowserActionRequest({ ...request, controlLeaseId: undefined })).toThrow()
    expect(() => validateBrowserActionRequest({ ...request, timeoutMs: 120001 })).toThrow()
    expect(() => validateBrowserActionRequest({ ...request, generation: 1.5 })).toThrow()
    expect(() => validateBrowserActionRequest({ ...request, authority: 'admin' })).toThrow()
  })
})

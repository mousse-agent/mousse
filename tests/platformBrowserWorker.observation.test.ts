import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { imagePointToViewport } from '../src/shared/browser/geometry'
import type { BrowserActionResult, BrowserElement, BrowserObservation, BrowserSessionRecord } from '../src/shared/browser/types'
import { pngDimensions } from '../src/browser-worker/observation/png'
import { createInProcessBroker, ensureManagedChrome, MANAGED_BROWSER_ROOT, startCrossOriginFixtureSite, startFixtureSite, workerRequest } from './fixtures/browser/harness'
import { decodePng } from './fixtures/browser/pngPixels'

const chrome = await ensureManagedChrome()

function named(observation: BrowserObservation, name: string): BrowserElement {
  const match = observation.elements.find((element) => (element.name ?? '').includes(name) || (element.text ?? '').includes(name))
  if (!match) throw new Error(`missing element ${name} in ${observation.elements.map((el) => el.name).join(',')}`)
  return match
}

function actParams(session: BrowserSessionRecord, observation: BrowserObservation, action: Record<string, unknown>, requestId: string) {
  return {
    requestId,
    sessionId: session.id,
    tabId: observation.tabId,
    generation: session.generation,
    observationId: observation.observationId,
    controlLeaseId: session.controlLeaseId,
    timeoutMs: 10_000,
    action
  }
}

describe.skipIf(!chrome.ok)('observation pipeline', () => {
  let origin = ''
  let closeSite: () => Promise<void> = async () => undefined

  beforeAll(async () => {
    const site = await startFixtureSite()
    origin = site.origin
    closeSite = site.close
  }, 120_000)
  afterAll(async () => { await closeSite() })

  it('invalidates refs after navigation and never exposes password field content', async () => {
    const { broker } = await createInProcessBroker()
    const opened = await broker.call(workerRequest('profile_obs', 'session.open', { url: `${origin}/form.html` }))
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const secret = payload.observation.elements.find((element) => (element.name ?? '').toLowerCase().includes('password') || element.states.includes('secret'))
    expect(secret?.text ?? '').not.toMatch(/hunter2|secret/)
    const serialized = JSON.stringify(payload.observation)
    expect(serialized).not.toContain('backendNodeId')
    expect(serialized).not.toMatch(/C:\\|\/Users\/|user-data/)
    const nav = await broker.call(workerRequest('profile_obs', 'session.close', { sessionId: payload.session.id }))
    expect(nav.ok).toBe(true)
    const openedNav = await broker.call(workerRequest('profile_obs', 'session.open', { url: `${origin}/nav-a.html` }))
    const navPayload = openedNav.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const stay = named(navPayload.observation, 'Stay')
    const clicked = await broker.call(workerRequest('profile_obs', 'act', {
      requestId: 'act_nav',
      sessionId: navPayload.session.id,
      tabId: navPayload.observation.tabId,
      generation: navPayload.session.generation,
      observationId: navPayload.observation.observationId,
      controlLeaseId: navPayload.session.controlLeaseId,
      timeoutMs: 8_000,
      action: { type: 'click', target: { kind: 'ref', ref: named(navPayload.observation, 'Go to B').ref } }
    }))
    expect(clicked.ok, clicked.error?.message).toBe(true)
    const stale = await broker.call(workerRequest('profile_obs', 'act', {
      requestId: 'act_stale',
      sessionId: navPayload.session.id,
      tabId: navPayload.observation.tabId,
      generation: navPayload.session.generation,
      observationId: navPayload.observation.observationId,
      controlLeaseId: navPayload.session.controlLeaseId,
      timeoutMs: 4_000,
      action: { type: 'click', target: { kind: 'ref', ref: stay.ref } }
    }))
    expect(stale.ok).toBe(false)
    expect(['stale_ref', 'stale_observation', 'stale_generation']).toContain(stale.error?.code)
    await broker.close()
  }, 120_000)

  it('captures screenshot geometry matching crop and high-DPI scale', async () => {
    const { broker, roots } = await createInProcessBroker()
    const opened = await broker.call(workerRequest('profile_geo', 'session.open', { url: `${origin}/geometry.html` }))
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const shot = await broker.call(workerRequest('profile_geo', 'observe', {
      sessionId: payload.session.id,
      tabId: payload.observation.tabId,
      includeScreenshot: true,
      deviceScaleFactor: 2,
      clip: { x: 40, y: 30, width: 120, height: 80 }
    }))
    expect(shot.ok).toBe(true)
    const observation = shot.result as BrowserObservation
    expect(observation.screenshot).toBeTruthy()
    const image = observation.screenshot!
    expect(image.cropOriginCss).toEqual({ x: 40, y: 30 })
    expect(image.cssToImageScaleX).toBeCloseTo(image.pixelWidth / 120, 5)
    expect(image.cssToImageScaleY).toBeCloseTo(image.pixelHeight / 80, 5)
    expect(image.pixelWidth).toBeGreaterThanOrEqual(120)
    expect(image.pixelHeight).toBeGreaterThanOrEqual(80)
    const mapped = imagePointToViewport({ x: 0, y: 0 }, image, observation.viewport)
    expect(mapped.x).toBeCloseTo(40, 5)
    expect(mapped.y).toBeCloseTo(30, 5)
    const file = join(roots.artifactRoot, 'profile_geo', payload.session.id, `${image.artifactId}.png`)
    const bytes = readFileSync(file)
    expect(pngDimensions(bytes)).toEqual({ width: image.pixelWidth, height: image.pixelHeight })
    expect(observation.viewport.deviceScaleFactor).toBeCloseTo(2, 5)
    await broker.close()
    void MANAGED_BROWSER_ROOT
  }, 120_000)

  it('a screenshot of a scrolled page shows what the viewport shows, whole or clipped', async () => {
    const { broker, roots } = await createInProcessBroker()
    // The page scrolls itself to 700: red above the fold, green below it, a blue mark at (40, 30) of the viewport.
    const opened = await broker.call(workerRequest('profile_scrolled', 'session.open', { url: `${origin}/scrolled.html` }))
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const pixels = async (clip?: { x: number; y: number; width: number; height: number }) => {
      const shot = await broker.call(workerRequest('profile_scrolled', 'observe', { sessionId: payload.session.id, tabId: payload.observation.tabId, includeScreenshot: true, ...(clip ? { clip } : {}) }))
      expect(shot.ok, JSON.stringify(shot.error)).toBe(true)
      const observation = shot.result as BrowserObservation
      expect(observation.viewport.scrollY).toBeCloseTo(700, 0)
      const image = observation.screenshot!
      const decoded = decodePng(readFileSync(join(roots.artifactRoot, 'profile_scrolled', payload.session.id, `${image.artifactId}.png`)))
      expect({ width: decoded.width, height: decoded.height }).toEqual({ width: image.pixelWidth, height: image.pixelHeight })
      /** The colour at a viewport CSS point of this picture. */
      return (x: number, y: number) => decoded.rgb((x - (image.cropOriginCss?.x ?? 0)) * image.cssToImageScaleX, (y - (image.cropOriginCss?.y ?? 0)) * image.cssToImageScaleY)
    }
    const isGreen = ([r, g, b]: number[]) => g > 200 && r < 60 && b < 60
    const isBlue = ([r, g, b]: number[]) => b > 200 && r < 60 && g < 60
    const whole = await pixels()
    expect(whole(400, 360)).toSatisfy(isGreen)
    expect(whole(400, 10)).toSatisfy(isGreen)
    expect(whole(100, 70)).toSatisfy(isBlue)
    const clipped = await pixels({ x: 40, y: 30, width: 120, height: 80 })
    expect(clipped(100, 70)).toSatisfy(isBlue)
    await broker.close()
  }, 120_000)
})

describe.skipIf(!chrome.ok)('find and extract stay bounded and untrusted', () => {
  it('pages find results and marks extract provenance', async () => {
    const site = await startFixtureSite()
    const { broker } = await createInProcessBroker()
    const opened = await broker.call(workerRequest('profile_find', 'session.open', { url: `${site.origin}/form.html` }))
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const found = await broker.call(workerRequest('profile_find', 'find', {
      sessionId: payload.session.id,
      tabId: payload.observation.tabId,
      role: 'button',
      maxResults: 5
    }))
    expect(found.ok).toBe(true)
    const matches = found.result as { elements: BrowserElement[] }
    expect(matches.elements.some((element) => element.role === 'button')).toBe(true)
    const extracted = await broker.call(workerRequest('profile_find', 'extract', {
      sessionId: payload.session.id,
      tabId: payload.observation.tabId
    }))
    expect(extracted.ok).toBe(true)
    expect((extracted.result as { provenance: string }).provenance).toBe('untrusted-page')
    await broker.close()
    await site.close()
  }, 120_000)
})

describe.skipIf(!chrome.ok)('cross-origin frames and open shadow observation', () => {
  it('observes and acts through an attached OOPIF without confusing duplicate labels', async () => {
    const site = await startCrossOriginFixtureSite()
    const { broker, capabilities } = await createInProcessBroker({ chromeExtraArgs: ['--host-resolver-rules=MAP foo.test 127.0.0.1'] })
    expect(capabilities.capabilities.oopif).toBe('supported')
    const opened = await broker.call(workerRequest('profile_oopif', 'session.open', { url: `${site.parentOrigin}/frame-parent.html` }))
    expect(opened.ok, opened.error?.message).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const duplicateButtons = payload.observation.elements.filter((element) => element.name === 'Duplicate')
    const frameInput = payload.observation.elements.find((element) => element.role === 'textbox' && element.name === 'Duplicate')
    const frameSubmit = named(payload.observation, 'Submit frame')
    expect(duplicateButtons.length).toBeGreaterThanOrEqual(1)
    expect(frameInput).toBeTruthy()
    expect(frameInput!.frameRef).not.toBe(duplicateButtons[0].frameRef)
    expect(payload.observation.warnings).toContain('oopif-attached')
    const bounded = await broker.call(workerRequest('profile_oopif', 'observe', {
      sessionId: payload.session.id,
      tabId: payload.observation.tabId,
      maxElements: 1
    }))
    expect(bounded.ok, JSON.stringify(bounded.error)).toBe(true)
    expect((bounded.result as BrowserObservation).elements.length).toBeLessThanOrEqual(1)
    expect((bounded.result as BrowserObservation).truncated).toBe(true)
    const refreshed = await broker.call(workerRequest('profile_oopif', 'observe', {
      sessionId: payload.session.id,
      tabId: payload.observation.tabId
    }))
    expect(refreshed.ok, JSON.stringify(refreshed.error)).toBe(true)
    const refreshedObservation = refreshed.result as BrowserObservation
    const emptySubmit = await broker.call(workerRequest('profile_oopif', 'act', actParams(payload.session, refreshedObservation, { type: 'click', target: { kind: 'ref', ref: named(refreshedObservation, 'Submit frame').ref } }, 'frame_empty_submit')))
    expect(emptySubmit.ok, JSON.stringify(emptySubmit.error)).toBe(true)
    expect(site.frameSubmitCount()).toBe(0)
    expect(JSON.stringify((emptySubmit.result as BrowserActionResult).observation)).toContain('error: value required')
    const afterEmptySubmit = (emptySubmit.result as BrowserActionResult).observation!
    const refreshedFrameInput = afterEmptySubmit.elements.find((element) => element.role === 'textbox' && element.name === 'Duplicate')
    expect(refreshedFrameInput).toBeTruthy()
    const filled = await broker.call(workerRequest('profile_oopif', 'act', actParams({ ...payload.session, generation: afterEmptySubmit.generation }, afterEmptySubmit, { type: 'fill', target: { kind: 'ref', ref: refreshedFrameInput.ref }, text: 'cross-origin-value' }, 'frame_fill')))
    expect(filled.ok, JSON.stringify(filled.error)).toBe(true)
    const afterFill = filled.result as BrowserActionResult
    const submitObservation = afterFill.observation ?? payload.observation
    const submit = submitObservation.elements.find((element) => element.name === 'Submit frame') ?? frameSubmit
    const clicked = await broker.call(workerRequest('profile_oopif', 'act', actParams({ ...payload.session, generation: submitObservation.generation }, submitObservation, { type: 'click', target: { kind: 'ref', ref: submit.ref } }, 'frame_submit')))
    expect(clicked.ok, JSON.stringify(clicked.error)).toBe(true)
    expect(site.frameSubmitCount()).toBe(1)
    const resultText = JSON.stringify((clicked.result as BrowserActionResult).observation)
    expect(resultText).toContain('frame-saved:cross-origin-value')
    const afterSubmit = (clicked.result as BrowserActionResult).observation!
    const navigateFrame = named(afterSubmit, 'Navigate frame')
    const navigated = await broker.call(workerRequest('profile_oopif', 'act', actParams({ ...payload.session, generation: afterSubmit.generation }, afterSubmit, { type: 'click', target: { kind: 'ref', ref: navigateFrame.ref } }, 'frame_navigate')))
    expect(navigated.ok, JSON.stringify(navigated.error)).toBe(true)
    const staleAfterNavigation = await broker.call(workerRequest('profile_oopif', 'act', actParams({ ...payload.session, generation: afterSubmit.generation }, afterSubmit, { type: 'click', target: { kind: 'ref', ref: navigateFrame.ref } }, 'stale_navigated_frame_ref')))
    expect(staleAfterNavigation.ok).toBe(false)
    expect(['stale_observation', 'stale_ref']).toContain(staleAfterNavigation.error?.code)
    const afterNavigation = (navigated.result as BrowserActionResult).observation!
    const removeFrame = named(afterNavigation, 'Remove frame')
    const detached = await broker.call(workerRequest('profile_oopif', 'act', actParams({ ...payload.session, generation: afterNavigation.generation }, afterNavigation, { type: 'click', target: { kind: 'ref', ref: removeFrame.ref } }, 'frame_detach')))
    expect(detached.ok, JSON.stringify(detached.error)).toBe(true)
    const stale = await broker.call(workerRequest('profile_oopif', 'act', actParams({ ...payload.session, generation: afterNavigation.generation }, afterNavigation, { type: 'click', target: { kind: 'ref', ref: frameInput!.ref } }, 'stale_frame_ref')))
    expect(stale.ok).toBe(false)
    expect(['stale_observation', 'stale_ref', 'worker_disconnected']).toContain(stale.error?.code)
    await broker.close()
    await site.close()
  }, 120_000)

  it('reads a visible form frame from another site behind hidden helper frames from the same site, and narrows to it by ref', async () => {
    const site = await startCrossOriginFixtureSite()
    const { broker } = await createInProcessBroker({ chromeExtraArgs: ['--host-resolver-rules=MAP foo.test 127.0.0.1'] })
    // A display:none helper and a 0x0 helper from the form's own site come before the visible form frame (at 320, 160).
    const opened = await broker.call(workerRequest('profile_helper', 'session.open', { url: `${site.parentOrigin}/frame-helper-parent.html` }))
    expect(opened.ok, opened.error?.message).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const observation = payload.observation
    const email = observation.elements.find((element) => element.role === 'textbox' && element.name === 'Work email')
    expect(email, observation.elements.map((element) => `${element.role}:${element.name}`).join(' | ')).toBeTruthy()
    expect(email!.bounds!.x).toBeGreaterThanOrEqual(320)
    expect(email!.bounds!.y).toBeGreaterThanOrEqual(160)
    expect(observation.elements.some((element) => element.role === 'button' && element.name === 'Sign up')).toBe(true)
    expect(observation.elements.some((element) => element.name === 'Helper ping')).toBe(false)
    expect(observation.warnings).toContain('oopif-attached')
    const found = await broker.call(workerRequest('profile_helper', 'find', { sessionId: payload.session.id, tabId: observation.tabId, role: 'textbox', name: 'work email' }))
    expect(found.ok, JSON.stringify(found.error)).toBe(true)
    const matches = (found.result as { elements: BrowserElement[] }).elements
    expect(matches).toHaveLength(1)
    expect(matches[0].frameRef).not.toBe(named(observation, 'Parent only').frameRef)

    const frame = observation.elements.find((element) => element.name === 'Signing form')
    expect(frame, observation.elements.map((element) => `${element.role}:${element.name}`).join(' | ')).toBeTruthy()
    const scoped = await broker.call(workerRequest('profile_helper', 'observe', { sessionId: payload.session.id, tabId: observation.tabId, observationId: observation.observationId, ref: frame!.ref }))
    expect(scoped.ok, JSON.stringify(scoped.error)).toBe(true)
    const scopedNames = (scoped.result as BrowserObservation).elements.map((element) => element.name)
    expect(scopedNames).toEqual(expect.arrayContaining(['Work email', 'Sign up']))
    expect(scopedNames).not.toContain('Parent only')
    expect(scopedNames).not.toContain('Checkout')
    const extracted = await broker.call(workerRequest('profile_helper', 'extract', { sessionId: payload.session.id, tabId: observation.tabId, observationId: observation.observationId, ref: frame!.ref }))
    expect(extracted.ok, JSON.stringify(extracted.error)).toBe(true)
    const text = (extracted.result as { text: string }).text
    expect(text).toContain('Sign up')
    expect(text).not.toContain('Parent only')
    const unknown = await broker.call(workerRequest('profile_helper', 'observe', { sessionId: payload.session.id, tabId: observation.tabId, ref: 'el_00000000-0000-4000-8000-000000000000' }))
    expect(unknown.ok).toBe(false)
    expect(unknown.error?.code).toBe('stale_ref')
    await broker.close()
    await site.close()
  }, 120_000)

  it('observes and acts through an open shadow root while keeping internals private', async () => {
    const site = await startFixtureSite()
    const { broker, capabilities } = await createInProcessBroker()
    expect(capabilities.capabilities.openShadowDom).toBe(true)
    const opened = await broker.call(workerRequest('profile_shadow', 'session.open', { url: `${site.origin}/shadow.html` }))
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const input = named(payload.observation, 'Shadow input')
    const button = named(payload.observation, 'Save shadow')
    const filled = await broker.call(workerRequest('profile_shadow', 'act', actParams(payload.session, payload.observation, { type: 'fill', target: { kind: 'ref', ref: input.ref }, text: 'shadow-value' }, 'shadow_fill')))
    expect(filled.ok, JSON.stringify(filled.error)).toBe(true)
    const afterFill = filled.result as BrowserActionResult
    const clickTarget = afterFill.observation?.elements.find((element) => element.name === 'Save shadow') ?? button
    const clicked = await broker.call(workerRequest('profile_shadow', 'act', actParams({ ...payload.session, generation: afterFill.observation?.generation ?? payload.session.generation }, afterFill.observation ?? payload.observation, { type: 'click', target: { kind: 'ref', ref: clickTarget.ref } }, 'shadow_submit')))
    expect(clicked.ok, JSON.stringify(clicked.error)).toBe(true)
    expect(JSON.stringify((clicked.result as BrowserActionResult).observation)).toContain('shadow-saved:shadow-value')
    await broker.close()
    await site.close()
  }, 120_000)
})

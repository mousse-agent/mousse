import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BrowserActionResult, BrowserElement, BrowserObservation, BrowserSessionRecord } from '../src/shared/browser/types'
import { BrowserBroker } from '../src/mms/browser/BrowserBroker'
import { createAllowHttpPolicy, createFilesystemArtifactPort } from '../src/mms/browser/defaultPorts'
import { isProcessAlive } from '../src/browser-worker/lifecycle/process'
import { journalPath, processRecordPath } from '../src/browser-worker/lifecycle/paths'
import { productBuild, sharedBuild } from './support/build'
import { createInProcessBroker, ensureManagedChrome, MANAGED_BROWSER_ROOT, startCrossOriginFixtureSite, startFixtureSite, workerRequest } from './fixtures/browser/harness'

const chrome = await ensureManagedChrome()

function named(observation: BrowserObservation, name: string, role?: string): BrowserElement {
  const matches = observation.elements.filter((element) => (element.name ?? '').includes(name) || (element.text ?? '').includes(name) || element.role === name)
  const match = role ? matches.find((element) => element.role === role) ?? matches[0] : matches[0]
  if (!match) throw new Error(`missing ${name}: ${observation.elements.map((el) => `${el.role}:${el.name}`).join(' | ')}`)
  return match
}

/** A screenshot pixel for a viewport CSS point of an observation's picture. */
function imagePointOf(observation: BrowserObservation, css: { x: number; y: number }): { x: number; y: number } {
  const image = observation.screenshot!
  return { x: (css.x - (image.cropOriginCss?.x ?? 0)) * image.cssToImageScaleX, y: (css.y - (image.cropOriginCss?.y ?? 0)) * image.cssToImageScaleY }
}

/** The middle of an element's box, in viewport CSS pixels. */
function middleOf(element: BrowserElement): { x: number; y: number } {
  return { x: element.bounds!.x + element.bounds!.width / 2, y: element.bounds!.y + element.bounds!.height / 2 }
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

describe.skipIf(!chrome.ok)('atomic action execution', () => {
  let origin = ''
  let closeSite: () => Promise<void> = async () => undefined

  beforeAll(async () => {
    const site = await startFixtureSite()
    origin = site.origin
    closeSite = site.close
  }, 120_000)
  afterAll(async () => { await closeSite() })

  it('fills a form and verifies the click end-state', async () => {
    const { broker } = await createInProcessBroker()
    const opened = await broker.call(workerRequest('profile_act', 'session.open', { url: `${origin}/form.html` }))
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const name = named(payload.observation, 'Name', 'textbox')
    const filled = await broker.call(workerRequest('profile_act', 'act', actParams(payload.session, payload.observation, {
      type: 'fill', target: { kind: 'ref', ref: name.ref }, text: 'Ada'
    }, 'fill_name')))
    expect(filled.ok, JSON.stringify(filled.error)).toBe(true)
    const fillResult = filled.result as BrowserActionResult
    expect(fillResult.dispatched).toBe(true)
    expect(['verified', 'unverified']).toContain(fillResult.outcome)
    const afterFill = fillResult.observation ?? (await broker.call(workerRequest('profile_act', 'observe', { sessionId: payload.session.id, tabId: payload.observation.tabId }))).result as BrowserObservation
    const save = named(afterFill, 'Save')
    const clicked = await broker.call(workerRequest('profile_act', 'act', {
      ...actParams({ ...payload.session, controlLeaseId: payload.session.controlLeaseId, generation: afterFill.generation }, afterFill, {
        type: 'click', target: { kind: 'ref', ref: save.ref }
      }, 'click_save'),
      expected: { type: 'text', text: 'saved:Ada:pwlen=0', present: true }
    }))
    expect(clicked.ok).toBe(true)
    const clickResult = clicked.result as BrowserActionResult
    expect(clickResult.dispatched).toBe(true)
    const haystack = `${clickResult.observation?.title ?? ''} ${clickResult.observation?.elements.map((el) => `${el.name ?? ''} ${el.text ?? ''}`).join(' ')}`
    expect(haystack).toContain('saved:Ada:pwlen=0')
    expect(JSON.stringify(clickResult.observation)).not.toContain('hunter2')
    await broker.close()
  }, 120_000)

  it('refuses overlay-intercepted clicks instead of force clicking', async () => {
    const { broker } = await createInProcessBroker()
    const opened = await broker.call(workerRequest('profile_over', 'session.open', { url: `${origin}/overlay.html` }))
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const submit = named(payload.observation, 'Submit')
    const clicked = await broker.call(workerRequest('profile_over', 'act', actParams(payload.session, payload.observation, {
      type: 'click', target: { kind: 'ref', ref: submit.ref }
    }, 'click_overlay')))
    expect(clicked.ok).toBe(false)
    expect(clicked.error?.code).toBe('not_actionable')
    expect(clicked.error?.message.toLowerCase()).toMatch(/overlay|intercept/)
    const check = await broker.call(workerRequest('profile_over', 'observe', { sessionId: payload.session.id, tabId: payload.observation.tabId }))
    const observation = check.result as BrowserObservation
    const haystack = observation.elements.map((el) => el.text ?? '').join(' ')
    expect(haystack).not.toContain('clicked')
    await broker.close()
  }, 120_000)

  it('fences queued agent actions on human takeover and cancels before dispatch', async () => {
    const { broker } = await createInProcessBroker()
    const opened = await broker.call(workerRequest('profile_take', 'session.open', { url: `${origin}/form.html` }))
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const take = await broker.call(workerRequest('profile_take', 'control.take', { sessionId: payload.session.id, owner: 'human' }))
    expect(take.ok).toBe(true)
    const blocked = await broker.call(workerRequest('profile_take', 'act', actParams(payload.session, payload.observation, {
      type: 'click', target: { kind: 'ref', ref: named(payload.observation, 'Save').ref }
    }, 'click_after_takeover')))
    expect(blocked.ok).toBe(false)
    expect(['human_controlled', 'stale_generation']).toContain(blocked.error?.code)
    const controller = new AbortController()
    const pending = broker.call(workerRequest('profile_take', 'wait', {
      sessionId: payload.session.id,
      tabId: payload.observation.tabId,
      condition: { type: 'text', text: 'never-appears', present: true },
      timeoutMs: 8_000
    }), { signal: controller.signal, timeoutMs: 8_000 })
    controller.abort('cancelled')
    const cancelled = await pending.catch((error: Error & { code?: string }) => error)
    expect(cancelled).toBeInstanceOf(Error)
    expect((cancelled as Error & { code?: string }).code).toBe('cancelled')
    const afterCancel = await broker.call(workerRequest('profile_take', 'observe', {
      sessionId: payload.session.id,
      tabId: payload.observation.tabId
    }))
    expect(afterCancel.ok, JSON.stringify(afterCancel)).toBe(true)
    const afterObservation = afterCancel.result as BrowserObservation
    expect(afterObservation.sessionId).toBe(payload.session.id)
    const haystack = `${afterObservation.title} ${afterObservation.elements.map((el) => `${el.name ?? ''} ${el.text ?? ''}`).join(' ')}`
    expect(haystack.toLowerCase()).not.toContain('never-appears')
    await broker.close()
  }, 120_000)

  it('stops repeated no-op actions with a bounded no-progress error', async () => {
    const { broker } = await createInProcessBroker()
    const opened = await broker.call(workerRequest('profile_progress', 'session.open', { url: `${origin}/coordinate.html` }))
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    let last = await broker.call(workerRequest('profile_progress', 'act', actParams(payload.session, payload.observation, {
      type: 'navigate', url: `${origin}/coordinate.html`
    }, 'navigate_0')))
    for (let index = 1; index < 4; index += 1) {
      last = await broker.call(workerRequest('profile_progress', 'act', actParams(payload.session, payload.observation, {
        type: 'navigate', url: `${origin}/coordinate.html`
      }, `navigate_${index}`)))
    }
    expect(last.ok).toBe(false)
    expect(last.error?.code, JSON.stringify(last)).toBe('no_progress')
    await broker.close()
  }, 120_000)

  it('does not automatically replay an action after disconnect', async () => {
    const { broker } = await createInProcessBroker()
    const opened = await broker.call(workerRequest('profile_disc', 'session.open', { url: `${origin}/form.html` }))
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const inflight = broker.call(workerRequest('profile_disc', 'act', {
      ...actParams(payload.session, payload.observation, {
        type: 'click', target: { kind: 'ref', ref: named(payload.observation, 'Save').ref }
      }, 'click_disconnect'),
      timeoutMs: 20_000
    }))
    await broker.close()
    const settled = await inflight.catch((error: Error & { code?: string }) => error)
    if ('ok' in (settled as object)) {
      const response = settled as { ok: boolean; error?: { code: string }; result?: BrowserActionResult }
      if (response.ok) expect(['unknown-effect', 'failed']).toContain(response.result?.outcome)
      else expect(['worker_disconnected', 'cancelled', 'session_closed']).toContain(response.error?.code)
    } else {
      expect(['worker_disconnected', 'cancelled'].includes((settled as Error & { code?: string }).code ?? '') || /disconnect|cancelled/i.test((settled as Error).message)).toBe(true)
    }
  }, 120_000)

  it('rejects evaluate tools and upload grants without an MMS resolver', async () => {
    const { broker } = await createInProcessBroker()
    const opened = await broker.call(workerRequest('profile_unsup', 'session.open', { url: `${origin}/form.html` }))
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const evaluate = await broker.call(workerRequest('profile_unsup', 'act', actParams(payload.session, payload.observation, {
      type: 'evaluate', code: 'document.cookie'
    }, 'eval')))
    expect(evaluate.ok).toBe(false)
    const upload = await broker.call(workerRequest('profile_unsup', 'act', actParams(payload.session, payload.observation, {
      type: 'upload', target: { kind: 'ref', ref: named(payload.observation, 'Save').ref }, artifactIds: ['art_1']
    }, 'upload')))
    expect(upload.ok).toBe(false)
    expect(upload.error?.code).toBe('artifact_denied')
    await broker.close()
  }, 120_000)

  it('performs a real bounded drag through CDP and verifies the drop result', async () => {
    const { broker } = await createInProcessBroker()
    const opened = await broker.call(workerRequest('profile_drag', 'session.open', { url: `${origin}/drag.html` }))
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const source = named(payload.observation, 'Drag me')
    const target = named(payload.observation, 'Drop here')
    const dragged = await broker.call(workerRequest('profile_drag', 'act', actParams(payload.session, payload.observation, {
      type: 'drag', from: { kind: 'ref', ref: source.ref }, to: { kind: 'ref', ref: target.ref }
    }, 'drag_fixture')))
    expect(dragged.ok, JSON.stringify(dragged.error)).toBe(true)
    const result = dragged.result as BrowserActionResult
    const text = result.observation?.elements.map((element) => `${element.name ?? ''} ${element.text ?? ''}`).join(' ') ?? ''
    expect(text).toContain('dropped')
    await broker.close()
  }, 120_000)

  it('maps a screenshot point with crop and device scale and rejects stale geometry', async () => {
    const { broker } = await createInProcessBroker()
    const opened = await broker.call(workerRequest('profile_point', 'session.open', { url: `${origin}/coordinate.html` }))
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const observed = await broker.call(workerRequest('profile_point', 'observe', { sessionId: payload.session.id, tabId: payload.observation.tabId, includeScreenshot: true, deviceScaleFactor: 2, clip: { x: 80, y: 70, width: 400, height: 300 } }))
    const observation = observed.result as BrowserObservation
    const bounds = observation.elements.find((element) => element.name === 'Point target')?.bounds
    expect(bounds && observation.screenshot).toBeTruthy()
    const point = { x: ((bounds!.x + bounds!.width / 2) - (observation.screenshot!.cropOriginCss?.x ?? 0)) * observation.screenshot!.cssToImageScaleX, y: ((bounds!.y + bounds!.height / 2) - (observation.screenshot!.cropOriginCss?.y ?? 0)) * observation.screenshot!.cssToImageScaleY }
    const clicked = await broker.call(workerRequest('profile_point', 'act', actParams({ ...payload.session, generation: observation.generation }, observation, { type: 'click', target: { kind: 'image-point', point } }, 'point_fixture')))
    expect(clicked.ok, JSON.stringify(clicked.error)).toBe(true)
    const stale = await broker.call(workerRequest('profile_point', 'act', actParams({ ...payload.session, generation: observation.generation }, { ...observation, observationId: 'obs_missing' }, { type: 'click', target: { kind: 'image-point', point } }, 'point_stale')))
    expect(stale.ok).toBe(false)
    expect(stale.error?.code).toBe('stale_observation')
    await broker.close()
  }, 120_000)

  it('scrolls the pane under an image point and no other, and refuses a scroll that moves nothing', async () => {
    const { broker } = await createInProcessBroker()
    try {
      // Two panes that scroll on their own (left at x 0-400, right at x 500-900, both at y 100-400); the page does not scroll.
      const opened = await broker.call(workerRequest('profile_point_scroll', 'session.open', { url: `${origin}/wheel-targets.html` }))
      expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
      const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
      const observe = async (includeScreenshot: boolean) => {
        const observed = await broker.call(workerRequest('profile_point_scroll', 'observe', { sessionId: payload.session.id, tabId: payload.observation.tabId, includeScreenshot }))
        expect(observed.ok, JSON.stringify(observed.error)).toBe(true)
        return observed.result as BrowserObservation
      }
      /** How far each pane has scrolled, as the page reports it. */
      const panes = async () => /left:\d+ right:\d+/.exec(JSON.stringify((await observe(false)).elements))?.[0]
      expect(await panes()).toBe('left:0 right:0')
      // The fixture's own coordinates, not the worker's bounds: the middle of the right pane.
      let observation = await observe(true)
      const right = await broker.call(workerRequest('profile_point_scroll', 'act', actParams(payload.session, observation, { type: 'scroll', target: { kind: 'image-point', point: imagePointOf(observation, { x: 700, y: 250 }) }, deltaX: 0, deltaY: 400 }, 'point_scroll_right')))
      expect(right.ok, JSON.stringify(right.error)).toBe(true)
      await expect.poll(panes, { timeout: 5_000 }).toMatch(/^left:0 right:[1-9]\d*$/)
      observation = await observe(true)
      const left = await broker.call(workerRequest('profile_point_scroll', 'act', actParams(payload.session, observation, { type: 'scroll', target: { kind: 'image-point', point: imagePointOf(observation, { x: 200, y: 250 }) }, deltaX: 0, deltaY: 400 }, 'point_scroll_left')))
      expect(left.ok, JSON.stringify(left.error)).toBe(true)
      await expect.poll(panes, { timeout: 5_000 }).toMatch(/^left:[1-9]\d* right:[1-9]\d*$/)
      const still = await broker.call(workerRequest('profile_point_scroll', 'act', actParams(payload.session, (left.result as BrowserActionResult).observation!, { type: 'scroll', deltaX: 0, deltaY: 0 }, 'zero_scroll')))
      expect(still.ok).toBe(false)
      expect(still.error?.code).toBe('invalid_action')
    } finally {
      await broker.close()
    }
  }, 120_000)

  it('refuses an image point on a page that scrolled by itself since its screenshot, and presses nothing', async () => {
    const { broker } = await createInProcessBroker()
    try {
      // The page scrolls itself 3px every 16ms; a button every 60px, which names itself in the title when pressed.
      const opened = await broker.call(workerRequest('profile_point_autoscroll', 'session.open', { url: `${origin}/autoscroll.html` }))
      expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
      const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
      const observed = await broker.call(workerRequest('profile_point_autoscroll', 'observe', { sessionId: payload.session.id, tabId: payload.observation.tabId, includeScreenshot: true }))
      expect(observed.ok, JSON.stringify(observed.error)).toBe(true)
      const observation = observed.result as BrowserObservation
      const clicked = await broker.call(workerRequest('profile_point_autoscroll', 'act', actParams(payload.session, observation, { type: 'click', target: { kind: 'image-point', point: imagePointOf(observation, { x: 200, y: 300 }) } }, 'autoscroll_click')))
      expect(clicked.ok).toBe(false)
      expect(clicked.error?.code).toBe('stale_observation')
      expect(clicked.error?.message).toMatch(/scroll/i)
      const after = await broker.call(workerRequest('profile_point_autoscroll', 'observe', { sessionId: payload.session.id, tabId: payload.observation.tabId }))
      expect(after.ok, JSON.stringify(after.error)).toBe(true)
      expect((after.result as BrowserObservation).title).not.toMatch(/pressed/)
    } finally {
      await broker.close()
    }
  }, 120_000)

  it('refuses an image point on an observation that has no screenshot, and says so', async () => {
    const { broker } = await createInProcessBroker()
    const opened = await broker.call(workerRequest('profile_point_noshot', 'session.open', { url: `${origin}/coordinate.html` }))
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const click = { type: 'click', target: { kind: 'image-point', point: { x: 200, y: 150 } } }
    const plain = await broker.call(workerRequest('profile_point_noshot', 'observe', { sessionId: payload.session.id, tabId: payload.observation.tabId, includeScreenshot: false }))
    expect(plain.ok, JSON.stringify(plain.error)).toBe(true)
    const refused = await broker.call(workerRequest('profile_point_noshot', 'act', actParams(payload.session, plain.result as BrowserObservation, click, 'point_no_screenshot')))
    expect(refused.ok).toBe(false)
    expect(refused.error?.code).toBe('stale_observation')
    expect(refused.error?.message).toMatch(/no screenshot/i)
    // An action's own observation carries no screenshot either: after a reload, the same answer.
    const reloaded = await broker.call(workerRequest('profile_point_noshot', 'act', actParams(payload.session, plain.result as BrowserObservation, { type: 'reload' }, 'reload_before_point')))
    expect(reloaded.ok, JSON.stringify(reloaded.error)).toBe(true)
    const afterReload = await broker.call(workerRequest('profile_point_noshot', 'act', actParams(payload.session, (reloaded.result as BrowserActionResult).observation!, click, 'point_after_reload')))
    expect(afterReload.ok).toBe(false)
    expect(afterReload.error?.code).toBe('stale_observation')
    expect(afterReload.error?.message).toMatch(/no screenshot/i)
    await broker.close()
  }, 120_000)

  it('uploads only a broker-resolved staged artifact and reports selected names', async () => {
    const stage = await mkdtemp(join(tmpdir(), 'mousse-browser-stage-'))
    const staged = join(stage, 'note.txt')
    await writeFile(staged, 'safe fixture text')
    const filesystem = createFilesystemArtifactPort(stage)
    const artifacts = {
      write: filesystem.write,
      resolveReadOnly: async ({ artifactIds }: { profileId: string; sessionId: string; artifactIds: string[] }) => artifactIds.map((artifactId) => ({ artifactId, path: staged, byteLength: 17, displayName: 'note.txt', mediaType: 'text/plain' }))
    }
    const { broker } = await createInProcessBroker({ artifacts })
    const opened = await broker.call(workerRequest('profile_upload', 'session.open', { url: `${origin}/upload.html` }))
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const input = named(payload.observation, 'Files')
    const uploaded = await broker.call(workerRequest('profile_upload', 'act', actParams(payload.session, payload.observation, { type: 'upload', target: { kind: 'ref', ref: input.ref }, artifactIds: ['grant_note'] }, 'upload_fixture')))
    expect(uploaded.ok, JSON.stringify(uploaded.error)).toBe(true)
    const result = uploaded.result as BrowserActionResult
    expect(result.observation?.elements.map((element) => element.text ?? '').join(' ')).toContain('note.txt')
    await broker.close()
  }, 120_000)

  it('publishes a local download through the quarantine artifact path', async () => {
    const { broker, roots } = await createInProcessBroker()
    const opened = await broker.call(workerRequest('profile_download', 'session.open', { url: `${origin}/download.html` }))
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const link = named(payload.observation, 'Download fixture', 'button')
    const downloaded = await broker.call(workerRequest('profile_download', 'act', actParams(payload.session, payload.observation, { type: 'click', target: { kind: 'ref', ref: link.ref } }, 'download_fixture')))
    expect(downloaded.ok, JSON.stringify(downloaded.error)).toBe(true)
    const result = downloaded.result as BrowserActionResult
    expect(result.artifactIds.length).toBeGreaterThan(0)
    expect(result.artifacts?.some((artifact) => artifact.displayName === 'fixture-download.txt')).toBe(true)
    const artifact = result.artifacts?.find((item) => item.displayName === 'fixture-download.txt')
    expect(artifact).toBeTruthy()
    const artifactDir = join(roots.artifactRoot, 'profile_download', payload.session.id)
    const artifactFile = (await readdir(artifactDir)).find((name) => name.startsWith(artifact!.artifactId))
    expect(artifactFile).toBeTruthy()
    const bytes = await readFile(join(artifactDir, artifactFile!))
    expect(bytes).toEqual(await readFile(join(process.cwd(), 'tests', 'fixtures', 'browser', 'site', 'download.txt')))
    expect(artifact!.byteLength).toBe(bytes.byteLength)
    expect(artifact!.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    const quarantine = join(roots.browserRoot, 'user-data', 'profile_download', 'ephemeral', payload.session.id, 'quarantine-downloads')
    expect(await readdir(quarantine)).toHaveLength(0)
    await broker.close()
  }, 120_000)

  it('does not publish aborted or oversize downloads', async () => {
    const { broker, roots } = await createInProcessBroker()
    const opened = await broker.call(workerRequest('profile_download_edges', 'session.open', { url: `${origin}/download-edge.html` }))
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const aborted = named(payload.observation, 'Aborted fixture')
    const abortedResult = await broker.call(workerRequest('profile_download_edges', 'act', actParams(payload.session, payload.observation, { type: 'click', target: { kind: 'ref', ref: aborted.ref } }, 'aborted_download')))
    expect(abortedResult.ok).toBe(false)
    expect(abortedResult.error?.code).toBe('download_failed')
    const afterAbort = await broker.call(workerRequest('profile_download_edges', 'observe', { sessionId: payload.session.id, tabId: payload.observation.tabId }))
    const oversizeObservation = afterAbort.result as BrowserObservation
    const oversize = named(oversizeObservation, 'Oversize fixture')
    const oversizeResult = await broker.call(workerRequest('profile_download_edges', 'act', actParams({ ...payload.session, generation: oversizeObservation.generation }, oversizeObservation, { type: 'click', target: { kind: 'ref', ref: oversize.ref } }, 'oversize_download')))
    expect(oversizeResult.ok).toBe(false)
    expect(oversizeResult.error?.code).toBe('download_failed')
    const artifactDir = join(roots.artifactRoot, 'profile_download_edges', payload.session.id)
    expect(existsSync(artifactDir) ? await readdir(artifactDir) : []).toHaveLength(0)
    const quarantine = join(roots.browserRoot, 'user-data', 'profile_download_edges', 'ephemeral', payload.session.id, 'quarantine-downloads')
    expect(existsSync(quarantine) ? await readdir(quarantine) : []).toHaveLength(0)
    await broker.close()
  }, 180_000)
})

describe.skipIf(!chrome.ok)('image points in a frame from another site', () => {
  /** Opens a page of the cross-site fixture and observes it with a screenshot on demand. */
  const openFrames = async (profile: string, page: string) => {
    const site = await startCrossOriginFixtureSite()
    const { broker } = await createInProcessBroker({ chromeExtraArgs: ['--host-resolver-rules=MAP foo.test 127.0.0.1'] })
    const close = async () => { try { await broker.close() } finally { await site.close() } }
    try {
      const opened = await broker.call(workerRequest(profile, 'session.open', { url: `${site.parentOrigin}/${page}` }))
      expect(opened.ok, opened.error?.message).toBe(true)
      const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
      const observe = async (includeScreenshot = true) => {
        const observed = await broker.call(workerRequest(profile, 'observe', { sessionId: payload.session.id, tabId: payload.observation.tabId, includeScreenshot }))
        expect(observed.ok, JSON.stringify(observed.error)).toBe(true)
        return observed.result as BrowserObservation
      }
      const act = (observation: BrowserObservation, action: Record<string, unknown>, requestId: string) => broker.call(workerRequest(profile, 'act', actParams(payload.session, observation, action, requestId)))
      return { observe, act, close }
    } catch (error) {
      await close()
      throw error
    }
  }

  it('fills and clicks at image points near the top of a frame taller than the viewport', async () => {
    const frames = await openFrames('profile_tall_frame', 'frame-tall-parent.html')
    try {
      let observation = await frames.observe()
      // The frame's middle is below the viewport: the image point, not the middle, is where it is hit.
      const frame = observation.elements.find((element) => element.name === 'Tall form')
      expect(frame, observation.elements.map((element) => `${element.role}:${element.name}`).join(' | ')).toBeTruthy()
      expect(middleOf(frame!).y).toBeGreaterThan(observation.viewport.cssHeight)
      // From the fixtures, not the worker's bounds: the frame is at (200, 120); its input at (20, 20),
      // its button at (20, 80), each 240x32.
      const name = { x: 200 + 20 + 120, y: 120 + 20 + 16 }
      const save = { x: 200 + 20 + 120, y: 120 + 80 + 16 }
      const filled = await frames.act(observation, { type: 'fill', target: { kind: 'image-point', point: imagePointOf(observation, name) }, text: 'tall-value' }, 'tall_fill')
      expect(filled.ok, JSON.stringify(filled.error)).toBe(true)
      observation = await frames.observe()
      const clicked = await frames.act(observation, { type: 'click', target: { kind: 'image-point', point: imagePointOf(observation, save) } }, 'tall_click')
      expect(clicked.ok, JSON.stringify(clicked.error)).toBe(true)
      expect(JSON.stringify((clicked.result as BrowserActionResult).observation)).toContain('applicant-saved:tall-value')
    } finally {
      await frames.close()
    }
  }, 120_000)

  it('clicks in a frame drawn at twice its size at the control drawn under the point', async () => {
    const frames = await openFrames('profile_scaled_frame', 'frame-scaled-parent.html')
    try {
      const observation = await frames.observe()
      // From the fixture: "Left choice" is at (20, 20) to (80, 80) of a 300x200 frame drawn twice its size
      // at (100, 100), so its middle is at (200, 200) of the page. That point less the frame's origin,
      // (100, 100), would be on "Right choice".
      const clicked = await frames.act(observation, { type: 'click', target: { kind: 'image-point', point: imagePointOf(observation, { x: 200, y: 200 }) } }, 'scaled_click')
      expect(clicked.ok, JSON.stringify(clicked.error)).toBe(true)
      const after = JSON.stringify((clicked.result as BrowserActionResult).observation)
      expect(after).toContain('choice:left')
      expect(after).not.toContain('choice:right')
    } finally {
      await frames.close()
    }
  }, 120_000)

  it('fills and clicks in a frame from another site inside a frame from this site', async () => {
    const frames = await openFrames('profile_nested_frame', 'frame-nested-parent.html')
    try {
      // From the fixtures: the same-site frame is at (100, 100) of the page, the frame from another site
      // at (50, 50) of it, so its input (20, 20, 240x32) and button (20, 80, 240x32) are 150px further in.
      // The element is found in the outer frame's own process, then carried into the inner frame.
      const name = { x: 150 + 20 + 120, y: 150 + 20 + 16 }
      const save = { x: 150 + 20 + 120, y: 150 + 80 + 16 }
      let observation = await frames.observe()
      const filled = await frames.act(observation, { type: 'fill', target: { kind: 'image-point', point: imagePointOf(observation, name) }, text: 'nested-value' }, 'nested_fill')
      expect(filled.ok, JSON.stringify(filled.error)).toBe(true)
      observation = await frames.observe()
      const clicked = await frames.act(observation, { type: 'click', target: { kind: 'image-point', point: imagePointOf(observation, save) } }, 'nested_click')
      expect(clicked.ok, JSON.stringify(clicked.error)).toBe(true)
      expect(JSON.stringify((clicked.result as BrowserActionResult).observation)).toContain('applicant-saved:nested-value')
    } finally {
      await frames.close()
    }
  }, 120_000)

  it('a press on a frame drawn over another reaches the frame on top, never the one behind', async () => {
    const frames = await openFrames('profile_overlap_frames', 'frame-overlap-parent.html')
    try {
      // From the fixture: a frame from another site covers (100, 100) to (900, 500), its button most of it.
      // Over that button, a frame from another site at (200, 150) and one from this site at (550, 150),
      // each 250x150 with its own button over its top 100px. The same-site frame's button is found in
      // the page's own process and hit-tested at its own frame's point.
      let observation = await frames.observe()
      const cross = await frames.act(observation, { type: 'click', target: { kind: 'image-point', point: imagePointOf(observation, { x: 200 + 125, y: 150 + 50 }) } }, 'overlap_cross')
      expect(cross.ok, JSON.stringify(cross.error)).toBe(true)
      observation = await frames.observe()
      const same = await frames.act(observation, { type: 'click', target: { kind: 'image-point', point: imagePointOf(observation, { x: 550 + 125, y: 150 + 50 }) } }, 'overlap_same')
      expect(same.ok, JSON.stringify(same.error)).toBe(true)
      const after = JSON.stringify(await frames.observe(false))
      expect(after).toContain('overlay:cross-clicked')
      expect(after).toContain('overlay:same-clicked')
      // The frame behind both received no press or click.
      expect(after).toContain('covered:idle')
      expect(after).not.toContain('covered:touched')
    } finally {
      await frames.close()
    }
  }, 120_000)
})

describe.skipIf(!chrome.ok)('child-process broker IPC', () => {
  it('opens and closes a session through a bundled worker child', async () => {
    const site = await startFixtureSite()
    const outfile = (await productBuild()).browserWorker
    const empty = await mkdtemp(join(tmpdir(), 'mousse-broker-child-'))
    const broker = new BrowserBroker({
      profileRoot: join(empty, 'profiles'),
      browserRoot: MANAGED_BROWSER_ROOT,
      artifactRoot: join(empty, 'artifacts'),
      policy: createAllowHttpPolicy(),
      transport: 'child-process',
      workerModulePath: outfile
    })
    try {
      const capabilities = await broker.start()
      expect(capabilities.transport).toBe('remote-debugging-pipe')
      const opened = await broker.call(workerRequest('profile_child', 'session.open', { url: `${site.origin}/form.html` }))
      expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
      const payload = opened.result as { session: BrowserSessionRecord }
      const closed = await broker.call(workerRequest('profile_child', 'session.close', { sessionId: payload.session.id }))
      expect(closed.ok).toBe(true)
    } finally {
      try { await broker.close() } finally { await site.close() }
    }
  }, 180_000)

  it('recovers the same persistent workspace after a real worker crash without replay', async () => {
    const site = await startFixtureSite()
    const outfile = await sharedBuild({
      entryPoints: ['tests/fixtures/browser/held-response-worker.ts'],
      outfile: 'held-response-worker.mjs',
      bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent'
    })
    const empty = await mkdtemp(join(tmpdir(), 'mousse-broker-crash-'))
    const suffix = String(Date.now())
    const profileId = `profile_crash_recovery_${suffix}`
    const workspaceId = `workspace_submit_${suffix}`
    const broker = new BrowserBroker({
      profileRoot: join(empty, 'profiles'),
      browserRoot: MANAGED_BROWSER_ROOT,
      artifactRoot: join(empty, 'artifacts'),
      policy: createAllowHttpPolicy(),
      transport: 'child-process',
      workerModulePath: outfile
    })
    try {
      await broker.start()
      const opened = await broker.call(workerRequest(profileId, 'session.open', { persistent: true, workspaceId, url: `${site.origin}/submit-once.html` }))
      expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
      const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
      let submitObservation = payload.observation
      const submitDeadline = Date.now() + 10_000
      while (!submitObservation.elements.some((element) => element.name === 'Submit once') && Date.now() < submitDeadline) {
        const observed = await broker.call(workerRequest(profileId, 'observe', { sessionId: payload.session.id, tabId: payload.observation.tabId }))
        if (observed.ok) submitObservation = observed.result as BrowserObservation
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const submit = named(submitObservation, 'Submit once')
      const request = workerRequest(profileId, 'act', actParams(payload.session, submitObservation, {
        type: 'click', target: { kind: 'ref', ref: submit.ref }
      }, 'submit_once'))
      const pending = broker.call(request, { timeoutMs: 30_000 })
      const marker = join(empty, 'profiles', 'held-action-response.json')
      await Promise.race([
        expect.poll(() => existsSync(marker), { timeout: 10_000 }).toBe(true),
        pending.then((response) => { throw new Error(`Action settled before its response was held: ${JSON.stringify(response)}`) })
      ])
      const held = JSON.parse(await readFile(marker, 'utf8'))
      expect(held.response).toMatchObject({ id: request.id, ok: true, result: { requestId: 'submit_once', dispatched: true } })
      expect(site.submitCount()).toBe(1)
      const journal = (await readFile(journalPath(MANAGED_BROWSER_ROOT, profileId, payload.session.id), 'utf8'))
        .trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.requestId === 'submit_once')
      expect(journal.map((record) => record.phase)).toEqual(['intent', 'dispatched', 'outcome'])
      await expect.poll(async () => {
        const effect = await broker.call(workerRequest(profileId, 'observe', { sessionId: payload.session.id, tabId: payload.observation.tabId }))
        return effect.ok && JSON.stringify(effect.result).includes('submitted')
      }, { timeout: 5_000 }).toBe(true)
      const recordPath = processRecordPath(join(MANAGED_BROWSER_ROOT, 'user-data', profileId, 'workspaces', workspaceId))
      const processRecord = JSON.parse(await readFile(recordPath, 'utf8')) as { pid: number }
      expect(isProcessAlive(processRecord.pid)).toBe(true)
      const child = (broker as unknown as { child: ChildProcess }).child
      expect(child.pid).toBe(held.pid)
      const exited = once(child, 'exit')
      expect(child.kill('SIGKILL')).toBe(true)
      await exited
      expect(child.signalCode).toBe('SIGKILL')
      const crashed = await pending.catch((error: Error & { code?: string }) => error)
      expect(crashed.ok, JSON.stringify(crashed)).toBe(true)
      expect((crashed.result as BrowserActionResult).outcome).toBe('unknown-effect')
      expect((crashed.result as BrowserActionResult).code).toBe('worker_disconnected')
      const cleanupDeadline = Date.now() + 10_000
      while (isProcessAlive(processRecord.pid) && Date.now() < cleanupDeadline) await new Promise((resolve) => setTimeout(resolve, 100))
      expect(isProcessAlive(processRecord.pid)).toBe(false)
      const recovered = await broker.call(workerRequest(profileId, 'session.open', { persistent: true, workspaceId, url: `${site.origin}/submit-once.html` }))
      expect(recovered.ok).toBe(true)
      const recoveredPayload = recovered.result as { session: BrowserSessionRecord; observation: BrowserObservation }
      expect(recoveredPayload.session.generation).toBeGreaterThan(payload.session.generation)
      expect(existsSync(join(MANAGED_BROWSER_ROOT, 'user-data', profileId, 'workspaces', workspaceId))).toBe(true)
      expect(site.submitCount()).toBe(1)
      const staleLease = await broker.call(workerRequest(profileId, 'act', {
        ...actParams(recoveredPayload.session, recoveredPayload.observation, { type: 'navigate', url: `${site.origin}/cookies.html` }, 'stale_lease'),
        controlLeaseId: payload.session.controlLeaseId
      }))
      expect(staleLease.ok).toBe(false)
      expect(staleLease.error?.code).toBe('human_controlled')
      const staleRef = await broker.call(workerRequest(profileId, 'act', {
        ...actParams(recoveredPayload.session, recoveredPayload.observation, { type: 'click', target: { kind: 'ref', ref: submit.ref } }, 'stale_ref'),
        observationId: payload.observation.observationId
      }))
      expect(staleRef.ok).toBe(false)
      expect(['stale_observation', 'stale_ref']).toContain(staleRef.error?.code)
    } finally {
      try { await broker.close() } finally { await site.close() }
    }
  }, 180_000)
})

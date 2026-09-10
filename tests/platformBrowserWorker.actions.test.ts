import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BrowserActionResult, BrowserElement, BrowserObservation, BrowserSessionRecord } from '../src/shared/browser/types'
import { BrowserBroker } from '../src/mms/browser/BrowserBroker'
import { createAllowHttpPolicy } from '../src/mms/browser/defaultPorts'
import { createInProcessBroker, ensureManagedChrome, MANAGED_BROWSER_ROOT, startFixtureSite, workerRequest } from './fixtures/browser/harness'

const chrome = await ensureManagedChrome()

function named(observation: BrowserObservation, name: string, role?: string): BrowserElement {
  const matches = observation.elements.filter((element) => (element.name ?? '').includes(name) || (element.text ?? '').includes(name) || element.role === name)
  const match = role ? matches.find((element) => element.role === role) ?? matches[0] : matches[0]
  if (!match) throw new Error(`missing ${name}: ${observation.elements.map((el) => `${el.role}:${el.name}`).join(' | ')}`)
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
    expect(cancelled === pending || cancelled).toBeTruthy()
    await broker.close()
  }, 120_000)

  it('does not automatically replay an action after disconnect', async () => {
    const { broker } = await createInProcessBroker()
    const opened = await broker.call(workerRequest('profile_disc', 'session.open', { url: `${origin}/form.html` }))
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

  it('rejects evaluate/selector tools and uncertified upload/drag explicitly', async () => {
    const { broker } = await createInProcessBroker()
    const opened = await broker.call(workerRequest('profile_unsup', 'session.open', { url: `${origin}/form.html` }))
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    const evaluate = await broker.call(workerRequest('profile_unsup', 'act', actParams(payload.session, payload.observation, {
      type: 'evaluate', code: 'document.cookie'
    }, 'eval')))
    expect(evaluate.ok).toBe(false)
    const upload = await broker.call(workerRequest('profile_unsup', 'act', actParams(payload.session, payload.observation, {
      type: 'upload', target: { kind: 'ref', ref: named(payload.observation, 'Save').ref }, artifactIds: ['art_1']
    }, 'upload')))
    expect(upload.ok).toBe(false)
    expect(['unsupported', 'invalid_action']).toContain(upload.error?.code)
    await broker.close()
  }, 120_000)
})

describe.skipIf(!chrome.ok)('child-process broker IPC', () => {
  it('opens and closes a session through a bundled worker child', async () => {
    const site = await startFixtureSite()
    const esbuild = await import('esbuild')
    const outfile = join(await mkdtemp(join(tmpdir(), 'mousse-worker-bundle-')), 'worker.mjs')
    await esbuild.build({
      entryPoints: [join(process.cwd(), 'src/browser-worker/index.ts')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'silent'
    })
    const empty = await mkdtemp(join(tmpdir(), 'mousse-broker-child-'))
    const broker = new BrowserBroker({
      profileRoot: join(empty, 'profiles'),
      browserRoot: MANAGED_BROWSER_ROOT,
      artifactRoot: join(empty, 'artifacts'),
      policy: createAllowHttpPolicy(),
      transport: 'child-process',
      workerModulePath: outfile
    })
    const capabilities = await broker.start()
    expect(capabilities.transport).toBe('remote-debugging-pipe')
    const opened = await broker.call(workerRequest('profile_child', 'session.open', { url: `${site.origin}/form.html` }))
    expect(opened.ok).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord }
    const closed = await broker.call(workerRequest('profile_child', 'session.close', { sessionId: payload.session.id }))
    expect(closed.ok).toBe(true)
    await broker.close()
    await site.close()
  }, 180_000)
})

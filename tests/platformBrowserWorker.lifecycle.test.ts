import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BrowserObservation, BrowserSessionRecord } from '../src/shared/browser/types'
import { BrowserBroker } from '../src/mms/browser/BrowserBroker'
import { createAllowHttpPolicy } from '../src/mms/browser/defaultPorts'
import { createInProcessBroker, ensureManagedChrome, startFixtureSite, workerRequest } from './fixtures/browser/harness'

const chrome = await ensureManagedChrome()

describe('managed browser setup_required', () => {
  it('fails closed with setup_required when no certified binary exists', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'mousse-browser-empty-'))
    const broker = new BrowserBroker({
      profileRoot: join(empty, 'profiles'),
      browserRoot: join(empty, 'browser'),
      artifactRoot: join(empty, 'artifacts'),
      policy: createAllowHttpPolicy(),
      transport: 'in-process'
    })
    const capabilities = await broker.start()
    expect(capabilities.setupRequired).toBe(true)
    expect(capabilities.ready).toBe(false)
    const response = await broker.call(workerRequest('profile_empty', 'session.open', { url: 'http://127.0.0.1:1/' }))
    expect(response.ok).toBe(false)
    expect(response.error?.code).toBe('setup_required')
    await broker.close()
  })
})

describe.skipIf(!chrome.ok)('managed Chromium lifecycle', () => {
  let origin = ''
  let closeSite: () => Promise<void> = async () => undefined

  beforeAll(async () => {
    const site = await startFixtureSite()
    origin = site.origin
    closeSite = site.close
  }, 120_000)

  afterAll(async () => {
    await closeSite()
  })

  it('starts and closes a managed session without a renderer-owned process', async () => {
    const { broker, capabilities } = await createInProcessBroker()
    expect(capabilities.transport).toBe('remote-debugging-pipe')
    expect(capabilities.ready).toBe(true)
    const opened = await broker.call(workerRequest('profile_life', 'session.open', { url: `${origin}/form.html` }))
    expect(opened.ok).toBe(true)
    const payload = opened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
    expect(payload.session.backend).toBe('managed-chromium')
    expect(payload.session.generation).toBe(1)
    expect(payload.observation.provenance).toBe('untrusted-page')
    expect(payload.observation.url).toContain('/form.html')
    const closed = await broker.call(workerRequest('profile_life', 'session.close', { sessionId: payload.session.id }))
    expect(closed.ok).toBe(true)
    const again = await broker.call(workerRequest('profile_life', 'observe', { sessionId: payload.session.id, tabId: payload.observation.tabId }))
    expect(again.ok).toBe(false)
    expect(again.error?.code).toBe('session_closed')
    await broker.close()
  }, 120_000)

  it('isolates cookies across two profiles', async () => {
    const { broker } = await createInProcessBroker()
    const a = await broker.call(workerRequest('profile_alpha', 'session.open', { url: `${origin}/cookies.html?set=alpha` }))
    const b = await broker.call(workerRequest('profile_beta', 'session.open', { url: `${origin}/cookies.html` }))
    expect(a.ok && b.ok).toBe(true)
    const obsA = (a.result as { observation: BrowserObservation }).observation
    const obsB = (b.result as { observation: BrowserObservation }).observation
    const textA = `${obsA.title} ${obsA.elements.map((el) => `${el.name ?? ''} ${el.text ?? ''}`).join(' ')}`
    const textB = `${obsB.title} ${obsB.elements.map((el) => `${el.name ?? ''} ${el.text ?? ''}`).join(' ')}`
    expect(textA).toContain('mousse_fixture=alpha')
    expect(textB).not.toContain('mousse_fixture=alpha')
    expect(textB).toContain('empty')
    await broker.close()
  }, 120_000)

  it('enforces a persistent workspace single-writer lock', async () => {
    const first = await createInProcessBroker()
    const opened = await first.broker.call(workerRequest('profile_lock', 'session.open', { persistent: true, workspaceId: 'ws_shared', url: `${origin}/form.html` }))
    expect(opened.ok).toBe(true)
    const second = await createInProcessBroker()
    const conflict = await second.broker.call(workerRequest('profile_lock', 'session.open', { persistent: true, workspaceId: 'ws_shared', url: `${origin}/form.html` }))
    expect(conflict.ok).toBe(false)
    expect(conflict.error?.code).toBe('policy_denied')
    await second.broker.close()
    await first.broker.close()
  }, 120_000)
})

if (!chrome.ok) {
  describe('managed Chromium lifecycle blocker', () => {
    it('records the exact Chrome launch blocker without claiming B01/B02 qualification', () => {
      expect(chrome.ok).toBe(false)
      expect((chrome as { message: string }).message.length).toBeGreaterThan(0)
    })
  })
}

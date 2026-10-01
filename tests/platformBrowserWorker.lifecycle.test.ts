import { mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BrowserObservation, BrowserSessionRecord } from '../src/shared/browser/types'
import { BrowserBroker } from '../src/mms/browser/BrowserBroker'
import { createAllowHttpPolicy } from '../src/mms/browser/defaultPorts'
import { createInProcessBroker, ensureManagedChrome, startFixtureSite, workerRequest } from './fixtures/browser/harness'
import { chromeLaunchArgs } from '../src/browser-worker/cdp/launch'

const chrome = await ensureManagedChrome()

describe('managed browser setup_required', () => {
  it('keeps fixture DNS and profile overrides out of default Chromium arguments', () => {
    const base = { executablePath: 'chrome', userDataDir: 'C:\\isolated-browser-profile' }
    expect(chromeLaunchArgs(base).some((arg) => arg.startsWith('--host-resolver-rules'))).toBe(false)
    expect(chromeLaunchArgs({ ...base, extraArgs: ['--host-resolver-rules=MAP foo.test 127.0.0.1'] }))
      .toContain('--host-resolver-rules=MAP foo.test 127.0.0.1')
    expect(() => chromeLaunchArgs({ ...base, extraArgs: ['--user-data-dir=C:\\shared-profile'] })).toThrow(/profile or debugging isolation/)
  })

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

  it('shares concurrent startup and resets after a failed child initialization', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'mousse-browser-startup-'))
    const broker = new BrowserBroker({
      profileRoot: join(empty, 'profiles'),
      browserRoot: join(empty, 'browser'),
      artifactRoot: join(empty, 'artifacts'),
      policy: createAllowHttpPolicy(),
      transport: 'child-process',
      workerModulePath: join(empty, 'missing-worker.mjs')
    })
    const first = await Promise.allSettled([broker.start(), broker.start()])
    expect(first.every((result) => result.status === 'rejected'), JSON.stringify(first)).toBe(true)
    const retry = await broker.start().then(() => null, (error: Error & { code?: string }) => error)
    expect(retry).toBeInstanceOf(Error)
    expect((retry as Error & { code?: string }).code).toBe('setup_required')
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
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
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

  it('removes ephemeral user data only after owned Chrome exits and retains persistent workspace data for reopen', async () => {
    const ephemeral = await createInProcessBroker()
    const opened = await ephemeral.broker.call(workerRequest('profile_cleanup', 'session.open', { url: `${origin}/form.html` }))
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const session = (opened.result as { session: BrowserSessionRecord }).session
    const ephemeralDir = join(ephemeral.roots.browserRoot, 'user-data', 'profile_cleanup', 'ephemeral', session.id)
    expect(existsSync(ephemeralDir)).toBe(true)
    await ephemeral.broker.close()
    expect(existsSync(ephemeralDir)).toBe(false)

    const persistent = await createInProcessBroker()
    const first = await persistent.broker.call(workerRequest('profile_cleanup', 'session.open', { persistent: true, workspaceId: 'reopenable', url: `${origin}/form.html` }))
    expect(first.ok).toBe(true)
    const workspaceDir = join(persistent.roots.browserRoot, 'user-data', 'profile_cleanup', 'workspaces', 'reopenable')
    expect(existsSync(workspaceDir)).toBe(true)
    await persistent.broker.close()
    expect(existsSync(workspaceDir)).toBe(true)
    const reopened = await createInProcessBroker()
    const second = await reopened.broker.call(workerRequest('profile_cleanup', 'session.open', { persistent: true, workspaceId: 'reopenable' }))
    expect(second.ok).toBe(true)
    await reopened.broker.close()
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
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
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

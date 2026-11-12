/**
 * When a managed browser's navigation is done: once its page has committed and its document is
 * ready. Waiting longer for `load` is "still loading", never a failure; a site that does not answer
 * by the ceiling is still loading too. Chromium's own failures come back in their class with its
 * code in the details. The ceiling scales with how long this computer's navigations have taken.
 */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NavigationPace, navigateHistory, navigateTab } from '../src/browser-worker/action/dispatch'
import type { CdpTransport } from '../src/browser-worker/cdp/transport'

class NavigationTransport extends EventEmitter implements CdpTransport {
  connected = true
  navigate = vi.fn<() => Promise<unknown>>(() => Promise.resolve({ frameId: 'main', loaderId: 'new' }))
  sent: string[] = []
  async send<T>(method: string): Promise<T> {
    this.sent.push(method)
    return (method === 'Page.navigate' ? await this.navigate() : {}) as T
  }
  lifecycle(name: string, frameId = 'main', loaderId = 'new', sessionId = 'tab'): void {
    this.emit('Page.lifecycleEvent', { name, frameId, loaderId }, sessionId)
  }
  committed(frame: Record<string, unknown>, sessionId = 'tab'): void {
    this.emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'new', url: 'https://fixture.test/', ...frame } }, sessionId)
  }
  listeners(): number {
    return this.listenerCount('Page.lifecycleEvent') + this.listenerCount('Page.frameNavigated') + this.listenerCount('Page.navigatedWithinDocument')
  }
}
const flush = async () => { for (let n = 0; n < 5; n++) await Promise.resolve() }
const quick = { ceilingMs: 1_000, loadGraceMs: 100, pace: new NavigationPace() }
afterEach(() => vi.useRealTimers())

describe('a navigation is done when its page has committed and its document is ready', () => {
  it('waits for this navigation\'s own document, never a stale one, a child frame or another tab', async () => {
    const cdp = new NavigationTransport()
    let outcome: unknown
    const waiting = navigateTab(cdp, 'tab', 'https://fixture.test', quick).then((value) => { outcome = value })
    await flush()
    cdp.lifecycle('load', 'main', 'about-blank')
    cdp.lifecycle('DOMContentLoaded', 'child', 'new')
    cdp.lifecycle('load', 'main', 'new', 'other-tab')
    await flush()
    expect(outcome).toBeUndefined()
    cdp.lifecycle('DOMContentLoaded')
    cdp.lifecycle('load')
    await waiting
    expect(outcome).toEqual({ url: 'https://fixture.test/', state: 'ready' })
    expect(cdp.listeners()).toBe(0)
  })

  it('answers "still loading" when the document is ready and the page goes on loading, without failing', async () => {
    vi.useFakeTimers()
    const cdp = new NavigationTransport()
    const waiting = navigateTab(cdp, 'tab', 'https://fixture.test', quick)
    await flush()
    cdp.lifecycle('DOMContentLoaded')
    await vi.advanceTimersByTimeAsync(100)
    await expect(waiting).resolves.toEqual({ url: 'https://fixture.test/', state: 'loading' })
    expect(cdp.listeners()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('answers "still loading" when the site has not answered, or the document is not ready, by the ceiling', async () => {
    vi.useFakeTimers()
    const cdp = new NavigationTransport()
    cdp.navigate.mockImplementation(() => new Promise(() => undefined))
    const silent = navigateTab(cdp, 'tab', 'https://fixture.test', quick)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(silent).resolves.toEqual({ url: 'https://fixture.test/', state: 'loading' })
    cdp.navigate.mockResolvedValue({ frameId: 'main', loaderId: 'new' })
    const committedOnly = navigateTab(cdp, 'tab', 'https://fixture.test', quick)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(committedOnly).resolves.toEqual({ url: 'https://fixture.test/', state: 'loading' })
    expect(cdp.listeners()).toBe(0)
  })

  it('keeps a load that arrives before the navigate command answers', async () => {
    const cdp = new NavigationTransport()
    cdp.navigate.mockImplementation(async () => {
      cdp.lifecycle('load', 'main', 'old')
      cdp.lifecycle('DOMContentLoaded')
      cdp.lifecycle('load')
      return { frameId: 'main', loaderId: 'new' }
    })
    await expect(navigateTab(cdp, 'tab', 'https://fixture.test', quick)).resolves.toMatchObject({ state: 'ready' })
  })

  it('a same-document navigation and a download are done at once; a person\'s own navigation answers at the commit', async () => {
    const cdp = new NavigationTransport()
    cdp.navigate.mockResolvedValueOnce({ frameId: 'main' })
    await expect(navigateTab(cdp, 'tab', 'https://fixture.test/#hash', quick)).resolves.toMatchObject({ state: 'ready' })
    cdp.navigate.mockResolvedValueOnce({ frameId: 'main', loaderId: 'dl', errorText: 'net::ERR_ABORTED' })
    await expect(navigateTab(cdp, 'tab', 'https://fixture.test/file.zip', quick)).resolves.toMatchObject({ state: 'ready' })
    await expect(navigateTab(cdp, 'tab', 'https://fixture.test', { ...quick, untilCommit: true })).resolves.toEqual({ url: 'https://fixture.test/', state: 'loading' })
  })

  it('cancels an in-flight navigation and leaves no listener or timer', async () => {
    vi.useFakeTimers()
    const cdp = new NavigationTransport()
    const abort = new AbortController()
    const waiting = expect(navigateTab(cdp, 'tab', 'https://fixture.test', { ...quick, signal: abort.signal })).rejects.toMatchObject({ code: 'cancelled' })
    await flush()
    abort.abort()
    await waiting
    expect(cdp.listeners()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('a failed navigation comes back in its class', () => {
  it.each([
    ['net::ERR_NAME_NOT_RESOLVED', 'site_unreachable', 'unreachable'],
    ['net::ERR_CONNECTION_REFUSED', 'site_unreachable', 'unreachable'],
    ['net::ERR_INTERNET_DISCONNECTED', 'site_unreachable', 'unreachable'],
    ['net::ERR_CERT_AUTHORITY_INVALID', 'site_unreachable', 'unreachable'],
    ['net::ERR_TIMED_OUT', 'site_unreachable', 'unreachable'],
    ['net::ERR_TOO_MANY_REDIRECTS', 'site_unreachable', 'unreachable'],
    ['net::ERR_BLOCKED_BY_CLIENT', 'site_blocked', 'blocked'],
    ['net::ERR_BLOCKED_BY_RESPONSE', 'site_blocked', 'blocked'],
    ['net::ERR_UNSAFE_PORT', 'site_blocked', 'blocked']
  ])('%s is %s, with Chromium\'s code kept for details', async (errorText, code, kind) => {
    const cdp = new NavigationTransport()
    cdp.navigate.mockResolvedValueOnce({ frameId: 'main', loaderId: 'x', errorText })
    const failed = await navigateTab(cdp, 'tab', 'https://www.fixture.test/a', quick).catch((error: unknown) => error)
    expect(failed).toMatchObject({ code, problem: { kind, code: errorText, host: 'fixture.test' } })
    expect((failed as Error).message).toContain(errorText)
    expect(cdp.listeners()).toBe(0)
  })

  it('reads what an opened page needs: a sign-in, a human check, or a refusal (the page did open)', async () => {
    const cdp = new NavigationTransport()
    const open = async (signs: Record<string, unknown>) => {
      const waiting = navigateTab(cdp, 'tab', 'https://fixture.test/account', { ...quick, signs: async () => signs })
      await flush()
      cdp.lifecycle('DOMContentLoaded')
      cdp.lifecycle('load')
      return waiting
    }
    expect(await open({ status: 401 })).toMatchObject({ state: 'ready', problem: { kind: 'needs-you', reason: 'sign-in', code: 'HTTP 401' } })
    expect(await open({ status: 200, password: true, title: 'Sign in' })).toMatchObject({ problem: { kind: 'needs-you', reason: 'sign-in' } })
    expect(await open({ status: 503, title: 'Just a moment...' })).toMatchObject({ problem: { kind: 'needs-you', reason: 'human-check' } })
    expect(await open({ status: 200, humanCheck: true })).toMatchObject({ problem: { kind: 'needs-you', reason: 'human-check' } })
    expect(await open({ status: 200, consent: true })).toMatchObject({ problem: { kind: 'needs-you', reason: 'consent' } })
    expect(await open({ status: 403 })).toMatchObject({ state: 'ready', problem: { kind: 'blocked', code: 'HTTP 403' } })
    expect(await open({ status: 429 })).toMatchObject({ problem: { kind: 'blocked' } })
    expect(await open({ status: 200, title: 'Welcome' })).toEqual({ url: 'https://fixture.test/account', state: 'ready' })
  })
})

describe('back, forward and reload', () => {
  it('follow the next commit of the main frame to a ready document', async () => {
    const cdp = new NavigationTransport()
    const waiting = navigateHistory(cdp, 'tab', 'reload', 'https://fixture.test/', quick)
    await flush()
    expect(cdp.sent).toContain('Page.reload')
    cdp.committed({ id: 'child', parentId: 'main' })
    cdp.committed({})
    cdp.lifecycle('DOMContentLoaded')
    cdp.lifecycle('load')
    await expect(waiting).resolves.toEqual({ url: 'https://fixture.test/', state: 'ready' })
    expect(cdp.listeners()).toBe(0)
  })

  it('a page that could not be loaded is a site that can\'t be reached; a same-document step is done at once', async () => {
    const cdp = new NavigationTransport()
    const failing = navigateHistory(cdp, 'tab', 'reload', 'https://fixture.test/', quick).catch((error: unknown) => error)
    await flush()
    cdp.committed({ url: 'chrome-error://chromewebdata/', unreachableUrl: 'https://fixture.test/' })
    expect(await failing).toMatchObject({ code: 'site_unreachable', problem: { kind: 'unreachable', host: 'fixture.test' } })
    const within = navigateHistory(cdp, 'tab', 'reload', 'https://fixture.test/', quick)
    await flush()
    cdp.emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'https://fixture.test/#b' }, 'tab')
    await expect(within).resolves.toEqual({ url: 'https://fixture.test/#b', state: 'ready' })
  })
})

describe('the ceiling a navigation waits for its page', () => {
  it('is 15 s until there are recent navigations, then four times their median, between 10 and 45 s', () => {
    const pace = new NavigationPace()
    expect(pace.ceilingMs()).toBe(15_000)
    for (let index = 0; index < 4; index += 1) pace.record(6_000)
    expect(pace.ceilingMs()).toBe(15_000)
    pace.record(6_000)
    expect(pace.ceilingMs()).toBe(24_000)
    for (let index = 0; index < 20; index += 1) pace.record(500)
    expect(pace.ceilingMs()).toBe(10_000)
    for (let index = 0; index < 20; index += 1) pace.record(30_000)
    expect(pace.ceilingMs()).toBe(45_000)
  })

  it('learns from each navigation that reached a ready document', async () => {
    const cdp = new NavigationTransport()
    const pace = new NavigationPace()
    const record = vi.spyOn(pace, 'record')
    const waiting = navigateTab(cdp, 'tab', 'https://fixture.test', { ...quick, pace })
    await flush()
    cdp.lifecycle('DOMContentLoaded')
    cdp.lifecycle('load')
    await waiting
    expect(record).toHaveBeenCalledTimes(1)
  })
})

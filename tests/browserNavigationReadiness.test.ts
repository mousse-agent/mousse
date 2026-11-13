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
import { browserNoteForAgent, browserProblemForAgent } from '../src/shared/browser/navigation'

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
/** Lets the navigation set itself up (its main frame, the site's answers) and start, as Chromium answers each step. */
const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve() }
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

  it('a same-document navigation is done at once; a person\'s own navigation answers at the commit', async () => {
    const cdp = new NavigationTransport()
    cdp.navigate.mockResolvedValueOnce({ frameId: 'main' })
    await expect(navigateTab(cdp, 'tab', 'https://fixture.test/#hash', quick)).resolves.toMatchObject({ state: 'ready' })
    await expect(navigateTab(cdp, 'tab', 'https://fixture.test', { ...quick, untilCommit: true })).resolves.toEqual({ url: 'https://fixture.test/', state: 'loading' })
  })

  it('a download says so with its name, and a navigation another replaced says where the tab really is', async () => {
    const cdp = new NavigationTransport()
    let where = 'https://fixture.test/before'
    const send = cdp.send.bind(cdp)
    cdp.send = (async <T>(method: string) => method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main', url: where } } } as T : send<T>(method)) as typeof cdp.send
    // Chromium drops the navigation and starts a download instead: the tab stays where it was.
    cdp.navigate.mockImplementationOnce(async () => {
      setTimeout(() => cdp.emit('Page.downloadWillBegin', { frameId: 'main', suggestedFilename: 'report.csv' }, 'tab'), 20)
      return { frameId: 'main', loaderId: 'dl', errorText: 'net::ERR_ABORTED' }
    })
    await expect(navigateTab(cdp, 'tab', 'https://fixture.test/report.csv', quick)).resolves.toEqual({ url: 'https://fixture.test/before', state: 'ready', download: { name: 'report.csv' } })
    // Another navigation replaced it: never "ready at the address asked for".
    where = 'https://fixture.test/elsewhere'
    cdp.navigate.mockResolvedValueOnce({ frameId: 'main', loaderId: 'x', errorText: 'net::ERR_ABORTED' })
    await expect(navigateTab(cdp, 'tab', 'https://fixture.test/asked', quick)).resolves.toMatchObject({ url: 'https://fixture.test/elsewhere', replaced: { asked: 'https://fixture.test/asked' } })
    expect(cdp.listeners()).toBe(0)
  })

  it('keeps the main frame\'s own events however many frames the page has', async () => {
    const cdp = new NavigationTransport()
    const send = cdp.send.bind(cdp)
    cdp.send = (async <T>(method: string) => method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main', url: 'about:blank' } } } as T : send<T>(method)) as typeof cdp.send
    let outcome: unknown
    const waiting = navigateTab(cdp, 'tab', 'https://fixture.test', quick).then((value) => { outcome = value })
    await flush()
    // A page of 300 frames, each with its own events, before the main frame's.
    for (let frame = 0; frame < 300; frame += 1) {
      for (const name of ['init', 'DOMContentLoaded', 'load']) cdp.lifecycle(name, `child-${frame}`, `loader-${frame}`)
    }
    cdp.lifecycle('DOMContentLoaded')
    cdp.lifecycle('load')
    await waiting
    expect(outcome).toEqual({ url: 'https://fixture.test/', state: 'ready' })
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
    ['net::ERR_TIMED_OUT', 'site_unreachable', 'unreachable'],
    ['net::ERR_TOO_MANY_REDIRECTS', 'site_unreachable', 'unreachable'],
    ['net::ERR_BLOCKED_BY_RESPONSE', 'site_blocked', 'blocked'],
    ['net::ERR_UNSAFE_PORT', 'browser_refused', 'browser-refused'],
    ['net::ERR_BLOCKED_BY_CLIENT', 'browser_refused', 'browser-refused'],
    ['net::ERR_NETWORK_ACCESS_DENIED', 'browser_refused', 'browser-refused'],
    ['net::ERR_CERT_AUTHORITY_INVALID', 'browser_refused', 'browser-refused']
  ])('%s is %s, with Chromium\'s code kept for details', async (errorText, code, kind) => {
    const cdp = new NavigationTransport()
    cdp.navigate.mockResolvedValueOnce({ frameId: 'main', loaderId: 'x', errorText })
    const failed = await navigateTab(cdp, 'tab', 'https://www.fixture.test/a', quick).catch((error: unknown) => error)
    expect(failed).toMatchObject({ code, problem: { kind, code: errorText, host: 'fixture.test' } })
    expect((failed as Error).message).toContain(errorText)
    expect(cdp.listeners()).toBe(0)
  })

  it('says truly what the browser refused: an unsafe port, its own rules, an untrusted certificate (never offering to get around it)', () => {
    const lines = (code: string) => browserProblemForAgent({ kind: 'browser-refused', reason: code === 'net::ERR_UNSAFE_PORT' ? 'unsafe-port' : code.startsWith('net::ERR_CERT') ? 'certificate' : 'browser-rules', code, host: 'fixture.test' })
    expect(lines('net::ERR_UNSAFE_PORT')).toMatch(/^This browser won't open that address: its port is one browsers refuse \(net::ERR_UNSAFE_PORT\)/)
    expect(lines('net::ERR_BLOCKED_BY_CLIENT')).toMatch(/^This browser's own rules refuse that address/)
    expect(lines('net::ERR_CERT_AUTHORITY_INVALID')).toMatch(/^fixture\.test's certificate is not trusted \(net::ERR_CERT_AUTHORITY_INVALID\), so this browser won't open it\. Check the address; don't try to get around it/)
    for (const code of ['net::ERR_UNSAFE_PORT', 'net::ERR_BLOCKED_BY_CLIENT', 'net::ERR_CERT_AUTHORITY_INVALID']) expect(lines(code)).not.toMatch(/blocked this browser|try again later|proceed|bypass|ignore/i)
  })

  it('an error status with no page: 401 a sign-in, 403 a refusal, 429 a wait, 404 and 5xx a page the tab shows', async () => {
    const cdp = new NavigationTransport()
    const answered = async (status: number, headers: Record<string, string> = {}) => {
      cdp.navigate.mockImplementationOnce(async () => {
        cdp.emit('Network.responseReceived', { type: 'Document', frameId: 'main', loaderId: `l${status}`, response: { status, headers } }, 'tab')
        return { frameId: 'main', loaderId: `l${status}`, errorText: 'net::ERR_HTTP_RESPONSE_CODE_FAILURE' }
      })
      return navigateTab(cdp, 'tab', 'https://fixture.test/x', quick).catch((error: unknown) => error)
    }
    expect(await answered(403)).toMatchObject({ code: 'site_blocked', problem: { kind: 'blocked', code: 'HTTP 403' } })
    expect(await answered(401)).toMatchObject({ code: 'needs_person', problem: { kind: 'needs-you', reason: 'sign-in', code: 'HTTP 401' } })
    expect(await answered(429, { 'Retry-After': '30' })).toEqual({ url: 'https://fixture.test/x', state: 'ready', notes: [{ kind: 'http-status', status: 429, retryAfterSeconds: 30 }] })
    expect(await answered(404)).toEqual({ url: 'https://fixture.test/x', state: 'ready', notes: [{ kind: 'http-status', status: 404 }] })
    expect(await answered(503)).toMatchObject({ state: 'ready', notes: [{ kind: 'http-status', status: 503 }] })
    expect(browserNoteForAgent({ kind: 'http-status', status: 429, retryAfterSeconds: 30 })).toBe('The site asked to slow down (HTTP 429): wait 30 s before loading it again.')
    expect(browserNoteForAgent({ kind: 'http-status', status: 404 })).toMatch(/^The page was not found \(HTTP 404\)\. It is open and can be read/)
    expect(browserNoteForAgent({ kind: 'http-status', status: 500 })).toMatch(/^The site had an error \(HTTP 500\)\. The page is open and can be read/)
  })

  it('a page that opened is a failure only when it is nothing but a check or a wall; else notes, never an order to stop', async () => {
    const cdp = new NavigationTransport()
    const open = async (signs: Record<string, unknown>) => {
      const waiting = navigateTab(cdp, 'tab', 'https://fixture.test/account', { ...quick, signs: async () => signs })
      await flush()
      cdp.lifecycle('DOMContentLoaded')
      cdp.lifecycle('load')
      return waiting
    }
    expect(await open({ status: 200, humanCheck: 'page' })).toMatchObject({ state: 'failed', problem: { kind: 'needs-you', reason: 'human-check' } })
    expect(await open({ status: 200, consent: 'wall' })).toMatchObject({ state: 'failed', problem: { kind: 'needs-you', reason: 'consent' } })
    expect(await open({ status: 403 })).toMatchObject({ state: 'failed', problem: { kind: 'blocked', code: 'HTTP 403' } })
    expect(await open({ status: 401 })).toMatchObject({ state: 'failed', problem: { kind: 'needs-you', reason: 'sign-in' } })
    expect(await open({ status: 401, signInForm: true })).toEqual({ url: 'https://fixture.test/account', state: 'ready', notes: [{ kind: 'sign-in-form' }] })
    expect(await open({ status: 200, signInForm: true, title: 'Sign in' })).toEqual({ url: 'https://fixture.test/account', state: 'ready', notes: [{ kind: 'sign-in-form' }] })
    expect(await open({ status: 200, humanCheck: 'part' })).toMatchObject({ state: 'ready', notes: [{ kind: 'human-check' }] })
    expect(await open({ status: 200, consent: 'banner' })).toMatchObject({ state: 'ready', notes: [{ kind: 'cookie-banner' }] })
    expect(await open({ status: 429 })).toMatchObject({ state: 'ready', notes: [{ kind: 'http-status', status: 429 }] })
    // What a page controls alone (its title, its classes) decides nothing.
    expect(await open({ status: 200, title: 'Just a moment...' })).toEqual({ url: 'https://fixture.test/account', state: 'ready' })
    expect(await open({ status: 200, title: 'Welcome' })).toEqual({ url: 'https://fixture.test/account', state: 'ready' })
    // The notes' words: what to deal with, or whom to ask; never "don't retry" or "stop".
    for (const note of [{ kind: 'sign-in-form' }, { kind: 'cookie-banner' }, { kind: 'human-check' }] as const) {
      for (const reader of ['agent', 'bot'] as const) expect(browserNoteForAgent(note, reader)).not.toMatch(/don't retry|stop|work around/i)
    }
    expect(browserNoteForAgent({ kind: 'sign-in-form' }, 'agent')).toMatch(/Fill it if you have what it needs/)
    expect(browserNoteForAgent({ kind: 'sign-in-form' }, 'bot')).toMatch(/ask your owner to sign in/)
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

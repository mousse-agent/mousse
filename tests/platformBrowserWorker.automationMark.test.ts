/**
 * What sites see of who drives the managed browser, on real Chromium. A page reads
 * `navigator.webdriver` as false only while a person holds the browser and drives it; anything the
 * agent loads or drives reads true from its first script, on every page, frame and popup, and when
 * the worker cannot be sure, the answer is true. A tab sees only its own frames.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BrowserActionResult, BrowserElement, BrowserObservation, BrowserSessionRecord, BrowserTab } from '../src/shared/browser/types'
import { createInProcessBroker, ensureManagedChrome, MANAGED_BROWSER_ROOT, startCrossOriginFixtureSite, workerRequest } from './fixtures/browser/harness'
import { launchManagedChrome, windowedChromeUserAgent } from '../src/browser-worker/cdp/launch'
import { resolveCertifiedBrowser } from '../src/browser-worker/binary/resolver'

const chrome = await ensureManagedChrome()
const PROFILE = 'profile_mark'

function named(observation: BrowserObservation, name: string): BrowserElement {
  const match = observation.elements.find((element) => (element.name ?? '').includes(name) || (element.text ?? '').includes(name))
  if (!match) throw new Error(`missing ${name}: ${observation.elements.map((el) => `${el.role}:${el.name}`).join(' | ')}`)
  return match
}

function textOf(observation: BrowserObservation): string {
  return observation.elements.map((element) => `${element.name ?? ''} ${element.text ?? ''}`).join(' ')
}

async function markFixture() {
  const site = await startCrossOriginFixtureSite()
  // foo.test is the frames' other site; missing.test never resolves.
  const { broker } = await createInProcessBroker({ chromeExtraArgs: ['--host-resolver-rules=MAP foo.test 127.0.0.1, MAP missing.test ~NOTFOUND'] })
  const call = (method: Parameters<typeof workerRequest>[1], params: Record<string, unknown>) => broker.call(workerRequest(PROFILE, method, params))
  const ok = async <T>(method: Parameters<typeof workerRequest>[1], params: Record<string, unknown>): Promise<T> => {
    const result = await call(method, params)
    expect(result.ok, `${method}: ${JSON.stringify(result.error)}`).toBe(true)
    return result.result as T
  }
  /** A fixture page that reports what its first script reads under `name`; `options` add frames, popups and the rest. */
  const page = (name: string, options: Record<string, string> = {}, origin = site.parentOrigin) =>
    `${origin}/automation-page.html?${new URLSearchParams({ name, ...options }).toString()}`
  const open = (url: string) => ok<{ session: BrowserSessionRecord; observation: BrowserObservation }>('session.open', { url })
  /** A person's click, made on a picture of the tab (it names where that picture was taken, as a view's click does). */
  const personClick = async (session: BrowserSessionRecord, controlLeaseId: string, tabId: string, x: number, y: number) => {
    const { spot } = await ok<{ spot?: unknown }>('frame', { sessionId: session.id, tabId })
    const { results } = await ok<{ results: Array<{ applied: boolean }> }>('human.input', { sessionId: session.id, controlLeaseId, tabId, inputs: [{ input: { kind: 'click', x, y }, spot }] })
    expect(results[0]).toMatchObject({ applied: true })
  }
  const observe = (session: BrowserSessionRecord, tabId: string) => ok<BrowserObservation>('observe', { sessionId: session.id, tabId })
  /** Waits until the tab's page and frames show every value (they print what they read on a timer). */
  const shows = async (session: BrowserSessionRecord, tabId: string, expected: string[]): Promise<BrowserObservation> => {
    let seen: BrowserObservation | undefined
    for (let attempt = 0; attempt < 60; attempt += 1) {
      seen = await observe(session, tabId)
      if (expected.every((value) => textOf(seen!).includes(value))) return seen
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(textOf(seen!)).toEqual(expect.stringContaining(expected.find((value) => !textOf(seen!).includes(value))!))
    return seen!
  }
  /** What pages reported under `key`, waiting until there are `count` of them. */
  const reported = async (key: string, count = 1, timeoutMs = 8_000): Promise<string[]> => {
    await expect.poll(() => site.reports.filter((report) => report.key === key).length, { timeout: timeoutMs, interval: 50 }).toBeGreaterThanOrEqual(count)
    return site.reports.filter((report) => report.key === key).map((report) => report.value)
  }
  const take = (session: BrowserSessionRecord) => ok<{ controlLeaseId: string; generation: number }>('control.take', { sessionId: session.id, owner: 'human' })
  const giveBack = (session: BrowserSessionRecord) => ok<{ controlLeaseId: string; generation: number }>('control.take', { sessionId: session.id, owner: 'agent' })
  const close = async () => {
    await broker.close()
    await site.close()
  }
  return { site, call, ok, page, open, observe, shows, reported, take, giveBack, close, personClick }
}

function act(session: BrowserSessionRecord, observation: BrowserObservation, action: Record<string, unknown>, lease: { controlLeaseId?: string; generation: number } = session) {
  return {
    requestId: 'req_' + Math.random().toString(36).slice(2),
    sessionId: session.id,
    tabId: observation.tabId,
    generation: observation.generation ?? lease.generation,
    observationId: observation.observationId,
    controlLeaseId: lease.controlLeaseId,
    timeoutMs: 10_000,
    action
  }
}

describe.skipIf(!chrome.ok)('what pages see of who drives the browser', () => {
  it('reads as automated on every page, frame and opened page while the agent drives, and not while a person holds it', async () => {
    const { site, ok, open, shows, take, close } = await markFixture()
    try {
      const { session, observation } = await open(`${site.parentOrigin}/automation-parent.html`)
      // The agent drives: the page and the frame from another site read true from their first script.
      // The browser names itself as the Chrome it is, and a page's worker still runs.
      await shows(session, observation.tabId, ['top-first:true', 'top-now:true', 'child-first:true', 'child-now:true', 'identity:chrome', 'worker:ran'])
      const before = await ok<BrowserObservation>('observe', { sessionId: session.id, tabId: observation.tabId })
      await ok('act', act(session, before, { type: 'click', target: { kind: 'ref', ref: named(before, 'Open popup').ref } }))
      await shows(session, observation.tabId, ['popup:true'])
      // A tab the agent opens on a page: the same from that page's first script, frames included.
      const tab = await ok<BrowserTab>('tabs.new', { sessionId: session.id, url: `${site.parentOrigin}/automation-parent.html` })
      await shows(session, tab.id, ['top-first:true', 'child-first:true', 'identity:chrome'])

      // A person holds the browser: the same documents now read false.
      const taken = await take(session)
      await shows(session, observation.tabId, ['top-now:false', 'child-now:false'])

      // Given back: true again.
      await ok('control.release', { sessionId: session.id, controlLeaseId: taken.controlLeaseId })
      await shows(session, observation.tabId, ['top-now:true', 'child-now:true'])
    } finally {
      await close()
    }
  }, 120_000)

  it('keeps each tab to its own frames from other sites, when every tab has some', async () => {
    const { site, ok, page, open, shows, observe, close } = await markFixture()
    try {
      // Tab A has a frame from another site and two of its own site (which run in the page and are no targets).
      const { session, observation: a } = await open(page('tab-a', { sameSite: '2', frame: page('frame-a', {}, site.childOrigin) }))
      const b = await ok<BrowserTab>('tabs.new', { sessionId: session.id, url: page('tab-b', { frame: page('frame-b', {}, site.childOrigin) }) })
      await shows(session, a.tabId, ['frame-a-first:true'])
      await shows(session, b.id, ['frame-b-first:true'])
      // Each tab's observation holds its own frame alone, whichever is asked first and however often.
      for (let round = 0; round < 3; round += 1) {
        const seenA = textOf(await observe(session, a.tabId))
        const seenB = textOf(await observe(session, b.id))
        expect(seenA).toContain('frame-a-first:true')
        expect(seenA).not.toContain('frame-b')
        expect(seenB).toContain('frame-b-first:true')
        expect(seenB).not.toContain('frame-a')
      }
      // An action on tab A reaches tab A's frame only: B's frame refs are not A's.
      const observedA = await observe(session, a.tabId)
      expect(observedA.elements.some((element) => (element.text ?? element.name ?? '').includes('frame-b'))).toBe(false)
    } finally {
      await close()
    }
  }, 120_000)

  it('marks frames inside frames from their first script, and they belong to their tab', async () => {
    const { site, page, open, shows, take, giveBack, reported, close } = await markFixture()
    try {
      // The top page (this site) holds a frame from another site, which holds a frame from this site again.
      const grandchild = page('nested-grandchild', {}, site.parentOrigin)
      const { session, observation } = await open(page('nested-top', { frame: page('nested-child', { frame: grandchild }, site.childOrigin) }))
      expect(await reported('nested-top')).toEqual(['true'])
      expect(await reported('nested-child')).toEqual(['true'])
      expect(await reported('nested-grandchild')).toEqual(['true'])
      await shows(session, observation.tabId, ['nested-child-first:true', 'nested-grandchild-first:true', 'nested-grandchild-now:true'])
      await take(session)
      await shows(session, observation.tabId, ['nested-top-now:false', 'nested-child-now:false', 'nested-grandchild-now:false'])
      await giveBack(session)
      await shows(session, observation.tabId, ['nested-top-now:true', 'nested-child-now:true', 'nested-grandchild-now:true'])
    } finally {
      await close()
    }
  }, 120_000)

  it('marks a page a site opens without an opener, and its frames, from their first script, at once', async () => {
    const { site, ok, page, open, observe, reported, close } = await markFixture()
    try {
      const popup = page('lone-popup', { frame: page('lone-popup-frame', {}, site.childOrigin) })
      const { session, observation } = await open(page('opener', { popup }))
      const click = async (label: string) => {
        const seen = await observe(session, observation.tabId)
        const started = Date.now()
        await ok('act', act(session, seen, { type: 'click', target: { kind: 'ref', ref: named(seen, label).ref } }))
        return started
      }
      // window.open with noopener: Chromium gives the page no renderer until it runs, so its mark
      // lands only then; it still reads true from its first script, and it opens at once.
      let started = await click('Open without opener')
      expect(await reported('lone-popup')).toEqual(['true'])
      expect(await reported('lone-popup-frame')).toEqual(['true'])
      expect(site.reports.find((report) => report.key === 'lone-popup')!.at - started).toBeLessThan(5_000)
      // A link with target=_blank and rel=noopener: the same. (Chromium itself takes about five seconds
      // to open a window from a link clicked through CDP, held or not.)
      started = await click('Open link')
      expect(await reported('lone-popup', 2, 12_000)).toEqual(['true', 'true'])
      expect(await reported('lone-popup-frame', 2)).toEqual(['true', 'true'])
      expect(site.reports.filter((report) => report.key === 'lone-popup')[1]!.at - started).toBeLessThan(9_000)
      // A blank page read at once by the page that opened it: the opener waits until it is marked.
      await click('Open blank')
      expect(await reported('opener-blank-at-once')).toEqual(['true'])
    } finally {
      await close()
    }
  }, 120_000)

  it('lets the agent open and load nothing while a person holds the browser, and marks what the person opens as theirs', async () => {
    const { site, call, ok, page, open, observe, shows, take, giveBack, reported, close, personClick } = await markFixture()
    try {
      const { session, observation } = await open(page('held', { popup: page('person-popup', { beacon: '1' }) }))
      const lease = await take(session)
      // The agent asks for a tab on a page: refused, no tab, and the site never sees the request.
      const refused = await call('tabs.new', { sessionId: session.id, url: page('agent-during-hold') })
      expect(refused.ok).toBe(false)
      expect(refused.error?.code).toBe('human_controlled')
      expect((await ok<{ tabs: BrowserTab[] }>('tabs.list', { sessionId: session.id })).tabs).toHaveLength(1)
      // The agent's actions are refused too; reading the page is not.
      const seen = await observe(session, observation.tabId)
      const navigate = await call('act', act(session, seen, { type: 'navigate', url: page('agent-navigates-during-hold') }, lease))
      expect(navigate.ok).toBe(false)
      expect(navigate.error?.code).toBe('human_controlled')
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(site.requests.some((request) => request.path.includes('during-hold'))).toBe(false)

      // The person opens a page from theirs: it is theirs, and reads false from its first script.
      const button = named(seen, 'Open popup').bounds!
      await personClick(session, lease.controlLeaseId, observation.tabId, button.x + button.width / 2, button.y + button.height / 2)
      expect(await reported('person-popup')).toEqual(['false'])
      // Given back, the agent has it: that page reads true now, and the agent's new tab opens as before.
      await giveBack(session)
      const reportsAtGiveBack = site.reports.length
      await expect.poll(() => site.reports.slice(reportsAtGiveBack).filter((report) => report.key === 'person-popup-now').map((report) => report.value).at(-1), { timeout: 5_000 }).toBe('true')
      const tab = await ok<BrowserTab>('tabs.new', { sessionId: session.id, url: page('agent-after-hold') })
      expect(await reported('agent-after-hold')).toEqual(['true'])
      await shows(session, tab.id, ['agent-after-hold-now:true'])
    } finally {
      await close()
    }
  }, 120_000)

  it('stops an agent action still loading a page when a person takes over: that page never opens for them', async () => {
    const { site, call, page, open, observe, take, close } = await markFixture()
    try {
      const { session, observation } = await open(page('before-take'))
      const seen = await observe(session, observation.tabId)
      // The agent goes to a page the site answers slowly; a person takes over meanwhile.
      const acting = call('act', act(session, seen, { type: 'navigate', url: page('slow-for-agent', { delayMs: '3000' }) }))
      await expect.poll(() => site.requests.some((request) => request.path.includes('slow-for-agent')), { timeout: 5_000, interval: 20 }).toBe(true)
      const startedTake = Date.now()
      await take(session)
      expect(Date.now() - startedTake).toBeLessThan(2_500)
      // The action ends without its effect, and nothing the agent sends lands after the person holds it.
      const ended = await acting
      if (ended.ok) expect((ended.result as BrowserActionResult).outcome).not.toBe('verified')
      await new Promise((resolve) => setTimeout(resolve, 4_000))
      expect(site.reports.some((report) => report.key === 'slow-for-agent')).toBe(false)
      expect((await observe(session, observation.tabId)).url).toContain('name=before-take')
    } finally {
      await close()
    }
  }, 120_000)

  it('takes over and gives back at once with a dialog left open, and closes a page that cannot take its mark back', async () => {
    const { site, ok, page, open, take, giveBack, close } = await markFixture()
    try {
      const { session } = await open(page('steady'))
      const dialogTab = await ok<BrowserTab>('tabs.new', { sessionId: session.id, url: page('left-open', { alert: '1' }) })
      await new Promise((resolve) => setTimeout(resolve, 800))
      let started = Date.now()
      await take(session)
      expect(Date.now() - started).toBeLessThan(4_000)
      started = Date.now()
      await giveBack(session)
      expect(Date.now() - started).toBeLessThan(8_000)
      // The page behind the dialog could not read true again, so it is gone rather than left reading false.
      await expect.poll(async () => (await ok<{ tabs: BrowserTab[] }>('tabs.list', { sessionId: session.id })).tabs.map((tab) => tab.id), { timeout: 3_000 }).not.toContain(dialogTab.id)
      expect((await ok<{ tabs: BrowserTab[] }>('tabs.list', { sessionId: session.id })).tabs).toHaveLength(1)
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(site.reports.filter((report) => report.key === 'left-open-after-alert').map((report) => report.value)).not.toContain('false')
    } finally {
      await close()
    }
  }, 120_000)

  it('opens a new tab with its real error when the page cannot load, and Back in a fresh tab goes nowhere', async () => {
    const { call, ok, page, open, observe, close } = await markFixture()
    try {
      const { session } = await open(page('first'))
      const failed = await call('tabs.new', { sessionId: session.id, url: 'http://missing.test/' })
      expect(failed.ok).toBe(false)
      expect(failed.error?.message).toContain('ERR_NAME_NOT_RESOLVED')
      await expect.poll(async () => (await ok<{ tabs: BrowserTab[] }>('tabs.list', { sessionId: session.id })).tabs.length, { timeout: 3_000 }).toBe(1)

      const fresh = await ok<BrowserTab>('tabs.new', { sessionId: session.id, url: page('fresh') })
      const seen = await observe(session, fresh.id)
      const back = await call('act', act(session, seen, { type: 'back' }))
      expect(back.ok).toBe(false)
      expect(back.error?.message).toMatch(/No back history entry/)
      expect((await observe(session, fresh.id)).url).toContain('name=fresh')

      // Two tabs asked for at once: two tabs, each on its own page.
      const [one, two] = await Promise.all([
        ok<BrowserTab>('tabs.new', { sessionId: session.id, url: page('together-1') }),
        ok<BrowserTab>('tabs.new', { sessionId: session.id, url: page('together-2') })
      ])
      expect(one.id).not.toBe(two.id)
      expect((await observe(session, one.id)).url).toContain('name=together-1')
      expect((await observe(session, two.id)).url).toContain('name=together-2')
    } finally {
      await close()
    }
  }, 120_000)

  it('shows one identity: the user agent, navigator.userAgentData and the Sec-CH-UA headers agree', async () => {
    const { site, page, open, reported, close } = await markFixture()
    try {
      await open(page('hints', { hints: '1' }))
      const [printed] = await reported('hints-hints')
      const hints = JSON.parse(printed!) as { brands: Array<{ brand: string; version: string }>; platform: string; mobile: boolean; userAgent: string }
      const major = /Chrome\/(\d+)\.0\.0\.0 /.exec(hints.userAgent)?.[1]
      expect(major, hints.userAgent).toBeTruthy()
      expect(hints.userAgent).not.toMatch(/headless/i)
      expect(hints.brands).toContainEqual({ brand: 'Chromium', version: major })
      expect(hints.brands.some((entry) => /headless/i.test(entry.brand))).toBe(false)
      expect(hints.mobile).toBe(false)
      const system = hints.userAgent.includes('Macintosh') ? 'macOS' : hints.userAgent.includes('Windows') ? 'Windows' : 'Linux'
      expect(hints.platform).toBe(system)
      // The request for the page carries the same: user agent, brands, platform, not mobile.
      const request = site.requests.find((entry) => entry.path.includes('name=hints'))!
      expect(request.userAgent).toBe(hints.userAgent)
      const headerBrands = [...(request.secChUa ?? '').matchAll(/"([^"]+)";v="(\d+)"/g)].map((match) => ({ brand: match[1], version: match[2] }))
      expect(headerBrands).toEqual(hints.brands)
      expect(request.secChUaPlatform).toBe(`"${hints.platform}"`)
      expect(request.secChUaMobile).toBe('?0')
    } finally {
      await close()
    }
  }, 120_000)

  it('clicks as a mouse does on a real page: no button held as the pointer arrives, the button down, then up', async () => {
    const { ok, page, open, observe, shows, take, close, personClick } = await markFixture()
    try {
      const { session, observation } = await open(page('mouse', { mouse: '1' }))
      const seen = await observe(session, observation.tabId)
      const press = named(seen, 'Press')
      await ok('act', act(session, seen, { type: 'click', target: { kind: 'ref', ref: press.ref } }))
      await shows(session, observation.tabId, ['mouse:mousemove=0,mousedown=1,mouseup=0,click=0'])
      // The person's click reads the same.
      const lease = await take(session)
      await personClick(session, lease.controlLeaseId, observation.tabId, press.bounds!.x + 10, press.bounds!.y + 10)
      const after = textOf(await shows(session, observation.tabId, ['click=0,']))
      expect(after).toMatch(/mouse:mousemove=0,mousedown=1,mouseup=0,click=0(,mousemove=0)*,mousedown=1,mouseup=0,click=0/)
      expect(after).not.toMatch(/mousemove=[1-9]/)
    } finally {
      await close()
    }
  }, 120_000)

  it('names itself with the user agent this Chrome has with a window', async () => {
    const resolution = resolveCertifiedBrowser(MANAGED_BROWSER_ROOT)
    const userDataDir = await mkdtemp(join(tmpdir(), 'mousse-browser-identity-'))
    // Launched without the session's arguments, Chrome without a window says HeadlessChrome.
    const launched = await launchManagedChrome({ executablePath: resolution.executablePath!, userDataDir, headless: true })
    try {
      const version = await launched.cdp.send<{ userAgent: string }>('Browser.getVersion')
      expect(version.userAgent).toContain('HeadlessChrome/')
      expect(windowedChromeUserAgent(resolution.metadata?.version)).toBe(version.userAgent.replace('HeadlessChrome/', 'Chrome/'))
    } finally {
      await launched.stop()
    }
  }, 120_000)
})

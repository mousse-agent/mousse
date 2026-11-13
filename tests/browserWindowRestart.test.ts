/**
 * "Open in a window" on the real managed Chromium: a browser without a window cannot show one, so it starts again
 * with a window on the same profile, and again without one when the window closes. Claims, each observed in the
 * pages themselves:
 * - the session, its tab ids and their addresses, a sign-in kept on disk and a session-only sign-in all survive
 *   opening and closing (Close window), and the pages read `navigator.webdriver` false while the person holds it;
 * - the agent is refused while the window is open (it opens and loads nothing, it acts on nothing);
 * - opening is refused while a page waits on the person (a dialog), and without a hold;
 * - the window stopping by itself (its process ended from outside) brings the browser back without a window, the
 *   session-only sign-in carried, and says it stopped (`crashed`);
 * - the window's own close button (Linux with a display only: a real window) brings it back, said as `closed`;
 * - the service stopping while the window is open leaves no browser behind, and the profile opens again;
 * - no debugging port or file appears: the browser is driven over its private pipe alone.
 *
 * Without a display (Windows, macOS, a Linux without one) nobody may see a window from a test, so the restart into a
 * "window" runs without one (`MOUSSE_BROWSER_TEST_WINDOW_HEADLESS`): everything but the window itself is the same.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BrowserObservation, BrowserSessionRecord, BrowserTab } from '../src/shared/browser/types'
import type { BrowserWindowState } from '../src/shared/browser/window'
import { processRecordPath, workspaceUserDataDir } from '../src/browser-worker/lifecycle/paths'
import { createInProcessBroker, ensureManagedChrome, MANAGED_BROWSER_ROOT, workerRequest } from './fixtures/browser/harness'

const chrome = await ensureManagedChrome()
const PROFILE = 'profile_window'
/** A real window: Linux with a display (the sandbox's own Xvfb). Anywhere else the restart runs without one. */
const REAL_WINDOW = process.platform === 'linux' && Boolean(process.env.DISPLAY)
const XDOTOOL = REAL_WINDOW && (() => { try { execFileSync('xdotool', ['version']); return true } catch { return false } })()
const display = REAL_WINDOW ? { DISPLAY: process.env.DISPLAY!, ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}) } : undefined

/** A site that signs in once (a cookie kept on disk and a session-only one) and pages that say what they read. */
async function cookieSite(): Promise<{ origin: string; close(): Promise<void> }> {
  let signedIn = false
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    response.setHeader('content-type', 'text/html; charset=utf-8')
    // Only the first visit signs in: a page loading again must not sign in by itself.
    if (url.pathname === '/login' && !signedIn) {
      signedIn = true
      response.setHeader('set-cookie', ['disk=kept; Max-Age=86400; Path=/', 'sess=carried; Path=/'])
    }
    if (url.pathname === '/dialog') {
      response.end('<title>asks</title><p id="said">waiting</p><script>setTimeout(() => alert("hello"), 50)</script>')
      return
    }
    response.end(`<title>${url.pathname.slice(1) || 'home'}</title><main><p id="said">reading</p></main><script>
      document.getElementById('said').textContent = 'cookies[' + document.cookie.split('; ').sort().join(',') + '] webdriver[' + navigator.webdriver + ']'
    </script>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

async function fixture(workspaceId: string) {
  const site = await cookieSite()
  const { broker } = await createInProcessBroker()
  const call = (method: Parameters<typeof workerRequest>[1], params: Record<string, unknown>) => broker.call(workerRequest(PROFILE, method, params))
  const ok = async <T>(method: Parameters<typeof workerRequest>[1], params: Record<string, unknown>): Promise<T> => {
    const result = await call(method, params)
    expect(result.ok, `${method}: ${JSON.stringify(result.error)}`).toBe(true)
    return result.result as T
  }
  const opened = await ok<{ session: BrowserSessionRecord; observation: BrowserObservation }>('session.open', { url: `${site.origin}/login`, persistent: true, workspaceId })
  const sessionId = opened.session.id
  /** What a tab's page said it read, once its script ran. */
  const said = async (tabId: string): Promise<string> => {
    let text = ''
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const extracted = await call('extract', { sessionId, tabId })
      text = extracted.ok ? String((extracted.result as { text?: string }).text ?? '') : ''
      if (text.includes('webdriver[')) return text.slice(text.indexOf('cookies['))
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return text
  }
  const tabs = async () => (await ok<{ tabs: BrowserTab[] }>('tabs.list', { sessionId })).tabs
  const take = () => ok<{ controlLeaseId: string }>('control.take', { sessionId, owner: 'human', tabId: opened.observation.tabId })
  const giveBack = () => ok('control.take', { sessionId, owner: 'agent' })
  const openWindow = () => ok<BrowserWindowState>('window.open', { sessionId, ...(display ? { display } : {}) })
  const waitWindow = (after: number) => ok<BrowserWindowState>('window.wait', { sessionId, after, waitMs: 20_000 })
  const userDataDir = workspaceUserDataDir(MANAGED_BROWSER_ROOT, PROFILE, workspaceId)
  const chromePid = () => (JSON.parse(readFileSync(processRecordPath(userDataDir), 'utf8')) as { pid: number }).pid
  const close = async () => {
    await broker.close()
    await site.close()
  }
  return { site, broker, call, ok, sessionId, first: opened.observation.tabId, said, tabs, take, giveBack, openWindow, waitWindow, userDataDir, chromePid, close }
}

describe.skipIf(!chrome.ok)('the bot\'s browser in a window', () => {
  const headlessBefore = process.env.MOUSSE_BROWSER_TEST_WINDOW_HEADLESS
  beforeAll(() => { if (!REAL_WINDOW) process.env.MOUSSE_BROWSER_TEST_WINDOW_HEADLESS = '1' })
  afterAll(() => {
    if (headlessBefore === undefined) delete process.env.MOUSSE_BROWSER_TEST_WINDOW_HEADLESS
    else process.env.MOUSSE_BROWSER_TEST_WINDOW_HEADLESS = headlessBefore
  })

  it('keeps the session, its tabs, a disk sign-in and a session-only sign-in across opening and closing, and refuses the agent meanwhile', async () => {
    const f = await fixture('botbrowser_window_keeps')
    try {
      // Signed in on the first tab; a second tab shows what the site sees.
      const second = (await f.ok<{ id: string }>('tabs.new', { sessionId: f.sessionId, url: `${f.site.origin}/second?page=2` })).id
      expect(await f.said(second)).toBe('cookies[disk=kept,sess=carried] webdriver[true]')
      const before = await f.tabs()

      // The window opens only for a person who holds the browser.
      const refused = await f.call('window.open', { sessionId: f.sessionId, ...(display ? { display } : {}) })
      expect(refused.ok).toBe(false)
      expect(refused.error?.code).toBe('human_controlled')

      await f.take()
      const open = await f.openWindow()
      expect(open.open).toBe(true)
      // The same tabs, under the same ids, at the same addresses: the session is the same one.
      expect((await f.tabs()).map((tab) => [tab.id, tab.url])).toEqual(before.map((tab) => [tab.id, tab.url]))
      // Each page loaded again with both sign-ins, and reads as the person's.
      expect(await f.said(second)).toBe('cookies[disk=kept,sess=carried] webdriver[false]')
      // Driven over its private pipe alone: no debugging port, no port file.
      expect(existsSync(join(f.userDataDir, 'DevToolsActivePort'))).toBe(false)

      // The agent opens nothing and loads nothing while the window is open.
      const opened = await f.call('tabs.new', { sessionId: f.sessionId, url: `${f.site.origin}/agent` })
      expect(opened.ok).toBe(false)
      expect(opened.error?.code).toBe('human_controlled')
      const acted = await f.call('act', { sessionId: f.sessionId, tabId: second, observationId: 'obs_none', action: { type: 'navigate', url: `${f.site.origin}/agent` } })
      expect(acted.ok).toBe(false)
      // Nothing of it is pictured: the person uses the window itself.
      const pictured = await f.call('frame', { sessionId: f.sessionId, tabId: second })
      expect(pictured.ok).toBe(false)

      const closed = await f.ok<BrowserWindowState>('window.close', { sessionId: f.sessionId })
      expect(closed).toMatchObject({ open: false, ended: 'given-back' })
      expect((await f.tabs()).map((tab) => [tab.id, tab.url])).toEqual(before.map((tab) => [tab.id, tab.url]))
      expect(await f.said(second)).toBe('cookies[disk=kept,sess=carried] webdriver[false]')

      // The agent has it again, signed in, and its pages read as automated again.
      await f.giveBack()
      const third = (await f.ok<{ id: string }>('tabs.new', { sessionId: f.sessionId, url: `${f.site.origin}/third` })).id
      expect(await f.said(third)).toBe('cookies[disk=kept,sess=carried] webdriver[true]')
    } finally {
      await f.close()
    }
  }, 120_000)

  it('gives the browser back to the agent, without a window, when the agent is given control while the window is open', async () => {
    const f = await fixture('botbrowser_window_giveback')
    try {
      await f.take()
      await f.openWindow()
      await f.giveBack()
      expect(await f.ok<BrowserWindowState>('window.wait', { sessionId: f.sessionId, after: -1 })).toMatchObject({ open: false, ended: 'given-back' })
      const tab = (await f.ok<{ id: string }>('tabs.new', { sessionId: f.sessionId, url: `${f.site.origin}/after` })).id
      expect(await f.said(tab)).toBe('cookies[disk=kept,sess=carried] webdriver[true]')
    } finally {
      await f.close()
    }
  }, 120_000)

  it('does not open while a page waits on the person: a dialog would be lost by the reload', async () => {
    const f = await fixture('botbrowser_window_dialog')
    try {
      const asks = (await f.ok<{ id: string }>('tabs.new', { sessionId: f.sessionId, url: `${f.site.origin}/dialog` })).id
      expect(asks).toBeTruthy()
      await f.take()
      // The dialog opens a moment after the page loads.
      let answer: Awaited<ReturnType<typeof f.call>> | undefined
      for (let attempt = 0; attempt < 40; attempt += 1) {
        answer = await f.call('window.open', { sessionId: f.sessionId, ...(display ? { display } : {}) })
        if (!answer.ok) break
        await f.ok('window.close', { sessionId: f.sessionId })
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(answer?.ok).toBe(false)
      expect(answer?.error?.message).toMatch(/A page is asking something/)
    } finally {
      await f.close()
    }
  }, 120_000)

  it('comes back without a window, the session-only sign-in carried, when the window\'s browser is ended from outside', async () => {
    const f = await fixture('botbrowser_window_crash')
    try {
      const before = await f.tabs()
      await f.take()
      const open = await f.openWindow()
      const windowed = f.chromePid()
      process.kill(windowed, 'SIGKILL')
      let state = open
      for (let attempt = 0; attempt < 5 && !state.ended; attempt += 1) state = await f.waitWindow(state.serial)
      expect(state).toMatchObject({ open: false, ended: 'crashed' })
      expect(f.chromePid()).not.toBe(windowed)
      expect((await f.tabs()).map((tab) => tab.id)).toEqual(before.map((tab) => tab.id))
      const tab = before[0]!.id
      // Its page loaded again (the login page signs in once only): the session-only cookie is the carried copy.
      expect(await f.said(tab)).toBe('cookies[disk=kept,sess=carried] webdriver[false]')
    } finally {
      await f.close()
    }
  }, 120_000)

  it.skipIf(!XDOTOOL)('comes back without a window when the person closes the window with its own close', async () => {
    const f = await fixture('botbrowser_window_person')
    try {
      const second = (await f.ok<{ id: string }>('tabs.new', { sessionId: f.sessionId, url: `${f.site.origin}/second` })).id
      await f.take()
      const open = await f.openWindow()
      // Let a copy of the cookies be taken, as the window is used for a moment.
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      const windows = execFileSync('xdotool', ['search', '--onlyvisible', '--pid', String(f.chromePid())]).toString().trim().split('\n').filter(Boolean)
      expect(windows.length).toBeGreaterThan(0)
      execFileSync('xdotool', ['windowactivate', '--sync', windows[0]!, 'key', '--clearmodifiers', 'ctrl+shift+w'])
      let state = open
      for (let attempt = 0; attempt < 5 && !state.ended; attempt += 1) state = await f.waitWindow(state.serial)
      expect(state).toMatchObject({ open: false, ended: 'closed' })
      expect(await f.said(second)).toBe('cookies[disk=kept,sess=carried] webdriver[false]')
    } finally {
      await f.close()
    }
  }, 120_000)

  it('leaves no browser behind when the service stops while the window is open, and the profile opens again', async () => {
    const f = await fixture('botbrowser_window_stop')
    const site = f.site
    try {
      await f.take()
      await f.openWindow()
      const windowed = f.chromePid()
      await f.broker.close()
      let alive = true
      for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
        try { process.kill(windowed, 0) } catch { alive = false }
        if (alive) await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(alive).toBe(false)
      // The next start opens the same profile without a window, still signed in on disk.
      const { broker } = await createInProcessBroker()
      try {
        const reopened = await broker.call(workerRequest(PROFILE, 'session.open', { url: `${site.origin}/again`, persistent: true, workspaceId: 'botbrowser_window_stop' }))
        expect(reopened.ok, JSON.stringify(reopened.error)).toBe(true)
        const { session, observation } = reopened.result as { session: BrowserSessionRecord; observation: BrowserObservation }
        let text = ''
        for (let attempt = 0; attempt < 40 && !text.includes('webdriver['); attempt += 1) {
          const extracted = await broker.call(workerRequest(PROFILE, 'extract', { sessionId: session.id, tabId: observation.tabId }))
          text = extracted.ok ? String((extracted.result as { text?: string }).text ?? '') : ''
          if (!text.includes('webdriver[')) await new Promise((resolve) => setTimeout(resolve, 100))
        }
        expect(text).toContain('disk=kept')
        expect(await broker.call(workerRequest(PROFILE, 'window.wait', { sessionId: session.id, after: -1 }))).toMatchObject({ ok: true, result: { open: false } })
      } finally {
        await broker.close()
      }
    } finally {
      await site.close()
    }
  }, 120_000)
})

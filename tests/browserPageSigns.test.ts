/**
 * What a page that opened is, on real Chromium (needs the managed Chrome; skipped without it): a
 * failure only when it is nothing but a human check or a consent wall, else notes the agent may deal
 * with. Only what is visible and covers the page counts; a title or a class decides nothing. Also:
 * the site's error statuses, a download, and a page of many frames, as the worker's navigation reads them.
 * The challenge providers' hosts are mapped to nowhere: no test reaches the internet.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchManagedChrome, type LaunchedChrome } from '../src/browser-worker/cdp/launch'
import { resolveCertifiedBrowser } from '../src/browser-worker/binary/resolver'
import { navigateTab, readPageSigns } from '../src/browser-worker/action/dispatch'
import { ensureManagedChrome, MANAGED_BROWSER_ROOT, startFixtureSite } from './fixtures/browser/harness'

const chrome = await ensureManagedChrome()
const NOWHERE = ['www.google.com', 'challenges.cloudflare.com', 'newassets.hcaptcha.com'].map((host) => `MAP ${host} ~NOTFOUND`).join(', ')

describe.skipIf(!chrome.ok)('what a page that opened is, on real Chromium', () => {
  let launched: LaunchedChrome
  let site: Awaited<ReturnType<typeof startFixtureSite>>
  let sessionId: string
  let userDataDir: string
  beforeAll(async () => {
    site = await startFixtureSite()
    userDataDir = await mkdtemp(join(tmpdir(), 'mousse-page-signs-'))
    launched = await launchManagedChrome({ executablePath: resolveCertifiedBrowser(MANAGED_BROWSER_ROOT).executablePath!, userDataDir, headless: true, extraArgs: [`--host-resolver-rules=${NOWHERE}`] })
    await launched.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: join(userDataDir, 'downloads'), eventsEnabled: true })
    const { targetId } = await launched.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
    sessionId = (await launched.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })).sessionId
    for (const method of ['Page.enable', 'Runtime.enable']) await launched.cdp.send(method, {}, { sessionId })
    await launched.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, { sessionId })
  }, 60_000)
  afterAll(async () => {
    await launched?.stop()
    await site?.close()
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true })
  })
  const go = (path: string) => navigateTab(launched.cdp, sessionId, `${site.origin}${path}`, { ceilingMs: 15_000, signs: (frameId) => readPageSigns(launched.cdp, sessionId, frameId) }).catch((error: unknown) => error)

  it('a page is a failure only when it is nothing but a human check or a consent wall; what else it shows is a note', async () => {
    // A contact form with a visible check: the page is usable, the check is a note.
    expect(await go('/signs-contact-form.html')).toEqual({ url: `${site.origin}/signs-contact-form.html`, state: 'ready', notes: [{ kind: 'human-check' }] })
    // An invisible badge (and a challenge's title): nothing.
    expect(await go('/signs-invisible-badge.html')).toEqual({ url: `${site.origin}/signs-invisible-badge.html`, state: 'ready' })
    // A cookie banner along the bottom: a note.
    expect(await go('/signs-cookie-banner.html')).toEqual({ url: `${site.origin}/signs-cookie-banner.html`, state: 'ready', notes: [{ kind: 'cookie-banner' }] })
    // A consent dialog over a layer that covers the page: a wall.
    expect(await go('/signs-consent-wall.html')).toMatchObject({ state: 'failed', problem: { kind: 'needs-you', reason: 'consent', host: '127.0.0.1' } })
    // A local app's sign-in page: a note, which the agent may fill.
    expect(await go('/login')).toEqual({ url: `${site.origin}/login`, state: 'ready', notes: [{ kind: 'sign-in-form' }] })
    // A page that is nothing but a check, and a check in an overlay over a full page: failures.
    expect(await go('/signs-human-check.html')).toMatchObject({ state: 'failed', problem: { kind: 'needs-you', reason: 'human-check' } })
    expect(await go('/signs-check-overlay.html')).toMatchObject({ state: 'failed', problem: { kind: 'needs-you', reason: 'human-check' } })
    // A page that only names a challenge (title "Just a moment...", challenge classes on tiny or hidden boxes): an ordinary page.
    expect(await go('/signs-markers-only.html')).toEqual({ url: `${site.origin}/signs-markers-only.html`, state: 'ready' })
  }, 90_000)

  it('the site\'s error statuses, a download and a page of many frames come back as what they are', async () => {
    const refused = await go('/status?code=403')
    expect(refused, String((refused as Error).message)).toMatchObject({ code: 'site_blocked', problem: { kind: 'blocked', code: 'HTTP 403' } })
    const slowDown = await go('/status?code=429')
    expect(slowDown, String((slowDown as Error).message)).toEqual({ url: `${site.origin}/status?code=429`, state: 'ready', notes: [{ kind: 'http-status', status: 429, retryAfterSeconds: 30 }] })
    expect(await go('/status?code=404&body=1')).toEqual({ url: `${site.origin}/status?code=404&body=1`, state: 'ready', notes: [{ kind: 'http-status', status: 404 }] })
    expect(await go('/status?code=503')).toMatchObject({ state: 'ready', notes: [{ kind: 'http-status', status: 503 }] })
    expect(await go('/status?code=401')).toMatchObject({ code: 'needs_person', problem: { kind: 'needs-you', reason: 'sign-in', code: 'HTTP 401' } })
    // An address that starts a download: the tab stays on the page it was on, and the download is named.
    expect(await go('/nav-a.html')).toMatchObject({ state: 'ready' })
    expect(await go('/report.csv')).toEqual({ url: `${site.origin}/nav-a.html`, state: 'ready', download: { name: 'report.csv' } })
    // 300 frames with their own events: the page's own load still counts.
    expect(await go('/many-frames.html')).toEqual({ url: `${site.origin}/many-frames.html`, state: 'ready' })
  }, 90_000)
})

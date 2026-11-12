/**
 * What a page that repaints a little costs a watched view, on real Chromium (needs the managed
 * Chrome; skipped without it): a blinking caret and a clock that ticks each second. The screencast
 * is never started again for a still picture, the caret's flips stop being sent after the first
 * few, and the clock costs one picture a second with no stills after the first two.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { launchManagedChrome } from '../src/browser-worker/cdp/launch'
import type { CdpTransport } from '../src/browser-worker/cdp/transport'
import { resolveCertifiedBrowser } from '../src/browser-worker/binary/resolver'
import { ViewerCaptures, type ViewerUpdate } from '../src/browser-worker/observation/screencast'
import { ensureManagedChrome, MANAGED_BROWSER_ROOT } from './fixtures/browser/harness'

const chrome = await ensureManagedChrome()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const CARET = `<!doctype html><title>Sign in</title><body style="margin:20px;font:20px sans-serif"><h1>Sign in</h1><p>${'Words around a form. '.repeat(20)}</p><input id="q" style="font:20px sans-serif;width:400px"></body>`
const CLOCK = `<!doctype html><title>Clock</title><body style="margin:20px;font:20px sans-serif"><h1>Clock <span id="t">0</span></h1><p>${'Words on a page with a clock. '.repeat(30)}</p><script>let n = 0; setInterval(() => { document.getElementById('t').textContent = String(++n) }, 1000)</script></body>`

describe.skipIf(!chrome.ok)('what a page that repaints a little costs a watched view, on real Chromium', () => {
  it('a blinking caret and a one-second clock: no restart, their changes only, and few stills', async () => {
    const resolution = resolveCertifiedBrowser(MANAGED_BROWSER_ROOT)
    const userDataDir = await mkdtemp(join(tmpdir(), 'mousse-screencast-cost-'))
    const launched = await launchManagedChrome({ executablePath: resolution.executablePath!, userDataDir, headless: true })
    const counts = new Map<string, number>()
    const cdp: CdpTransport = {
      get connected() { return launched.cdp.connected },
      send: (method, params, options) => {
        counts.set(method, (counts.get(method) ?? 0) + 1)
        return launched.cdp.send(method, params, options)
      },
      on: (event, listener) => launched.cdp.on(event, listener),
      off: (event, listener) => launched.cdp.off(event, listener)
    }
    const captures = new ViewerCaptures(cdp, { behind: () => false })
    try {
      const { targetId } = await launched.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await launched.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
      await launched.cdp.send('Page.enable', {}, { sessionId })
      await launched.cdp.send('Runtime.enable', {}, { sessionId })
      await launched.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, { sessionId })

      /** Watches the page in the pane's size and rate for `seconds`: what it was sent, and what Chromium was asked. */
      const watch = async (label: string, html: string, seconds: number, setup?: string) => {
        await launched.cdp.send('Page.navigate', { url: 'data:text/html,' + encodeURIComponent(html) }, { sessionId })
        await sleep(800)
        if (setup) await launched.cdp.send('Runtime.evaluate', { expression: setup }, { sessionId })
        counts.clear()
        const info = { cdpSessionId: sessionId, tabId: 'tab_cost', url: 'data:', title: label }
        const pictures: Array<{ chars: number; sharp: boolean; at: number }> = []
        const start = Date.now()
        let seen: { frameSeq: number; stateSeq: number } | undefined
        while (Date.now() - start < seconds * 1_000) {
          const update: ViewerUpdate = await captures.next(info, { watchKey: label, maxWidth: 960, maxFps: 15, afterFrame: seen?.frameSeq ?? 0, afterState: seen?.stateSeq ?? 0, waitMs: Math.max(0, Math.min(2_000, seconds * 1_000 - (Date.now() - start))) })
          seen = update
          if (update.picture) pictures.push({ chars: update.picture.data.length, sharp: update.picture.sharp, at: Date.now() - start })
        }
        captures.stop(label)
        const chars = pictures.reduce((sum, picture) => sum + picture.chars, 0)
        return {
          label, seconds, pictures: pictures.length, sharp: pictures.filter((picture) => picture.sharp).length,
          base64CharsPerSecond: Math.round(chars / seconds), averagePictureChars: Math.round(chars / Math.max(1, pictures.length)),
          screencastStarts: counts.get('Page.startScreencast') ?? 0, screenshots: counts.get('Page.captureScreenshot') ?? 0,
          /** Pictures after the first 5 s, when the page has shown all it does. */
          afterFirstFiveSeconds: pictures.filter((picture) => picture.at > 5_000).length,
          at: pictures.map((picture) => picture.at)
        }
      }

      const caret = await watch('caret', CARET, 30, `document.getElementById('q').focus()`)
      const clock = await watch('clock', CLOCK, 20)
      await writeFile(join(tmpdir(), 'mousse-screencast-cost.json'), JSON.stringify({ caret, clock }, null, 2))

      // The caret: its first flips and stills in the first seconds, then one repeat after a gap that
      // doubles (at most three in the next 25 s), never a restart. It sent two pictures a second before.
      expect(caret.screencastStarts).toBe(1)
      expect(caret.afterFirstFiveSeconds).toBeLessThanOrEqual(3)
      expect(caret.pictures).toBeLessThanOrEqual(15)
      expect(caret.base64CharsPerSecond).toBeLessThan(caret.averagePictureChars)
      // The clock: one picture a tick, the screencast never started again, and stills only after the first ticks.
      expect(clock.screencastStarts).toBe(1)
      expect(clock.pictures).toBeGreaterThanOrEqual(15)
      expect(clock.pictures).toBeLessThanOrEqual(20 + 4)
      expect(clock.sharp).toBeLessThanOrEqual(3)
      expect(clock.afterFirstFiveSeconds).toBeLessThanOrEqual(16)
      // Each still is checked against its echo with up to three more screenshots, none of them sent.
      expect(clock.screenshots).toBeLessThanOrEqual(3 * 4)
    } finally {
      captures.dispose()
      await launched.stop()
      await rm(userDataDir, { recursive: true, force: true })
    }
  }, 120_000)
})

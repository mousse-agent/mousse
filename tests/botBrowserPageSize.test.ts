/**
 * A bot's browser laid out at the split view's size, on real managed Chromium (needs the managed
 * Chrome; skipped without it): with a tall split view the page is that size and its picture shows it
 * whole; a click near the bottom of the tall page lands on what is there; a click made on a picture
 * from before a resize is refused, never placed by the new layout; at a pixel ratio of 2 the picture has
 * twice the pixels while a click still lands at the page's point and the bot's screenshot stays at the
 * page's size; with no split view the page is 1280 by 720 again.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserBroker } from '../src/mms/browser/BrowserBroker'
import { MmsBrowserService } from '../src/mms/browser/MmsBrowserService'
import { BrowserArtifactService } from '../src/mms/browser/BrowserArtifactService'
import { createAllowHttpPolicy } from '../src/mms/browser/defaultPorts'
import { ExecutionPolicyService } from '../src/mms/execution/ExecutionPolicyService'
import { BOT_BROWSER_KEEPER, BotBrowsers } from '../src/mms/bots/browser/BotBrowsers'
import { BROWSER_AUTOMATION_TOOLS, type BrowserToolContext } from '../src/shared/browser/automation'
import type { BrowserObservation } from '../src/shared/browser/types'
import type { BotBrowserAck, BotBrowserFrameEvent, BotBrowserInput } from '../src/shared/bots/personal/browser'
import type { WatchedBrowserPageSize } from '../src/shared/browser/watched'
import { MANAGED_BROWSER_ROOT, ensureManagedChrome, startFixtureSite } from './fixtures/browser/harness'

const chrome = await ensureManagedChrome()
const profileId = '44444444-4444-4444-8444-444444444444'
const BOT = 'bot-pagesizepage'
const VIEW = 'view-pane'
const HOME = 'home-pagesize'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A JPEG's size in pixels, read from its frame header. */
function jpegSize(base64: string): { width: number; height: number } {
  const bytes = Buffer.from(base64, 'base64')
  for (let at = 2; at < bytes.length - 9;) {
    if (bytes[at] !== 0xff) { at += 1; continue }
    const marker = bytes[at + 1]!
    if (marker >= 0xc0 && marker <= 0xc3) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) }
    at += 2 + bytes.readUInt16BE(at + 2)
  }
  throw new Error('not a JPEG')
}

const press = (x: number, y: number): BotBrowserInput[] => [
  { kind: 'pointer', type: 'move', x, y, button: 'none', buttons: 0 },
  { kind: 'pointer', type: 'down', x, y, button: 'left', buttons: 1, clicks: 1 },
  { kind: 'pointer', type: 'up', x, y, button: 'left', buttons: 0, clicks: 1 }
]

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mousse-bot-pagesize-'))
  const workerArtifactRoot = join(root, 'worker-artifacts')
  await mkdir(workerArtifactRoot)
  const broker = new BrowserBroker({ profileRoot: root, browserRoot: MANAGED_BROWSER_ROOT, artifactRoot: workerArtifactRoot, policy: createAllowHttpPolicy(), transport: 'in-process' })
  await broker.start()
  const artifacts = new BrowserArtifactService({ profileId, profileRoot: root, workerArtifactRoot })
  const browser = new MmsBrowserService({ profileId, profileRoot: root, workerArtifactRoot, artifacts, installationBrowserRoot: MANAGED_BROWSER_ROOT, threadExists: () => true, createManagedBackend: () => broker })
  const bots = new BotBrowsers({ profileId, browser: () => browser, homeThread: () => HOME, setTimer: () => ({ clear: () => undefined }), computerName: 'Test computer' })
  const site = await startFixtureSite()
  cleanups.push(async () => {
    await bots.removeBot(BOT, true)
    await browser.dispose()
    await broker.close()
    await site.close()
    await rm(root, { force: true, recursive: true })
  })
  const policy = new ExecutionPolicyService().snapshot(profileId, { allowedTools: [...BROWSER_AUTOMATION_TOOLS], allowedCapabilities: ['browser.session', 'browser.observe'], allowedEffects: ['read', 'external'], maxToolCalls: 1_000, maxElapsedMs: 600_000 })
  const home: BrowserToolContext = { execution: { profileId, threadId: HOME, turnId: 'reader', actor: { kind: 'main' }, source: 'schedule', policySnapshotId: policy.id, cancellationId: 'reader' }, policy, target: { backend: 'managed-chromium' }, keeper: BOT_BROWSER_KEEPER, vision: true }
  /** What the bot sees when it looks: the page's words, its title, and its screenshot when asked. */
  const look = async (includeScreenshot = false): Promise<BrowserObservation> => {
    const sessionId = browser.sessions.listThreadSessions({ profileId, threadId: HOME, keeper: BOT_BROWSER_KEEPER })[0]!.id
    const seen = await browser.tools.invoke('browser_observe', { sessionId, ...(includeScreenshot ? { includeScreenshot: true } : {}) }, home)
    if (!seen.ok) throw new Error(seen.error.message)
    return seen.value.observation as BrowserObservation
  }
  /** The page's title (it names what was clicked). */
  const text = async () => (await look()).title
  /** The page's size as the bot sees it when it looks, and its pixel ratio. A windowless page tells its own scripts only at its next painted frame. */
  const size = async () => { const { viewport } = await look(); return `${viewport.cssWidth}x${viewport.cssHeight} ratio ${viewport.deviceScaleFactor}` }
  const events: BotBrowserFrameEvent[] = []
  let seq = 0
  let holdId = ''
  /** The split view: it holds the browser on the test page, and watches it at `page`. */
  const pane = async (page: WatchedBrowserPageSize | undefined) => {
    await bots.watch(BOT, 'pane', { width: page ? Math.round(page.width * page.scale) : 960, fps: 30, connectionId: 'c1', viewId: VIEW, ...(page ? { page } : {}), emit: async (event) => { events.push(event) } })
  }
  const open = async (page: WatchedBrowserPageSize) => {
    const { hold } = await bots.open(BOT, `${site.origin}/fills-view.html`, { viewId: VIEW, platform: 'other' })
    holdId = hold!.id
    await pane(page)
  }
  /** The pictures the view was sent, each with the page's size it shows. */
  const pictures = () => {
    let viewport: { width: number; height: number } | undefined
    return events.flatMap((event) => {
      if (event.viewport) viewport = event.viewport
      return event.frame?.id ? [{ id: event.frame.id, data: event.frame.data, viewport: viewport! }] : []
    })
  }
  /** The latest picture once it shows the page at `width` by `height`. */
  const pictureAt = async (width: number, height: number) => {
    await expect.poll(() => pictures().at(-1)?.viewport, { timeout: 15_000 }).toEqual({ width, height })
    return pictures().at(-1)!
  }
  const send = async (inputs: BotBrowserInput[], picture: number): Promise<BotBrowserAck[]> =>
    (await bots.send(BOT, VIEW, holdId, inputs.map((input) => ({ seq: ++seq, input, picture })))).acks
  return { bots, open, pane, pictureAt, send, text, size, look }
}

describe.skipIf(!chrome.ok)('a bot\'s browser at the split view\'s size', () => {
  it('a tall split view lays the page out at its size and the picture shows it whole; a click near the bottom lands; with no split view the page is 1280 by 720 again', async () => {
    const { bots, open, pictureAt, send, text, size } = await fixture()
    await open({ width: 600, height: 1000, scale: 1 })
    await expect.poll(size, { timeout: 15_000 }).toBe('600x1000 ratio 1')
    const shown = await pictureAt(600, 1000)
    expect(jpegSize(shown.data)).toEqual({ width: 600, height: 1000 })
    // The Bottom button sits 16 px above the bottom of the tall page: below where a 1280 by 720 page ends.
    expect((await send(press(300, 960), shown.id)).map((ack) => ack.status)).toEqual(['applied', 'applied', 'applied'])
    await expect.poll(text, { timeout: 5_000 }).toContain('clicked bottom')
    // The split view closes: the page goes back to the bot's default size.
    bots.unwatch(BOT, 'pane', 'c1')
    await expect.poll(size, { timeout: 15_000 }).toBe('1280x720 ratio 1')
  })

  it('a click made on a picture from before a resize is refused, never placed by the new layout; one on a picture after it lands', async () => {
    const { open, pane, pictureAt, send, text, size } = await fixture()
    await open({ width: 600, height: 1000, scale: 1 })
    const before = await pictureAt(600, 1000)
    // The person drags the divider: the page is now 720 high, and its Bottom button is where the old picture showed nothing.
    await pane({ width: 600, height: 720, scale: 1 })
    await expect.poll(size, { timeout: 15_000 }).toBe('600x720 ratio 1')
    const after = await pictureAt(600, 720)
    const stale = await send(press(300, 680), before.id)
    expect(stale.find((ack) => ack.status !== 'applied')).toMatchObject({ status: 'refused', reason: 'page-changed', text: 'Page changed · click again' })
    expect(await text()).not.toContain('clicked')
    expect((await send(press(300, 680), after.id)).every((ack) => ack.status === 'applied')).toBe(true)
    await expect.poll(text, { timeout: 5_000 }).toContain('clicked bottom')
  })

  it('at a pixel ratio of 2 the picture has twice the pixels, a click lands at the page\'s point, and the bot\'s screenshot stays at the page\'s size', async () => {
    const { open, pictureAt, send, text, size, look } = await fixture()
    await open({ width: 500, height: 800, scale: 2 })
    await expect.poll(size, { timeout: 15_000 }).toBe('500x800 ratio 2')
    await expect.poll(async () => jpegSize((await pictureAt(500, 800)).data), { timeout: 15_000 }).toEqual({ width: 1000, height: 1600 })
    const shown = await pictureAt(500, 800)
    expect((await send(press(250, 760), shown.id)).every((ack) => ack.status === 'applied')).toBe(true)
    await expect.poll(text, { timeout: 5_000 }).toContain('clicked bottom')
    const seen = await look(true)
    expect(seen.screenshot).toMatchObject({ pixelWidth: 500, pixelHeight: 800 })
  })
})

/**
 * The pictures behind a bot's browser view (`ViewerCaptures`): one screencast per watched tab, shared
 * by its watchers, each with its own latest-wins slot and cap; nothing at all while nobody watches;
 * Chromium's pictures acknowledged only once a watcher takes one; a sharp picture once the page
 * stops changing; and a tab behind pictured without bringing it to the front.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CdpEventListener, CdpTransport } from '../src/browser-worker/cdp/transport'
import { MAX_PICTURE_CHARS, MAX_REPEAT_GAP_MS, REPEAT_GAP_MS, SETTLE_MS, ViewerCaptures, type ViewerTabInfo, type ViewerUpdate } from '../src/browser-worker/observation/screencast'

/**
 * A Chromium of one or more tabs: `paint` changes a tab's page and sends it while its screencast
 * runs (as `<page>@<quality>`). As measured on Chromium 153: a screencast that starts usually sends
 * the page as it is (not always: `sendsOnStart`), and a screenshot makes it send the page again
 * (`screenshotRepaints`), as another encoding of the same page the first time (`'variant'`:
 * `<page>@<quality>~`), and then as that same encoding. `shot` answers a screenshot's picture.
 */
function fakeCdp({ sendsOnStart = true, screenshotRepaints = false as boolean | 'variant', shot = undefined as ((params: Record<string, unknown>, index: number) => string) | undefined } = {}) {
  const listeners = new Map<string, Set<CdpEventListener>>()
  const sent: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = []
  const pages = new Map<string, string>()
  const casting = new Map<string, number>()
  let shots = 0
  let frame = 0
  const emit = (sessionId: string, data: string) => {
    frame += 1
    for (const listener of listeners.get('Page.screencastFrame') ?? []) listener({ data, sessionId: frame, metadata: {} }, sessionId)
    return frame
  }
  const cdp: CdpTransport = {
    connected: true,
    async send<T>(method: string, params?: Record<string, unknown>, options?: { sessionId?: string }) {
      sent.push({ method, params, sessionId: options?.sessionId })
      const sessionId = options?.sessionId ?? ''
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1280, clientHeight: 720, pageX: 0, pageY: 0 } } as T
      if (method === 'Page.captureScreenshot') {
        const page = pages.get(sessionId)
        if (screenshotRepaints && page && casting.has(sessionId)) emit(sessionId, `${page}@${casting.get(sessionId)}${screenshotRepaints === 'variant' ? '~' : ''}`)
        shots += 1
        return { data: shot ? shot(params!, shots) : `SHOT${shots}` } as T
      }
      if (method === 'Page.stopScreencast') casting.delete(sessionId)
      if (method === 'Page.startScreencast') {
        casting.set(sessionId, params!.quality as number)
        const page = pages.get(sessionId)
        if (page && sendsOnStart) setTimeout(() => { if (casting.has(sessionId)) emit(sessionId, `${page}@${casting.get(sessionId)}`) }, 0)
      }
      return {} as T
    },
    on(event, listener) { (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(listener) },
    off(event, listener) { listeners.get(event)?.delete(listener) }
  }
  const paint = (sessionId: string, page: string) => {
    pages.set(sessionId, page)
    return emit(sessionId, `${page}@${casting.get(sessionId) ?? 60}`)
  }
  const count = (method: string, sessionId?: string) => sent.filter((entry) => entry.method === method && (!sessionId || entry.sessionId === sessionId)).length
  const acks = () => sent.filter((entry) => entry.method === 'Page.screencastFrameAck').map((entry) => entry.params!.sessionId)
  const qualities = (sessionId: string) => sent.filter((entry) => entry.method === 'Page.startScreencast' && entry.sessionId === sessionId).map((entry) => entry.params!.quality)
  return { cdp, sent, paint, count, acks, qualities, listeners }
}

const TAB_A: ViewerTabInfo = { cdpSessionId: 'cdp-a', tabId: 'tab_a', url: 'https://a.example/', title: 'A' }
const TAB_B: ViewerTabInfo = { cdpSessionId: 'cdp-b', tabId: 'tab_b', url: 'https://b.example/', title: 'B' }
type Seen = { frameSeq: number; stateSeq: number } | undefined
const ask = (captures: ViewerCaptures, info: ViewerTabInfo, watchKey: string, seen: Seen, options: { maxFps?: number; maxWidth?: number; waitMs?: number } = {}) =>
  captures.next(info, { watchKey, maxWidth: options.maxWidth ?? 960, maxFps: options.maxFps ?? 15, afterFrame: seen?.frameSeq ?? 0, afterState: seen?.stateSeq ?? 0, waitMs: options.waitMs ?? 20_000 })
/** Runs the capture's timers and awaits for `ms` of fake time, then answers. */
async function after<T>(promise: Promise<T>, ms = 0): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms)
  return promise
}
/** A new watcher: its first request answers the tab's state at once (no picture yet). */
async function join(captures: ViewerCaptures, info: ViewerTabInfo, watchKey: string, options: { maxFps?: number; maxWidth?: number } = {}): Promise<ViewerUpdate> {
  const state = await after(ask(captures, info, watchKey, undefined, options))
  expect(state.picture).toBeUndefined()
  return state
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('the pictures of a watched tab', () => {
  it('captures nothing while nobody watches', async () => {
    const { cdp, sent } = fakeCdp()
    const captures = new ViewerCaptures(cdp, { behind: () => false })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sent).toEqual([])
    expect(captures.active).toBe(0)
    captures.dispose()
  })

  it('starts a screencast for the first watcher, answers a paint at once, sends nothing more for a still page but one sharp picture', async () => {
    const { cdp, paint, count, sent, qualities } = fakeCdp({ screenshotRepaints: true })
    const captures = new ViewerCaptures(cdp, { behind: () => false })
    const state = await join(captures, TAB_A, 'w1')
    expect(state).toMatchObject({ tabId: 'tab_a', url: 'https://a.example/', title: 'A', viewport: { width: 1280, height: 720 }, behind: false })
    expect(sent.filter((entry) => entry.sessionId === 'cdp-a').map((entry) => entry.method)).toEqual(['Page.getLayoutMetrics', 'Page.stopScreencast', 'Page.startScreencast'])
    expect(sent.find((entry) => entry.method === 'Page.startScreencast')!.params).toMatchObject({ format: 'jpeg', quality: 60, maxWidth: 960 })
    const first = ask(captures, TAB_A, 'w1', state)
    paint('cdp-a', 'AAA')
    const one = await after(first)
    expect(one.picture).toMatchObject({ data: 'AAA@60', width: 960, height: 540, sharp: false })
    // The page stops changing: one screenshot at full quality, the screencast left as it is, then nothing.
    const sharp = await after(ask(captures, TAB_A, 'w1', one), SETTLE_MS + 10)
    expect(sharp.picture).toMatchObject({ data: 'SHOT1', sharp: true, width: 960, height: 540 })
    expect(sent.find((entry) => entry.method === 'Page.captureScreenshot')!.params).toMatchObject({ quality: 90, clip: { scale: 0.75 } })
    expect(await after(ask(captures, TAB_A, 'w1', sharp, { waitMs: 5_000 }), 5_000)).toMatchObject({ idle: true })
    expect(count('Page.captureScreenshot')).toBe(1)
    // The same picture painted again is no change.
    const repeat = ask(captures, TAB_A, 'w1', sharp, { waitMs: 1_000 })
    paint('cdp-a', 'AAA')
    paint('cdp-a', 'AAA')
    const repeated = await after(repeat, 1_000)
    expect(repeated).toMatchObject({ idle: true })
    // It changes again: that picture goes.
    const change = ask(captures, TAB_A, 'w1', sharp)
    paint('cdp-a', 'BBB')
    expect((await after(change)).picture).toMatchObject({ data: 'BBB@60', sharp: false })
    // The screencast was never started again: one quality all along.
    expect(qualities('cdp-a')).toEqual([60])
    // The layout is read when the capture starts and for each still: never per picture.
    expect(count('Page.getLayoutMetrics')).toBe(2)
    captures.dispose()
  })

  it('a still page\'s screenshot echo asks for no endless stills: at most two, then nothing', async () => {
    const { cdp, paint, count, qualities } = fakeCdp({ sendsOnStart: false, screenshotRepaints: 'variant', shot: () => 'SAME' })
    const captures = new ViewerCaptures(cdp, { behind: () => false })
    const state = await join(captures, TAB_A, 'w1')
    const first = ask(captures, TAB_A, 'w1', state)
    paint('cdp-a', 'AAA')
    let seen: ViewerUpdate = await after(first)
    expect(seen.picture).toMatchObject({ data: 'AAA@60', sharp: false })
    const pictures: string[] = []
    for (let index = 0; index < 20; index += 1) {
      const update = await after(ask(captures, TAB_A, 'w1', seen, { waitMs: 1_000 }), 1_000)
      if (update.picture) pictures.push(update.picture.data)
      seen = update.picture ? update : { ...update, frameSeq: seen.frameSeq }
    }
    // The screenshot's echo is a new encoding of the page: a second screenshot, the same bytes, says nothing changed.
    expect(pictures).toEqual(['SAME'])
    expect(count('Page.captureScreenshot')).toBe(2)
    expect(qualities('cdp-a')).toEqual([60])
    captures.dispose()
  })

  it('a page that changes just as its still is taken: the second screenshot shows it, at full quality', async () => {
    let page = 'AAA'
    const { cdp, paint, count } = fakeCdp({ sendsOnStart: false, screenshotRepaints: 'variant', shot: () => `SHOT-${page}` })
    const captures = new ViewerCaptures(cdp, { behind: () => false })
    const state = await join(captures, TAB_A, 'w1')
    const first = ask(captures, TAB_A, 'w1', state)
    paint('cdp-a', 'AAA')
    let seen: ViewerUpdate = await after(first)
    // The page changes right as the still is taken: Chromium's next picture is its echo window's.
    page = 'BBB'
    const pictures: string[] = []
    for (let index = 0; index < 6; index += 1) {
      const update = await after(ask(captures, TAB_A, 'w1', seen, { waitMs: 1_000 }), 1_000)
      if (update.picture) pictures.push(update.picture.data)
      seen = update.picture ? update : { ...update, frameSeq: seen.frameSeq }
    }
    expect(pictures.at(-1)).toBe('SHOT-BBB')
    expect(count('Page.captureScreenshot')).toBeLessThanOrEqual(3)
    captures.dispose()
  })

  it('a page that changes a little every second costs its changes: no restart, and stills stop once each is replaced at once', async () => {
    let clock = ''
    const { cdp, paint: paintPage, count } = fakeCdp({ screenshotRepaints: 'variant', shot: () => `SHOT-${clock}` })
    const paint = (sessionId: string, page: string) => { clock = page; return paintPage(sessionId, page) }
    const captures = new ViewerCaptures(cdp, { behind: () => false })
    let seen: Seen = await join(captures, TAB_A, 'w1')
    const pictures: Array<{ data: string; sharp: boolean }> = []
    let stop = false
    const loop = (async () => {
      while (!stop) {
        const update: ViewerUpdate = await ask(captures, TAB_A, 'w1', seen, { waitMs: 2_000 })
        seen = update
        if (update.picture) pictures.push({ data: update.picture.data, sharp: update.picture.sharp })
      }
    })()
    // A clock: a new picture each second for 30 s.
    for (let second = 1; second <= 30; second += 1) {
      paint('cdp-a', `T${second}`)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    stop = true
    await vi.advanceTimersByTimeAsync(2_000)
    await loop
    const ticks = pictures.filter((picture) => /^T\d+@60$/.test(picture.data))
    expect(ticks).toHaveLength(30)
    // Stills after the first two ticks (each replaced within the second, so the wait doubles past it),
    // then none until the clock stops: one more. Each still is checked once against its echo.
    expect(pictures.filter((picture) => picture.sharp).map((picture) => picture.data)).toEqual(['SHOT-T1', 'SHOT-T2', 'SHOT-T30'])
    expect(count('Page.captureScreenshot')).toBeLessThanOrEqual(6)
    // The screencast never restarts.
    expect(count('Page.startScreencast')).toBe(1)
    expect(pictures).toHaveLength(33)
    captures.dispose()
  })

  it('a blinking caret sends the flip back once, then one every 5, 10, 20, 40 and 60 s; an action brings one back at once', async () => {
    const { cdp, paint, count } = fakeCdp()
    const captures = new ViewerCaptures(cdp, { behind: () => false })
    let seen: Seen = await join(captures, TAB_A, 'w1')
    const pictures: Array<{ data: string; at: number }> = []
    const start = Date.now()
    let stop = false
    const loop = (async () => {
      while (!stop) {
        const update: ViewerUpdate = await ask(captures, TAB_A, 'w1', seen, { waitMs: 2_000 })
        seen = update
        if (update.picture) pictures.push({ data: update.picture.data, at: Date.now() - start })
      }
    })()
    // The caret blinks every 530 ms (Chromium's period) for three minutes.
    for (let blink = 0; blink < 340; blink += 1) {
      paint('cdp-a', blink % 2 ? 'CARET-OFF' : 'CARET-ON')
      await vi.advanceTimersByTimeAsync(530)
    }
    const caret = pictures.filter((picture) => picture.data.startsWith('CARET'))
    // The first picture and the flip back, then at most one per growing gap (5, 10, 20, 40, 60, 60 s).
    expect(caret.length).toBeGreaterThanOrEqual(2)
    expect(caret.length).toBeLessThanOrEqual(2 + 7)
    const late = caret.slice(2).map((picture) => picture.at)
    expect(late.slice(1).map((at, index) => at - late[index]!).every((gap) => gap >= REPEAT_GAP_MS - 600)).toBe(true)
    expect(late.slice(1).map((at, index) => at - late[index]!).every((gap) => gap <= MAX_REPEAT_GAP_MS + 600)).toBe(true)
    // Stills only in the first seconds (the flips replace them at once), and no restart.
    expect(count('Page.captureScreenshot')).toBeLessThanOrEqual(3)
    expect(count('Page.startScreencast')).toBe(1)
    // The agent acts (a click toggles a box back to how it was): that picture goes at once.
    const before = pictures.length
    captures.acted('tab_a')
    // The last blink painted CARET-OFF: the page goes back to CARET-ON.
    paint('cdp-a', 'CARET-ON')
    await vi.advanceTimersByTimeAsync(50)
    expect(pictures.length).toBe(before + 1)
    stop = true
    await vi.advanceTimersByTimeAsync(2_500)
    await loop
    captures.dispose()
  })

  it('an older view asking every 40 ms still gets the sharp picture of a still page', async () => {
    const { cdp, paint, count } = fakeCdp()
    const captures = new ViewerCaptures(cdp, { behind: () => false })
    await after(captures.latest(TAB_A, 960))
    paint('cdp-a', 'P1')
    let last: string | undefined
    for (let index = 0; index < 40; index += 1) {
      last = (await after(captures.latest(TAB_A, 960), 40)).picture?.data
    }
    expect(last).toBe('SHOT1')
    expect(count('Page.captureScreenshot')).toBe(1)
    captures.dispose()
  })

  it('never hands out a picture over the limit: a still at a lower quality, or smaller, instead', async () => {
    const big = 'X'.repeat(MAX_PICTURE_CHARS + 1)
    const { cdp, paint, sent } = fakeCdp({ shot: (params, index) => (params.quality as number) >= 60 ? big : `SMALL${index}` })
    const captures = new ViewerCaptures(cdp, { behind: () => false })
    const state = await join(captures, TAB_A, 'w1')
    const first = ask(captures, TAB_A, 'w1', state)
    // A screencast picture over the limit (a noisy page) is not sent; a still that fits is.
    paint('cdp-a', big)
    const got = await after(first, 50)
    expect(got.picture!.data).toMatch(/^SMALL/)
    expect(got.picture!.data.length).toBeLessThanOrEqual(MAX_PICTURE_CHARS)
    expect(sent.filter((entry) => entry.method === 'Page.captureScreenshot').map((entry) => entry.params!.quality)).toEqual([90, 60, 40])
    captures.dispose()
  })

  it('holds Chromium\'s pictures unacknowledged until a watcher takes one, and gives it the latest', async () => {
    const { cdp, paint, acks } = fakeCdp()
    const captures = new ViewerCaptures(cdp, { behind: () => false })
    const state = await join(captures, TAB_A, 'w1')
    const first = ask(captures, TAB_A, 'w1', state)
    const f1 = paint('cdp-a', 'P1')
    const got = await after(first)
    expect(acks()).toEqual([f1])
    // The watcher is busy delivering it: nothing it asked for waits, so new paints are held.
    const f2 = paint('cdp-a', 'P2')
    const f3 = paint('cdp-a', 'P3')
    await vi.advanceTimersByTimeAsync(100)
    expect(acks()).toEqual([f1])
    // It asks again: it gets the latest (P2 is dropped), and both are acknowledged then.
    const next = await after(ask(captures, TAB_A, 'w1', got))
    expect(next.picture!.data).toBe('P3@60')
    expect(acks()).toEqual([f1, f2, f3])
    captures.dispose()
  })

  it('keeps each watcher to its cap: a picture at most every 1/fps, always the latest, and the last change arrives', async () => {
    const { cdp, paint } = fakeCdp()
    const captures = new ViewerCaptures(cdp, { behind: () => false })
    let seen: Seen
    const pictures: Array<{ data: string; at: number; sharp: boolean }> = []
    const start = Date.now()
    // A watcher that asks again as soon as it has an answer, at 5 a second, while the page paints every 50 ms for a second.
    let stop = false
    const loop = (async () => {
      while (!stop) {
        const update: ViewerUpdate = await ask(captures, TAB_A, 'w1', seen, { maxFps: 5, maxWidth: 480, waitMs: 2_000 })
        seen = update
        if (update.picture) pictures.push({ data: update.picture.data, at: Date.now() - start, sharp: update.picture.sharp })
      }
    })()
    await vi.advanceTimersByTimeAsync(0)
    for (let index = 1; index <= 20; index += 1) {
      paint('cdp-a', `P${index}`)
      await vi.advanceTimersByTimeAsync(50)
    }
    await vi.advanceTimersByTimeAsync(400)
    stop = true
    await vi.advanceTimersByTimeAsync(2_000)
    await loop
    const moving = pictures.filter((picture) => !picture.sharp)
    const gaps = pictures.slice(1).map((picture, index) => picture.at - pictures[index]!.at)
    expect(gaps.every((gap) => gap >= 200)).toBe(true)
    expect(moving.length).toBeGreaterThanOrEqual(4)
    expect(moving.length).toBeLessThanOrEqual(6)
    // The last paint arrived, then the sharp picture of it.
    expect(moving.at(-1)!.data).toBe('P20@60')
    expect(pictures.at(-1)).toMatchObject({ data: 'SHOT1', sharp: true })
    captures.dispose()
  })

  it('shares one capture between watchers at the widest size; a slow watcher does not hold up a fast one', async () => {
    const { cdp, paint, sent } = fakeCdp()
    const captures = new ViewerCaptures(cdp, { behind: () => false })
    const smallState = await join(captures, TAB_A, 'preview', { maxWidth: 480, maxFps: 5 })
    const largeState = await join(captures, TAB_A, 'pane', { maxWidth: 960, maxFps: 15 })
    expect(sent.filter((entry) => entry.method === 'Page.startScreencast').map((entry) => entry.params!.maxWidth)).toEqual([480, 960])
    const small = ask(captures, TAB_A, 'preview', smallState, { maxWidth: 480, maxFps: 5 })
    const large = ask(captures, TAB_A, 'pane', largeState, { maxWidth: 960, maxFps: 15 })
    paint('cdp-a', 'P1')
    const [s1, l1] = await after(Promise.all([small, large]))
    expect(s1.picture!.data).toBe('P1@60')
    expect(l1.picture!.data).toBe('P1@60')
    // The preview does not ask again (still delivering); the pane keeps getting pictures.
    let pane = l1
    for (const data of ['P2', 'P3', 'P4']) {
      await vi.advanceTimersByTimeAsync(70)
      const next = ask(captures, TAB_A, 'pane', pane, { maxWidth: 960, maxFps: 15 })
      paint('cdp-a', data)
      pane = await after(next)
      expect(pane.picture!.data).toBe(`${data}@60`)
    }
    // When the preview asks at last, it gets only the latest.
    expect((await after(ask(captures, TAB_A, 'preview', s1, { maxWidth: 480, maxFps: 5 }))).picture!.data).toBe('P4@60')
    captures.dispose()
  })

  it('stops the screencast when the last watcher stops, and when a watcher stops asking', async () => {
    const { cdp, paint, count } = fakeCdp()
    const captures = new ViewerCaptures(cdp, { behind: () => false, leaseMs: 1_000 })
    const state = await join(captures, TAB_A, 'w1')
    const waiting = ask(captures, TAB_A, 'w1', state)
    paint('cdp-a', 'P1')
    const seen = await after(waiting)
    const again = ask(captures, TAB_A, 'w1', seen)
    await vi.advanceTimersByTimeAsync(0)
    captures.stop('w1')
    expect(await again).toMatchObject({ idle: true })
    expect(count('Page.stopScreencast', 'cdp-a')).toBe(2)
    expect(captures.active).toBe(0)
    // A watcher that stops asking is dropped after its lease.
    const other = await join(captures, TAB_B, 'w2')
    const once = ask(captures, TAB_B, 'w2', other)
    paint('cdp-b', 'B1')
    await after(once)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(captures.active).toBe(0)
    expect(cdp).toBeDefined()
    expect(count('Page.startScreencast', 'cdp-b')).toBeGreaterThanOrEqual(1)
    expect(count('Page.stopScreencast', 'cdp-b')).toBe(count('Page.startScreencast', 'cdp-b') + 1)
    captures.dispose()
  })

  it('pictures a tab behind once, without bringing it to the front, and says it is behind', async () => {
    const { cdp, sent, count, paint } = fakeCdp()
    let front = 'cdp-a'
    const captures = new ViewerCaptures(cdp, { behind: (cdpSessionId) => cdpSessionId !== front })
    const state = await join(captures, TAB_B, 'w1')
    expect(state.behind).toBe(true)
    // Chromium sends nothing for a tab behind: the one still picture is a screenshot of it.
    let update = await after(ask(captures, TAB_B, 'w1', state))
    expect(update.picture).toMatchObject({ data: 'SHOT1', sharp: true })
    expect(update.behind).toBe(true)
    expect(sent.some((entry) => entry.method === 'Target.activateTarget')).toBe(false)
    // Nothing more while it stays behind, even when the screenshot made Chromium send a picture.
    const quiet = ask(captures, TAB_B, 'w1', update, { waitMs: 3_000 })
    paint('cdp-b', 'FORCED')
    expect(await after(quiet, 3_000)).toMatchObject({ idle: true })
    expect(count('Page.captureScreenshot')).toBe(1)
    // The agent acts on it: it comes to the front, and the view hears it at once.
    const moved = ask(captures, TAB_B, 'w1', update)
    await vi.advanceTimersByTimeAsync(0)
    front = 'cdp-b'
    captures.frontChanged()
    update = await after(moved)
    expect(update.behind).toBe(false)
    captures.dispose()
  })

  it('tells a watcher at once when the agent cursor moves or a new page commits, and restarts the screencast on a commit', async () => {
    const { cdp, paint, count } = fakeCdp()
    const captures = new ViewerCaptures(cdp, { behind: () => false })
    const state = await join(captures, TAB_A, 'w1')
    const first = ask(captures, TAB_A, 'w1', state)
    paint('cdp-a', 'P1')
    const got = await after(first)
    const cursor = ask(captures, TAB_A, 'w1', got)
    await vi.advanceTimersByTimeAsync(0)
    captures.cursorMoved('tab_a')
    const moved = await cursor
    expect(moved.picture).toBeUndefined()
    expect(moved.stateSeq).toBeGreaterThan(got.stateSeq)
    const starts = count('Page.startScreencast', 'cdp-a')
    const commit = ask(captures, TAB_A, 'w1', moved)
    await vi.advanceTimersByTimeAsync(0)
    captures.committed('cdp-a', 'https://a.example/next')
    const committed = await after(commit)
    expect(committed).toMatchObject({ url: 'https://a.example/next' })
    expect(count('Page.startScreencast', 'cdp-a')).toBe(starts + 1)
    // The session knows the new address from then on.
    const titled = ask(captures, { ...TAB_A, url: 'https://a.example/next' }, 'w1', committed)
    await vi.advanceTimersByTimeAsync(0)
    captures.titled('cdp-a', 'Next')
    expect((await after(titled)).title).toBe('Next')
    captures.dispose()
  })

  it('a watcher that moves to another tab gets that tab\'s picture at once, and a second request answers the first', async () => {
    const { cdp, paint } = fakeCdp()
    const captures = new ViewerCaptures(cdp, { behind: () => false })
    const stateA = await join(captures, TAB_A, 'w1')
    const a = ask(captures, TAB_A, 'w1', stateA)
    paint('cdp-a', 'A1')
    const seenA = await after(a)
    // Another watcher keeps tab B's capture, with a picture painted before.
    const stateB = await join(captures, TAB_B, 'other')
    const b = ask(captures, TAB_B, 'other', stateB)
    paint('cdp-b', 'B1')
    await after(b)
    const pending = ask(captures, TAB_A, 'w1', seenA)
    await vi.advanceTimersByTimeAsync(0)
    const moved = await after(ask(captures, TAB_B, 'w1', seenA))
    expect(moved.picture?.data).toBe('B1@60')
    expect(await pending).toMatchObject({ idle: true })
    captures.dispose()
  })

  it('answers a reader that asks each time (the older view) from the same capture', async () => {
    const { cdp, paint, acks } = fakeCdp()
    const captures = new ViewerCaptures(cdp, { behind: () => false })
    expect((await after(captures.latest(TAB_A, 960))).picture).toBeUndefined()
    const f1 = paint('cdp-a', 'P1')
    expect((await after(captures.latest(TAB_A, 960))).picture?.data).toBe('P1@60')
    expect(acks()).toContain(f1)
    captures.dispose()
  })
})

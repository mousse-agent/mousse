/**
 * The screencast behind a bot's browser view: pictures arrive as the page paints, each is
 * acknowledged as it arrives (never after a viewer reads it), the latest is what a viewer gets, and
 * the screencast moves with the watched tab and stops once nobody watches.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CdpEventListener, CdpTransport } from '../src/browser-worker/cdp/transport'
import { TabScreencast } from '../src/browser-worker/observation/screencast'

function fakeCdp() {
  const listeners = new Map<string, Set<CdpEventListener>>()
  const sent: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = []
  const cdp: CdpTransport = {
    connected: true,
    async send<T>(method: string, params?: Record<string, unknown>, options?: { sessionId?: string }) {
      sent.push({ method, params, sessionId: options?.sessionId })
      return {} as T
    },
    on(event, listener) { (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(listener) },
    off(event, listener) { listeners.get(event)?.delete(listener) }
  }
  const paint = (sessionId: string, frame: number, data: string) => {
    for (const listener of listeners.get('Page.screencastFrame') ?? []) listener({ data, sessionId: frame, metadata: { deviceWidth: 960, deviceHeight: 540 } }, sessionId)
  }
  return { cdp, sent, paint, listeners }
}

afterEach(() => { vi.useRealTimers() })

describe('a watched tab\'s screencast', () => {
  it('starts on the first picture asked for, acknowledges each paint as it arrives and keeps the latest', async () => {
    const { cdp, sent, paint } = fakeCdp()
    const cast = new TabScreencast(cdp, { now: () => 1_000 })
    // Nothing painted yet: the caller takes a picture itself.
    expect(await cast.watch('tab-a', 960)).toBeUndefined()
    // Stopped first, then started: a screencast left "active" by a page that committed is restarted.
    expect(sent.map((entry) => entry.method)).toEqual(['Page.stopScreencast', 'Page.startScreencast'])
    expect(sent[1]).toEqual({ method: 'Page.startScreencast', params: expect.objectContaining({ format: 'jpeg', maxWidth: 960 }), sessionId: 'tab-a' })
    paint('tab-a', 1, 'AAA')
    paint('tab-a', 2, 'BBB')
    expect(sent.filter((entry) => entry.method === 'Page.screencastFrameAck')).toEqual([
      { method: 'Page.screencastFrameAck', params: { sessionId: 1 }, sessionId: 'tab-a' },
      { method: 'Page.screencastFrameAck', params: { sessionId: 2 }, sessionId: 'tab-a' }
    ])
    // The latest painted picture.
    expect(await cast.watch('tab-a', 960)).toEqual({ data: 'BBB', at: 1_000 })
    // Asking again does not start it again.
    expect(sent.filter((entry) => entry.method === 'Page.startScreencast')).toHaveLength(1)
    cast.dispose()
  })

  it('moves to another tab (stopping the first), forgets a closed tab and stops once nobody watches', async () => {
    vi.useFakeTimers()
    const { cdp, sent, paint, listeners } = fakeCdp()
    const cast = new TabScreencast(cdp, { idleMs: 1_000 })
    await cast.watch('tab-a', 960)
    paint('tab-a', 1, 'AAA')
    await cast.watch('tab-b', 960)
    expect(sent).toContainEqual({ method: 'Page.stopScreencast', params: {}, sessionId: 'tab-a' })
    // A late paint of the first tab is acknowledged but never shown for the second.
    paint('tab-a', 2, 'LATE')
    expect(await cast.watch('tab-b', 960)).toBeUndefined()
    paint('tab-b', 1, 'BBB')
    expect((await cast.watch('tab-b', 960))?.data).toBe('BBB')
    cast.forget('tab-b')
    expect(await cast.watch('tab-b', 960)).toBeUndefined()
    expect(sent.filter((entry) => entry.method === 'Page.startScreencast' && entry.sessionId === 'tab-b')).toHaveLength(2)
    // Nobody asks for a second: the screencast stops.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent.at(-1)).toEqual({ method: 'Page.stopScreencast', params: {}, sessionId: 'tab-b' })
    cast.dispose()
    expect(listeners.get('Page.screencastFrame')?.size).toBe(0)
  })

  it('a picture over two seconds old is not served: the caller takes one, which is kept until the page paints', async () => {
    let now = 1_000
    const { cdp, sent, paint } = fakeCdp()
    const cast = new TabScreencast(cdp, { now: () => now })
    await cast.watch('tab-a', 960)
    paint('tab-a', 1, 'AAA')
    now = 3_000
    expect((await cast.watch('tab-a', 960))?.data).toBe('AAA')
    now = 3_001
    expect(await cast.watch('tab-a', 960)).toBeUndefined()
    cast.keep('tab-a', 'TAKEN')
    expect(await cast.watch('tab-a', 960)).toEqual({ data: 'TAKEN', at: 3_001 })
    paint('tab-a', 2, 'BBB')
    expect((await cast.watch('tab-a', 960))?.data).toBe('BBB')
    // A picture of another tab is not kept for the watched one; the screencast was never restarted.
    cast.keep('tab-b', 'OTHER')
    expect((await cast.watch('tab-a', 960))?.data).toBe('BBB')
    expect(sent.filter((entry) => entry.method === 'Page.startScreencast')).toHaveLength(1)
    cast.dispose()
  })

  it('a tab that cannot screencast leaves the picture to the caller', async () => {
    const { cdp } = fakeCdp()
    cdp.send = async () => { throw new Error('Page.startScreencast is not supported') }
    const cast = new TabScreencast(cdp)
    expect(await cast.watch('tab-a', 960)).toBeUndefined()
    cast.dispose()
  })
})

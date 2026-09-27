import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { navigateAndWaitForLoad } from '../src/browser-worker/action/dispatch'
import type { CdpTransport } from '../src/browser-worker/cdp/transport'

class NavigationTransport extends EventEmitter implements CdpTransport {
  connected = true
  navigate = vi.fn<() => Promise<unknown>>(() => Promise.resolve({ frameId: 'main', loaderId: 'new' }))
  async send<T>(method: string): Promise<T> {
    return (method === 'Page.navigate' ? await this.navigate() : {}) as T
  }
  load(frameId = 'main', loaderId = 'new', sessionId = 'tab', name = 'load'): void {
    this.emit('Page.lifecycleEvent', { name, frameId, loaderId }, sessionId)
  }
}
const flush = async () => { for (let n = 0; n < 5; n++) await Promise.resolve() }
afterEach(() => vi.useRealTimers())

describe('initial navigation readiness', () => {
  it('rejects stale documents, child frames, other sessions and incomplete document events', async () => {
    const cdp = new NavigationTransport()
    let completed = false
    const waiting = navigateAndWaitForLoad(cdp, 'tab', 'https://fixture.test', 1000).then(() => { completed = true })
    await flush()
    cdp.load('main', 'about-blank')
    cdp.load('child', 'new')
    cdp.load('main', 'new', 'other-tab')
    cdp.load('main', 'new', 'tab', 'DOMContentLoaded')
    await flush()
    expect(completed).toBe(false)
    cdp.load()
    await waiting
    expect(completed).toBe(true)
    expect(cdp.listenerCount('Page.lifecycleEvent')).toBe(0)
  })

  it('retains a matching load that arrives before the navigate command response', async () => {
    const cdp = new NavigationTransport()
    cdp.navigate.mockImplementation(async () => {
      cdp.load('main', 'old')
      cdp.load()
      return { frameId: 'main', loaderId: 'new' }
    })
    await navigateAndWaitForLoad(cdp, 'tab', 'https://fixture.test', 1000)
    expect(cdp.listenerCount('Page.lifecycleEvent')).toBe(0)
  })

  it('times out without publishing a ready document and removes its listener', async () => {
    vi.useFakeTimers()
    const cdp = new NavigationTransport()
    const waiting = expect(navigateAndWaitForLoad(cdp, 'tab', 'https://fixture.test', 25)).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(25)
    await waiting
    expect(cdp.listenerCount('Page.lifecycleEvent')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels an in-flight navigation and removes its listener and timer', async () => {
    vi.useFakeTimers()
    const cdp = new NavigationTransport()
    const abort = new AbortController()
    const waiting = expect(navigateAndWaitForLoad(cdp, 'tab', 'https://fixture.test', 1000, abort.signal)).rejects.toMatchObject({ code: 'cancelled' })
    await flush()
    abort.abort()
    await waiting
    expect(cdp.listenerCount('Page.lifecycleEvent')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handles same-document commits and navigation errors without waiting for a new loader', async () => {
    const cdp = new NavigationTransport()
    cdp.navigate.mockResolvedValueOnce({ frameId: 'main' })
    await navigateAndWaitForLoad(cdp, 'tab', 'https://fixture.test/#hash', 1000)
    cdp.navigate.mockResolvedValueOnce({ frameId: 'main', errorText: 'net::ERR_NAME_NOT_RESOLVED' })
    await expect(navigateAndWaitForLoad(cdp, 'tab', 'https://fixture.test', 1000)).rejects.toMatchObject({ code: 'not_actionable' })
    expect(cdp.listenerCount('Page.lifecycleEvent')).toBe(0)
  })
})

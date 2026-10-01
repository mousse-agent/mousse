import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserViewerSnapshot } from '../src/shared/browser/viewer'
import type { PlatformRequestApi } from '../src/shared/platform'
import { createBrowserViewerClient } from '../src/renderer/components/browserAutomation/createBrowserViewerClient'

const empty = (): BrowserViewerSnapshot => ({ mode: 'managed', tabs: [], connection: 'disconnected', history: [], artifacts: [], updatedAt: new Date().toISOString() })
afterEach(() => vi.restoreAllMocks())

describe('profile-scoped browser viewer client', () => {
  it('pins every viewer request to its mounted profile/thread and removes subscriptions on dispose', async () => {
    const request = vi.fn(async () => empty())
    const client = createBrowserViewerClient({ request } as PlatformRequestApi, 'profile-a', 'thread-a')
    const listener = vi.fn()
    client.subscribe(listener)
    await client.takeControl({ sessionId: 'session-a' })
    expect(request).toHaveBeenCalledWith('browser.sessions.takeControl', { profileId: 'profile-a', threadId: 'thread-a', sessionId: 'session-a' })
    expect(listener).toHaveBeenCalledTimes(1)
    client.dispose()
    await expect(client.snapshot()).rejects.toThrow('closed')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects a late response after profile switch instead of publishing it to a replacement viewer', async () => {
    let complete!: (snapshot: BrowserViewerSnapshot) => void
    const request = vi.fn(() => new Promise<BrowserViewerSnapshot>((resolve) => { complete = resolve }))
    const client = createBrowserViewerClient({ request } as PlatformRequestApi, 'profile-a', 'thread-a')
    const listener = vi.fn()
    client.subscribe(listener)
    const pending = client.snapshot()
    client.dispose()
    complete(empty())
    await expect(pending).rejects.toThrow('closed')
    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects a returned session owned by another thread before reading its artifacts', async () => {
    const request = vi.fn(async () => ({ ...empty(), session: { profileId: 'profile-a', threadId: 'thread-b' } }))
    const client = createBrowserViewerClient({ request } as unknown as PlatformRequestApi, 'profile-a', 'thread-a')
    await expect(client.snapshot()).rejects.toThrow('owner changed')
    expect(request).toHaveBeenCalledTimes(1)
    client.dispose()
  })
})

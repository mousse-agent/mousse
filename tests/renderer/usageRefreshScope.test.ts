// @vitest-environment jsdom
/**
 * Which providers the Usage page reads: opening it reads only the providers not read in the last ten
 * minutes (the others show their last reading); a card's own Refresh reads that provider alone; Refresh
 * all reads every one, recent or not.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderUsage, UsageSlot } from '../../src/shared/providerAuth'

vi.mock('../../src/renderer/lib/providerSnapshots', async (original) => ({
  ...(await original<typeof import('../../src/renderer/lib/providerSnapshots')>()),
  onProviderSignInChanged: () => () => {}
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { SubscriptionUsagePage } = await import('../../src/renderer/components/SubscriptionUsagePage')
const { useAppStore } = await import('../../src/renderer/stores/appStore')

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const plan = (id: string, label: string, remainingPercent: number): ProviderUsage => ({ id, label, status: 'available', windows: [{ id: 'seven_day', label: 'Weekly limit', remainingPercent }] })

// Inputs: read 2 minutes ago (kept), read 25 minutes ago (read), never read (read).
const recent = plan('codex:chatgpt-subscription', 'ChatGPT subscription', 40)
const stale = plan('openrouter', 'OpenRouter', 70)
const unread = plan('zai', 'Z.ai', 90)
const slots: UsageSlot[] = [
  { id: recent.id, label: recent.label, cached: recent, cachedAt: minutesAgo(2) },
  { id: stale.id, label: stale.label, cached: stale, cachedAt: minutesAgo(25) },
  { id: unread.id, label: unread.label }
]
const fresh: Record<string, ProviderUsage> = { [recent.id]: plan(recent.id, recent.label, 35), [stale.id]: plan(stale.id, stale.label, 65), [unread.id]: plan(unread.id, unread.label, 85) }
const getUsageFor = vi.fn(async ({ providerId }: { providerId: string }) => ({ provider: fresh[providerId] }))
let root: Root | undefined
let host: HTMLElement | undefined

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('mousse.usage.tab', 'limits')
  getUsageFor.mockClear()
  useAppStore.setState({ profileId: 'prf_work' })
  ;(window as unknown as { mousse: unknown }).mousse = {
    providers: {
      usageSlots: async () => ({ slots }),
      getUsageFor,
      instances: { setEnabled: vi.fn() },
      openLoginUrl: vi.fn(),
      setUsageProxyKey: vi.fn(),
      clearUsageProxyKey: vi.fn()
    }
  }
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
  vi.useRealTimers()
})

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const readIds = () => getUsageFor.mock.calls.map(([request]) => request.providerId).sort()

async function open() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(createElement(SubscriptionUsagePage, { onClose: () => {} })) })
  await settle()
}

const card = (label: string) => [...document.querySelectorAll<HTMLElement>('.usage-provider')].find((element) => element.textContent?.includes(label))
const shownRemaining = (label: string) => card(label)?.querySelector('[data-testid="usage-window"]')?.getAttribute('data-remaining')

describe('reading the usage', () => {
  it('opens by reading only the providers not read in the last ten minutes', async () => {
    await open()
    expect(readIds()).toEqual([stale.id, unread.id].sort())
    // The recent one shows its last reading, not a skeleton.
    expect(shownRemaining('ChatGPT subscription')).toBe('40')
    expect(shownRemaining('OpenRouter')).toBe('65')
    expect(document.querySelector('[data-testid="usage-card-loading"]')).toBeNull()
  })

  it("reads one provider alone from its card's Refresh", async () => {
    await open()
    getUsageFor.mockClear()
    const button = card('ChatGPT subscription')!.querySelector<HTMLButtonElement>('[data-testid="usage-provider-refresh"]')!
    await act(async () => { button.click() })
    await settle()
    expect(readIds()).toEqual([recent.id])
    expect(shownRemaining('ChatGPT subscription')).toBe('35')
  })

  it('refreshes only the selected provider from an Other usage row', async () => {
    getUsageFor.mockImplementationOnce(async () => ({ provider: { ...fresh[stale.id]!, authType: 'api_key' } }))
    await open()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="usage-section-usage-other"] button')!.click()
    })
    getUsageFor.mockClear()
    const button = document.querySelector<HTMLButtonElement>('[data-testid="usage-other-row"] [data-testid="usage-provider-refresh"]')!
    await act(async () => { button.click() })
    expect(readIds()).toEqual([stale.id])
  })

  it('skips a recent provider on the automatic timer until its reading is ten minutes old', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(new Date(Date.parse(slots[0]!.cachedAt!) + 2 * 60_000))
    await open()
    getUsageFor.mockClear()
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000) })
    expect(readIds()).not.toContain(recent.id)
    getUsageFor.mockClear()
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000) })
    expect(readIds()).toContain(recent.id)
  })

  it('reads every provider, recent ones too, from Refresh all', async () => {
    await open()
    getUsageFor.mockClear()
    const all = document.querySelector<HTMLButtonElement>('[data-testid="usage-refresh"]')!
    expect(all.textContent).toContain('Refresh all')
    await act(async () => { all.click() })
    await settle()
    expect(readIds()).toEqual([recent.id, stale.id, unread.id].sort())
  })
})

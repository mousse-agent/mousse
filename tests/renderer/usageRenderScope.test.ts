// @vitest-environment jsdom
/**
 * While the Usage page reads every provider, each answer re-renders that provider's card or row only.
 * Re-rendering the whole page per answer made the lists' open and close motion stutter.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderUsage, UsageForResponse, UsageSlot } from '../../src/shared/providerAuth'

// Renders counted by the provider or window they draw.
const renders = new Map<string, number>()
const count = (key: string) => renders.set(key, (renders.get(key) ?? 0) + 1)
vi.mock('../../src/renderer/components/UsageBar', () => ({
  UsageBar: ({ label }: { label: string }) => { count(`bar:${label}`); return null }
}))
vi.mock('../../src/renderer/components/UsageRowMenu', () => ({
  UsageRowMenu: ({ provider }: { provider: ProviderUsage }) => { count(`row:${provider.id}`); return null }
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { SubscriptionUsagePage } = await import('../../src/renderer/components/SubscriptionUsagePage')
const { useAppStore } = await import('../../src/renderer/stores/appStore')

const plan = (id: string, label: string, remainingPercent: number, instanceId?: string): ProviderUsage =>
  ({ id, label, status: 'available', windows: [{ id: 'seven_day', label: `${label} weekly`, remainingPercent }], ...(instanceId ? { instanceId } : {}) })
const key = (id: string, label: string, balanceUsd: number): ProviderUsage =>
  ({ id, label, authType: 'api_key', status: 'available', windows: [], credit: { balanceUsd } })

const slots: UsageSlot[] = [
  { id: 'claude', label: 'Claude', cached: plan('claude', 'Claude', 40) },
  { id: 'codex', label: 'Codex', instanceId: 'codex-work', cached: plan('codex', 'Codex', 50) },
  { id: 'gateway', label: 'Gateway', authType: 'api_key', cached: key('gateway', 'Gateway', 10) },
  { id: 'router', label: 'Router', authType: 'api_key', cached: key('router', 'Router', 20) },
  { id: 'gemini', label: 'Gemini', cached: plan('gemini', 'Gemini', 60) }
]

// Each provider's read waits until the test answers it.
const answers = new Map<string, (response: UsageForResponse) => void>()
let root: Root | undefined
let host: HTMLElement | undefined

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('mousse.usage.section.other', 'open')
  renders.clear()
  answers.clear()
  useAppStore.setState({ profileId: 'prf_work' })
  ;(window as unknown as { mousse: unknown }).mousse = {
    providers: {
      usageSlots: async () => ({ slots }),
      getUsageFor: ({ providerId }: { providerId: string }) => new Promise<UsageForResponse>((resolve) => answers.set(providerId, resolve)),
      onSnapshots: () => () => {},
      instances: { setEnabled: vi.fn() },
      openLoginUrl: vi.fn(),
      setUsageProxyKey: vi.fn(),
      clearUsageProxyKey: vi.fn(),
      useLimitReset: vi.fn()
    }
  }
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
})

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const answer = async (provider: ProviderUsage) => {
  await act(async () => { answers.get(provider.id)!({ provider }) })
  await settle()
}

describe('a refresh, one answer at a time', () => {
  it('re-renders only the card or row whose provider answered', async () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    // A parent that re-renders hands the page a new onClose each time, as App does.
    const page = () => createElement(SubscriptionUsagePage, { onClose: () => {} })
    await act(async () => { root!.render(page()) })
    await settle()
    expect([...answers.keys()].sort()).toEqual(['claude', 'codex', 'gateway', 'gemini', 'router'])
    expect(document.querySelectorAll('[data-testid="usage-other-row"]')).toHaveLength(2)

    // Gemini stays unanswered, so the read is not over and nothing page-wide (the reading time) changes.
    renders.clear()
    await answer(plan('claude', 'Claude', 35))
    expect(Object.fromEntries(renders)).toEqual({ 'bar:Claude weekly': 1 })

    // A provider with a Settings entry of its own keeps its object too.
    renders.clear()
    await answer(plan('codex', 'Codex', 45))
    expect(Object.fromEntries(renders)).toEqual({ 'bar:Codex weekly': 1 })

    renders.clear()
    await answer(key('gateway', 'Gateway', 9))
    expect(Object.fromEntries(renders)).toEqual({ 'row:gateway': 1 })

    // The app re-rendering the page (a stream, a sidebar push) re-renders no card or row.
    renders.clear()
    await act(async () => { root!.render(page()) })
    expect(Object.fromEntries(renders)).toEqual({})
  })
})

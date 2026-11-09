// @vitest-environment jsdom
/**
 * The Usage page reads again when a provider signs in, out or to another account: a provider that
 * signs in leaves Needs attention for its own section, and the page stops listening when it closes.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderUsage } from '../../src/shared/providerAuth'

let signInChanged: (() => void) | undefined
const stopListening = vi.fn()
vi.mock('../../src/renderer/lib/providerSnapshots', async (original) => ({
  ...(await original<typeof import('../../src/renderer/lib/providerSnapshots')>()),
  onProviderSignInChanged: (changed: () => void) => { signInChanged = changed; return stopListening }
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { SubscriptionUsagePage } = await import('../../src/renderer/components/SubscriptionUsagePage')
const { useAppStore } = await import('../../src/renderer/stores/appStore')

const signedOut: ProviderUsage = { id: 'codex:chatgpt-subscription', label: 'ChatGPT subscription', status: 'unavailable', windows: [], signedOut: true, message: 'Signed out' }
const signedIn: ProviderUsage = { id: 'codex:chatgpt-subscription', label: 'ChatGPT subscription', status: 'available', windows: [{ id: 'seven_day', label: 'Weekly limit', remainingPercent: 58 }] }
let current = signedOut
const usageSlots = vi.fn(async () => ({ slots: [{ id: current.id, label: current.label, ...(current.signedOut ? { signedOut: true } : {}) }] }))
let root: Root | undefined
let host: HTMLElement | undefined

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('mousse.usage.section.attention', 'open')
  current = signedOut
  usageSlots.mockClear()
  stopListening.mockClear()
  useAppStore.setState({ profileId: 'prf_work' })
  ;(window as unknown as { mousse: unknown }).mousse = {
    providers: {
      usageSlots,
      getUsageFor: async () => ({ provider: current }),
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
})

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

describe('a sign-in change', () => {
  it('reads again, and a provider that signed in moves from Needs attention to its section', async () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root!.render(createElement(SubscriptionUsagePage, { onClose: () => {} })) })
    await settle()
    expect(document.querySelector('[data-testid="usage-attention-row"]')?.textContent).toContain('Signed out')
    expect(document.querySelectorAll('.usage-provider')).toHaveLength(0)
    expect(usageSlots).toHaveBeenCalledTimes(1)

    current = signedIn
    await act(async () => { signInChanged!() })
    await settle()
    expect(usageSlots).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-testid="usage-attention-row"]')).toBeNull()
    expect(document.querySelector('.usage-provider .settings-group-title')?.textContent).toBe('ChatGPT subscription')
    // It arrives with the page's fade, not by jumping in.
    expect(document.querySelector('.usage-provider')?.className).toContain('usage-enter')
  })

  it('stops listening when the page closes', async () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root!.render(createElement(SubscriptionUsagePage, { onClose: () => {} })) })
    await settle()
    act(() => root!.unmount())
    root = undefined
    expect(stopListening).toHaveBeenCalledTimes(1)
  })
})

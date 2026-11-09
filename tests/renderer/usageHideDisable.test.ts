// @vitest-environment jsdom
/**
 * Other usage and Needs attention rows can be hidden from the Usage page (a personal preference of
 * the profile, with Undo) or the provider turned off with Settings' own switch, after a question.
 * Hidden rows wait behind "N hidden · Show".
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderUsage } from '../../src/shared/providerAuth'

const toasts: Array<{ message: string; action?: { label: string; run: () => void } }> = []
vi.mock('../../src/renderer/components/ui/Toast', () => ({ showToast: (input: (typeof toasts)[number]) => { toasts.push(input); return toasts.length } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { SubscriptionUsagePage } = await import('../../src/renderer/components/SubscriptionUsagePage')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { readHiddenUsage, writeHiddenUsage } = await import('../../src/renderer/lib/usageHidden')

const providers: ProviderUsage[] = [
  { id: 'claude-subscription', label: 'Claude subscription', status: 'available', windows: [{ id: 'seven_day', label: 'Weekly limit', remainingPercent: 58 }] },
  { id: 'xai', label: 'Grok (xAI)', authType: 'oauth', status: 'error', windows: [], problem: 'session_expired', message: 'Grok session expired.' },
  { id: 'opencode-go', label: 'OpenCode Go', authType: 'api_key', status: 'error', windows: [], problem: 'key_expired', message: 'x' },
  { id: 'vercel-ai-gateway', label: 'Vercel AI Gateway', authType: 'api_key', status: 'available', windows: [], credit: { balanceUsd: 4.39, usedUsd: 30.61 } }
]
// The Settings entry each one lists with, as the daemon's usage slots name it.
const instanceIds: Record<string, string> = { 'claude-subscription': 'claude', xai: 'pi:xai', 'opencode-go': 'pi:opencode-go', 'vercel-ai-gateway': 'pi:vercel-ai-gateway' }
const setEnabled = vi.fn(async () => ({}))
let root: Root | undefined
let host: HTMLElement | undefined

beforeEach(() => {
  localStorage.clear()
  toasts.length = 0
  setEnabled.mockClear()
  // Both lists open, so their rows can be reached.
  localStorage.setItem('mousse.usage.section.other', 'open')
  localStorage.setItem('mousse.usage.section.attention', 'open')
  useAppStore.setState({ profileId: 'prf_work' })
  ;(window as unknown as { mousse: unknown }).mousse = {
    providers: {
      usageSlots: async () => ({ slots: providers.map((provider) => ({ id: provider.id, label: provider.label, instanceId: instanceIds[provider.id], ...(provider.authType ? { authType: provider.authType } : {}) })) }),
      getUsageFor: async ({ providerId, preview }: { providerId: string; preview?: boolean }) => (preview ? {} : { provider: providers.find((provider) => provider.id === providerId) }),
      instances: { setEnabled },
      onSnapshots: () => () => {},
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

async function render() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(createElement(SubscriptionUsagePage, { onClose: () => {} })) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const rowNames = (testId: string) => [...document.querySelectorAll(`[data-testid="${testId}"] .usage-slim-name`)].map((name) => name.textContent)
const openMenu = (label: string) => act(() => (document.querySelector(`[aria-label="${label} options"]`) as HTMLElement).click())
const item = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === text)!

describe('Hide from Usage', () => {
  it('takes the row off the page, keeps that for the profile, and offers Undo', async () => {
    await render()
    expect(rowNames('usage-attention-row')).toEqual(['Grok (xAI)', 'OpenCode Go'])
    openMenu('Grok (xAI)')
    act(() => item('Hide from Usage').click())
    expect(rowNames('usage-attention-row')).toEqual(['OpenCode Go'])
    expect([...readHiddenUsage('prf_work')]).toEqual(['xai'])
    expect(readHiddenUsage('prf_other').size).toBe(0)
    expect(toasts.at(-1)).toMatchObject({ message: 'Hidden', action: { label: 'Undo' } })
    act(() => toasts.at(-1)!.action!.run())
    expect(rowNames('usage-attention-row')).toEqual(['Grok (xAI)', 'OpenCode Go'])
    expect(readHiddenUsage('prf_work').size).toBe(0)
  })

  it('"2 hidden · Show" reveals them dimmed, each with Unhide; it stays hidden after reopening', async () => {
    writeHiddenUsage('prf_work', new Set(['xai', 'vercel-ai-gateway']))
    await render()
    expect(document.querySelector('[data-testid="usage-hidden-footer"]')?.textContent).toBe('2 hidden · Show')
    expect(rowNames('usage-attention-row')).toEqual(['OpenCode Go'])
    expect(rowNames('usage-other-row')).toEqual([])
    act(() => (document.querySelector('[data-testid="usage-hidden-toggle"]') as HTMLElement).click())
    expect(rowNames('usage-attention-row')).toEqual(['Grok (xAI)', 'OpenCode Go'])
    expect(document.querySelectorAll('.usage-row-slot.is-hidden')).toHaveLength(2)
    openMenu('Grok (xAI)')
    act(() => item('Unhide').click())
    expect([...readHiddenUsage('prf_work')]).toEqual(['vercel-ai-gateway'])
    expect(document.querySelector('[data-testid="usage-hidden-footer"]')?.textContent).toBe('1 hidden · Hide')
  })
})

describe('Disable provider', () => {
  it('asks first, then turns it off with the Settings switch for this computer', async () => {
    await render()
    openMenu('OpenCode Go')
    act(() => item('Disable provider').click())
    expect(document.body.textContent).toContain('Disable OpenCode Go?')
    expect(document.body.textContent).toContain("It won't be offered for new threads. You can turn it back on in Settings.")
    expect(setEnabled).not.toHaveBeenCalled()
    await act(async () => { (document.querySelector('[data-testid="usage-disable-confirm"]') as HTMLElement).click() })
    expect(setEnabled).toHaveBeenCalledWith('pi:opencode-go', { kind: 'device' }, false)
  })

  it('Cancel turns nothing off', async () => {
    await render()
    openMenu('Grok (xAI)')
    act(() => item('Disable provider').click())
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Cancel')!
    act(() => cancel.click())
    expect(setEnabled).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Disable Grok (xAI)?')
  })
})

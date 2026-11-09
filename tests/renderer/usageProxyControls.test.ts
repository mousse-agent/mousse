// @vitest-environment jsdom
/**
 * A Claude card read through a CLI API proxy: a detected proxy without a key offers "Enter proxy key"
 * in place; the key field saves on Enter and cancels on Escape, says "Saving…" while it waits and a
 * few words when the proxy says no; the gear opens the card's usage settings. The key never comes
 * back to the window: the card only learns whether one is saved.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubscriptionUsageView } from '../../src/renderer/components/SubscriptionUsagePage'
import type { ProviderUsage, UsageProxyKeyResult } from '../../src/shared/providerAuth'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.parse('2026-11-08T12:00:00Z')
const claude = (proxy: ProviderUsage['proxy'], windows: ProviderUsage['windows'] = []): ProviderUsage => ({
  id: 'claude-subscription',
  label: 'Claude Subscription',
  status: windows.length ? 'available' : 'unavailable',
  windows,
  source: 'via local proxy',
  message: 'Limits unavailable (proxy). Set CLIPROXY_MANAGEMENT_KEY to show them.',
  ...(proxy ? { proxy } : {})
})

let root: Root | undefined
let host: HTMLElement | undefined
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  document.body.innerHTML = ''
  root = undefined
})

function render(provider: ProviderUsage, handlers: { save?: (id: string, key: string) => Promise<UsageProxyKeyResult>; clear?: () => Promise<void>; refresh?: () => void } = {}) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const onSaveProxyKey = vi.fn(handlers.save ?? (async () => ({ ok: true as const })))
  const onClearProxyKey = vi.fn(handlers.clear ?? (async () => {}))
  const onRefresh = vi.fn(handlers.refresh ?? (() => {}))
  act(() => root!.render(createElement(SubscriptionUsageView, {
    usage: { providers: [provider], fetchedAt: '2026-11-08T11:59:00Z' },
    loading: false, failed: false, now: NOW,
    onBack: () => {}, onRefresh, onManage: () => {}, onSaveProxyKey, onClearProxyKey
  })))
  return { onSaveProxyKey, onClearProxyKey, onRefresh }
}
const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
const type = (input: HTMLInputElement, value: string) => act(() => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const key = (target: HTMLElement, name: string) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })) })

describe('a detected proxy without a key', () => {
  it('says so in one muted line with an Enter proxy key action, and no "via local proxy" in the title', () => {
    render(claude({ address: '100.101.102.103:8317', key: 'none' }))
    expect(q('usage-proxy-note')?.textContent).toContain('Detected CLI API proxy')
    expect(q('usage-proxy-enter')?.textContent).toBe('Enter proxy key')
    expect(document.querySelector('.settings-group-title')?.textContent).toBe('Claude Subscription')
    expect(document.body.textContent).not.toMatch(/via local proxy|Proxy key missing|CLIPROXY_MANAGEMENT_KEY/)
    expect(q('usage-settings')?.getAttribute('title')).toBe('Usage settings')
  })

  it('Enter saves, the button says Saving… meanwhile, and a working key refreshes the card', async () => {
    let finish: (result: UsageProxyKeyResult) => void = () => {}
    const { onSaveProxyKey, onRefresh } = render(claude({ address: '100.101.102.103:8317', key: 'none' }), { save: () => new Promise((resolve) => { finish = resolve }) })
    act(() => q('usage-proxy-enter')!.click())
    const input = q('usage-proxy-form')!.querySelector('input')!
    expect(input.type).toBe('password')
    expect(document.activeElement).toBe(input)
    type(input, 'mgmt-key')
    key(input, 'Enter')
    expect(onSaveProxyKey).toHaveBeenCalledWith('claude-subscription', 'mgmt-key')
    expect(q('usage-proxy-save')?.textContent).toBe('Saving…')
    await act(async () => finish({ ok: true }))
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(q('usage-proxy-form')).toBeNull()
  })

  it('a refused key or an unreachable proxy is said in a few words, and the field stays', async () => {
    const answers: UsageProxyKeyResult[] = [{ ok: false, reason: 'rejected' }, { ok: false, reason: 'unreachable' }]
    const { onRefresh } = render(claude({ address: '100.101.102.103:8317', key: 'none' }), { save: async () => answers.shift()! })
    act(() => q('usage-proxy-enter')!.click())
    const input = q('usage-proxy-form')!.querySelector('input')!
    type(input, 'wrong')
    await act(async () => { key(input, 'Enter') })
    expect(q('usage-proxy-error')?.textContent).toBe('Key rejected')
    await act(async () => { q('usage-proxy-save')!.click() })
    expect(q('usage-proxy-error')?.textContent).toBe('Proxy not reachable')
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('Escape cancels the field without saving', () => {
    const { onSaveProxyKey } = render(claude({ address: '100.101.102.103:8317', key: 'none' }))
    act(() => q('usage-proxy-enter')!.click())
    key(q('usage-proxy-form')!.querySelector('input')!, 'Escape')
    expect(q('usage-proxy-form')).toBeNull()
    expect(q('usage-proxy-enter')).not.toBeNull()
    expect(onSaveProxyKey).not.toHaveBeenCalled()
  })
})

describe('a working key', () => {
  const working = claude({ address: '100.101.102.103:8317', key: 'saved' }, [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 63 }])

  it('shows the limits; the proxy is named only in the gear tooltip', () => {
    render(working)
    expect(q('usage-proxy-note')).toBeNull()
    expect(document.querySelectorAll('[data-testid="usage-window"]')).toHaveLength(1)
    expect(q('usage-settings')?.getAttribute('title')).toBe('Usage settings · via CLI API proxy')
    expect(document.body.textContent).not.toMatch(/via (local|CLI API) proxy/)
  })

  it('the gear opens the usage settings: the proxy address, the key masked with Change and Remove', async () => {
    const { onClearProxyKey, onRefresh } = render(working)
    act(() => q('usage-settings')!.click())
    const popover = q('usage-settings-popover')!
    expect(q('usage-settings-address')?.textContent).toBe('100.101.102.103:8317')
    expect(popover.textContent).toContain('••••••••')
    const remove = [...popover.querySelectorAll('button')].find((button) => button.textContent === 'Remove')!
    await act(async () => remove.click())
    expect(onClearProxyKey).toHaveBeenCalledWith('claude-subscription')
    expect(onRefresh).toHaveBeenCalled()
  })

  it("a key from Claude's environment is shown as such, with nothing to change here", () => {
    render(claude({ address: '100.101.102.103:8317', key: 'environment' }, working.windows))
    act(() => q('usage-settings')!.click())
    const popover = q('usage-settings-popover')!
    expect(popover.textContent).toContain("From Claude's environment")
    expect([...popover.querySelectorAll('button')].map((button) => button.textContent)).toEqual([])
  })
})

// @vitest-environment jsdom
/**
 * Using a Codex limit reset from the ChatGPT card: a reset icon in the header (there while resets are
 * left), then one inline row that asks first, says "Resetting…", and what happened. The chip stays
 * information only. Everything here is mocked: no reset is ever used.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubscriptionUsageView } from '../../src/renderer/components/SubscriptionUsagePage'
import { resetScope, soonestCredit } from '../../src/renderer/components/UsageResetAction'
import type { ProviderUsage, UseLimitResetResponse } from '../../src/shared/providerAuth'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.parse('2026-11-09T12:00:00Z')
const chatgpt = (patch: Partial<ProviderUsage> = {}): ProviderUsage => ({
  id: 'codex:chatgpt-subscription', label: 'ChatGPT subscription', plan: 'Plus', status: 'available',
  windows: [{ id: 'seven_day', label: 'Weekly limit', remainingPercent: 0, resetsAt: '2026-11-11T10:00:00Z' }],
  resets: { available: 2, credits: [
    { id: 'rc_late', title: 'Full reset', type: 'codexRateLimits', expiresAt: '2026-12-01T12:00:00Z' },
    { id: 'rc_soon', title: 'Full reset', type: 'codexRateLimits', expiresAt: '2026-11-30T12:00:00Z' }
  ] },
  ...patch
})

let root: Root | undefined
let host: HTMLElement | undefined
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
  vi.useRealTimers()
})

function render(provider: ProviderUsage, onUseReset?: (providerId: string, creditId: string | undefined) => Promise<UseLimitResetResponse>) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const onRefresh = vi.fn()
  act(() => root!.render(createElement(SubscriptionUsageView, {
    usage: { providers: [provider], fetchedAt: '2026-11-09T12:00:00Z' }, loading: false, failed: false, now: NOW,
    onBack: () => {}, onRefresh, onManage: () => {}, ...(onUseReset ? { onUseReset } : {})
  })))
  return { onRefresh }
}
const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
/** The row's state on show: its text layer that is on (the others are stacked under it, faded out). */
const shown = () => [...document.querySelectorAll('[data-testid="usage-reset-row"] .usage-reset-text > .usage-reset-layer[data-on]')].map((layer) => layer.textContent).join('|')
const buttonsShown = () => !!document.querySelector('[data-testid="usage-reset-row"] .usage-reset-actions[data-on]')

describe('the reset button', () => {
  it('sits in the header while resets are left; the chip is information only', () => {
    render(chatgpt(), vi.fn())
    expect(q('usage-reset-button')?.getAttribute('title')).toBe('Use a reset · 2 left')
    expect(q('usage-resets')?.tagName).toBe('SPAN')
    expect(q('usage-reset-row')).toBeNull()
  })

  it('is not there at 0 resets, or where resets cannot be used', () => {
    render(chatgpt({ resets: { available: 0 } }), vi.fn())
    expect(q('usage-reset-button')).toBeNull()
    act(() => root!.unmount())
    render(chatgpt())
    expect(q('usage-reset-button')).toBeNull()
  })

  it('takes a hint of accent when a limit is low', () => {
    render(chatgpt(), vi.fn())
    expect(q('usage-reset-button')?.className).toContain('is-hint')
    act(() => root!.unmount())
    render(chatgpt({ windows: [{ id: 'seven_day', label: 'Weekly limit', remainingPercent: 60 }] }), vi.fn())
    expect(q('usage-reset-button')?.className).not.toContain('is-hint')
  })
})

describe('the inline row', () => {
  it('asks first; Cancel uses nothing', () => {
    const onUseReset = vi.fn()
    render(chatgpt(), onUseReset)
    act(() => q('usage-reset-button')!.click())
    expect(shown()).toBe('Reset all Codex limits to 100%? 1 will be left.')
    expect(buttonsShown()).toBe(true)
    const cancel = [...q('usage-reset-row')!.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!
    act(() => cancel.click())
    expect(q('usage-reset-row')).toBeNull()
    expect(onUseReset).not.toHaveBeenCalled()
  })

  it('Reset now uses the credit that expires first, says "Resetting…", then "Codex limits reset" and refreshes', async () => {
    vi.useFakeTimers()
    let finish: (result: UseLimitResetResponse) => void = () => {}
    const onUseReset = vi.fn(() => new Promise<UseLimitResetResponse>((resolve) => { finish = resolve }))
    const { onRefresh } = render(chatgpt(), onUseReset)
    act(() => q('usage-reset-button')!.click())
    act(() => q('usage-reset-now')!.click())
    expect(onUseReset).toHaveBeenCalledWith('codex:chatgpt-subscription', 'rc_soon')
    expect(shown()).toBe('Resetting…')
    expect(q('usage-reset-now')).toHaveProperty('disabled', true)
    await act(async () => finish({ outcome: 'reset' }))
    expect(shown()).toBe('Codex limits reset')
    expect(buttonsShown()).toBe(false)
    expect(onRefresh).toHaveBeenCalledOnce()
    act(() => { vi.advanceTimersByTime(2600) })
    expect(q('usage-reset-row')).toBeNull()
  })

  it('an outcome that is not a reset, or a failure, is said in the row', async () => {
    const answers: Array<UseLimitResetResponse | Error> = [{ outcome: 'noCredit' }, new Error('down')]
    render(chatgpt(), vi.fn(async () => { const next = answers.shift()!; if (next instanceof Error) throw next; return next }))
    act(() => q('usage-reset-button')!.click())
    await act(async () => { q('usage-reset-now')!.click() })
    expect(q('usage-reset-problem')?.textContent).toBe(' No resets left')
    await act(async () => { q('usage-reset-now')!.click() })
    expect(q('usage-reset-problem')?.textContent).toBe(" Couldn't use the reset")
  })

  it('reads the limits again after a failure, since the reset may still have been used', async () => {
    const { onRefresh } = render(chatgpt(), vi.fn(async () => { throw new Error('timed out') }))
    act(() => q('usage-reset-button')!.click())
    await act(async () => { q('usage-reset-now')!.click() })
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it('uses one reset per answer: a second Reset now while one is out uses nothing', async () => {
    let finish: (result: UseLimitResetResponse) => void = () => {}
    const onUseReset = vi.fn(() => new Promise<UseLimitResetResponse>((resolve) => { finish = resolve }))
    render(chatgpt(), onUseReset)
    act(() => q('usage-reset-button')!.click())
    const now = q('usage-reset-now')!
    // Two clicks in the same task, before the button can be disabled.
    act(() => { now.click(); now.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onUseReset).toHaveBeenCalledOnce()
    await act(async () => finish({ outcome: 'reset' }))
  })

  it('closes with motion: keeps showing its last state while it shrinks, then goes', () => {
    vi.useFakeTimers()
    const realMatchMedia = window.matchMedia
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
    try {
      render(chatgpt(), vi.fn())
      act(() => q('usage-reset-button')!.click())
      expect(document.querySelector('.ui-collapse')?.getAttribute('data-motion')).toBe('enter')
      act(() => { vi.advanceTimersByTime(400) })
      expect(document.querySelector('.ui-collapse')?.hasAttribute('data-motion')).toBe(false)
      const cancel = [...q('usage-reset-row')!.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!
      act(() => cancel.click())
      expect(document.querySelector('.ui-collapse')?.getAttribute('data-motion')).toBe('exit')
      expect(shown()).toBe('Reset all Codex limits to 100%? 1 will be left.')
      act(() => { vi.advanceTimersByTime(400) })
      expect(q('usage-reset-row')).toBeNull()
    } finally {
      window.matchMedia = realMatchMedia
    }
  })

  it('without credit details, Codex picks the credit', () => {
    expect(soonestCredit({ available: 2 })).toBeUndefined()
    expect(soonestCredit({ available: 2, credits: [{ id: 'a' }, { id: 'b', expiresAt: '2026-11-10T00:00:00Z' }] })?.id).toBe('b')
  })
})

describe('the question names what is reset', () => {
  it("all Codex limits, one window's limit, or all limits when the type is not given", () => {
    expect(resetScope({ available: 1, credits: [{ type: 'codexRateLimits' }] })).toBe('all Codex limits')
    expect(resetScope({ available: 1, credits: [{ type: 'five_hour' }] })).toBe('the 5-hour limit')
    expect(resetScope({ available: 1, credits: [{ type: 'weekly' }] })).toBe('the Weekly limit')
    expect(resetScope({ available: 1 })).toBe('all limits')
  })
})

describe('a window with nothing left', () => {
  it('reads as empty: "0% left" in red over a faint red track', () => {
    render(chatgpt(), vi.fn())
    expect(document.querySelector('.usage-window-used')?.className).toContain('is-empty')
    expect(document.querySelector('.usage-window-used')?.textContent).toBe('0% left')
  })
})

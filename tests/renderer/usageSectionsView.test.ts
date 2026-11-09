// @vitest-environment jsdom
/**
 * The Usage page's sections: subscriptions as cards, Other usage and Needs attention as compact,
 * collapsible lists (collapsed at first, the choice kept), a header chip that opens Needs attention,
 * Reconnect that opens the provider's settings, and skeletons for providers still on their way.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubscriptionUsageView } from '../../src/renderer/components/SubscriptionUsagePage'
import type { ProviderUsage } from '../../src/shared/providerAuth'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const providers: ProviderUsage[] = [
  { id: 'claude-subscription', label: 'Claude subscription', status: 'available', windows: [{ id: 'seven_day', label: 'Weekly limit', remainingPercent: 58 }] },
  { id: 'vercel-ai-gateway', label: 'Vercel AI Gateway', authType: 'api_key', status: 'available', windows: [], credit: { balanceUsd: 12.4, usedUsd: 37.6 } },
  { id: 'codex:chatgpt-subscription', label: 'ChatGPT subscription', status: 'unavailable', windows: [], signedOut: true, message: 'Signed out' },
  { id: 'xai', label: 'Grok (xAI)', authType: 'oauth', status: 'error', windows: [], problem: 'session_expired', message: 'Grok session expired.' },
  { id: 'opencode-go', label: 'OpenCode Go', authType: 'api_key', status: 'unavailable', windows: [], problem: 'no_subscription', message: 'No subscription' }
]

let root: Root | undefined
let host: HTMLElement | undefined
beforeEach(() => {
  localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
})

function render(patch: Partial<Parameters<typeof SubscriptionUsageView>[0]> = {}) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const onReconnect = vi.fn()
  act(() => root!.render(createElement(SubscriptionUsageView, {
    usage: { providers, fetchedAt: '2026-11-09T12:00:00Z' }, loading: false, failed: false, now: Date.parse('2026-11-09T12:00:00Z'),
    onBack: () => {}, onRefresh: () => {}, onManage: () => {}, onReconnect, ...patch
  })))
  return { onReconnect }
}
const q = (selector: string) => document.querySelector<HTMLElement>(selector)
const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]

describe('the three sections', () => {
  it('a subscription card, Other usage and Needs attention collapsed to their header rows, and the header chip counts', () => {
    render()
    expect(all('.usage-provider').map((card) => card.querySelector('.settings-group-title')?.textContent)).toEqual(['Claude subscription'])
    expect(q('[data-testid="usage-section-usage-other"] .usage-section-head')?.textContent).toContain('Other usage· 1')
    expect(q('[data-testid="usage-section-usage-attention"] .usage-section-head')?.textContent).toContain('Needs attention· 3')
    expect(all('[data-testid="usage-other-row"]')).toHaveLength(0)
    expect(all('[data-testid="usage-attention-row"]')).toHaveLength(0)
    expect(q('[data-testid="usage-attention-chip"]')?.textContent).toBe('3')
    expect(q('[data-testid="usage-section-usage-attention"]')?.className).toContain('is-dimmed')
  })

  it('opening a section shows its rows and is remembered', () => {
    render()
    act(() => q('[data-testid="usage-section-usage-other"] .usage-section-head')!.click())
    expect(q('[data-testid="usage-other-row"]')?.textContent).toBe('Vercel AI Gateway$12.40 left · $37.60 used')
    expect(localStorage.getItem('mousse.usage.section.other')).toBe('open')
    act(() => root!.unmount())
    render()
    expect(all('[data-testid="usage-other-row"]')).toHaveLength(1)
  })

  it('Other usage starts open when there are no subscriptions at all', () => {
    render({ usage: { providers: providers.slice(1), fetchedAt: '2026-11-09T12:00:00Z' } })
    expect(all('[data-testid="usage-other-row"]')).toHaveLength(1)
  })

  it('the header chip opens Needs attention and brings it into view; rows are ordered, no subscription last', () => {
    render()
    act(() => q('[data-testid="usage-attention-chip"]')!.click())
    expect(all('[data-testid="usage-attention-row"]').map((row) => row.textContent)).toEqual([
      'ChatGPT subscriptionSigned outReconnect',
      'Grok (xAI)Session expiredReconnect',
      'OpenCode GoNo subscription'
    ])
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('Reconnect opens that provider\'s settings entry', () => {
    const { onReconnect } = render()
    act(() => q('[data-testid="usage-attention-chip"]')!.click())
    const [chatgpt, grok] = all('[data-testid="usage-reconnect"]')
    act(() => chatgpt!.click())
    act(() => grok!.click())
    expect(onReconnect.mock.calls).toEqual([['codex:chatgpt-subscription'], ['pi:xai']])
  })
})

describe('providers still on their way', () => {
  it('a subscription waits as a skeleton card; other and attention rows as slim placeholders', () => {
    localStorage.setItem('mousse.usage.section.other', 'open')
    localStorage.setItem('mousse.usage.section.attention', 'open')
    const waiting: ProviderUsage[] = [
      { id: 'claude-subscription', label: 'Claude subscription', status: 'unavailable', windows: [] },
      { id: 'vercel-ai-gateway', label: 'Vercel AI Gateway', authType: 'api_key', status: 'unavailable', windows: [] },
      { id: 'codex:chatgpt-subscription', label: 'ChatGPT subscription', status: 'unavailable', windows: [], signedOut: true }
    ]
    render({ usage: { providers: waiting, fetchedAt: '2026-11-09T12:00:00Z' }, loading: true, loadingIds: new Set(waiting.map((provider) => provider.id)) })
    expect(all('[data-testid="usage-card-loading"]')).toHaveLength(1)
    expect(all('[data-testid="usage-row-loading"]').map((row) => row.textContent)).toEqual(['Vercel AI Gateway', 'ChatGPT subscription'])
    expect(document.body.textContent).not.toContain('No usage reported')
  })

  it('sign-ins still being read show skeleton cells under the usual columns', () => {
    const claude: ProviderUsage = { id: 'claude-subscription', label: 'Claude subscription', status: 'available', windows: [], accounts: [
      { id: 'a', label: 'a@example.com', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 50 }] },
      { id: 'b', label: 'b@example.com', windows: [], pending: true }
    ] }
    render({ usage: { providers: [claude], fetchedAt: '2026-11-09T12:00:00Z' } })
    expect(all('[data-testid="usage-table-cell-loading"]')).toHaveLength(1)
    expect(all('[data-testid="usage-table-cell"]')).toHaveLength(1)
    expect(q('[data-testid="usage-summary"]')).not.toBeNull()
  })
})

import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProviderUsage, ProvidersUsageResponse } from '../../src/shared/providerAuth'
import { SubscriptionUsageView } from '../../src/renderer/components/SubscriptionUsagePage'
import { DelayedLoader, LOADER_DELAY_MS } from '../../src/renderer/components/ui/DelayedLoader'
import { formatUsageReset, remainingPercent, usageReadingTime, usageTone, usageWindowLine } from '../../src/renderer/lib/subscriptionUsage'

const NOW = Date.parse('2026-11-05T12:00:00Z')
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ').trim()
const tagOf = (html: string, testId: string) => html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? ''
const noop = () => undefined

const claude: ProviderUsage = {
  id: 'claude',
  label: 'Claude',
  status: 'available',
  windows: [
    { id: 'five_hour', label: '5-hour limit', remainingPercent: 62, resetsAt: '2026-11-05T14:05:00Z' },
    { id: 'seven_day', label: 'Weekly limit', remainingPercent: 12 },
    { id: 'opus', label: 'Opus', remainingPercent: 0, resetsAt: '2026-11-07T12:00:00Z' }
  ]
}
const response = (providers: ProviderUsage[] = [claude]): ProvidersUsageResponse => ({ providers, fetchedAt: '2026-11-05T11:58:00Z' })
const view = (patch: Partial<ComponentProps<typeof SubscriptionUsageView>> = {}) => renderToStaticMarkup(createElement(SubscriptionUsageView, {
  usage: response(), loading: false, failed: false, now: NOW, onBack: noop, onRefresh: noop, onManage: noop, ...patch
}))
const windows = (html: string) => [...html.matchAll(/data-testid="usage-window" data-remaining="([^"]+)"/g)].map((match) => match[1])

describe('a usage window', () => {
  it('reads as one line: share left, window, and when it resets', () => {
    expect(usageWindowLine(claude.windows[0]!, NOW)).toBe('62% left · 5-hour limit · resets in 2h 5m')
    expect(usageWindowLine(claude.windows[1]!, NOW)).toBe('12% left · Weekly limit')
    expect(formatUsageReset('2026-11-07T15:00:00Z', NOW)).toBe('resets in 2d 3h')
    expect(formatUsageReset('2026-11-05T11:00:00Z', NOW)).toBe('resets soon')
    expect(formatUsageReset('not a date', NOW)).toBeUndefined()
  })

  it('keeps an unknown share unknown, never zero or full', () => {
    expect(remainingPercent({ remainingPercent: Number.NaN })).toBeUndefined()
    expect(remainingPercent({ remainingPercent: undefined as never })).toBeUndefined()
    expect(remainingPercent({ remainingPercent: 140 })).toBe(100)
    expect(usageWindowLine({ id: 'x', label: 'Weekly limit', remainingPercent: Number.NaN }, NOW)).toBe('Unknown · Weekly limit')
  })

  it('warns only when little or nothing is left', () => {
    expect([usageTone(50), usageTone(19), usageTone(0)]).toEqual(['ok', 'low', 'empty'])
  })

  it('labels a reading with its clock time, and nothing for a bad time', () => {
    expect(usageReadingTime('2026-11-05T11:58:00Z')).toMatch(/\d/)
    expect(usageReadingTime('nope')).toBeUndefined()
  })
})

describe('the Usage page', () => {
  it('draws a small ring only for a known share above zero; zero and unknown are words alone', () => {
    const html = view({ usage: response([{ ...claude, windows: [...claude.windows, { id: 'u', label: 'Sonnet', remainingPercent: Number.NaN }] }]) })
    expect(windows(html)).toEqual(['62', '12', '0', 'unknown'])
    expect(html.match(/data-testid="usage-ring"/g)).toHaveLength(2)
    expect(html).not.toMatch(/role="progressbar"|usage-bar/)
    const page = text(html)
    expect(page).toContain('0% left · Opus')
    expect(page).toContain('Unknown · Sonnet')
  })

  it('shows each provider as one group, with its own usage page behind an icon', () => {
    const html = view({ usage: response([claude, { id: 'codex', label: 'Codex', status: 'unavailable', windows: [], message: "ChatGPT shows this plan's usage on its own page.", manageUrl: 'https://chatgpt.com/settings/usage' }]) })
    expect(html.match(/class="settings-group[^"]*usage-provider/g)).toHaveLength(2)
    expect(html).toContain('aria-label="Open Codex usage page"')
    expect(html).not.toContain('aria-label="Open Claude usage page"')
    expect(text(html)).toContain("ChatGPT shows this plan's usage on its own page.")
  })

  it('shows only the delayed loader before the first reading, with no words', () => {
    const html = view({ usage: null, loading: true })
    expect(html).toContain('data-testid="usage-loading"')
    expect(text(html)).toBe('Subscription usage')
  })

  it('keeps the last reading after a failed refresh, says from when, and offers Retry', () => {
    const html = view({ failed: true })
    expect(tagOf(html, 'usage-error')).toContain('role="alert"')
    expect(text(html)).toContain("Couldn't refresh usage.")
    expect(html).toContain('data-testid="usage-stale"')
    expect(text(html)).toMatch(/Showing usage from \d/)
    expect(windows(html)).toEqual(['62', '12', '0'])
    // Retry is a real button, so the keyboard reaches it.
    expect(tagOf(html, 'usage-retry')).toMatch(/^<button type="button"/)
    expect(text(view({ usage: null, failed: true }))).not.toContain('Showing')
  })

  it('names the computer only when there are others', () => {
    expect(text(view())).not.toContain(' on ')
    expect(text(view({ computerName: 'Studio' }))).toContain('Subscription usage on Studio')
  })

  it('says so in one line when no provider is connected', () => {
    expect(text(view({ usage: response([]) }))).toContain('No subscription providers are connected.')
  })
})

describe('the delayed loader', () => {
  it('renders nothing until the delay has passed, so quick loads never flash it', () => {
    expect(LOADER_DELAY_MS).toBe(160)
    const html = renderToStaticMarkup(createElement(DelayedLoader, { label: 'Loading usage' }))
    expect(html).not.toContain('role="status"')
    expect(text(html)).toBe('')
  })

  it('once shown, is a labelled status with no text', () => {
    const html = renderToStaticMarkup(createElement(DelayedLoader, { label: 'Loading usage', delayMs: 0, size: 'small' }))
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-label="Loading usage"')
    expect(html).toContain('ui-loader small')
    expect(text(html)).toBe('')
  })
})

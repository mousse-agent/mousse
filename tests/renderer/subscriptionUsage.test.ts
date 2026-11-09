import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProviderUsage, ProvidersUsageResponse } from '../../src/shared/providerAuth'
import { SubscriptionUsageView } from '../../src/renderer/components/SubscriptionUsagePage'
import { DelayedLoader, LOADER_DELAY_MS } from '../../src/renderer/components/ui/DelayedLoader'
import { ALL_COMPUTERS, THIS_COMPUTER, usageRows, usageSelection, type ComputerUsage } from '../../src/renderer/lib/subscriptionUsage'
import { formatCountdown, nextResetGain, resetsLabel, resetsTooltip, resetTooltip, summarizeAccounts, totalResets } from '../../src/renderer/lib/subscriptionUsage'
import { activeAccountsLabel } from '../../src/renderer/components/UsageAccountsView'
import { formatResetLine, orderUsageWindows, remainingNow, remainingPercent, shortUsageNote, usageReadAtLabel, usageReadingTime, usageRedMix } from '../../src/renderer/lib/subscriptionUsage'

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
  it('reads as the share left; a reset that has passed is 100% left; unknown stays unknown, never zero or full', () => {
    expect(remainingNow({ remainingPercent: 58 }, NOW)).toBe(58)
    expect(remainingNow({ remainingPercent: 3, resetsAt: '2026-11-05T11:00:00Z' }, NOW)).toBe(100)
    expect(remainingNow({ remainingPercent: 3, resetsAt: '2026-11-05T13:00:00Z' }, NOW)).toBe(3)
    expect(remainingNow({ remainingPercent: Number.NaN }, NOW)).toBeUndefined()
    expect(remainingPercent({ remainingPercent: undefined as never })).toBeUndefined()
    expect(remainingPercent({ remainingPercent: 140 })).toBe(100)
  })

  it('takes on red smoothly as it nears empty: none at 80% left, a trace at 30%, clearly red-tinted at 5%', () => {
    expect([usageRedMix(100), usageRedMix(80), usageRedMix(35), usageRedMix(30), usageRedMix(5), usageRedMix(0)]).toEqual([0, 0, 0, 8, 47, 55])
  })

  it('counts down, not by weekday: 45m, 1h 12m; from a day on always with hours (1d 0h, 3d 0h, 6d 23h)', () => {
    expect(formatCountdown(45)).toBe('45m')
    expect(formatCountdown(72)).toBe('1h 12m')
    expect(formatCountdown(23 * 60 + 59)).toBe('23h 59m')
    expect(formatCountdown(1440)).toBe('1d 0h')
    expect(formatCountdown(3 * 1440)).toBe('3d 0h')
    expect(formatCountdown(3 * 1440 + 59)).toBe('3d 0h')
    expect(formatCountdown(3 * 1440 + 4 * 60 + 20)).toBe('3d 4h')
    expect(formatCountdown(6 * 1440 + 23 * 60 + 59)).toBe('6d 23h')
  })

  it('says when it resets as a countdown, with the exact time in the tooltip', () => {
    const now = new Date(2026, 10, 9, 12, 20).getTime()
    const thursday = new Date(2026, 10, 12, 16, 40)
    const day = thursday.toLocaleDateString([], { weekday: 'short' })
    expect(formatResetLine(thursday.toISOString(), now)).toBe('Resets in 3d 4h')
    expect(resetTooltip(thursday.toISOString(), now)).toBe(`Resets ${day} 16:40 · in 3d 4h`)
    expect(formatResetLine(new Date(now + 72 * 60_000).toISOString(), now)).toBe('Resets in 1h 12m')
    expect(formatResetLine(new Date(now - 60_000).toISOString(), now)).toBe('Resets soon')
    expect(formatResetLine(undefined, now)).toBeUndefined()
    expect(formatResetLine('not a date', now)).toBeUndefined()
  })

  it('lists the shortest window first, whatever order the provider sent', () => {
    expect(orderUsageWindows([{ id: 'seven_day' }, { id: 'extra_usage' }, { id: 'seven_day_opus' }, { id: 'five_hour' }, { id: 'primary' }]).map((window) => window.id))
      .toEqual(['five_hour', 'seven_day', 'seven_day_opus', 'primary', 'extra_usage'])
  })

  it('labels a reading with its clock time, and nothing for a bad time', () => {
    expect(usageReadingTime('2026-11-05T11:58:00Z')).toMatch(/\d/)
    expect(usageReadingTime('nope')).toBeUndefined()
  })
})

describe('the Usage page', () => {
  it('gives each window its own row, shortest first: label and share used, a bar filled to it, then the reset', () => {
    const html = view({ usage: response([{ ...claude, windows: [claude.windows[1]!, claude.windows[0]!, { id: 'u', label: 'Sonnet', remainingPercent: Number.NaN }] }]) })
    expect(windows(html)).toEqual(['62', '12', 'unknown'])
    const page = text(html)
    expect(page).toContain('5-hour limit 62% left')
    expect(page).toContain('Weekly limit 12% left')
    expect(page).toContain('Sonnet Unknown')
    expect(page).toContain('Resets in 2h 5m')
    expect([...html.matchAll(/role="meter"[^>]*aria-valuenow="(\d+)"/g)].map((match) => match[1])).toEqual(['62', '12'])
    // The fill is what is left, and only the nearly empty one is tinted red.
    expect([...html.matchAll(/data-red="(\d+)" style="width:(\d+)%/g)].map((match) => [match[2], match[1]])).toEqual([['62', '0'], ['12', '36']])
    expect(html).toContain('--usage-red:36%')
    expect(html).not.toContain('usage-ring')
  })

  it('a provider with only a weekly window shows one row, with no empty 5-hour row', () => {
    const html = view({ usage: response([{ ...claude, windows: [{ id: 'seven_day', label: 'Weekly limit', remainingPercent: 5, resetsAt: '2026-11-08T12:00:00Z' }] }]) })
    expect(windows(html)).toEqual(['5'])
    expect(text(html)).not.toContain('5-hour')
    expect(html).toContain('data-red="47" style="width:5%')
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

  it('with one computer, shows no computer label or picker at all', () => {
    const html = view()
    expect(html).not.toContain('data-testid="usage-computer"')
    expect(html).not.toContain('usage-provider-computer')
    expect(text(html)).not.toMatch(/this computer|All computers/)
  })

  it('says so in one line when no provider is connected', () => {
    expect(text(view({ usage: response([]) }))).toContain('No subscription providers are connected.')
  })
})

describe('limits across several accounts', () => {
  const now = Date.parse('2026-11-09T12:00:00Z')
  const at = (hours: number) => new Date(now + hours * 3600_000).toISOString()
  const accounts = [
    { id: 'a', label: 'a@example.com', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 40, resetsAt: at(3) }, { id: 'seven_day', label: 'Weekly limit', remainingPercent: 80, resetsAt: at(50) }, { id: 'model_fable', label: 'Weekly · Fable', remainingPercent: 20, resetsAt: at(60) }] },
    { id: 'b', label: 'b@example.com', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 60, resetsAt: at(1) }, { id: 'seven_day', label: 'Weekly limit', remainingPercent: 50, resetsAt: at(30) }, { id: 'model_fable', label: 'Weekly · Fable', remainingPercent: 40, resetsAt: at(70) }] },
    { id: 'c', label: 'c@example.com', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 100, resetsAt: at(2) }, { id: 'seven_day', label: 'Weekly limit', remainingPercent: 20, resetsAt: at(10) }] },
    // Expired: its last numbers count for nothing.
    { id: 'd', label: 'd@example.com', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 0, resetsAt: at(0.1) }], problem: 'Sign-in expired' }
  ]

  it('averages what is left over the active accounts that report each limit, and takes the soonest reset', () => {
    expect(summarizeAccounts(accounts, now).map(({ gain: _gain, ...summary }) => summary)).toEqual([
      { id: 'five_hour', heading: '5-hour', label: '5-hour · all accounts', accounts: 3, remaining: 67, resetsAt: at(1) },
      { id: 'seven_day', heading: 'Weekly', label: 'Weekly · all accounts', accounts: 3, remaining: 50, resetsAt: at(10) },
      { id: 'model_fable', heading: 'Weekly · Fable', label: 'Weekly · Fable · 2 accounts', accounts: 2, remaining: 30, resetsAt: at(60) }
    ])
    expect(activeAccountsLabel(accounts)).toBe('3 of 4 accounts active')
  })

  it('a reset that has passed counts as 100% left and is not the next reset', () => {
    const passed = [{ id: 'a', label: 'a', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 10, resetsAt: at(-1) }] }, { id: 'b', label: 'b', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 30, resetsAt: at(4) }] }]
    expect(summarizeAccounts(passed, now)[0]).toMatchObject({ remaining: 65, resetsAt: at(4), label: '5-hour · all accounts' })
  })

  it('with every account failing there is nothing to sum', () => {
    expect(summarizeAccounts([accounts[3]!], now)).toEqual([])
  })
})

describe('resets available', () => {
  const now = Date.parse('2026-11-09T12:00:00Z')
  const chatgpt = (resets: ProviderUsage['resets']): ProviderUsage => ({ id: 'codex:chatgpt-subscription', label: 'ChatGPT subscription', plan: 'Plus', status: 'available', windows: [{ id: 'seven_day', label: 'Weekly limit', remainingPercent: 60 }], ...(resets ? { resets } : {}) })

  it('a chip "2 resets" beside the plan, each credit and its expiry in the tooltip', () => {
    const resets = { available: 2, credits: [{ title: 'Weekly limit reset', type: 'weekly', expiresAt: '2026-11-14T12:00:00Z' }, { title: '5-hour reset', type: 'five_hour', expiresAt: '2026-11-09T14:30:00Z' }] }
    const html = view({ now, usage: response([chatgpt(resets)]) })
    expect(text(html)).toContain('ChatGPT subscription Plus 2 resets')
    expect(resetsTooltip(resets, now)).toBe('Weekly limit reset · weekly · expires in 5d 0h\n5-hour reset · five_hour · expires in 2h 30m')
  })

  it('nothing at 0 or when absent', () => {
    expect(view({ now, usage: response([chatgpt({ available: 0 })]) })).not.toContain('usage-resets')
    expect(view({ now, usage: response([chatgpt(undefined)]) })).not.toContain('usage-resets')
    expect([resetsLabel({ available: 1 }), resetsLabel({ available: 0 }), resetsLabel(undefined)]).toEqual(['1 reset', undefined, undefined])
  })

  it('several accounts: a badge after each name that has some, and the total in the header', () => {
    const accounts = [
      { id: 'a', label: 'a@example.com', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 50 }], resets: { available: 2 } },
      { id: 'b', label: 'b@example.com', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 70 }], resets: { available: 1 } },
      { id: 'c', label: 'c@example.com', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 90 }] }
    ]
    expect(totalResets(accounts)).toBe(3)
    const html = view({ now, usage: response([{ id: 'claude-subscription', label: 'Claude subscription', status: 'available', windows: [], accounts }]) })
    expect(text(html)).toContain('3 resets across accounts')
    expect(text(html)).toContain('a@example.com 2 resets')
    expect(html.match(/data-testid="usage-resets"/g)).toHaveLength(2)
  })
})

describe('what the next reset gives back', () => {
  const now = Date.parse('2026-11-09T12:00:00Z')
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString()
  const entry = (label: string, left: number, minutes?: number) => ({ label, window: { remainingPercent: left, ...(minutes !== undefined ? { resetsAt: at(minutes) } : {}) } })

  it('one account of five resetting: its used share over all five (mitra at 55% → +9%)', () => {
    const gain = nextResetGain([entry('mitra@example.com', 55, 8 * 60 + 24), entry('b', 70, 3000), entry('c', 80, 4000), entry('d', 60, 5000), entry('e', 90, 6000)], now)
    expect(gain).toEqual({ percent: 9, at: at(8 * 60 + 24), accounts: [{ label: 'mitra@example.com', at: at(8 * 60 + 24) }] })
  })

  it('accounts resetting within a minute of each other reset together', () => {
    const gain = nextResetGain([entry('a', 40, 44), entry('b', 60, 44.5), entry('c', 80, 300)], now)
    // (60 + 40) / 3 = 33.3 → +33%, from the two that reset together.
    expect(gain).toMatchObject({ percent: 33, at: at(44) })
    expect(gain?.accounts.map((account) => account.label)).toEqual(['a', 'b'])
  })

  it('all resetting together lift the average to 100%', () => {
    expect(nextResetGain([entry('a', 20, 60), entry('b', 50, 60)], now)?.percent).toBe(65)
  })

  it('a reset that rounds to 0% is skipped for the next one; with none ahead there is nothing', () => {
    const gain = nextResetGain([entry('full', 99.6, 30), entry('b', 50, 120), entry('c', 100), entry('d', 100)], now)
    expect(gain).toMatchObject({ percent: 13, at: at(120) })
    expect(nextResetGain([entry('a', 100, 30), entry('b', 99.8, 60)], now)).toBeUndefined()
    expect(nextResetGain([], now)).toBeUndefined()
  })

  it('the summary says "+24% in 44m", or "no change soon"', () => {
    const one = (left: number, minutes: number) => ({ id: 'x', label: 'x@example.com', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: left, resetsAt: new Date(Date.now() + minutes * 60_000 + 30_000).toISOString() }] })
    const pair = (lefts: [number, number]) => [{ ...one(lefts[0], 44), id: 'a' }, { ...one(lefts[1], 300), id: 'b' }]
    const card = (accounts: ProviderUsage['accounts']) => view({ now: Date.now(), usage: response([{ id: 'claude-subscription', label: 'Claude subscription', status: 'available', windows: [], accounts }]) })
    expect(text(card(pair([52, 70])))).toContain('+24% in 44m')
    expect(text(card(pair([100, 100])))).toContain('no change soon')
  })
})

describe('several accounts in one card', () => {
  const account = (id: string, label: string, windows: ProviderUsage['windows'], problem?: string) => ({ id, label, windows, ...(problem ? { problem } : {}) })
  const fable = { id: 'model_fable', label: 'Weekly · Fable', remainingPercent: 36 }
  const grouped: ProviderUsage = {
    id: 'claude-subscription', label: 'Claude Subscription', status: 'available', windows: [], proxy: { address: '100.101.102.103:8317', key: 'saved' },
    accounts: [
      account('a1', 'me@example.com', [fable, { id: 'seven_day', label: 'Weekly limit', remainingPercent: 69 }, { id: 'five_hour', label: '5-hour limit', remainingPercent: 58 }]),
      account('b2', 'work@example.com', [], 'Sign-in expired')
    ]
  }

  it('several accounts: a summary strip and a table, the header names the proxy and how many are active', () => {
    const html = view({ usage: response([grouped]) })
    expect(html).toContain('data-testid="usage-summary"')
    expect(html.match(/data-testid="usage-account"/g)).toHaveLength(2)
    const page = text(html)
    expect(page).toContain('via CLI API proxy')
    expect(page).toContain('1 of 2 accounts active')
    expect(page).toContain('Account 5-hour Weekly Weekly · Fable')
    expect(page).toContain('work@example.com Sign-in expired · Reconnect in proxy')
    expect([...html.matchAll(/data-testid="usage-table-cell" data-remaining="(\d+)"/g)].map((match) => match[1])).toEqual(['58', '69', '36'])
    expect(html).not.toContain('data-testid="usage-window"')
  })

  it('a disabled sign-in and an API key read muted; a failing one reads as an error', () => {
    const html = view({ usage: response([{ ...grouped, accounts: [...grouped.accounts!, account('c3', 'off@example.com', [], 'Disabled in proxy'), account('d4', 'Team key', [], 'API key · no plan limits')] }]) })
    expect(html.match(/class="usage-table-problem is-info"/g)).toHaveLength(2)
    expect(html.match(/class="usage-table-problem"/g)).toHaveLength(1)
    expect(text(html)).toContain('1 of 4 accounts active')
  })

  it('one account: no group and no account label, only its windows', () => {
    const single: ProviderUsage = { ...grouped, accounts: [grouped.accounts![0]!], windows: grouped.accounts![0]!.windows }
    const html = view({ usage: response([single]) })
    expect(html).not.toContain('data-testid="usage-account"')
    expect(text(html)).not.toContain('me@example.com')
    expect(windows(html)).toEqual(['58', '69', '36'])
  })
})

describe('a credit balance (AI Gateway)', () => {
  const gateway = (patch: Partial<ProviderUsage>): ProviderUsage => ({ id: 'vercel-ai-gateway', label: 'Vercel AI Gateway', status: 'available', windows: [], ...patch })

  it('is a slim row in Other usage: what is left and what was spent, with no bar when there is no limit', () => {
    const html = view({ usage: response([gateway({ credit: { balanceUsd: 12.4, usedUsd: 37.6 } })]) })
    expect(text(html)).toContain('Vercel AI Gateway $12.40 left · $37.60 used')
    expect(html).toContain('data-testid="usage-other-row"')
    expect(html).not.toContain('role="meter"')
  })

  it('draws a mini bar against a known limit', () => {
    const html = view({ usage: response([gateway({ credit: { balanceUsd: 25, usedUsd: 75, limitUsd: 100 } })]) })
    expect(html).toMatch(/role="meter"[^>]*aria-valuenow="25"/)
  })

  it('a rejected key or an unreachable gateway goes to Needs attention', () => {
    const html = view({ usage: response([gateway({ status: 'error', message: 'Key rejected', problem: 'key_rejected' })]) })
    expect(text(html)).toContain('Needs attention · 1')
    expect(html).toContain('data-testid="usage-attention-chip"')
  })
})

describe('limits a provider reported earlier, or read through a proxy', () => {
  const chatgpt: ProviderUsage = {
    id: 'codex:chatgpt-subscription', label: 'ChatGPT subscription', status: 'available', manageUrl: 'https://chatgpt.com/settings/usage',
    readAt: '2026-11-05T11:40:00Z',
    windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 58, resetsAt: '2026-11-05T13:00:00Z' }, { id: 'seven_day', label: 'Weekly limit', remainingPercent: 82 }]
  }

  it('dates reported windows in the header, right-aligned, with the exact time on hover; a live reading has none', () => {
    const html = view({ usage: response([chatgpt]) })
    expect(windows(html)).toEqual(['58', '82'])
    expect(tagOf(html, 'usage-read-at')).toContain('title="Reported ')
    expect(text(html)).toContain(`${usageReadAtLabel(chatgpt.readAt, NOW)}`)
    expect(html).not.toContain('data-testid="usage-note"')
    expect(view({ usage: response([{ ...chatgpt, readAt: undefined }]) })).not.toContain('usage-read-at')
    expect(usageReadAtLabel('2026-11-05T11:40:00Z', NOW)).toMatch(/^As of \d/)
    expect(usageReadAtLabel('2026-11-01T11:40:00Z', NOW)).toMatch(/^As of .+, /)
    expect(usageReadAtLabel('bad', NOW)).toBeUndefined()
  })

  it('names the source beside the provider, and an unavailable proxy is one line, not an error', () => {
    const proxy: ProviderUsage = { id: 'claude-subscription', label: 'Claude Subscription', status: 'unavailable', windows: [], source: 'via local proxy', message: 'Limits unavailable (proxy)' }
    const html = view({ usage: response([proxy]) })
    expect(text(html)).toContain('Claude Subscription · via local proxy')
    expect(text(html)).toContain('Limits unavailable (proxy)')
    expect(html).not.toContain('settings-status-bad')
  })
})

describe('provider notes are a few words, the detail on hover', () => {
  it('shortens the known notes and keeps others as they are', () => {
    expect(shortUsageNote('Limits show after the next turn.')).toEqual({ text: 'No limits yet', detail: 'Shows after the next turn' })
    expect(shortUsageNote('Limits unavailable (proxy). Set CLIPROXY_MANAGEMENT_KEY to show them.')).toEqual({ text: 'Proxy key missing', detail: 'Set CLIPROXY_MANAGEMENT_KEY' })
    expect(shortUsageNote('Limits unavailable (proxy)')).toEqual({ text: 'Limits unavailable (proxy)' })
    expect(shortUsageNote(undefined)).toBeUndefined()
  })

  it('renders the short note with its detail as the tooltip, and keeps "As of"', () => {
    const html = view({ usage: response([
      { id: 'codex:chatgpt-subscription', label: 'ChatGPT subscription', status: 'unavailable', windows: [], message: 'Limits show after the next turn.' },
      { id: 'codex', label: 'Codex', status: 'available', message: "Codex couldn't be reached.", readAt: '2026-11-05T11:40:00Z', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 50 }] }
    ]) })
    expect(text(html)).toContain('No limits yet')
    expect(text(html)).not.toContain('next turn.')
    expect(html).toContain('title="Shows after the next turn"')
    expect(text(html)).toContain('Not reachable')
    expect(tagOf(html, 'usage-read-at')).toBeTruthy()
  })
})

describe('several computers', () => {
  const computers = { selfName: 'Animatrix', others: [{ id: 'n2', name: 'Studio' }] }
  const codex = (account: string, remaining: number, readAt?: string) => ({ id: 'codex:chatgpt-subscription', label: 'ChatGPT subscription', status: 'available' as const, account, ...(readAt ? { readAt } : {}), windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: remaining }] })
  const readings: ComputerUsage[] = [
    { id: THIS_COMPUTER, name: 'Animatrix', providers: [codex('acct-a', 40, '2026-11-05T11:00:00Z'), { ...claude, account: 'acct-c' }] },
    { id: 'n2', name: 'Studio', providers: [{ ...codex('acct-a', 35), id: 'codex' }, codex('acct-b', 90)] }
  ]

  it('defaults to All computers, with this computer marked among the options', () => {
    const html = view({ computers })
    expect(tagOf(html, 'usage-computer')).toBeTruthy()
    expect(text(html)).toContain('All computers')
    expect(usageSelection(ALL_COMPUTERS, [THIS_COMPUTER, 'n2'])).toBe(ALL_COMPUTERS)
  })

  it('All computers shows a shared account once, its freshest reading, and names the computer only for accounts of one computer', () => {
    const rows = usageRows(readings, ALL_COMPUTERS)
    expect(rows.map((row) => [row.provider.label, row.provider.windows[0]?.remainingPercent, row.computerName])).toEqual([
      ['ChatGPT subscription', 35, undefined],
      ['Claude', 62, 'Animatrix'],
      ['ChatGPT subscription', 90, 'Studio']
    ])
    const html = view({ computers, remote: [readings[1]!], usage: response(readings[0]!.providers) })
    expect(text(html)).toContain('Studio')
    expect([...html.matchAll(/data-testid="usage-provider-computer"/g)]).toHaveLength(2)
  })

  it('a provider without an account is never merged, and one computer alone names none', () => {
    const plain: ComputerUsage[] = [{ id: THIS_COMPUTER, name: 'Animatrix', providers: [claude] }, { id: 'n2', name: 'Studio', providers: [claude] }]
    expect(usageRows(plain, ALL_COMPUTERS)).toHaveLength(2)
    expect(usageRows([plain[0]!], ALL_COMPUTERS).map((row) => row.computerName)).toEqual([undefined])
  })

  it('a picked computer shows only its own providers, unlabelled', () => {
    expect(usageRows(readings, 'n2').map((row) => [row.provider.windows[0]?.remainingPercent, row.computerName])).toEqual([[35, undefined], [90, undefined]])
    const html = view({ computers, selected: 'n2' })
    expect(text(html)).toContain('No usage shared yet.')
    expect(html).not.toContain('usage-provider-computer')
  })

  it('falls back to All computers when the picked computer is gone', () => {
    expect(usageSelection('n9', [THIS_COMPUTER, 'n2'])).toBe(ALL_COMPUTERS)
    expect(usageSelection(THIS_COMPUTER, [THIS_COMPUTER, 'n2'])).toBe(THIS_COMPUTER)
    expect(text(view({ computers, selected: 'n9' }))).toContain('All computers')
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

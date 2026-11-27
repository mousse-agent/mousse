import { describe, expect, it } from 'vitest'
import { CLAUDE_USAGE_ID, nextReading, NO_USAGE_INFO, usageReading } from '../../src/renderer/components/bots/botUsageRing'
import type { ProviderUsage, UsageAccount } from '../../src/shared/providerAuth'

/**
 * The bot header's usage ring: the share left of the talk provider's limit with the least left, or of its spend budget.
 * Inputs: who reports (Claude through the CLI API proxy, Claude on its own, a subscription, a key with or without a
 * budget, a proxy or provider that reports nothing, none), how (windows, pooled sign-ins, credit), a model's own weekly
 * limit, the reading's status and its age.
 */

const NOW = Date.parse('2026-11-19T12:00:00Z')
const SONNET = 'claude-sonnet-5-5'
const window = (id: string, label: string, remainingPercent: number) => ({ id, label, remainingPercent })
const usage = (patch: Partial<ProviderUsage>): ProviderUsage => ({ id: 'codex:chatgpt', label: 'ChatGPT', status: 'available', windows: [], readAt: new Date(NOW - 60_000).toISOString(), ...patch })
const account = (id: string, windows: UsageAccount['windows']): UsageAccount => ({ id, label: id, windows })
const proxy = { address: '127.0.0.1:8317', key: 'saved' as const }

describe('the ring and its tooltip', () => {
  const rows: Array<[string, ProviderUsage | undefined, number | undefined, RegExp]> = [
    ['no reading', undefined, undefined, /^No usage info$/],
    ['a subscription: the limit with the least left', usage({ windows: [window('five_hour', '5-hour', 72), window('seven_day', 'Weekly', 41)] }), 41, /^5-hour: 72% left\nWeekly: 41% left$/],
    ['Claude on its own sign-in: not counted', usage({ id: CLAUDE_USAGE_ID, windows: [window('five_hour', '5-hour', 72)] }), undefined, /^No usage info$/],
    ['Claude through the CLI API proxy', usage({ id: CLAUDE_USAGE_ID, proxy, windows: [window('five_hour', '5-hour', 18)] }), 18, /^5-hour: 18% left$/],
    ['Claude through the proxy with nothing to read', usage({ id: CLAUDE_USAGE_ID, proxy, status: 'unavailable', windows: [] }), undefined, /^No usage info$/],
    ['the proxy\'s sign-ins, pooled', usage({ id: CLAUDE_USAGE_ID, accounts: [account('a', [window('five_hour', '5-hour', 60)]), account('b', [window('five_hour', '5-hour', 80)])] }), 70, /5-hour.*70% left.*\n2 of 2 accounts active$/],
    ['another model\'s weekly does not count', usage({ windows: [window('five_hour', '5-hour', 72), window('seven_day_fable', 'Weekly · Fable', 9)] }), 72, /^5-hour: 72% left$/],
    ['a key with a spend budget', usage({ credit: { balanceUsd: 12.4, limitUsd: 50 } }), 24.8, /of .*50.* left$/],
    ['a key without a budget', usage({ credit: { balanceUsd: 0, usedUsd: 3.2 } }), undefined, /spent so far$/],
    ['a proxy or provider that reports nothing', usage({ status: 'unavailable', message: 'Limits unavailable' }), undefined, /^No usage info$/],
    ['a read that failed', usage({ status: 'error', windows: [window('five_hour', '5-hour', 50)] }), undefined, /^No usage info$/]
  ]
  it.each(rows)('%s', (_name, reading, left, tooltip) => {
    const shown = usageReading(reading, NOW, SONNET)
    expect(shown.left).toBe(left)
    expect(shown.tooltip).toMatch(tooltip)
  })

  it('a model\'s own weekly counts while that model is picked', () => {
    expect(usageReading(usage({ windows: [window('five_hour', '5-hour', 72), window('seven_day_fable', 'Weekly · Fable', 9)] }), NOW, 'claude-fable-5-2').left).toBe(9)
  })

  it('a read that fails keeps the numbers shown before; any other reading replaces them', () => {
    const good = usage({ windows: [window('five_hour', '5-hour', 40)] })
    const failed = usage({ status: 'error', message: 'Not reachable' })
    expect(nextReading(good, failed)).toBe(good)
    expect(nextReading(undefined, failed)).toBe(failed)
    const none = usage({ status: 'unavailable' })
    expect(nextReading(good, none)).toBe(none)
  })

  it('an old reading keeps its numbers and says when it is from', () => {
    const old = usageReading(usage({ windows: [window('five_hour', '5-hour', 40)], readAt: new Date(NOW - 30 * 60_000).toISOString() }), NOW, SONNET)
    expect(old.left).toBe(40)
    expect(old.tooltip).toMatch(/\nas of \d\d:\d\d$/)
    expect(usageReading(undefined, NOW, SONNET).tooltip).toBe(NO_USAGE_INFO)
  })
})

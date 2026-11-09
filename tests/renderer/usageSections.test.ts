import { describe, expect, it } from 'vitest'
import { attentionReason, orderAttention, otherUsageFigure, slotSection, usageInstanceId, usageSection } from '../../src/renderer/lib/usageSections'
import { applyAccount, applyFailure, applyPreview, applyProvider, loadingIds, refreshEntries, startEntries, stillReading } from '../../src/renderer/lib/progressiveUsage'
import type { ProviderUsage, UsageSlot } from '../../src/shared/providerAuth'

const usage = (patch: Partial<ProviderUsage>): ProviderUsage => ({ id: 'x', label: 'X', status: 'available', windows: [], ...patch })
const weekly = { id: 'seven_day', label: 'Weekly limit', remainingPercent: 58 }

describe('which section a provider goes to', () => {
  it('working plan limits are subscriptions; credits, API keys and no-data providers are other usage', () => {
    expect(usageSection(usage({ id: 'codex:chatgpt-subscription', windows: [weekly] }))).toBe('subscription')
    expect(usageSection(usage({ id: 'claude-subscription', status: 'unavailable', message: 'Limits unavailable (proxy)', proxy: { address: 'h:1', key: 'none' } }))).toBe('subscription')
    expect(usageSection(usage({ id: 'vercel-ai-gateway', authType: 'api_key', credit: { balanceUsd: 12.4 } }))).toBe('other')
    expect(usageSection(usage({ id: 'opencode-go', authType: 'api_key', windows: [weekly] }))).toBe('other')
    expect(usageSection(usage({ id: 'openrouter', status: 'unavailable', message: 'Usage information is not available for this provider.' }))).toBe('other')
  })

  it('signed out and failing providers need attention', () => {
    expect(usageSection(usage({ signedOut: true, status: 'unavailable' }))).toBe('attention')
    expect(usageSection(usage({ status: 'error', problem: 'session_expired' }))).toBe('attention')
    expect(usageSection(usage({ authType: 'api_key', status: 'error', problem: 'key_expired' }))).toBe('attention')
  })

  it('no subscription is listed among Other usage, not as something to fix', () => {
    expect(usageSection(usage({ status: 'unavailable', problem: 'no_subscription' }))).toBe('other')
    expect(usageSection(usage({ authType: 'api_key', status: 'error', problem: 'no_subscription' }))).toBe('other')
    // Signed out still needs attention, whatever else is said.
    expect(usageSection(usage({ signedOut: true, problem: 'no_subscription' }))).toBe('attention')
  })

  it('a provider on its way waits where its slot suggests', () => {
    expect([slotSection({ signedOut: true }), slotSection({ authType: 'api_key' }), slotSection({ authType: 'oauth' }), slotSection({})]).toEqual(['attention', 'other', 'subscription', 'subscription'])
  })
})

describe('why a provider needs attention', () => {
  it('names each kind in a few words, with Reconnect only where signing in again fixes it', () => {
    expect(attentionReason(usage({ signedOut: true }))).toEqual({ text: 'Signed out', reconnect: true, rank: 0 })
    expect(attentionReason(usage({ status: 'error', problem: 'session_expired', message: 'Grok (xAI) session expired. Reconnect it in Settings.' }))).toMatchObject({ text: 'Session expired', reconnect: true })
    expect(attentionReason(usage({ status: 'error', problem: 'key_expired' }))).toMatchObject({ text: 'Key expired', reconnect: true })
    expect(attentionReason(usage({ status: 'error', problem: 'key_rejected' }))).toMatchObject({ text: 'Key rejected', reconnect: true })
    expect(attentionReason(usage({ status: 'error', message: 'Not reachable', problem: 'unavailable' }))).toMatchObject({ text: 'Not reachable', reconnect: false })
    expect(attentionReason(usage({ status: 'error', message: 'Could not refresh Provider login. Reconnect it in Settings.' }))).toMatchObject({ text: 'Login refresh failed', reconnect: true })
    expect(attentionReason(usage({ status: 'error', message: 'Something odd' }))).toMatchObject({ text: 'Usage unavailable', reconnect: false })
  })

  it('things to fix first', () => {
    const rows = [usage({ id: 'a', status: 'error', message: 'Something odd' }), usage({ id: 'b', status: 'error', message: 'Not reachable' }), usage({ id: 'c', signedOut: true })].map((provider) => ({ provider }))
    expect(orderAttention(rows).map((row) => row.provider.id)).toEqual(['c', 'a', 'b'])
  })

  it('Reconnect opens the right entry in Settings → Providers', () => {
    expect([usageInstanceId('codex:chatgpt-subscription'), usageInstanceId('claude-subscription'), usageInstanceId('codex'), usageInstanceId('xai'), usageInstanceId('opencode-go')])
      .toEqual(['codex:chatgpt-subscription', 'claude', 'codex', 'pi:xai', 'pi:opencode-go'])
  })
})

describe("an other usage row's figure", () => {
  it('a balance and its spend; the tightest window; or, muted, no subscription or no usage data', () => {
    expect(otherUsageFigure(usage({ credit: { balanceUsd: 12.4, usedUsd: 37.6 } }))).toEqual({ text: '$12.40 left · $37.60 used' })
    expect(otherUsageFigure(usage({ credit: { balanceUsd: 25, limitUsd: 100 } }))).toEqual({ text: '$25.00 left', remaining: 25 })
    expect(otherUsageFigure(usage({ windows: [weekly, { id: 'five_hour', label: '5-hour limit', remainingPercent: 30 }] }))).toEqual({ text: '30% left · 5-hour limit', remaining: 30 })
    expect(otherUsageFigure(usage({ status: 'unavailable' }))).toEqual({ text: 'No usage data', muted: true })
    expect(otherUsageFigure(usage({ status: 'unavailable', problem: 'no_subscription' }))).toEqual({ text: 'No subscription', muted: true })
  })
})

describe('the page filling in one provider at a time', () => {
  const slots: UsageSlot[] = [
    { id: 'claude-subscription', label: 'Claude subscription', cached: usage({ id: 'claude-subscription', windows: [weekly], readAt: '2026-11-09T10:00:00Z' }) },
    { id: 'vercel-ai-gateway', label: 'Vercel AI Gateway', authType: 'api_key' },
    { id: 'codex:chatgpt-subscription', label: 'ChatGPT subscription', signedOut: true }
  ]

  it('starts with every provider: last readings dated, the rest as placeholders in their section', () => {
    const entries = startEntries(slots)
    expect(entries.map((entry) => entry.state)).toEqual(['cached', 'loading', 'loading'])
    expect(entries[0]!.usage.readAt).toBe('2026-11-09T10:00:00Z')
    expect([...loadingIds(entries)]).toEqual(['vercel-ai-gateway', 'codex:chatgpt-subscription'])
    expect(slotSection(entries[2]!.usage)).toBe('attention')
  })

  it('a fresh reading replaces the cached one in place, undated; the others keep waiting', () => {
    const fresh = applyProvider(startEntries(slots), usage({ id: 'claude-subscription', windows: [{ ...weekly, remainingPercent: 40 }] }))
    expect(fresh[0]).toMatchObject({ state: 'fresh', usage: { windows: [{ remainingPercent: 40 }] } })
    expect(fresh[0]!.usage.readAt).toBeUndefined()
    expect(fresh.map((entry) => entry.slot.id)).toEqual(slots.map((slot) => slot.id))
    expect(stillReading(fresh)).toBe(true)
  })

  it('one provider failing says "Not reachable" where it is and leaves the others alone', () => {
    const entries = applyFailure(applyProvider(startEntries(slots), usage({ id: 'vercel-ai-gateway', credit: { balanceUsd: 1 } })), 'codex:chatgpt-subscription')
    expect(entries[2]!.usage).toMatchObject({ status: 'error', message: 'Not reachable' })
    expect(entries[1]!.usage.credit).toEqual({ balanceUsd: 1 })
  })

  it('sign-ins listed first keep their last numbers until each one\'s fresh reading arrives', () => {
    const cached = usage({ id: 'claude-subscription', accounts: [{ id: 'a', label: 'a', windows: [weekly] }] })
    let entries = startEntries([{ id: 'claude-subscription', label: 'Claude subscription', cached }])
    entries = applyPreview(entries, usage({ id: 'claude-subscription', accounts: [{ id: 'a', label: 'a', windows: [], pending: true }, { id: 'b', label: 'b', windows: [], pending: true }] }))
    expect(entries[0]!.state).toBe('partial')
    expect(entries[0]!.usage.accounts!.map((account) => [account.id, account.windows.length, !!account.pending])).toEqual([['a', 1, true], ['b', 0, true]])
    entries = applyAccount(entries, 'claude-subscription', { id: 'b', label: 'b', windows: [weekly] })
    expect(entries[0]!.state).toBe('partial')
    entries = applyAccount(entries, 'claude-subscription', { id: 'a', label: 'a', windows: [{ ...weekly, remainingPercent: 10 }] })
    expect(entries[0]).toMatchObject({ state: 'fresh', usage: { status: 'available' } })
  })

  it('a refresh keeps what is shown until the fresh reading lands (no skeleton, no jump)', () => {
    const shown = applyProvider(startEntries(slots), usage({ id: 'vercel-ai-gateway', credit: { balanceUsd: 5 } }))
    const again = refreshEntries(shown, slots)
    expect(again[1]).toMatchObject({ state: 'fresh', usage: { credit: { balanceUsd: 5 } } })
    expect(loadingIds(again).has('vercel-ai-gateway')).toBe(false)
  })
})

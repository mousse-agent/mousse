import { describe, expect, it, vi } from 'vitest'
import { cachedUsage, keepAccount, keepUsage, steadyAccount, steadyUsage, unreachableUsage, usageSlots, withUsageDeadline } from '../src/mms/protocol/usageReads'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import type { ProviderUsage } from '../src/shared/providerAuth'

/**
 * The usage page reads progressively: the list of providers with their last readings first, then
 * each provider on its own, within its own deadline, so a slow one never holds the others up.
 */

const reading = (id: string, patch: Partial<ProviderUsage> = {}): ProviderUsage => ({ id, label: id, status: 'available', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 50 }], ...patch })

describe('one provider within its deadline', () => {
  it('a hung read becomes "Not reachable" at the deadline, and its signal is aborted', async () => {
    let signalled: AbortSignal | undefined
    const result = await withUsageDeadline((signal) => { signalled = signal; return new Promise<ProviderUsage>(() => {}) }, () => unreachableUsage('xai', 'Grok'), 20)
    expect(result).toEqual({ id: 'xai', label: 'Grok', status: 'error', windows: [], problem: 'unavailable', message: 'Not reachable' })
    expect(signalled?.aborted).toBe(true)
  })

  it('a failing read is "Not reachable" too; a quick one is itself', async () => {
    expect(await withUsageDeadline(async () => { throw new Error('boom') }, () => unreachableUsage('a', 'A'), 1_000)).toMatchObject({ message: 'Not reachable' })
    expect(await withUsageDeadline(async () => reading('a'), () => unreachableUsage('a', 'A'), 1_000)).toEqual(reading('a'))
  })
})

describe('the last readings', () => {
  it('a slot carries its provider\'s last reading, dated; a fresh reading replaces it', () => {
    const owner = {}
    expect(usageSlots(owner, [{ id: 'a', label: 'A' }])).toEqual([{ id: 'a', label: 'A' }])
    keepUsage(owner, reading('a'), Date.parse('2026-11-09T10:00:00Z'))
    expect(usageSlots(owner, [{ id: 'a', label: 'A' }])[0]!.cached).toMatchObject({ id: 'a', readAt: '2026-11-09T10:00:00.000Z' })
    keepUsage(owner, reading('a', { windows: [] }), Date.parse('2026-11-09T11:00:00Z'))
    expect(cachedUsage(owner, 'a')).toMatchObject({ windows: [], readAt: '2026-11-09T11:00:00.000Z' })
    // Another profile's services keep their own.
    expect(cachedUsage({}, 'a')).toBeUndefined()
  })

  it('a preview of sign-ins keeps what each had last time; one sign-in\'s reading updates only it', () => {
    const owner = {}
    const full = reading('claude-subscription', { accounts: [{ id: 'x', label: 'x', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 40 }] }, { id: 'y', label: 'y', windows: [] , problem: 'Disabled in proxy' }] })
    keepUsage(owner, full)
    keepUsage(owner, reading('claude-subscription', { windows: [], accounts: [{ id: 'x', label: 'x', windows: [], pending: true }, { id: 'z', label: 'z', windows: [], pending: true }] }))
    expect(cachedUsage(owner, 'claude-subscription')!.accounts!.map((account) => [account.id, account.pending ?? false, account.windows.length])).toEqual([['x', false, 1], ['z', true, 0]])
    keepAccount(owner, 'claude-subscription', { id: 'z', label: 'z', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 90 }] })
    expect(cachedUsage(owner, 'claude-subscription')!.accounts!.find((account) => account.id === 'z')).toMatchObject({ windows: [{ remainingPercent: 90 }] })
  })
})

describe('a rate-limited sign-in', () => {
  it('keeps the numbers it had last time; one never read says it is rate limited', () => {
    const owner = {}
    const good = { id: 'a', label: 'a', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 40 }] }
    keepUsage(owner, reading('claude-subscription', { accounts: [good, { id: 'b', label: 'b', windows: [], problem: 'Disabled in proxy' }] }))
    expect(steadyAccount(owner, 'claude-subscription', { id: 'a', label: 'a', windows: [], problem: 'Rate limited' })).toEqual(good)
    expect(steadyAccount(owner, 'claude-subscription', { id: 'c', label: 'c', windows: [], problem: 'Rate limited' })).toMatchObject({ problem: 'Rate limited' })
    expect(steadyAccount(owner, 'claude-subscription', { id: 'a', label: 'a', windows: [], problem: 'Sign-in expired' })).toMatchObject({ problem: 'Sign-in expired' })
    const fresh = steadyUsage(owner, reading('claude-subscription', { status: 'unavailable', message: 'Limits unavailable (proxy)', windows: [], accounts: [{ id: 'a', label: 'a', windows: [], problem: 'Rate limited' }] }))
    expect(fresh).toMatchObject({ status: 'available', accounts: [good] })
    expect(fresh.message).toBeUndefined()
  })
})

describe('the protocol methods', () => {
  function services(options: { slow?: string } = {}) {
    const providerAccess = {
      usageSlots: () => [{ id: 'xai', label: 'Grok (xAI)', authType: 'oauth' as const }, { id: 'vercel-ai-gateway', label: 'Vercel AI Gateway', authType: 'api_key' as const }],
      usageFor: vi.fn(async (id: string) => (id === options.slow ? new Promise<ProviderUsage>(() => {}) : reading(id)))
    }
    const harness = { instances: { usageSlots: () => [{ id: 'codex:chatgpt-subscription', label: 'ChatGPT subscription', signedOut: true as const }], usageFor: vi.fn(async (_scope: unknown, id: string) => ({ id, label: 'ChatGPT subscription', status: 'unavailable' as const, windows: [], signedOut: true as const, message: 'Signed out' })) } }
    const claudeSubscription = { configured: () => false }
    return { providerAccess, harness, claudeSubscription }
  }
  const call = (mms: object, method: string, params?: unknown) => dispatchMethod({ mms: mms as never, globalSequence: () => 0, connection: { clientType: 'gui' } as never }, method, params)

  it('lists every provider at once, without reading any', async () => {
    const mms = services()
    expect(await call(mms, 'providers.usageSlots')).toEqual({ slots: [
      { id: 'xai', label: 'Grok (xAI)', authType: 'oauth' },
      { id: 'vercel-ai-gateway', label: 'Vercel AI Gateway', authType: 'api_key' },
      { id: 'codex:chatgpt-subscription', label: 'ChatGPT subscription', signedOut: true }
    ] })
    expect(mms.providerAccess.usageFor).not.toHaveBeenCalled()
  })

  it('reads one provider at a time; a hung one does not hold the others, and the fresh reading is kept', async () => {
    vi.useFakeTimers()
    try {
      const mms = services({ slow: 'xai' })
      const slow = call(mms, 'providers.getUsageFor', { providerId: 'xai' })
      expect(await call(mms, 'providers.getUsageFor', { providerId: 'vercel-ai-gateway' })).toEqual({ provider: reading('vercel-ai-gateway') })
      expect(await call(mms, 'providers.getUsageFor', { providerId: 'codex:chatgpt-subscription' })).toMatchObject({ provider: { signedOut: true } })
      await vi.advanceTimersByTimeAsync(20_001)
      expect(await slow).toEqual({ provider: unreachableUsage('xai', 'Grok (xAI)') })
      expect((await call(mms, 'providers.usageSlots') as { slots: Array<{ id: string; cached?: ProviderUsage }> }).slots.find((slot) => slot.id === 'vercel-ai-gateway')?.cached).toMatchObject({ status: 'available' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads and keeps nothing for a provider the page does not list', async () => {
    const mms = { ...services(), providerAccess: { ...services().providerAccess, usageFor: vi.fn(async () => { throw new Error('down') }) } }
    expect(await call(mms, 'providers.getUsageFor', { providerId: 'made-up' })).toEqual({})
    expect(mms.providerAccess.usageFor).not.toHaveBeenCalled()
    expect((await call(mms, 'providers.usageSlots') as { slots: Array<{ id: string }> }).slots.map((slot) => slot.id)).not.toContain('made-up')
  })

  it('answers only a window or the CLI on this computer', async () => {
    const mms = services()
    const remote = (method: string, params?: unknown) => dispatchMethod({ mms: mms as never, globalSequence: () => 0, connection: { clientType: 'bridge' } as never }, method, params)
    await expect(remote('providers.usageSlots')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(remote('providers.getUsageFor', { providerId: 'xai' })).rejects.toMatchObject({ code: 'forbidden' })
    expect(mms.providerAccess.usageFor).not.toHaveBeenCalled()
  })
})

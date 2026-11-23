import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { cachedUsage, keepAccount, keepUsage, onUsageKept, steadyAccount, steadyUsage, unreachableUsage, usageSlots, withUsageDeadline } from '../src/mms/protocol/usageReads'
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

  it('a slot says when this computer last read it, even when the provider dated its numbers earlier', () => {
    const owner = {}
    keepUsage(owner, reading('a', { readAt: '2026-11-09T08:00:00.000Z' }), Date.parse('2026-11-09T10:00:00Z'))
    const [slot] = usageSlots(owner, [{ id: 'a', label: 'A' }])
    expect(slot!.cached?.readAt).toBe('2026-11-09T08:00:00.000Z')
    expect(slot!.cachedAt).toBe('2026-11-09T10:00:00.000Z')
  })

  it('a preview of sign-ins keeps what each had last time; one sign-in\'s reading updates only it', () => {
    const owner = {}
    const full = reading('claude-subscription', { accounts: [{ id: 'x', label: 'x', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 40 }] }, { id: 'y', label: 'y', windows: [] , problem: 'Disabled in proxy' }] })
    keepUsage(owner, full)
    keepUsage(owner, reading('claude-subscription', { windows: [], accounts: [{ id: 'x', label: 'x', windows: [], pending: true }, { id: 'z', label: 'z', windows: [], pending: true }] }))
    expect(cachedUsage(owner, 'claude-subscription')!.accounts!.map((account) => [account.id, account.pending ?? false, account.windows.length])).toEqual([['x', false, 1], ['z', true, 0]])
    const slots = [{ id: 'claude-subscription', label: 'Claude subscription' }]
    keepAccount(owner, 'claude-subscription', { id: 'z', label: 'z', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 90 }] })
    expect(cachedUsage(owner, 'claude-subscription')!.accounts!.find((account) => account.id === 'z')).toMatchObject({ windows: [{ remainingPercent: 90 }] })
    expect(usageSlots(owner, slots)[0]?.cachedAt).toBeUndefined()
    keepAccount(owner, 'claude-subscription', full.accounts![0]!, Date.parse('2026-11-09T11:00:00Z'))
    expect(usageSlots(owner, slots)[0]?.cachedAt).toBe('2026-11-09T11:00:00.000Z')
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

  it('lists Claude with its Settings entry, its sign-ins previewed first', async () => {
    const mms = { ...services(), claudeSubscription: { configured: () => true } }
    expect((await call(mms, 'providers.usageSlots') as { slots: unknown[] }).slots).toContainEqual({ id: 'claude-subscription', label: 'Claude subscription', instanceId: 'claude', previewAccounts: true })
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

  it('uses a limit reset for this computer only, passing the credit on', async () => {
    const useLimitReset = vi.fn(async () => ({ outcome: 'reset' as const }))
    const mms = { ...services(), harness: { instances: { ...services().harness.instances, useLimitReset } } }
    expect(await call(mms, 'providers.useLimitReset', { providerId: 'codex:chatgpt-subscription', creditId: 'rc_1' })).toEqual({ outcome: 'reset' })
    expect(useLimitReset).toHaveBeenCalledWith({ kind: 'device' }, 'codex:chatgpt-subscription', 'rc_1')
    const remote = dispatchMethod({ mms: mms as never, globalSequence: () => 0, connection: { clientType: 'bridge' } as never }, 'providers.useLimitReset', { providerId: 'codex:chatgpt-subscription' })
    await expect(remote).rejects.toMatchObject({ code: 'forbidden' })
    expect(useLimitReset).toHaveBeenCalledTimes(1)
  })

  it('keeps every limit the page reads for its trends, and answers them in the range asked', async () => {
    const home = mkdtempSync(join(tmpdir(), 'usage-reads-'))
    try {
      const mms = { ...services(), getProfileHomeDir: () => home }
      await call(mms, 'providers.getUsageFor', { providerId: 'xai' })
      await vi.waitFor(async () => {
        const { trends } = await call(mms, 'providers.limitTrends', { range: '24h' }) as { trends: Array<{ id: string; windows: Array<{ id: string; points: unknown[] }> }> }
        expect(trends.map((trend) => [trend.id, trend.windows.map((window) => [window.id, window.points.length])])).toEqual([['xai', [['five_hour', 1]]]])
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('answers only a window or the CLI on this computer', async () => {
    const mms = services()
    const remote = (method: string, params?: unknown) => dispatchMethod({ mms: mms as never, globalSequence: () => 0, connection: { clientType: 'bridge' } as never }, method, params)
    await expect(remote('providers.usageSlots')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(remote('providers.getUsageFor', { providerId: 'xai' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(remote('providers.limitTrends', { range: '7d' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(remote('providers.watchUsage', { providerId: 'xai' })).rejects.toMatchObject({ code: 'forbidden' })
    expect(mms.providerAccess.usageFor).not.toHaveBeenCalled()
  })

  describe('the 5-minute refresh behind a bot header\'s usage ring', () => {
    it('reads a watched provider at most once per 5 minutes however many windows ask, and stops once none asks', async () => {
      vi.useFakeTimers()
      try {
        const mms = services()
        const kept: string[] = []
        onUsageKept(mms, (id) => kept.push(id))
        // Two windows ask at once: one read, kept and heard.
        await call(mms, 'providers.watchUsage', { providerId: 'xai' })
        expect(await call(mms, 'providers.watchUsage', { providerId: 'xai' })).toEqual({ watched: true })
        await vi.advanceTimersByTimeAsync(0)
        expect(mms.providerAccess.usageFor).toHaveBeenCalledTimes(1)
        expect(kept).toEqual(['xai'])
        // A window that asks later gets the reading kept.
        expect(await call(mms, 'providers.watchUsage', { providerId: 'xai' })).toMatchObject({ watched: true, cached: { id: 'xai' } })
        // A window asks again within the lease: the next read comes 5 minutes after the last.
        await vi.advanceTimersByTimeAsync(4 * 60_000)
        await call(mms, 'providers.watchUsage', { providerId: 'xai' })
        expect(mms.providerAccess.usageFor).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(60_000)
        expect(mms.providerAccess.usageFor).toHaveBeenCalledTimes(2)
        // Nobody asks any more: one more read while the lease lasts, then none.
        await vi.advanceTimersByTimeAsync(30 * 60_000)
        expect(mms.providerAccess.usageFor).toHaveBeenCalledTimes(3)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('reads nothing for a provider the page does not list', async () => {
      const mms = services()
      expect(await call(mms, 'providers.watchUsage', { providerId: 'made-up' })).toEqual({ watched: false })
      expect(mms.providerAccess.usageFor).not.toHaveBeenCalled()
    })

    it('reads Claude as the page does: the proxy\'s sign-ins, each on its own', async () => {
      const usageAccount = vi.fn(async (id: string) => ({ id, label: id, windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 30 }] }))
      const getUsage = vi.fn(async () => reading('claude-subscription'))
      const claudeSubscription = {
        configured: () => true,
        usageAccountsPreview: vi.fn(async () => reading('claude-subscription', { windows: [], accounts: [{ id: 'a', label: 'a', windows: [], pending: true }, { id: 'b', label: 'b', windows: [], pending: true }] })),
        usageAccount,
        getUsage
      }
      const mms = { ...services(), claudeSubscription }
      await call(mms, 'providers.watchUsage', { providerId: 'claude-subscription' })
      await vi.waitFor(() => expect(usageAccount).toHaveBeenCalledTimes(2))
      expect(getUsage).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(cachedUsage(mms, 'claude-subscription')!.accounts!.every((account) => account.windows.length === 1)).toBe(true))
    })
  })
})

describe('kept readings are heard', () => {
  it('each provider reading and each sign-in\'s reading tells the listeners which provider it was', () => {
    const owner = {}
    const heard: string[] = []
    const stop = onUsageKept(owner, (id) => heard.push(id))
    keepUsage(owner, reading('claude-subscription', { accounts: [{ id: 'a', label: 'a', windows: [] }] }))
    keepAccount(owner, 'claude-subscription', { id: 'a', label: 'a', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: 10 }] })
    stop()
    keepUsage(owner, reading('xai'))
    expect(heard).toEqual(['claude-subscription', 'claude-subscription'])
  })
})

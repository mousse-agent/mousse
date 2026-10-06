import { expect, it, vi } from 'vitest'
import { dispatchMethod, type HandlerContext } from '../src/mms/protocol/handlers'
import type { ProvidersUsageResponse, ProviderUsage } from '../src/shared/providerAuth'

function fixture(configured: boolean, claudeUsage: ProviderUsage) {
  const getUsage = vi.fn(async () => claudeUsage)
  const existing = { id: 'openai-codex', label: 'Codex', status: 'available', windows: [{ id: 'five_hour', label: '5-hour', remainingPercent: 80 }] }
  const context = { mms: {
    providerAuth: { getUsage: vi.fn(async () => ({ providers: [existing], fetchedAt: 'old' })) },
    claudeSubscription: { configured: () => configured, getUsage },
    worktrees: { getRepoRoot: () => '/trusted/workspace' }
  }, globalSequence: () => 0 } as unknown as HandlerContext
  return { context, getUsage, existing }
}
const claude: ProviderUsage = { id: 'claude-subscription', label: 'Claude Subscription', status: 'available', windows: [{ id: 'five_hour', label: '5-hour', remainingPercent: 65 }] }

it('includes Claude-managed subscription quotas alongside credential-store providers', async () => {
  const f = fixture(true, claude)
  const usage = await dispatchMethod(f.context, 'providers.getUsage', {}) as ProvidersUsageResponse
  expect(usage.providers).toEqual([f.existing, claude])
  expect(f.getUsage).toHaveBeenCalledWith('/trusted/workspace')
  expect(Number.isFinite(Date.parse(usage.fetchedAt))).toBe(true)
})
it('retains a connected Claude entry when quota data is unavailable', async () => {
  const unavailable: ProviderUsage = { ...claude, status: 'unavailable', windows: [], message: 'Quota data unavailable' }
  const f = fixture(true, unavailable)
  expect(await dispatchMethod(f.context, 'providers.getUsage', {})).toMatchObject({ providers: [f.existing, unavailable] })
})
it('does not initialize or report an unconfigured Claude provider', async () => {
  const f = fixture(false, claude)
  expect(await dispatchMethod(f.context, 'providers.getUsage', {})).toMatchObject({ providers: [f.existing] })
  expect(f.getUsage).not.toHaveBeenCalled()
})

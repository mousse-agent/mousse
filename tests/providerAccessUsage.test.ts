import { describe, expect, it, vi } from 'vitest'
import { createProviderAccess, type SharedProviderCalls } from '../src/mms/providers/providerAccess'

/** The usage page lists and reads only the providers that are on: one turned off in Settings is left out. */
describe('the usage page and providers turned off', () => {
  const auth = {
    getConfiguredProviders: () => [{ id: 'xai', label: 'Grok (xAI)', authType: 'oauth' }, { id: 'opencode-go', label: 'OpenCode Go', authType: 'api_key' }],
    getUsage: vi.fn(async (include: (id: string) => boolean) => ({ providers: ['xai', 'opencode-go'].filter(include).map((id) => ({ id, label: id, status: 'available', windows: [] })), fetchedAt: '' })),
    getProviderDisplayName: (id: string) => id
  } as unknown as SharedProviderCalls
  const instances = {
    isRemoved: () => false,
    isDisabled: (instanceId: string) => instanceId === 'pi:opencode-go',
    instanceIdForLegacyProvider: (id: string) => `pi:${id}`
  }

  it('leaves a disabled provider out of the list and does not read it', async () => {
    const access = createProviderAccess(auth, instances)
    expect(access.usageSlots().map((slot) => [slot.id, slot.instanceId])).toEqual([['xai', 'pi:xai']])
    expect(await access.usageFor('opencode-go')).toBeUndefined()
    expect(await access.usageFor('xai')).toMatchObject({ id: 'xai' })
  })

  it('without the check (an older instance service) every provider is listed', () => {
    const access = createProviderAccess(auth, { isRemoved: () => false, instanceIdForLegacyProvider: (id: string) => `pi:${id}` })
    expect(access.usageSlots()).toHaveLength(2)
  })
})

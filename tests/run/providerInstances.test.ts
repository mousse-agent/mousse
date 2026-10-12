import { describe, expect, it } from 'vitest'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import {
  instanceIdForLegacyProvider,
  legacyProviderForInstance,
  seedProviderInstances
} from '../../src/shared/providerInstances'

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

const PI_PROVIDERS = new Set(['openai', 'anthropic', 'openrouter', 'openai-codex'])
const isPi = (id: string) => PI_PROVIDERS.has(id)

describe('legacy provider mapping', () => {
  it('maps every older llmProvider name to one instance id', () => {
    const table: Array<[string, string]> = [
      ['claude-subscription', 'claude'],
      ['antigravity', 'antigravity'],
      ['codex', 'codex'],
      ['openai', 'pi:openai'],
      ['anthropic', 'pi:anthropic'],
      ['openai-codex', 'pi:openai-codex'],
      [' openrouter ', 'pi:openrouter']
    ]
    for (const [legacy, instanceId] of table) expect(instanceIdForLegacyProvider(legacy, isPi)).toBe(instanceId)
  })

  it('rejects unknown and empty names with provider_instance_unknown', () => {
    for (const name of ['whatever', 'claude', 'pi:openai', 'codex-cli', ''])
      expect(codeOf(() => instanceIdForLegacyProvider(name, isPi))).toBe('provider_instance_unknown')
    expect(() => instanceIdForLegacyProvider('whatever', isPi)).toThrow(/"whatever"/)
  })

  it('derives the reported llmProvider back from an instance', () => {
    expect(legacyProviderForInstance('claude', { driver: 'claude' })).toBe('claude-subscription')
    expect(legacyProviderForInstance('antigravity', { driver: 'antigravity' })).toBe('antigravity')
    expect(legacyProviderForInstance('codex', { driver: 'codex' })).toBe('codex')
    expect(legacyProviderForInstance('pi:openai', { driver: 'pi' })).toBe('openai')
    expect(legacyProviderForInstance('openai', { driver: 'pi' })).toBeUndefined()
  })
})

describe('instance seeding', () => {
  it('seeds the vendor instances and one pi instance per credentialed provider', () => {
    const { instances, added, seedVersion } = seedProviderInstances(undefined, ['openai'])
    expect(seedVersion).toBe(1)
    expect(instances).toEqual({
      antigravity: { driver: 'antigravity', enabled: true },
      claude: { driver: 'claude', enabled: true },
      codex: { driver: 'codex', enabled: true },
      'pi:openai': { driver: 'pi', enabled: true }
    })
    expect(added).toEqual(['antigravity', 'claude', 'codex', 'pi:openai'])
  })

  it('extends a stored map with missing seeds and never overwrites a stored entry', () => {
    const stored = {
      claude: { driver: 'claude', enabled: false, config: { note: 'mine' } },
      codex: { driver: 'codex', enabled: false },
      'pi:openai': 'malformed but stored',
      custom: { driver: 'pi', enabled: true }
    }
    const { instances, added } = seedProviderInstances(stored, ['openai', 'openrouter'], 1)
    expect(instances.claude).toEqual({ driver: 'claude', enabled: false, config: { note: 'mine' } })
    expect(instances.codex).toEqual({ driver: 'codex', enabled: false })
    expect(instances['pi:openai']).toBe('malformed but stored')
    expect(instances.custom).toEqual({ driver: 'pi', enabled: true })
    expect(added).toEqual(['antigravity', 'pi:openrouter'])
    // The input is not mutated.
    expect(Object.keys(stored)).toEqual(['claude', 'codex', 'pi:openai', 'custom'])
  })
})

describe('seed versions', () => {
  // A hypothetical future change: version 2 seeds `claude` with a config.
  const change = { before: 2, id: 'claude', seed: { driver: 'claude' as const, enabled: true }, next: { driver: 'claude' as const, enabled: true, config: { v: 2 } } }

  it('never upgrades an entry without seed provenance', () => {
    // No marker: a disabled Codex may be the user's choice, so it stays disabled.
    expect(seedProviderInstances({ codex: { driver: 'codex', enabled: false } }, [], undefined)).toMatchObject({
      instances: { codex: { driver: 'codex', enabled: false } }, upgraded: [], seedVersion: 1
    })
    expect(seedProviderInstances({ claude: { driver: 'claude', enabled: true } }, [], undefined, [change], 2)).toMatchObject({
      instances: { claude: { driver: 'claude', enabled: true } }, upgraded: []
    })
  })

  it('moves a marked entry that still equals a superseded seed and keeps one the user changed', () => {
    expect(seedProviderInstances({ claude: { driver: 'claude', enabled: true } }, [], 1, [change], 2)).toMatchObject({
      instances: { claude: { driver: 'claude', enabled: true, config: { v: 2 } } }, upgraded: ['claude'], seedVersion: 2
    })
    expect(seedProviderInstances({ claude: { driver: 'claude', enabled: false } }, [], 1, [change], 2)).toMatchObject({
      instances: { claude: { driver: 'claude', enabled: false } }, upgraded: []
    })
    // Already at the change's version: nothing to move.
    expect(seedProviderInstances({ claude: { driver: 'claude', enabled: true } }, [], 2, [change], 2).upgraded).toEqual([])
  })
})

describe('ProviderInstanceService', () => {
  const service = (stored?: unknown, credentials: string[] = [], seedVersion: unknown = 1) => {
    const store = { value: stored, seedVersion, writes: 0, fail: undefined as Error | undefined }
    const instances = new ProviderInstanceService({
      store: {
        read: () => {
          if (store.fail) throw store.fail
          return { instances: store.value, seedVersion: store.seedVersion }
        },
        write: (next) => { store.value = next.instances; store.seedVersion = next.seedVersion; store.writes += 1 }
      },
      providerAuth: {
        credentials: { listProviderIds: () => credentials },
        has: (id: string) => id !== 'web-tool:exa',
        getConfiguredProviders: () => credentials.map((id) => ({ id, label: id, authType: 'api_key' as const })),
        getConfiguredLlmProviders: () => credentials.map((id) => ({ id, label: id, models: [{ id: 'm', label: 'M' }] }))
      }
    })
    return { instances, store }
  }

  it('persists seeds once on load and again only when a new provider is credentialed', () => {
    const credentials = ['openai', 'web-tool:exa']
    const { instances, store } = service(undefined, credentials)
    expect(Object.keys(instances.list())).toEqual(['antigravity', 'claude', 'codex', 'pi:openai'])
    expect(store.writes).toBe(1)
    instances.list()
    expect(store.writes).toBe(1)
    credentials.push('openrouter')
    expect(instances.list()['pi:openrouter']).toEqual({ driver: 'pi', enabled: true })
    expect(store.writes).toBe(2)
  })

  it('records the seed version with the seeds and keeps an unmarked disabled Codex disabled', () => {
    const fresh = service(undefined, [], null)
    fresh.instances.list()
    expect(fresh.store.seedVersion).toBe(1)
    expect((fresh.store.value as Record<string, unknown>).codex).toEqual({ driver: 'codex', enabled: true })
    const old = service({ antigravity: { driver: 'antigravity', enabled: true }, claude: { driver: 'claude', enabled: true }, codex: { driver: 'codex', enabled: false } }, [], null)
    expect(old.instances.list().codex).toEqual({ driver: 'codex', enabled: false })
    // Only the marker is written; later reads write nothing.
    expect(old.store).toMatchObject({ seedVersion: 1, writes: 1 })
    old.instances.list()
    expect(old.store.writes).toBe(1)
  })

  it('never seeds or writes after a failed read, and keeps the last map it read', () => {
    const { instances, store } = service({ claude: { driver: 'claude', enabled: false, config: { note: 'mine' } } })
    expect(instances.list().claude).toEqual({ driver: 'claude', enabled: false, config: { note: 'mine' } })
    const writes = store.writes
    store.fail = new Error('settings unreadable')
    store.value = undefined
    expect(instances.list().claude).toEqual({ driver: 'claude', enabled: false, config: { note: 'mine' } })
    expect(codeOf(() => instances.resolve('claude'))).toBe('provider_instance_disabled')
    expect(store.writes).toBe(writes)
    expect(instances.storeError()).toBe('settings unreadable')
    // A profile that was never read successfully still works from in-memory seeds, unsaved.
    const cold = service(undefined)
    cold.store.fail = new Error('locked')
    expect(cold.instances.list().claude).toEqual({ driver: 'claude', enabled: true })
    expect(cold.store.writes).toBe(0)
    store.fail = undefined
    store.value = { claude: { driver: 'claude', enabled: true } }
    instances.list()
    expect(instances.storeError()).toBeUndefined()
  })

  it('ignores malformed stored entries on read without rewriting them', () => {
    const { instances, store } = service({ claude: { driver: 'nope', enabled: true } })
    expect(instances.list().claude).toBeUndefined()
    expect((store.value as Record<string, unknown>).claude).toEqual({ driver: 'nope', enabled: true })
    expect(codeOf(() => instances.resolve('claude'))).toBe('provider_instance_unknown')
  })

  it('stores protocol selections in the instance shape and rejects unknown or disabled ones', () => {
    const { instances } = service({ antigravity: { driver: 'antigravity', enabled: false } }, ['openai'])
    expect(instances.overrideFor({ llmProvider: 'claude-subscription', model: 'sonnet' })).toEqual({ instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' })
    expect(instances.overrideFor({ instanceId: 'pi:openai', llmProvider: 'stale', model: 'gpt' })).toEqual({ instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt' })
    expect(codeOf(() => instances.overrideFor({ llmProvider: 'whatever', model: 'x' }))).toBe('provider_instance_unknown')
    expect(codeOf(() => instances.overrideFor({ instanceId: 'antigravity', model: 'x' }))).toBe('provider_instance_disabled')
  })

  it('migrates stored selections on read and leaves unmappable ones for the turn to reject', () => {
    const { instances } = service()
    expect(instances.migrate({ llmProvider: 'antigravity', model: 'gemini' })).toEqual({ instanceId: 'antigravity', llmProvider: 'antigravity', model: 'gemini' })
    expect(instances.migrate({ llmProvider: 'openai', model: 'gpt' })).toEqual({ instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt' })
    expect(instances.migrate({ llmProvider: 'whatever', model: 'x' })).toEqual({ llmProvider: 'whatever', model: 'x' })
    expect(instances.migrate(undefined)).toBeUndefined()
  })

  it('lists configured providers and model catalogs from one instance map, with instance ids', () => {
    const { instances } = service({ 'pi:openrouter': { driver: 'pi', enabled: false }, antigravity: { driver: 'antigravity', enabled: false } }, ['openai', 'openrouter'])
    instances
      .registerVendor('claude', { configuredProvider: () => ({ id: 'claude-subscription', label: 'Claude', authType: 'oauth' }), llmProvider: () => ({ id: 'claude-subscription', label: 'Claude', models: [] }) })
      .registerVendor('antigravity', { configuredProvider: () => ({ id: 'antigravity', label: 'Antigravity', authType: 'oauth' }), llmProvider: () => undefined })
    expect(instances.configuredProviders().map((provider) => [provider.id, provider.instanceId])).toEqual([
      ['openai', 'pi:openai'],
      ['claude-subscription', 'claude']
    ])
    expect(instances.llmProviders().map((provider) => [provider.id, provider.instanceId])).toEqual([
      ['openai', 'pi:openai'],
      ['claude-subscription', 'claude']
    ])
  })
})

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
    const { instances, added } = seedProviderInstances(undefined, ['openai'])
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
    const { instances, added } = seedProviderInstances(stored, ['openai', 'openrouter'])
    expect(instances.claude).toEqual({ driver: 'claude', enabled: false, config: { note: 'mine' } })
    expect(instances.codex).toEqual({ driver: 'codex', enabled: false })
    expect(instances['pi:openai']).toBe('malformed but stored')
    expect(instances.custom).toEqual({ driver: 'pi', enabled: true })
    expect(added).toEqual(['antigravity', 'pi:openrouter'])
    // The input is not mutated.
    expect(Object.keys(stored)).toEqual(['claude', 'codex', 'pi:openai', 'custom'])
  })
})

describe('ProviderInstanceService', () => {
  const service = (stored?: unknown, credentials: string[] = []) => {
    const store = { value: stored, writes: 0 }
    const instances = new ProviderInstanceService({
      store: { read: () => store.value, write: (next) => { store.value = next; store.writes += 1 } },
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

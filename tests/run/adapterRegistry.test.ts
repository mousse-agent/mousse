import { describe, expect, it } from 'vitest'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { RunStoreError } from '../../src/mms/run/db/RunStoreError'
import { AdapterRegistry } from '../../src/mms/run/adapters/AdapterRegistry'
import { PiLoopAdapter } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { ProviderAdapter } from '../../src/mms/run/adapters/ProviderAdapter'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'

const pi = (): PiLoopAdapter => new PiLoopAdapter(() => ({ chat: async () => { throw new Error('unused') } }))

const fake = (driver: ProviderDriverKind, configured = true): ProviderAdapter => ({
  driver,
  capabilities: pi().capabilities,
  configured: () => configured,
  startTurn: async () => { throw new Error('unused') },
  interrupt: async () => 'not_active'
})

/** An in-memory profile whose stored map is `stored`; `credentials` are the credentialed pi providers. */
const instances = (stored?: Record<string, unknown>, credentials: string[] = []) => {
  let value: unknown = stored
  return new ProviderInstanceService({
    store: { read: () => value, write: (next) => { value = next } },
    providerAuth: { credentials: { listProviderIds: () => credentials } }
  })
}

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

describe('AdapterRegistry', () => {
  const full = (source = instances()) => {
    const adapters = { pi: pi(), claude: fake('claude'), antigravity: fake('antigravity'), codex: fake('codex') }
    const registry = new AdapterRegistry(source)
    for (const adapter of Object.values(adapters)) registry.register(adapter)
    return { registry, adapters }
  }

  it('resolves each seeded instance to the adapter of its driver', () => {
    const { registry, adapters } = full(instances({ codex: { driver: 'codex', enabled: true } }, ['openai']))
    expect(registry.resolve('claude')).toMatchObject({ instanceId: 'claude', llmProvider: 'claude-subscription', adapter: adapters.claude })
    expect(registry.resolve('antigravity')).toMatchObject({ llmProvider: 'antigravity', adapter: adapters.antigravity })
    expect(registry.resolve('codex')).toMatchObject({ llmProvider: 'codex', adapter: adapters.codex })
    // A pi instance runs on the pi loop with the provider id taken from the instance id.
    expect(registry.resolve('pi:openai')).toMatchObject({ entry: { driver: 'pi' }, llmProvider: 'openai', adapter: adapters.pi })
    // A known pi-ai provider without credentials (no stored entry yet) is still its own instance.
    expect(registry.resolve('pi:anthropic')).toMatchObject({ llmProvider: 'anthropic', adapter: adapters.pi })
  })

  it('routes older llmProvider selections through the legacy mapping', () => {
    const { registry, adapters } = full()
    expect(registry.resolveSelection({ llmProvider: 'claude-subscription' })).toMatchObject({ instanceId: 'claude', adapter: adapters.claude })
    expect(registry.resolveSelection({ llmProvider: 'antigravity' })).toMatchObject({ instanceId: 'antigravity', adapter: adapters.antigravity })
    expect(registry.resolveSelection({ llmProvider: 'openai' })).toMatchObject({ instanceId: 'pi:openai', adapter: adapters.pi })
    // The instance id wins over a stale provider name.
    expect(registry.resolveSelection({ instanceId: 'claude', llmProvider: 'openai' }).adapter).toBe(adapters.claude)
  })

  it('rejects an unknown instance by name instead of falling back to the pi loop', () => {
    const { registry } = full()
    for (const id of ['whatever', 'claude-subscription', 'pi:not-a-provider', 'pi:'])
      expect(codeOf(() => registry.resolve(id))).toBe('provider_instance_unknown')
    expect(() => registry.resolve('whatever')).toThrow(/"whatever"/)
    expect(codeOf(() => registry.resolveSelection({ llmProvider: 'whatever' }))).toBe('provider_instance_unknown')
  })

  it('rejects a disabled instance, but still reaches it to stop running work', () => {
    const { registry, adapters } = full(instances({ 'pi:openai': { driver: 'pi', enabled: false } }))
    // Codex is seeded disabled until its adapter ships.
    expect(codeOf(() => registry.resolve('codex'))).toBe('provider_instance_disabled')
    expect(() => registry.resolve('codex')).toThrow(/"codex"/)
    expect(codeOf(() => registry.resolveSelection({ llmProvider: 'openai' }))).toBe('provider_instance_disabled')
    expect(registry.resolve('codex', { allowDisabled: true }).adapter).toBe(adapters.codex)
  })

  it('reports a driver without an adapter as a bad request', () => {
    const registry = new AdapterRegistry(instances()).register(pi())
    let error: unknown
    try {
      registry.resolve('antigravity')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(RunStoreError)
    expect((error as RunStoreError).code).toBe('bad_request')
  })

  it('runs a selection that names nothing on the pi loop, which resolves its own default', () => {
    const { registry, adapters } = full()
    expect(registry.resolveSelection({ llmProvider: '' })).toMatchObject({ instanceId: 'pi', llmProvider: '', adapter: adapters.pi })
  })

  it('offers only enabled, signed-in vendor instances as configured providers', () => {
    const registry = new AdapterRegistry(instances({ antigravity: { driver: 'antigravity', enabled: false } }))
      .register(pi()).register(fake('claude')).register(fake('antigravity')).register(fake('codex'))
    expect(registry.configuredProviderIds()).toEqual(['claude-subscription'])
    const signedOut = new AdapterRegistry(instances()).register(pi()).register(fake('claude', false))
    expect(signedOut.configuredProviderIds()).toEqual([])
  })

  it('refuses a second adapter for the same driver', () => {
    const registry = new AdapterRegistry().register(pi())
    expect(() => registry.register(pi())).toThrow(/already registered/)
  })
})

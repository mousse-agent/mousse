import { describe, expect, it } from 'vitest'
import { RunStoreError } from '../../src/mms/run/db/RunStoreError'
import { AdapterRegistry, adapterIdFor } from '../../src/mms/run/adapters/AdapterRegistry'
import { PiLoopAdapter } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { ProviderAdapter } from '../../src/mms/run/adapters/ProviderAdapter'

const pi = (): PiLoopAdapter => new PiLoopAdapter(() => ({ chat: async () => { throw new Error('unused') } }))

const fake = (id: string): ProviderAdapter => ({
  id,
  capabilities: pi().capabilities,
  startTurn: async () => { throw new Error('unused') },
  interrupt: async () => 'not_active'
})

describe('AdapterRegistry', () => {
  it('routes vendor runtimes to their own adapter and everything else to pi', () => {
    expect(adapterIdFor('claude-subscription')).toBe('claude-subscription')
    expect(adapterIdFor('antigravity')).toBe('antigravity')
    for (const provider of ['openai', 'anthropic', 'openrouter', 'cursor', 'whatever'])
      expect(adapterIdFor(provider)).toBe('pi')
  })

  it('resolves registered adapters', () => {
    const piAdapter = pi()
    const claude = fake('claude-subscription')
    const registry = new AdapterRegistry().register(piAdapter).register(claude)
    expect(registry.get('openai')).toBe(piAdapter)
    expect(registry.get('claude-subscription')).toBe(claude)
    expect(registry.list()).toEqual([piAdapter, claude])
  })

  it('rejects an unregistered adapter as a bad request', () => {
    const registry = new AdapterRegistry().register(pi())
    let error: unknown
    try {
      registry.get('antigravity')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(RunStoreError)
    expect((error as RunStoreError).code).toBe('bad_request')
    expect(() => new AdapterRegistry().get('openai')).toThrow(RunStoreError)
  })

  it('refuses a second adapter with the same id', () => {
    const registry = new AdapterRegistry().register(pi())
    expect(() => registry.register(pi())).toThrow(/already registered/)
  })
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createProvider, type Api, type Model } from '@earendil-works/pi-ai'
import { FileModelsStore } from '../src/mms/providers/FileModelsStore'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'

function fixtureDir(context: { onTestFinished: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-catalog-startup-'))
  context.onTestFinished(() => {
    if (!dir.startsWith(join(tmpdir(), 'mousse-catalog-startup-'))) throw new Error('Unsafe fixture cleanup')
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

describe('FileModelsStore', () => {
  it('persists entries across instances and tolerates a corrupt file', async (context) => {
    const dir = fixtureDir(context)
    const path = join(dir, 'models-cache.json')
    writeFileSync(path, 'corrupt')
    const store = new FileModelsStore(path)
    expect(await store.read('openrouter')).toBeUndefined()

    await store.write('openrouter', { models: [], checkedAt: 1 })
    expect(await new FileModelsStore(path).read('openrouter')).toEqual({ models: [], checkedAt: 1 })

    await store.delete('openrouter')
    expect(await new FileModelsStore(path).read('openrouter')).toBeUndefined()
  })
})

describe('ProviderAuthService startup', () => {
  it('restores cached catalogs without waiting for the network', async (context) => {
    const dir = fixtureDir(context)
    const openrouter = new ProviderAuthService(join(dir, 'probe', 'auth.json')).models.getModels('openrouter')[0]!
    const cachedModel = { ...openrouter, id: 'cached/model-from-last-run', name: 'Cached Model' }
    writeFileSync(
      join(dir, 'models-cache.json'),
      JSON.stringify({ version: 1, providers: { openrouter: { models: [cachedModel], checkedAt: Date.now() } } })
    )
    writeFileSync(
      join(dir, 'pi-catalog-cache.json'),
      JSON.stringify({
        version: 1,
        piVersion: '9.9.9',
        checkedAt: Date.now(),
        providers: {
          'openai-codex': [
            {
              id: 'gpt-6-sol',
              name: 'GPT-6 Sol',
              api: 'openai-codex-responses',
              provider: 'openai-codex',
              baseUrl: 'https://chatgpt.com/backend-api',
              reasoning: true,
              input: ['text', 'image'],
              cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
              contextWindow: 272000,
              maxTokens: 128000
            }
          ]
        }
      })
    )

    // Every network request hangs: startup must not depend on any of them.
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined))
    vi.stubGlobal('fetch', fetchMock)
    context.onTestFinished(() => vi.unstubAllGlobals())

    const service = new ProviderAuthService(join(dir, 'auth.json'))
    context.onTestFinished(() => service.stop())
    const started = performance.now()
    await service.init()
    expect(performance.now() - started).toBeLessThan(5_000)

    const catalogs = service.getCatalogLlmProviders()
    const models = (id: string) => catalogs.find((provider) => provider.id === id)?.models.map((model) => model.id) ?? []
    expect(models('openrouter')).toContain('cached/model-from-last-run')
    expect(models('openai-codex')).toContain('gpt-6-sol')
    expect(models('cursor').length).toBeGreaterThan(0)
  })

  async function controlledCatalog(context: { onTestFinished: (fn: () => void) => void }) {
    const dir = fixtureDir(context)
    // Keep the independent package overlay fresh so these tests isolate provider refresh.
    writeFileSync(join(dir, 'pi-catalog-cache.json'), JSON.stringify({
      version: 1, piVersion: '9.9.9', checkedAt: Date.now(), providers: {}
    }))
    const service = new ProviderAuthService(join(dir, 'auth.json'))
    context.onTestFinished(() => service.stop())
    const original = service.models.getProvider('openrouter')!
    const baseline = { ...original.getModels()[0]!, provider: 'probe', id: 'cached-probe', name: 'Cached Probe' }
    const requests: { signal: AbortSignal; resolve: (models: Model<Api>[]) => void }[] = []
    service.models.clearProviders()
    service.models.setProvider(createProvider({
      id: 'probe',
      name: 'Probe',
      models: [baseline],
      auth: { apiKey: { name: 'Probe', resolve: async () => ({ auth: { apiKey: 'probe' } }) } },
      fetchModels: (input) => new Promise((resolve) => requests.push({ signal: input.signal, resolve })),
      api: { stream: original.stream, streamSimple: original.streamSimple }
    }))
    await service.init()
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    return { service, requests, baseline, dir }
  }

  it('discovers once per refresh and notifies changes to model metadata', async (context) => {
    const { service, requests, baseline } = await controlledCatalog(context)
    const changed = vi.fn()
    service.onCatalogChanged(changed)
    requests[0].resolve([{ ...baseline, contextWindow: baseline.contextWindow + 1 }])
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    expect(requests).toHaveLength(1)
    expect(service.models.getModels('probe')[0].contextWindow).toBe(baseline.contextWindow + 1)
  })

  it('queues one refresh for credentials changed during discovery', async (context) => {
    const { service, requests, baseline } = await controlledCatalog(context)
    const first = service.refreshDynamicModels()
    const second = service.refreshDynamicModels()
    expect(first).toBe(second)
    requests[0].resolve([baseline])
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    requests[1].resolve([{ ...baseline, id: 'new-probe' }])
    await first
    expect(requests).toHaveLength(2)
    expect(service.models.getModels('probe').map((model) => model.id)).toContain('new-probe')
  })

  it('aborts refresh on shutdown and fences late results and queued work', async (context) => {
    const { service, requests, baseline, dir } = await controlledCatalog(context)
    const changed = vi.fn()
    service.onCatalogChanged(changed)
    const queued = service.refreshDynamicModels()
    service.stop()
    await queued
    expect(requests[0].signal.aborted).toBe(true)
    requests[0].resolve([{ ...baseline, id: 'late-probe' }])
    await new Promise((resolve) => setImmediate(resolve))
    expect(service.models.getModels('probe').map((model) => model.id)).not.toContain('late-probe')
    expect(await new FileModelsStore(join(dir, 'models-cache.json')).read('probe')).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()
    expect(requests).toHaveLength(1)
  })

  it('bounds hung discovery and permits a later refresh without stale publication', async (context) => {
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    context.onTestFinished(() => timeout.mockRestore())
    const { service, requests, baseline } = await controlledCatalog(context)
    const queued = service.refreshDynamicModels()
    timeout.mockRestore()
    deadline.abort()
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    requests[1].resolve([{ ...baseline, id: 'fresh-probe' }])
    await queued
    requests[0].resolve([{ ...baseline, id: 'stale-probe' }])
    await new Promise((resolve) => setImmediate(resolve))
    expect(service.models.getModels('probe').map((model) => model.id)).toContain('fresh-probe')
    expect(service.models.getModels('probe').map((model) => model.id)).not.toContain('stale-probe')
  })
})

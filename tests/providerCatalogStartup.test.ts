import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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
  })
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { compareVersions } from '../src/mms/harness/driver'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { catalogApiModels, gateModelCatalog, parseModelCatalog, type ModelCatalog } from '../src/shared/modelCatalog'
import type { LlmModelOption } from '../src/shared/settings'

// Made-up models only: adding a real model to the catalog never touches this file.
const entry = (id: string, released: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Acme ${id}`,
  short: id,
  maker: 'acme',
  family: 'ember',
  released,
  routes: { openai: { id: `api-${id}` } },
  ...extra
})
const catalogOf = (models: unknown[]): ModelCatalog => parseModelCatalog({ format: 1, revision: 1, models })

describe('API model lists named by the catalog', () => {
  const catalog = catalogOf([
    entry('ember-1', '2030-01-01', { older: true }),
    entry('ember-3', '2030-03-01'),
    entry('ember-2', '2030-02-01', { older: true }),
    entry('ember-next', '2030-04-01', { routes: { openai: { id: 'api-ember-next', minMousse: '1.3.0' } } }),
    entry('ember-claude', '2030-05-01', { routes: { claude: { id: 'api-ember-claude' } } })
  ])
  const listed: LlmModelOption[] = [
    { id: 'custom-b', label: 'Custom B' },
    { id: 'api-ember-1', label: 'ember one', efforts: ['low', 'high'], contextWindow: 1000 },
    { id: 'api-ember-claude', label: 'Only on another route' },
    { id: 'api-ember-3', label: 'ember three', images: true, oneShot: false },
    { id: 'custom-a', label: 'Custom A' },
    { id: 'api-ember-2', label: 'ember two', older: true },
    { id: 'api-ember-next', label: 'ember next' }
  ]

  it('names catalog models, newest first, with older ones marked, and keeps other fields', () => {
    const models = catalogApiModels(listed, catalog, catalog, 'openai')
    expect(models.slice(0, 4)).toEqual([
      { id: 'api-ember-next', label: 'Acme ember-next' },
      { id: 'api-ember-3', label: 'Acme ember-3', images: true, oneShot: false },
      { id: 'api-ember-2', label: 'Acme ember-2', older: true },
      { id: 'api-ember-1', label: 'Acme ember-1', efforts: ['low', 'high'], contextWindow: 1000, older: true }
    ])
  })

  it('keeps models the catalog does not know on this route by their own name, after the known ones', () => {
    const models = catalogApiModels(listed, catalog, catalog, 'openai')
    expect(models.slice(4)).toEqual([
      { id: 'custom-b', label: 'Custom B' },
      { id: 'api-ember-claude', label: 'Only on another route' },
      { id: 'custom-a', label: 'Custom A' }
    ])
  })

  it('matches by the route id, not the catalog id', () => {
    expect(catalogApiModels([{ id: 'ember-3', label: 'by catalog id' }], catalog, catalog, 'openai')).toEqual([{ id: 'ember-3', label: 'by catalog id' }])
  })

  it('drops a model whose route needs a newer Mousse', () => {
    const gated = gateModelCatalog(catalog, '1.2.0', compareVersions)
    const ids = catalogApiModels(listed, catalog, gated, 'openai').map((model) => model.id)
    expect(ids).not.toContain('api-ember-next')
    expect(ids).toEqual(['api-ember-3', 'api-ember-2', 'api-ember-1', 'custom-b', 'api-ember-claude', 'custom-a'])
  })

  it('does not change the list it was given', () => {
    const before = structuredClone(listed)
    catalogApiModels(listed, catalog, catalog, 'openai')
    expect(listed).toEqual(before)
  })
})

describe('ProviderAuthService API lists', () => {
  function service(context: { onTestFinished: (fn: () => void) => void }, catalog: () => ModelCatalog) {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-api-names-'))
    context.onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    // Offline, with the package overlay fresh: the lists are the bundled ones.
    writeFileSync(join(dir, 'pi-catalog-cache.json'), JSON.stringify({ version: 1, piVersion: '9.9.9', checkedAt: Date.now(), providers: {} }))
    const auth = new ProviderAuthService(join(dir, 'auth.json'), { modelCatalog: catalog })
    context.onTestFinished(() => auth.stop())
    return auth
  }

  function offline(context: { onTestFinished: (fn: () => void) => void }) {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Offline') }))
    context.onTestFinished(() => {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    })
  }

  const empty = (): ModelCatalog => catalogOf([])

  for (const [provider, route] of [['openai', 'openai'], ['anthropic', 'anthropic']] as const) {
    it(`names and orders the ${provider} list, gates it, and changes no field turns run on`, async (context) => {
      offline(context)
      vi.stubEnv('MOUSSE_VERSION', '1.2.0')
      const plain = service(context, empty)
      await plain.init()
      const before = JSON.stringify(plain.models.getModels(provider))
      const ids = plain.models.getModels(provider).map((model) => model.id)
      expect(ids.length).toBeGreaterThan(3)
      const [first, second, third] = ids as [string, string, string]
      const catalog = catalogOf([
        { ...entry('older-one', '2030-01-01', { older: true }), routes: { [route]: { id: first } } },
        { ...entry('newer-one', '2030-06-01'), routes: { [route]: { id: second } } },
        { ...entry('later-one', '2030-09-01'), routes: { [route]: { id: third, minMousse: '1.3.0' } } }
      ])
      const named = service(context, () => catalog)
      await named.init()
      const listOf = (auth: ProviderAuthService) => auth.getCatalogLlmProviders().find((option) => option.id === provider)!.models

      const plainList = listOf(plain)
      const namedList = listOf(named)
      expect(namedList.slice(0, 2)).toEqual([
        { ...plainList.find((model) => model.id === second), label: 'Acme newer-one' },
        { ...plainList.find((model) => model.id === first), label: 'Acme older-one', older: true }
      ])
      // The route that needs a newer Mousse is gone; the rest keep their names and order.
      expect(namedList.map((model) => model.id)).not.toContain(third)
      expect(namedList.slice(2)).toEqual(plainList.filter((model) => ![first, second, third].includes(model.id)))
      // The models turns run on are the same, field for field.
      expect(JSON.stringify(named.models.getModels(provider))).toBe(before)
      expect(JSON.stringify(plain.models.getModels(provider))).toBe(before)
    })
  }

  it('leaves other providers alone', async (context) => {
    offline(context)
    const plain = service(context, empty)
    const openrouter = plain.models.getModels('openrouter')[0]!.id
    const named = service(context, () => catalogOf([{ ...entry('router', '2030-01-01'), routes: { openai: { id: openrouter } } }]))
    await Promise.all([plain.init(), named.init()])
    const list = (auth: ProviderAuthService) => auth.getCatalogLlmProviders().find((option) => option.id === 'openrouter')!.models
    expect(list(named)).toEqual(list(plain))
  })

  it('keeps the plain list when the catalog cannot be read', async (context) => {
    offline(context)
    const plain = service(context, empty)
    const broken = service(context, () => { throw new Error('unreadable') })
    await Promise.all([plain.init(), broken.init()])
    const list = (auth: ProviderAuthService) => auth.getCatalogLlmProviders().find((option) => option.id === 'openai')!.models
    expect(list(broken)).toEqual(list(plain))
  })
})

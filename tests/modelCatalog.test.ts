import { describe, expect, it } from 'vitest'
import { compareVersions } from '../src/mms/harness/driver'
import { catalogModelsOnRoute, gateModelCatalog, ModelCatalogError, parseModelCatalog, validCatalogDate } from '../src/shared/modelCatalog'

// Made-up models only: adding a real model to the catalog never touches this file.
const ember = { id: 'ember-2', name: 'Acme Ember 2', short: 'Ember 2', maker: 'acme', family: 'ember', released: '2030-02-01', routes: { claude: { id: 'ember-2' } } }
const file = (models: unknown[], extra: Record<string, unknown> = {}) => ({ format: 1, revision: 3, models, ...extra })

describe('model catalog reader', () => {
  it('reads a model and fills the short name from the full one', () => {
    const { short: _short, ...unnamed } = ember
    const catalog = parseModelCatalog(file([ember, { ...unnamed, id: 'ember-3', routes: { claude: { id: 'ember-3' } } }]))
    expect(catalog).toEqual({ format: 1, revision: 3, models: [ember, { ...unnamed, id: 'ember-3', short: 'Acme Ember 2', routes: { claude: { id: 'ember-3' } } }] })
  })

  it('ignores unknown fields, route keys and effort levels', () => {
    const catalog = parseModelCatalog(file([
      { ...ember, price: 3, older: true, efforts: ['low', 'turbo', 'high', 'low'], routes: { claude: { id: 'ember-2', headers: {} }, someday: { id: 'ember-2' } } }
    ], { signedBy: 'nobody' }))
    expect(catalog.models).toEqual([{ ...ember, older: true, efforts: ['low', 'high'], routes: { claude: { id: 'ember-2' } } }])
  })

  it('reads an optional tier, with or without it, and drops a tier it does not know (Bot Phase 1 §5.6)', () => {
    const catalog = parseModelCatalog(file([
      { ...ember, tier: 'frontier' },
      { ...ember, id: 'ember-3', tier: 'gigantic', routes: { claude: { id: 'ember-3' } } },
      { ...ember, id: 'ember-4', routes: { claude: { id: 'ember-4' } } }
    ]))
    expect(catalog.models.map((model) => model.tier)).toEqual(['frontier', undefined, undefined])
    expect(catalog.models[1]).not.toHaveProperty('tier')
    expect(catalog.models).toHaveLength(3)
  })

  it('drops an invalid model and keeps the rest', () => {
    const catalog = parseModelCatalog(file([
      { ...ember, id: '' },
      { ...ember, id: 'no-date', released: '2030-02-30' },
      { ...ember, id: 'no-routes', routes: { someday: { id: 'x' } } },
      { ...ember, id: 'no-name', name: 7 },
      'not a model',
      ember,
      { ...ember, name: 'Acme Ember 2 again' },
      { ...ember, id: 'same-route', routes: { claude: { id: 'ember-2' } } }
    ]))
    expect(catalog.models.map((model) => model.id)).toEqual(['ember-2'])
  })

  it('rejects the whole file only when it is not a catalog or its format is unknown', () => {
    expect(() => parseModelCatalog('{ not json')).toThrow(ModelCatalogError)
    expect(() => parseModelCatalog(file([ember], { format: 2 }))).toThrow(ModelCatalogError)
    expect(() => parseModelCatalog([])).toThrow(ModelCatalogError)
    expect(() => parseModelCatalog(file([ember], { revision: 'one' }))).toThrow(ModelCatalogError)
    expect(parseModelCatalog(JSON.stringify(file([ember]))).models).toHaveLength(1)
  })

  it('reads minMousse on a route and drops a route whose limit does not parse', () => {
    const catalog = parseModelCatalog(file([
      { ...ember, routes: { claude: { id: 'ember-2', minMousse: '0.3.0' }, anthropic: { id: 'ember-2', minMousse: 'soon' } } },
      { ...ember, id: 'ember-1', routes: { claude: { id: 'ember-1', minMousse: 3 } } }
    ]))
    expect(catalog.models).toEqual([{ ...ember, routes: { claude: { id: 'ember-2', minMousse: '0.3.0' } } }])
  })

  it('checks dates on the calendar', () => {
    expect(validCatalogDate('2030-02-28')).toBe(true)
    expect(validCatalogDate('2030-02-29')).toBe(false)
    expect(validCatalogDate('2030-2-1')).toBe(false)
  })
})

describe('model catalog version limits', () => {
  const catalog = parseModelCatalog(file([
    { ...ember, routes: { claude: { id: 'ember-2', minMousse: '0.3.0' }, anthropic: { id: 'ember-2' } } },
    { ...ember, id: 'ember-9', routes: { claude: { id: 'ember-9', minMousse: '0.3.1' } } }
  ]))

  it('removes a route this version does not handle yet; the model stays on its other routes', () => {
    const gated = gateModelCatalog(catalog, '0.2.9', compareVersions)
    expect(gated.models).toEqual([{ ...ember, routes: { anthropic: { id: 'ember-2' } } }])
  })

  it('counts the bound as inclusive and reads a nightly by its version', () => {
    expect(gateModelCatalog(catalog, '0.3.0', compareVersions).models.map((model) => Object.keys(model.routes))).toEqual([['claude', 'anthropic']])
    expect(gateModelCatalog(catalog, '0.3.1-nightly.20301101', compareVersions).models.map((model) => model.id)).toEqual(['ember-2', 'ember-9'])
  })

  it('counts a missing version (0.0.0) as newest', () => {
    expect(gateModelCatalog(catalog, '0.0.0', compareVersions)).toEqual(catalog)
  })

  it('lists a route\'s models newest first', () => {
    const models = parseModelCatalog(file([
      { ...ember, id: 'a', released: '2030-01-01', routes: { claude: { id: 'a' } } },
      { ...ember, id: 'b', released: '2030-03-01', routes: { claude: { id: 'b' } } },
      { ...ember, id: 'c', released: '2030-02-01', routes: { anthropic: { id: 'c' } } }
    ]))
    expect(catalogModelsOnRoute(models, 'claude').map((model) => [model.id, model.route.id])).toEqual([['b', 'b'], ['a', 'a']])
  })
})

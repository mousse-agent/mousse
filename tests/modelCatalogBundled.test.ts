import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareVersions } from '../src/mms/harness/driver'
import { bundledModelCatalog, modelCatalog } from '../src/mms/models/modelCatalog'
import { MODEL_CATALOG_FORMAT, MODEL_CATALOG_ROUTES, validCatalogDate } from '../src/shared/modelCatalog'
import { REASONING_LEVELS } from '../src/shared/modelVariants'

// The one test that reads the real catalog. Every other test uses made-up models.
const root = join(__dirname, '..')
const raw = JSON.parse(readFileSync(join(root, 'src/mms/models/models.json'), 'utf8')) as {
  format: unknown
  revision: unknown
  models: Array<Record<string, unknown>>
}
const packageVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version
/** The brand each maker's full names start with (#490: `short` is `name` without it). */
const BRANDS: Record<string, string> = { anthropic: 'Claude' }
const FIELDS = new Set(['id', 'name', 'short', 'maker', 'family', 'released', 'older', 'efforts', 'routes'])

describe('bundled model catalog', () => {
  it('is format 1 with a whole-number revision, and every model reads as written', () => {
    expect(raw.format).toBe(MODEL_CATALOG_FORMAT)
    expect(Number.isInteger(raw.revision) && (raw.revision as number) >= 1).toBe(true)
    // Nothing is dropped or changed by the reader: no invalid model, field, route or level.
    expect(bundledModelCatalog().models).toEqual(raw.models)
    expect(modelCatalog().models.length).toBe(raw.models.length)
  })

  it('has only known fields, of the right types', () => {
    for (const model of raw.models) {
      for (const field of Object.keys(model)) expect(FIELDS.has(field), `${model.id}: ${field}`).toBe(true)
      for (const field of ['id', 'name', 'short', 'maker', 'family', 'released']) expect(typeof model[field], `${model.id}: ${field}`).toBe('string')
      if ('older' in model) expect(model.older).toBe(true)
      if ('efforts' in model) {
        expect(Array.isArray(model.efforts) && (model.efforts as unknown[]).length > 0).toBe(true)
        for (const level of model.efforts as string[]) expect(REASONING_LEVELS as readonly string[]).toContain(level)
      }
    }
  })

  it('has unique ids, and unique ids within each route', () => {
    const ids = raw.models.map((model) => model.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const key of MODEL_CATALOG_ROUTES) {
      const routeIds = raw.models.flatMap((model) => {
        const route = (model.routes as Record<string, { id: string }>)[key]
        return route ? [route.id] : []
      })
      expect(new Set(routeIds).size, key).toBe(routeIds.length)
    }
  })

  it('has valid release dates', () => {
    for (const model of raw.models) expect(validCatalogDate(model.released as string), `${model.id}: ${model.released}`).toBe(true)
  })

  it('has known route keys, each with an id', () => {
    for (const model of raw.models) {
      const routes = Object.entries(model.routes as Record<string, Record<string, unknown>>)
      expect(routes.length, String(model.id)).toBeGreaterThan(0)
      for (const [key, route] of routes) {
        expect(MODEL_CATALOG_ROUTES as readonly string[], `${model.id}: ${key}`).toContain(key)
        expect(typeof route.id === 'string' && route.id.length > 0, `${model.id}: ${key}`).toBe(true)
        for (const field of Object.keys(route)) expect(['id', 'minMousse'], `${model.id}: ${key}.${field}`).toContain(field)
      }
    }
  })

  it('names each model in short form as its full name without the brand', () => {
    for (const model of raw.models) {
      const brand = BRANDS[model.maker as string]
      expect(brand, `${model.id}: maker ${model.maker}`).toBeDefined()
      expect(model.name, String(model.id)).toBe(`${brand} ${model.short}`)
    }
  })

  it('asks for no Mousse version above this one', () => {
    for (const model of raw.models)
      for (const [key, route] of Object.entries(model.routes as Record<string, { minMousse?: string }>))
        if (route.minMousse !== undefined) {
          expect(route.minMousse, `${model.id}: ${key}`).toMatch(/^\d+(?:\.\d+)*$/)
          expect(compareVersions(route.minMousse, packageVersion), `${model.id}: ${key} needs ${route.minMousse}`).toBeLessThanOrEqual(0)
        }
  })
})

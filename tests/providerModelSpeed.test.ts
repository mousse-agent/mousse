import { describe, expect, it } from 'vitest'
import { __testUtils, getCursorModelMetadata } from 'pi-cursor-sdk/src/model-discovery'
import { FALLBACK_MODEL_ITEMS } from 'pi-cursor-sdk/src/cursor-fallback-models.generated'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import type { LlmProviderOption } from '../src/shared/settings'

describe('Cursor model endpoint speed in the renderer catalog', () => {
  it('exports default and explicit speeds only for models with Fast support', () => {
    const models = __testUtils.registerModelItems(FALLBACK_MODEL_ITEMS)
    // Exercise catalog conversion without creating credentials or starting network refreshes.
    const service = Object.create(ProviderAuthService.prototype) as ProviderAuthService
    Object.defineProperty(service, 'models', { value: {
      getModels: () => models,
      getProvider: () => ({ name: 'Cursor' })
    } })
    const toCatalog = Reflect.get(ProviderAuthService.prototype, 'toLlmProviderOption') as
      (this: ProviderAuthService, id: string) => LlmProviderOption
    const catalog = toCatalog.call(service, 'cursor')
    expect(catalog.models.some(model => model.id.endsWith(':fast'))).toBe(true)
    expect(catalog.models.some(model => model.id.endsWith(':slow'))).toBe(true)
    expect(catalog.models.some(model => !getCursorModelMetadata(model.id)?.supportsFast)).toBe(true)
    for (const model of catalog.models) {
      const metadata = getCursorModelMetadata(model.id)!
      expect(model.speed).toBe(metadata.supportsFast
        ? (metadata.fastOverride ?? metadata.defaultFast) ? 'fast' : 'slow'
        : undefined)
    }
  })
})

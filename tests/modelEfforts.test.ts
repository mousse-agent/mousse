import { describe, expect, it } from 'vitest'
import { __testUtils } from 'pi-cursor-sdk/src/model-discovery'
import { FALLBACK_MODEL_ITEMS } from 'pi-cursor-sdk/src/cursor-fallback-models.generated'
import { getModelEffortLevels } from '../src/shared/modelEfforts'

describe('modelEfforts', () => {
  it('reads effort levels from cursor fallback fable metadata', () => {
    const configs = __testUtils.registerModelItems(FALLBACK_MODEL_ITEMS)
    const fable = configs.find((model) => model.id === 'fable-5@300k')
    expect(fable?.reasoning).toBe(true)
    expect(getModelEffortLevels(fable!)).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('returns undefined when no effort controls exist', () => {
    expect(getModelEffortLevels({ reasoning: false })).toBeUndefined()
  })
})

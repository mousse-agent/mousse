import { describe, expect, it } from 'vitest'
import { getModelEffortLevels } from '../src/shared/modelEfforts'

describe('modelEfforts', () => {
  it('includes implicit intermediate levels from subscription model maps', () => {
    expect(
      getModelEffortLevels({
        reasoning: true,
        thinkingLevelMap: { minimal: 'low', xhigh: 'xhigh' }
      })
    ).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
  })

  it('keeps an explicitly supported maximum level', () => {
    expect(getModelEffortLevels({ reasoning: true, thinkingLevelMap: { max: 'max' } })).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'max'
    ])
  })

  it('returns undefined when no effort controls exist', () => {
    expect(getModelEffortLevels({ reasoning: false })).toBeUndefined()
  })
})

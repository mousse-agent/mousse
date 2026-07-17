import { describe, expect, it } from 'vitest'
import {
  extractFamilyLabel,
  groupModelsByFamily,
  parseModelVariant,
  parseThinkingSuffixFromModelId,
  resolveModelVariant
} from '../src/shared/modelVariants'
import type { LlmModelOption } from '../src/shared/settings'

describe('modelVariants', () => {
  it('extracts family labels from cursor-style names', () => {
    expect(extractFamilyLabel('Fable 5 @ 300k')).toBe('Fable 5')
    expect(extractFamilyLabel('Fable 5 (fable-5) @ 1m')).toBe('Fable 5')
    expect(extractFamilyLabel('Composer 2.5 (fast)')).toBe('Composer 2.5')
  })

  it('groups fable variants into one family', () => {
    const models: LlmModelOption[] = [
      { id: 'fable-5@300k', label: 'Fable 5 @ 300k' },
      { id: 'fable-5@1m', label: 'Fable 5 @ 1m' },
      { id: 'fable@300k', label: 'Fable 5 (fable) @ 300k' },
      { id: 'haiku-4.5', label: 'Haiku 4.5' }
    ]

    const families = groupModelsByFamily('cursor', models)
    expect(families).toHaveLength(2)
    const fable = families.find((family) => family.familyLabel === 'Fable 5')
    expect(fable?.variants).toHaveLength(3)
    expect(fable?.hasSubOptions).toBe(true)
    expect(fable?.contexts).toEqual(['1m', '300k'])
  })

  it('parses effort and speed suffixes from ids', () => {
    expect(parseModelVariant({ id: 'gpt-5.5@1m:medium', label: 'GPT-5.5 @ 1m' })).toMatchObject({
      context: '1m',
      effort: 'medium'
    })
    expect(parseModelVariant({ id: 'composer-2-5:slow', label: 'Composer 2.5 (slow)' })).toMatchObject({
      speed: 'slow'
    })
  })

  it('resolves the closest variant for selected options', () => {
    const family = groupModelsByFamily('cursor', [
      { id: 'fable-5@300k', label: 'Fable 5 @ 300k' },
      { id: 'fable-5@1m:medium', label: 'Fable 5 @ 1m' },
      { id: 'fable-5@1m:high', label: 'Fable 5 @ 1m' }
    ])[0]

    expect(resolveModelVariant(family, { context: '1m', effort: 'high' })?.id).toBe('fable-5@1m:high')
    expect(resolveModelVariant(family, { context: '300k' })?.id).toBe('fable-5@300k')
  })

  it('groups effort levels from model metadata', () => {
    const models: LlmModelOption[] = [
      {
        id: 'fable-5@300k',
        label: 'Fable 5 @ 300k',
        efforts: ['low', 'medium', 'high', 'xhigh']
      },
      {
        id: 'fable-5@1m',
        label: 'Fable 5 @ 1m',
        efforts: ['low', 'medium', 'high', 'xhigh']
      },
      {
        id: 'gpt-5.5@1m',
        label: 'GPT-5.5 @ 1m',
        efforts: ['minimal', 'medium', 'high']
      }
    ]

    const families = groupModelsByFamily('cursor', models)
    const fable = families.find((family) => family.familyLabel === 'Fable 5')
    expect(fable?.efforts).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(fable?.hasSubOptions).toBe(true)
    expect(resolveModelVariant(fable!, { context: '1m', effort: 'high' })?.id).toBe('fable-5@1m:high')
  })

  it('parses effort suffix from stored model ids', () => {
    expect(parseThinkingSuffixFromModelId('gpt-5.5@1m:high')).toEqual({
      baseId: 'gpt-5.5@1m',
      effort: 'high'
    })
    expect(parseThinkingSuffixFromModelId('composer-2-5@1m:fast:medium')).toEqual({
      baseId: 'composer-2-5@1m:fast',
      effort: 'medium'
    })
  })
})

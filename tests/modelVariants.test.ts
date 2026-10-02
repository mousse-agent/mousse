import { describe, expect, it } from 'vitest'
import {
  applyEffortToModelId,
  compareModelsNewestFirst,
  extractFamilyLabel,
  findModelFamily,
  formatEffortLabel,
  getCurrentEffort,
  getModelFastToggle,
  getEffortsForModel,
  groupModelsByFamily,
  groupProviderModels,
  inferModelBrand,
  modelNewnessScore,
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

  it('groups effort levels from model metadata as model sub-options', () => {
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

    const singleContext = groupModelsByFamily('cursor', [
      {
        id: 'gpt-5.5@1m',
        label: 'GPT-5.5 @ 1m',
        efforts: ['minimal', 'medium', 'high']
      }
    ])[0]
    expect(singleContext.hasSubOptions).toBe(true)
    expect(singleContext.efforts).toEqual(['minimal', 'medium', 'high'])
  })

  it('applies and reads effort suffixes for the model selector', () => {
    expect(applyEffortToModelId('gpt-5.5@1m', 'high')).toBe('gpt-5.5@1m:high')
    expect(applyEffortToModelId('gpt-5.5@1m:medium', 'xhigh')).toBe('gpt-5.5@1m:xhigh')
    expect(applyEffortToModelId('gpt-5.5@1m:high', 'off')).toBe('gpt-5.5@1m')
    expect(formatEffortLabel('xhigh')).toBe('XHigh')

    const models: LlmModelOption[] = [
      {
        id: 'fable-5@300k',
        label: 'Fable 5 @ 300k',
        efforts: ['low', 'medium', 'high', 'xhigh']
      }
    ]
    expect(getEffortsForModel('cursor', 'fable-5@300k:high', models)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh'
    ])
    expect(getCurrentEffort('fable-5@300k:high', models, 'cursor')).toBe('high')
    expect(findModelFamily('cursor', models, 'fable-5@300k:high')?.familyLabel).toBe('Fable 5')
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

  it('sorts families newest version first via digit score', () => {
    expect(modelNewnessScore('GPT 5.6')).toBeCloseTo(5.006)
    expect(modelNewnessScore('GPT 5.5')).toBeCloseTo(5.005)
    expect(modelNewnessScore('Claude Opus 4.8')).toBeCloseTo(4.008)
    expect(compareModelsNewestFirst('GPT 5.6', 'GPT 5.5')).toBeLessThan(0)
    expect(compareModelsNewestFirst('Opus 4.6', 'Opus 4.8')).toBeGreaterThan(0)

    const families = groupModelsByFamily('cursor', [
      { id: 'gpt-4.1', label: 'GPT-4.1' },
      { id: 'gpt-5.5@1m', label: 'GPT-5.5 @ 1m' },
      { id: 'gpt-5.6@1m', label: 'GPT-5.6 @ 1m' },
      { id: 'claude-opus-4.6', label: 'Claude Opus 4.6' }
    ])
    expect(families.map((family) => family.familyLabel)).toEqual([
      'GPT-5.6',
      'GPT-5.5',
      'Claude Opus 4.6',
      'GPT-4.1'
    ])
  })

  it('infers model brands for section headers', () => {
    expect(inferModelBrand('claude-sonnet-4', 'Claude Sonnet 4')).toMatchObject({
      brandId: 'anthropic',
      brandLabel: 'Anthropic'
    })
    expect(inferModelBrand('gpt-5.5@1m', 'GPT-5.5 @ 1m')).toMatchObject({
      brandId: 'openai',
      brandLabel: 'OpenAI'
    })
    expect(inferModelBrand('composer-2-5', 'Composer 2.5')).toMatchObject({
      brandId: 'cursor',
      brandLabel: 'Cursor'
    })
    expect(inferModelBrand('gemini-3-flash', 'Gemini 3 Flash')).toMatchObject({
      brandId: 'google',
      brandLabel: 'Google'
    })
    expect(inferModelBrand('openrouter/anthropic/claude-sonnet-4')).toMatchObject({
      brandId: 'anthropic'
    })
    expect(inferModelBrand('grok-4.3', 'Grok 4.3')).toMatchObject({ brandId: 'xai' })
  })

  it('divides multi-vendor provider models into brand sections', () => {
    const models: LlmModelOption[] = [
      { id: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
      { id: 'gpt-5.5@1m', label: 'GPT-5.5 @ 1m' },
      { id: 'composer-2-5', label: 'Composer 2.5' },
      { id: 'gemini-3-flash', label: 'Gemini 3 Flash' }
    ]

    const group = groupProviderModels('cursor', 'Cursor', models)
    expect(group.brandSections.map((section) => section.brandId)).toEqual([
      'cursor',
      'anthropic',
      'openai',
      'google'
    ])
    expect(group.brandSections.find((s) => s.brandId === 'anthropic')?.families).toHaveLength(1)
    expect(group.brandSections.find((s) => s.brandId === 'openai')?.families[0]?.familyLabel).toBe(
      'GPT-5.5'
    )
  })

  it('keeps a single brand section for single-vendor providers', () => {
    const models: LlmModelOption[] = [
      { id: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
      { id: 'claude-opus-4', label: 'Claude Opus 4' }
    ]
    const group = groupProviderModels('anthropic', 'Anthropic', models)
    expect(group.brandSections).toHaveLength(1)
    expect(group.brandSections[0]?.brandId).toBe('anthropic')
    expect(group.families).toHaveLength(2)
  })
})

describe('Fast endpoint toggle', () => {
  const models: LlmModelOption[] = [
    { id: 'composer@200k', label: 'Composer @ 200k', efforts: ['low', 'high'] },
    { id: 'composer@200k:fast', label: 'Composer (fast) @ 200k', efforts: ['low', 'high'] },
    { id: 'composer@200k:slow', label: 'Composer (slow) @ 200k', efforts: ['low', 'high'] },
    { id: 'composer@1m', label: 'Composer @ 1m', efforts: ['low', 'high'] },
    { id: 'composer@1m:fast', label: 'Composer (fast) @ 1m', efforts: ['low', 'high'] },
    { id: 'composer@1m:slow', label: 'Composer (slow) @ 1m', efforts: ['low', 'high'] }
  ]

  it('switches only listed endpoints while preserving context and supported effort', () => {
    expect(getModelFastToggle('cursor', 'composer@1m:high', models)).toEqual({
      active: false, targetModelId: 'composer@1m:fast:high'
    })
    expect(getModelFastToggle('cursor', 'composer@1m:fast:high', models)).toEqual({
      active: true, targetModelId: 'composer@1m:slow:high'
    })
    expect(getModelFastToggle('cursor', 'composer@200k:slow', models)).toEqual({
      active: false, targetModelId: 'composer@200k:fast'
    })
  })

  it('keeps speed suffixes in the catalog id used for actual requests and effort changes', () => {
    expect(parseThinkingSuffixFromModelId('composer@1m:fast')).toEqual({ baseId: 'composer@1m:fast' })
    expect(parseThinkingSuffixFromModelId('composer@1m:slow')).toEqual({ baseId: 'composer@1m:slow' })
    expect(applyEffortToModelId('composer@1m:fast', 'high')).toBe('composer@1m:fast:high')
    expect(applyEffortToModelId('composer@1m:fast:high', 'off')).toBe('composer@1m:fast')
    expect(parseModelVariant({ id: 'composer@1m:fast:high', label: 'Composer' })).toMatchObject({
      speed: 'fast', effort: 'high', context: '1m'
    })
  })

  it('reflects provider defaults even when the default endpoint has no speed suffix', () => {
    expect(getModelFastToggle('cursor', 'composer@1m:high', models.map(model => ({
      ...model, ...(model.id === 'composer@1m' ? { speed: 'fast' as const } : {})
    })))).toEqual({ active: true, targetModelId: 'composer@1m:slow:high' })
  })

  it('hides the toggle for unsupported models, missing catalog entries, and unmatched contexts', () => {
    expect(getModelFastToggle('openai', 'fast-name', [{ id: 'fast-name', label: 'A Fast Model' }])).toBeUndefined()
    expect(getModelFastToggle('cursor', 'missing', models)).toBeUndefined()
    expect(getModelFastToggle('cursor', 'composer@2m', [
      ...models, { id: 'composer@2m', label: 'Composer @ 2m' }
    ])).toBeUndefined()
    expect(getModelFastToggle('cursor', 'fast-only:fast', [
      { id: 'fast-only:fast', label: 'Only Fast (fast)' }
    ])).toBeUndefined()
  })

  it('does not append an effort that the target endpoint does not support', () => {
    expect(getModelFastToggle('cursor', 'composer@1m:high', models.map(model => ({
      ...model, efforts: model.id.endsWith(':fast') ? ['low'] : model.efforts
    })))).toEqual({ active: false, targetModelId: 'composer@1m:fast' })
  })

  it('supports label-only endpoint variants and existing effort-specific catalog rows', () => {
    expect(getModelFastToggle('other', 'normal:high', [
      { id: 'normal:high', label: 'Model' },
      { id: 'quick:high', label: 'Model (fast)' }
    ])).toEqual({ active: false, targetModelId: 'quick:high' })
  })
})

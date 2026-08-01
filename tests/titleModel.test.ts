import { describe, expect, it } from 'vitest'
import { getDefaultSettings, resolveTitleModel, type LlmProviderOption } from '../src/shared/settings'

const providers: LlmProviderOption[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    models: [
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }
    ]
  },
  {
    id: 'openai',
    label: 'OpenAI',
    models: [
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', efforts: ['low', 'medium'] },
      { id: 'gpt-5.6', label: 'GPT-5.6' }
    ]
  }
]

describe('title model defaults', () => {
  it('prefers OpenAI Luna Low when available', () => {
    expect(resolveTitleModel(getDefaultSettings(), providers)).toEqual({
      llmProvider: 'openai',
      model: 'gpt-5.6-luna:low'
    })
  })

  it('uses the latest Haiku for Anthropic', () => {
    expect(resolveTitleModel(getDefaultSettings(), [providers[0]])).toEqual({
      llmProvider: 'anthropic',
      model: 'claude-haiku-4-5-20251001'
    })
  })

  it('honors an explicit valid selection', () => {
    const settings = getDefaultSettings()
    settings.title = { llmProvider: 'openai', model: 'gpt-5.6' }
    expect(resolveTitleModel(settings, providers)).toEqual(settings.title)
  })
})

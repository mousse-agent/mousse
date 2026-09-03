import { describe, expect, it } from 'vitest'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import {
  buildAgentTypesFromCatalogs,
  buildOpencodeAgentModels,
  groupAgentModelOptions
} from '../src/shared/settings'
import { groupProviderModels, inferModelBrand } from '../src/shared/modelVariants'

describe('opencode catalog helpers', () => {
  it('builds opencode agent models with CLI-style ids and groups', () => {
    const models = buildOpencodeAgentModels(
      [
        { id: 'big-pickle', label: 'Big Pickle' },
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }
      ],
      [
        { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
        { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' }
      ]
    )
    expect(models).toEqual([
      { id: 'opencode/big-pickle', label: 'Big Pickle', group: 'OpenCode Zen' },
      { id: 'opencode/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', group: 'OpenCode Zen' },
      { id: 'opencode-go/gpt-5.6-luna', label: 'GPT-5.6 Luna', group: 'OpenCode Go' },
      { id: 'opencode-go/deepseek-v4-flash', label: 'DeepSeek V4 Flash', group: 'OpenCode Go' }
    ])
  })

  it('groups agent model options into optgroup buckets', () => {
    const groups = groupAgentModelOptions([
      { id: 'opencode/big-pickle', label: 'Big Pickle', group: 'OpenCode Zen' },
      { id: 'opencode-go/gpt-5.6-luna', label: 'GPT-5.6 Luna', group: 'OpenCode Go' },
      { id: 'default', label: 'Default' }
    ])
    expect(groups.map((g) => g.group)).toEqual(['OpenCode Zen', 'OpenCode Go', ''])
    expect(groups[0]?.models).toHaveLength(1)
    expect(groups[2]?.models[0]?.id).toBe('default')
  })

  it('keeps all opencode-provider models under the opencode brand', () => {
    expect(
      inferModelBrand('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'opencode')
    ).toMatchObject({ brandId: 'opencode', brandLabel: 'OpenCode Zen' })
    expect(inferModelBrand('gpt-5.6-luna', 'GPT-5.6 Luna', 'opencode-go')).toMatchObject({
      brandId: 'opencode-go'
    })

    const group = groupProviderModels('opencode', 'OpenCode', [
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
      { id: 'big-pickle', label: 'Big Pickle' }
    ])
    expect(group.brandSections).toHaveLength(1)
    expect(group.brandSections[0]?.brandId).toBe('opencode')
  })

  it('builds agent pickers from live provider catalogs instead of the static fallback', () => {
    const types = buildAgentTypesFromCatalogs([
      {
        id: 'anthropic',
        label: 'Anthropic',
        models: [{ id: 'claude-opus-4-6', label: 'Claude Opus 4.6' }]
      },
      {
        id: 'openai',
        label: 'OpenAI',
        models: [{ id: 'gpt-5.4', label: 'GPT-5.4' }]
      },
      {
        id: 'cursor',
        label: 'Cursor',
        models: [{ id: 'composer-2', label: 'Composer 2' }]
      },
      {
        id: 'opencode',
        label: 'OpenCode',
        models: [{ id: 'big-pickle', label: 'Big Pickle' }]
      }
    ])
    expect(types.find((agent) => agent.id === 'claude-code')?.models.map((m) => m.id)).toEqual([
      'claude-opus-4-6'
    ])
    expect(types.find((agent) => agent.id === 'codex')?.models.map((m) => m.id)).toEqual(['gpt-5.4'])
    expect(types.find((agent) => agent.id === 'cursor-agents-cli')?.models.map((m) => m.id)).toEqual([
      'composer-2'
    ])
    expect(types.find((agent) => agent.id === 'opencode')?.models.map((m) => m.id)).toEqual([
      'opencode/big-pickle'
    ])
  })

  it('ships the OpenCode Go catalog with gpt-5.6-luna (regression)', () => {
    // Upstream owns this catalog; assert on the stable GPT-5.6 line rather than
    // a point release. A stale pi-ai pin previously dropped gpt-5.6-luna from
    // the OpenCode Go provider's catalog.
    const modelIds = new Set(builtinModels().getModels('opencode-go').map((model) => model.id))
    expect(modelIds).toContain('gpt-5.6-luna')
  })
})

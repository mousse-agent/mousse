import { describe, expect, it } from 'vitest'
import {
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
      { id: 'opencode/big-pickle', label: 'Big Pickle', group: 'OpenCode' },
      { id: 'opencode/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', group: 'OpenCode' },
      { id: 'opencode-go/gpt-5.6-luna', label: 'GPT-5.6 Luna', group: 'OpenCode Go' },
      { id: 'opencode-go/deepseek-v4-flash', label: 'DeepSeek V4 Flash', group: 'OpenCode Go' }
    ])
  })

  it('groups agent model options into optgroup buckets', () => {
    const groups = groupAgentModelOptions([
      { id: 'opencode/big-pickle', label: 'Big Pickle', group: 'OpenCode' },
      { id: 'opencode-go/gpt-5.6-luna', label: 'GPT-5.6 Luna', group: 'OpenCode Go' },
      { id: 'default', label: 'Default' }
    ])
    expect(groups.map((g) => g.group)).toEqual(['OpenCode', 'OpenCode Go', ''])
    expect(groups[0]?.models).toHaveLength(1)
    expect(groups[2]?.models[0]?.id).toBe('default')
  })

  it('keeps all opencode-provider models under the opencode brand', () => {
    expect(
      inferModelBrand('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'opencode')
    ).toMatchObject({ brandId: 'opencode', brandLabel: 'OpenCode' })
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
})

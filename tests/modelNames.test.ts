import { describe, expect, it } from 'vitest'
import { ModelNamesService, modelsWithPrefs, EMPTY_PREFS, visibleProviderOption } from '../src/mms/harness/catalog'
import { findListedModel, modelChoiceOf, modelLabel } from '../src/shared/modelChoice'
import { canonicalModelName, modelNameFromId, shortModelName } from '../src/shared/modelNames'

describe('model names', () => {
  it('gives every listing one style: the brand, then the family and version', () => {
    expect(canonicalModelName('Opus 5.5', 'opus')).toBe('Claude Opus 5.5')
    expect(canonicalModelName('Sonnet', 'sonnet')).toBe('Claude Sonnet')
    expect(canonicalModelName('Claude Sonnet', 'sonnet')).toBe('Claude Sonnet')
    expect(canonicalModelName('Claude 3.5 Haiku', 'claude-3-5-haiku-20241022')).toBe('Claude Haiku 3.5')
    expect(canonicalModelName('Claude Fable 5.1', 'claude-fable-5-1')).toBe('Claude Fable 5.1')
    // What follows the name stays as listed.
    expect(canonicalModelName('Claude Haiku 4.5 (latest)', 'claude-haiku-4-5')).toBe('Claude Haiku 4.5 (latest)')
    expect(canonicalModelName('Fable 5 (fable) @ 300k', 'fable@300k')).toBe('Claude Fable 5 (fable) @ 300k')
    // Other makers' names are theirs.
    expect(canonicalModelName('GPT-6.1 Sol', 'gpt-6.1-sol')).toBe('GPT-6.1 Sol')
    expect(canonicalModelName('Anthropic: Claude Fable 5', 'anthropic/claude-fable-5')).toBe('Anthropic: Claude Fable 5')
    expect(canonicalModelName('Default (recommended)', 'default')).toBe('Default (recommended)')
  })

  it('names a model from its id when the listing gives no name, or only the id', () => {
    expect(canonicalModelName(undefined, 'gpt-6.1-sol')).toBe('GPT-6.1 Sol')
    expect(canonicalModelName('gpt-6.1-sol', 'gpt-6.1-sol')).toBe('GPT-6.1 Sol')
    expect(canonicalModelName('gpt-6.1-sol', 'gpt-6.1-sol:low')).toBe('GPT-6.1 Sol')
  })

  it('makes a name from any maker\'s id, without the suffixes a stored id carries', () => {
    expect(modelNameFromId('gpt-6.1-sol:low')).toBe('GPT-6.1 Sol')
    expect(modelNameFromId('gpt-5.3-codex')).toBe('GPT-5.3 Codex')
    expect(modelNameFromId('gpt-4o-mini')).toBe('GPT-4o Mini')
    expect(modelNameFromId('o4-mini')).toBe('o4-mini')
    expect(modelNameFromId('claude-haiku-5-5')).toBe('Claude Haiku 5.5')
    expect(modelNameFromId('claude-3-5-haiku-20241022')).toBe('Claude Haiku 3.5')
    expect(modelNameFromId('claude-sonnet-4-20250514')).toBe('Claude Sonnet 4')
    expect(modelNameFromId('claude-opus-4-5-20251101')).toBe('Claude Opus 4.5')
    expect(modelNameFromId('opus@1m:fast:high')).toBe('Claude Opus')
    expect(modelNameFromId('sonnet[1m]')).toBe('Claude Sonnet (1m)')
    expect(modelNameFromId('anthropic/claude-fable-5')).toBe('Claude Fable 5')
    expect(modelNameFromId('gemini-3.5-flash')).toBe('Gemini 3.5 Flash')
    expect(modelNameFromId('grok-4.7')).toBe('Grok 4.7')
    expect(modelNameFromId('deepseek-v4-flash')).toBe('DeepSeek V4 Flash')
    expect(modelNameFromId('gpt-oss-120b')).toBe('GPT-OSS 120B')
  })

  it('is safe to apply twice', () => {
    for (const [label, id] of [['Opus 5.5', 'opus'], ['Claude 3.5 Haiku', 'claude-3-5-haiku'], [undefined, 'gpt-6.1-sol'], ['Fable 5 @ 1m', 'fable-5@1m']] as const) {
      const once = canonicalModelName(label, id)
      expect(canonicalModelName(once, id)).toBe(once)
    }
  })

  it('drops the brand only where it comes before a family name of its own', () => {
    expect(shortModelName('Claude Opus 5.5')).toBe('Opus 5.5')
    expect(shortModelName('Claude Haiku 3.5')).toBe('Haiku 3.5')
    expect(shortModelName('GPT-6.1 Sol')).toBe('GPT-6.1 Sol')
    expect(shortModelName('Claude Code Model')).toBe('Claude Code Model')
  })
})

describe('model choice', () => {
  it('names a stored selection with its level, context and speed apart from the name', () => {
    const listed = modelChoiceOf({ instanceId: 'claude', provider: 'claude-subscription', model: 'opus:high' }, 'Opus 5.5')
    expect(listed).toEqual({ instanceId: 'claude', provider: 'claude-subscription', modelId: 'opus', name: 'Claude Opus 5.5', effort: 'high' })
    expect(modelLabel(listed)).toBe('Claude Opus 5.5 · High')
    expect(modelLabel(listed, { short: true, effort: false })).toBe('Opus 5.5')
    const unlisted = modelChoiceOf({ provider: 'codex', model: 'gpt-6.1-sol@1m:fast:low' })
    expect(unlisted).toMatchObject({ modelId: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', context: '1m', speed: 'fast', effort: 'low' })
    expect(modelLabel(unlisted)).toBe('GPT-6.1 Sol (fast) · 1m · Low')
  })

  it('finds a listed model by the stored string, then without its level or suffixes', () => {
    const models = [{ id: 'opus' }, { id: 'fable-5@1m' }]
    expect(findListedModel(models, 'opus:high')).toEqual({ id: 'opus' })
    expect(findListedModel(models, 'fable-5@1m:high')).toEqual({ id: 'fable-5@1m' })
    expect(findListedModel(models, 'gpt-6')).toBeUndefined()
  })
})

describe('model names in the catalog', () => {
  it('names listed models in one style and keeps a custom model\'s own name', () => {
    const entries = modelsWithPrefs(
      [{ id: 'opus', label: 'Opus 5.5' }, { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' }],
      { ...EMPTY_PREFS, custom: [{ id: 'my-model', label: 'my model', capabilities: { efforts: [], images: false } }] }
    )
    expect(entries.map((entry) => entry.label)).toEqual(['Claude Opus 5.5', 'GPT-6.1 Sol', 'my model'])
    const option = visibleProviderOption({ id: 'claude-subscription', label: 'Claude Code', models: [{ id: 'opus', label: 'Opus 5.5', efforts: ['high'] }] }, EMPTY_PREFS)
    expect(option.models).toEqual([{ id: 'opus', label: 'Claude Opus 5.5', efforts: ['high'] }])
  })

  it('remembers every name a listing gave, writes only on a change, and forgets an instance on removal', () => {
    let stored: Record<string, Record<string, string>> = {}
    let writes = 0
    const names = new ModelNamesService({ read: () => stored, write: (next) => { stored = next; writes += 1 } })
    names.remember('codex', [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }, { id: 'raw', label: 'raw' }])
    names.remember('codex', [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }])
    expect(writes).toBe(1)
    // An empty list (Codex before its first listing) forgets nothing.
    names.remember('codex', [])
    expect(names.get('codex')).toEqual({ 'gpt-6.1-sol': 'GPT-6.1 Sol' })
    names.remember('claude', [{ id: 'opus', label: 'Claude Opus 5.5' }])
    names.remove('codex')
    expect(stored).toEqual({ claude: { opus: 'Claude Opus 5.5' } })
  })
})

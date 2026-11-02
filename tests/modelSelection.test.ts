import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { contextHandoff } from '../src/mms/orchestrator/contextHandoff'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import { decodeScopes } from '../src/mms/harness/scope'
import { findModelInCatalog } from '../src/renderer/components/agentDefinitions/editorIssues'
import { modelGroups, modelKeyOf } from '../src/renderer/components/scheduled/jobDraft'
import { modelChoiceOf, modelLabel } from '../src/shared/modelChoice'
import { agentModelId, pickedSelection, pickerModelId, splitStoredModel, upgradeSelection } from '../src/shared/modelSelection'
import type { LlmProviderOption } from '../src/shared/settings'

describe('stored model selections', () => {
  it('keep the model as listed and the reasoning level apart; the level is attached only for the agent', () => {
    expect(splitStoredModel('gpt-6.1-sol:low')).toEqual({ model: 'gpt-6.1-sol', effort: 'low' })
    expect(splitStoredModel('opus')).toEqual({ model: 'opus' })
    // A listed id's own suffixes are part of the model.
    expect(splitStoredModel('fable-5@1m:fast')).toEqual({ model: 'fable-5@1m:fast' })
    expect(agentModelId('opus', 'high')).toBe('opus:high')
    expect(agentModelId('opus')).toBe('opus')
    expect(pickedSelection(pickerModelId({ model: 'opus', effort: 'off' }))).toEqual({ model: 'opus', effort: 'off' })
  })

  it('upgrade a record written before #490, and the level it ran at stays', () => {
    expect(upgradeSelection({ instanceId: 'codex', llmProvider: 'codex', model: 'gpt-6.1-sol:low' }))
      .toEqual({ instanceId: 'codex', llmProvider: 'codex', model: 'gpt-6.1-sol', effort: 'low' })
    expect(upgradeSelection({ model: 'opus', effort: 'high' })).toEqual({ model: 'opus', effort: 'high' })
    // An agent definition's ref can have both; the packed level is the one it ran at.
    expect(upgradeSelection({ model: 'opus:high', effort: 'low' })).toEqual({ model: 'opus', effort: 'high' })
    expect(decodeScopes({ projects: { p: { instances: {}, defaultSelection: { instanceId: 'claude', model: 'opus:max' } } } }).projects.p?.defaultSelection)
      .toEqual({ instanceId: 'claude', model: 'opus', effort: 'max' })
  })

  it('are named by the name stored with them when nothing lists the model', () => {
    const choice = modelChoiceOf({ instanceId: 'codex', provider: 'codex', model: 'gpt-6.1-sol', effort: 'low', name: 'GPT-6.1 Sol' })
    expect(modelLabel(choice)).toBe('GPT-6.1 Sol · Low')
    // A listing's name wins over the stored one.
    expect(modelChoiceOf({ provider: 'claude', model: 'opus', name: 'Claude Opus' }, 'Opus 5.5').name).toBe('Claude Opus 5.5')
  })

  it('switch context only when the provider or model changes, whatever form older messages took', () => {
    const before = { provider: 'claude-subscription', model: 'opus:high' }
    expect(contextHandoff(before, { provider: 'claude-subscription', model: 'opus', effort: 'low' })).toBeUndefined()
    expect(contextHandoff(before, { provider: 'claude-subscription', model: 'sonnet', effort: 'low' }))
      .toEqual({ from: { provider: 'claude-subscription', model: 'opus', effort: 'high' }, to: { provider: 'claude-subscription', model: 'sonnet', effort: 'low' } })
  })
})

describe('default model settings', () => {
  const withSettings = (run: (home: string) => void) => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-model-selection-'))
    try {
      run(home)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  it('read a default and title model saved with a packed level as the model and its level', () => {
    withSettings((home) => {
      writeFileSync(join(home, 'mousse.conf'), JSON.stringify({
        providers: { llmProvider: 'codex', instanceId: 'codex', model: 'gpt-6.1-sol:low' },
        settings: { title: { llmProvider: 'anthropic', model: 'claude-haiku-5-5:minimal' } }
      }))
      const settings = new SettingsStore(MousseConfigStore.load(home)).get()
      expect(settings.provider).toMatchObject({ instanceId: 'codex', model: 'gpt-6.1-sol', effort: 'low' })
      expect(settings.title).toMatchObject({ model: 'claude-haiku-5-5', effort: 'minimal' })
    })
  })

  it('drop the level and name of an earlier model when another is chosen, on disk too', () => {
    withSettings((home) => {
      const settings = new SettingsStore(MousseConfigStore.load(home))
      settings.set({ provider: { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'opus', effort: 'high', name: 'Claude Opus 5.5' } })
      settings.set({ title: { llmProvider: 'anthropic', model: 'claude-haiku-5-5', effort: 'low' } })
      settings.set({ integrations: { skills: { model: { review: { llmProvider: 'anthropic', model: 'claude-opus-5-5', effort: 'max' } } } } } as never)
      const reloaded = () => new SettingsStore(MousseConfigStore.load(home)).get()
      expect(reloaded().provider).toMatchObject({ model: 'opus', effort: 'high', name: 'Claude Opus 5.5' })

      settings.set({ provider: { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'sonnet' } })
      settings.set({ title: { llmProvider: 'anthropic', model: 'claude-sonnet-5-5' } })
      settings.set({ integrations: { skills: { model: { review: { llmProvider: 'anthropic', model: 'claude-sonnet-5-5' } } } } } as never)
      const after = reloaded()
      expect(after.provider.model).toBe('sonnet')
      expect(after.provider.effort).toBeUndefined()
      expect(after.provider.name).toBeUndefined()
      expect(after.title).toEqual({ llmProvider: 'anthropic', model: 'claude-sonnet-5-5' })
      expect(after.integrations.skills.model.review).toEqual({ llmProvider: 'anthropic', model: 'claude-sonnet-5-5' })
    })
  })
})

describe('catalog checks on screens', () => {
  const providers: LlmProviderOption[] = [{ id: 'claude-subscription', instanceId: 'claude', llmProvider: 'claude-subscription', label: 'Claude Code', models: [{ id: 'opus', label: 'Claude Opus 5.5', efforts: ['low', 'high'] }] }]

  it('find a model saved with its level, so the agent editor and scheduled jobs accept it', () => {
    const catalogs = { providers } as never
    expect(findModelInCatalog(catalogs, 'claude-subscription', 'opus:high', 'claude')).toEqual({ providerLabel: 'Claude Code', modelLabel: 'Claude Opus 5.5' })
    const groups = modelGroups(providers)
    const listedKey = groups[0]!.choices[0]!.key
    expect(modelKeyOf({ instanceId: 'claude', llmProvider: 'claude-subscription', model: 'opus', effort: 'high' }, groups, providers)).toBe(listedKey)
    expect(modelKeyOf({ instanceId: 'claude', llmProvider: 'claude-subscription', model: 'opus:high' }, groups, providers)).toBe(listedKey)
  })
})

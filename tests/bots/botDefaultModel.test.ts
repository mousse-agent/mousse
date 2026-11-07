/**
 * The default bot model (Settings → Models → Bot model): stored like the title model, Automatic by
 * default, and used by the bots' model choice only while a bot's choice is automatic and the model
 * can run it. Anything else falls back to automatic at the same depth.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import { createBotModelResolver, REPRESENTATIVE_BOT_POLICY } from '../../src/mms/bots/model/BotModelResolver'
import type { BotRuntimeHold } from '../../src/mms/bots/seams'
import type { InstanceSnapshot } from '../../src/shared/harness/status'
import type { InstanceModel, RunPolicy } from '../../src/shared/harness/types'
import type { ModelCatalog } from '../../src/shared/modelCatalog'
import { botProviderOptions, getDefaultSettings, type LlmProviderOption } from '../../src/shared/settings'

describe('the bot model setting', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'mousse-bot-model-setting-')) })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('is Automatic by default, keeps the instance, drops any level, and is saved in mousse.conf', () => {
    expect(getDefaultSettings().botModel).toEqual({ llmProvider: '', model: '' })
    const store = new SettingsStore(MousseConfigStore.load(home))
    expect(store.get().botModel).toEqual({ llmProvider: '', model: '' })
    store.set({ botModel: { llmProvider: 'claude-subscription', model: 'sonnet', instanceId: 'claude', effort: 'high' } as never })
    const saved = new SettingsStore(MousseConfigStore.load(home)).get().botModel
    expect(saved).toEqual({ llmProvider: 'claude-subscription', model: 'sonnet', instanceId: 'claude' })
    // A choice by provider name alone does not keep the instance of the earlier one.
    store.set({ botModel: { llmProvider: 'openai', model: 'gpt-5.1' } })
    expect(new SettingsStore(MousseConfigStore.load(home)).get().botModel).toEqual({ llmProvider: 'openai', model: 'gpt-5.1' })
    // Back to Automatic.
    store.set({ botModel: { llmProvider: '', model: '', instanceId: '' } })
    expect(new SettingsStore(MousseConfigStore.load(home)).get().botModel).toEqual({ llmProvider: '', model: '' })
  })

  it('offers only the listed models that can hold a bot, with no reasoning level', () => {
    const providers = [
      { id: 'claude-subscription', instanceId: 'claude', label: 'Claude Code', models: [{ id: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'], defaultEffort: 'low' }, { id: 'haiku', label: 'Haiku' }] },
      { id: 'cursor', instanceId: 'cursor', label: 'Cursor', models: [{ id: 'auto', label: 'Auto' }] }
    ] as LlmProviderOption[]
    expect(botProviderOptions(providers, [{ instanceId: 'claude', model: 'sonnet' }])).toEqual([
      { id: 'claude-subscription', instanceId: 'claude', label: 'Claude Code', models: [{ id: 'sonnet', label: 'Sonnet' }] }
    ])
  })
})

const policy: RunPolicy = { mode: 'default', origin: 'bot', approvals: 'grants', tools: { allow: ['read'] }, authority: { kind: 'bot', digest: 'd1' } }

const catalog: ModelCatalog = {
  format: 1,
  revision: 2,
  models: [
    { id: 'acme-big-2', name: 'Acme Big 2', short: 'Big 2', maker: 'acme', family: 'big', tier: 'frontier', released: '2030-03-01', routes: { claude: { id: 'acme-big-2' } } },
    { id: 'acme-mid-2', name: 'Acme Mid 2', short: 'Mid 2', maker: 'acme', family: 'mid', tier: 'standard', released: '2030-02-01', routes: { claude: { id: 'acme-mid-2' } } }
  ]
}

function snapshot(instanceId: string, patch: { driver?: InstanceSnapshot['driver']; auth?: Partial<InstanceSnapshot['auth']> } = {}): InstanceSnapshot {
  return {
    instanceId,
    driver: patch.driver ?? 'pi',
    displayName: instanceId,
    builtIn: false,
    scope: { kind: 'device' },
    enabled: { device: true, effective: true, setBy: 'device' },
    runs: { state: 'yes' },
    auth: { state: 'signed_in', ...patch.auth }
  } as unknown as InstanceSnapshot
}

const model = (id: string): InstanceModel => ({
  id, label: id, source: 'catalog', capabilities: { efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', images: false }, hidden: false, favorite: false
})

const MODELS: Record<string, InstanceModel[]> = {
  claude: [model('acme-big-2'), model('acme-mid-2')],
  'pi:openai': [model('gpt-5.1'), model('gpt-5.1-mini')],
  'pi:refused': [model('gpt-5.1')]
}

const SNAPSHOTS = [
  snapshot('claude', { driver: 'claude', auth: { credential: 'subscription' } }),
  snapshot('pi:openai', { auth: { credential: 'api_key' } }),
  snapshot('pi:refused')
]

const hold: BotRuntimeHold = {
  canHoldBot: (instanceId) => (instanceId === 'pi:refused'
    ? { ok: false, error: { code: 'policy_unenforceable', message: 'no gate', missing: ['toolControl'] } }
    : { ok: true })
}

describe('the bots\' model choice with a Settings default', () => {
  const clock = new Date('2030-06-01T10:00:00.000Z')
  const resolver = (defaultModel: { instanceId: string; model: string } | undefined, snapshots = SNAPSHOTS, holds = hold) =>
    createBotModelResolver({ snapshots: async () => snapshots, models: (id) => MODELS[id] ?? [], hold: holds, catalog: () => catalog, now: () => clock, defaultModel: () => defaultModel })

  it('an automatic bot runs on the default, at the effort its depth gives', async () => {
    const chooser = resolver({ instanceId: 'pi:openai', model: 'gpt-5.1-mini' })
    expect(await chooser.resolve({ botId: 'b', choice: { mode: 'auto', depth: 'normal' }, policy })).toEqual({ selection: { instanceId: 'pi:openai', model: 'gpt-5.1-mini', effort: 'medium' } })
    expect(await chooser.resolve({ botId: 'b', choice: { mode: 'auto', depth: 'quick' }, policy })).toEqual({ selection: { instanceId: 'pi:openai', model: 'gpt-5.1-mini', effort: 'low' } })
    expect(await chooser.resolve({ botId: 'b', choice: { mode: 'auto', depth: 'deep' }, policy })).toEqual({ selection: { instanceId: 'pi:openai', model: 'gpt-5.1-mini', effort: 'high' } })
  })

  it('a named choice in the definition, and the bot\'s own override, come before the default', async () => {
    const chooser = resolver({ instanceId: 'pi:openai', model: 'gpt-5.1-mini' })
    expect(await chooser.resolve({ botId: 'b', choice: { mode: 'named', model: 'Big 2', depth: 'normal' }, policy })).toEqual({ selection: { instanceId: 'claude', model: 'acme-big-2', effort: 'medium' } })
    // `use_model` named: the override wins over an automatic definition and the default.
    expect(await chooser.resolve({ botId: 'b', choice: { mode: 'auto', depth: 'normal' }, override: { mode: 'named', model: 'mid', depth: 'deep' }, policy })).toEqual({ selection: { instanceId: 'claude', model: 'acme-mid-2', effort: 'high' } })
    // `set_depth` on an automatic bot: still the default, at the new depth.
    expect(await chooser.resolve({ botId: 'b', choice: { mode: 'auto', depth: 'normal' }, override: { mode: 'auto', depth: 'quick' }, policy })).toEqual({ selection: { instanceId: 'pi:openai', model: 'gpt-5.1-mini', effort: 'low' } })
  })

  it('falls back to automatic at the same depth when the default cannot run the bot', async () => {
    const auto = { selection: { instanceId: 'claude', model: 'acme-mid-2', effort: 'medium' } }
    const normal = { botId: 'b', choice: { mode: 'auto' as const, depth: 'normal' as const }, policy }
    // Refused by `canHoldBot`.
    expect(await resolver({ instanceId: 'pi:refused', model: 'gpt-5.1' }).resolve(normal)).toEqual(auto)
    // Removed entry, or a model it no longer lists.
    expect(await resolver({ instanceId: 'pi:gone', model: 'gpt-5.1' }).resolve(normal)).toEqual(auto)
    expect(await resolver({ instanceId: 'pi:openai', model: 'gpt-4' }).resolve(normal)).toEqual(auto)
    // Signed out.
    const out = [SNAPSHOTS[0]!, snapshot('pi:openai', { auth: { state: 'signed_out' } })]
    expect(await resolver({ instanceId: 'pi:openai', model: 'gpt-5.1' }, out).resolve(normal)).toEqual(auto)
    // Automatic.
    expect(await resolver(undefined).resolve(normal)).toEqual(auto)
  })

  it('a default at its usage limit falls back to automatic; with every model limited the bot pauses', async () => {
    const chooser = resolver({ instanceId: 'pi:openai', model: 'gpt-5.1' })
    const normal = { botId: 'b', choice: { mode: 'auto' as const, depth: 'normal' as const }, policy }
    chooser.markLimited('pi:openai', '2030-06-01T12:00:00.000Z')
    expect(await chooser.resolve(normal)).toEqual({ selection: { instanceId: 'claude', model: 'acme-mid-2', effort: 'medium' } })
    chooser.markLimited('claude', '2030-06-01T13:00:00.000Z')
    expect(await chooser.resolve(normal)).toEqual({ problem: 'all_limited', until: '2030-06-01T12:00:00.000Z', instanceId: 'pi:openai' })
  })

  it('lists the models that can hold a bot for Settings, with a policy that stands for any bot', async () => {
    const seen: RunPolicy[] = []
    const chooser = resolver(undefined, SNAPSHOTS, { canHoldBot: (instanceId, checked) => { seen.push(checked); return hold.canHoldBot(instanceId, checked) } })
    expect(await chooser.holdable()).toEqual([
      { instanceId: 'claude', model: 'acme-big-2' }, { instanceId: 'claude', model: 'acme-mid-2' },
      { instanceId: 'pi:openai', model: 'gpt-5.1' }, { instanceId: 'pi:openai', model: 'gpt-5.1-mini' }
    ])
    expect(seen.every((checked) => checked === REPRESENTATIVE_BOT_POLICY && checked.authority?.kind === 'bot')).toBe(true)
  })
})

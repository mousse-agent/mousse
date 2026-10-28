/**
 * Moving a model API entry to the agent that now serves it (agent CLIs plan §5, v3 "move flow"):
 * nothing moves without the user's action; the old entry is turned off with `movedTo`, never
 * deleted; device and project defaults that named it are rewritten and listed; and a thread pinned
 * to it continues on the agent with its history handed over, told once.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Harness, TurnSpec } from '../../src/mms/harness/gateway'
import { decodeInstanceConfig } from '../../src/mms/harness/driver'
import { HarnessScopeStore } from '../../src/mms/harness/scope'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { CODEX_CAPABILITIES } from '../../src/mms/harness/drivers/codex/adapter'
import type { ProviderAdapter, TurnInput, TurnResult } from '../../src/mms/harness/adapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { claudeFamilyAlias } from '../../src/mms/harness/drivers/claudeCode'
import { rewriteMovedDefaults } from '../../src/mms/settings/movedDefaults'
import { FOLDED_INTO_AGENT, FOLDED_TARGETS, acceptsMove } from '../../src/shared/harness/move'

class Agent implements ProviderAdapter {
  readonly capabilities = CODEX_CAPABILITIES
  readonly turns: TurnInput[] = []
  constructor(readonly driver: 'codex' | 'pi' | 'claude') {}
  async startTurn(input: TurnInput, sink: Parameters<ProviderAdapter['startTurn']>[1]): Promise<TurnResult> {
    this.turns.push(input)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    return { text: 'ok', aborted: false, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef }
  }
  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

const homes: string[] = []
const harnesses: Harness[] = []
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function fixture(keys: { exported?: string; adopted?: string[] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-move-'))
  homes.push(home)
  let stored: Record<string, unknown> = { 'pi:fake': { driver: 'pi', enabled: true }, codex: { driver: 'codex', enabled: true } }
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances as Record<string, unknown> } } })
  // The device default named the model API; the profile's settings rewrite it.
  let deviceDefault = { instanceId: 'pi:fake', llmProvider: 'fake', model: 'fake-model' }
  const agent = new Agent('codex')
  const harness = testHarness({
    drivers: [
      adapterDriver(new Agent('pi'), { runtime: { exportApiKey: async () => keys.exported } }),
      adapterDriver(agent, {
        runtime: {
          models: () => [{ id: 'agent-model', label: 'Agent model' }],
          adoptApiKey: async (key: string) => void keys.adopted?.push(key)
        }
      })
    ],
    instances,
    profileHome: home,
    foldedInto: (providerId) => (providerId === 'fake' ? 'codex' : undefined),
    defaults: {
      rewrite: (from, to) => {
        if (deviceDefault.instanceId !== from) return []
        const model = to.model(deviceDefault.model)
        deviceDefault = { instanceId: to.instanceId, llmProvider: to.llmProvider, model }
        return [model === 'fake-model' ? 'Default model' : `Default model: ${model} instead of fake-model`]
      }
    }
  })
  const notices: Array<[string, string]> = []
  harness.setLiveHost({ notice: (threadId, text) => notices.push([threadId, text]) })
  harnesses.push(harness)
  new HarnessScopeStore(home).setDefaultSelection('project-1', { instanceId: 'pi:fake', model: 'fake-model' })
  const spec = (binding: TurnSpec['binding']): TurnSpec => ({
    binding,
    input: { threadId: 'pinned', instanceId: binding.instanceId, llmProvider: '', model: binding.model, mode: 'agent', prompt: 'hi', signal: new AbortController().signal } as unknown as TurnInput,
    sink: { providerRef: () => {} } as unknown as TurnSpec['sink'],
    control: {} as TurnSpec['control'],
    host: {} as TurnSpec['host']
  })
  return { home, harness, agent, notices, spec, stored: () => stored, deviceDefault: () => deviceDefault }
}

describe('moving a model API to its agent', () => {
  it('has a row per agent that took a model API over', () => {
    expect(FOLDED_INTO_AGENT).toEqual({ anthropic: 'claude', cursor: 'cursor', xai: 'grok', 'openai-codex': 'codex' })
    // Only Anthropic narrows the agent's entries: Claude Code on an API key, never the user's own.
    expect(FOLDED_TARGETS).toEqual({ anthropic: { slug: 'api', displayName: 'Claude Code (API key)', loginMethod: 'api_key', copyKey: true } })
  })

  it("copies the entry's API key only when asked, before anything moves", async () => {
    const adopted: string[] = []
    const { harness, stored } = fixture({ exported: 'saved-key', adopted })
    await harness.instances.move('pi:fake', 'codex')
    expect(adopted).toEqual([])
    const again = fixture({ exported: 'saved-key', adopted })
    await again.harness.instances.move('pi:fake', 'codex', { copyKey: true })
    expect(adopted).toEqual(['saved-key'])
    expect(stored()['pi:fake']).toMatchObject({ enabled: false })
  })

  it('refuses to copy a key the entry does not have, and moves nothing', async () => {
    const { harness, stored } = fixture({ adopted: [] })
    await expect(harness.instances.move('pi:fake', 'codex', { copyKey: true })).rejects.toMatchObject({ code: 'unsupported' })
    expect(stored()['pi:fake']).toEqual({ driver: 'pi', enabled: true })
  })

  it('never moves without the user: a pinned thread keeps the model API until then', () => {
    const { harness } = fixture()
    expect(harness.resolveStored({ instanceId: 'pi:fake', llmProvider: 'fake', model: 'fake-model' }, { purpose: 'turn' })).toMatchObject({ instanceId: 'pi:fake', driver: 'pi' })
  })

  it('turns the old entry off with movedTo, rewrites and lists the defaults that named it, with models the agent has', async () => {
    const { home, harness, stored, deviceDefault, agent, spec } = fixture()
    const result = await harness.instances.move('pi:fake', 'codex')
    // The agent does not list the API's model: both defaults take the agent's default, and say so.
    expect(result).toEqual({ from: 'pi:fake', to: 'codex', rewritten: ['Default model: agent-model instead of fake-model', 'Project default (project-1): Agent model instead of fake-model'] })
    expect(stored()['pi:fake']).toEqual({ driver: 'pi', enabled: false, config: { movedTo: 'codex' } })
    expect(deviceDefault()).toEqual({ instanceId: 'codex', llmProvider: 'codex', model: 'agent-model' })
    const projectDefault = new HarnessScopeStore(home).project('project-1')?.defaultSelection
    expect(projectDefault).toEqual({ instanceId: 'codex', model: 'agent-model' })
    // Both rewritten defaults run on the agent with a model it has.
    for (const selection of [deviceDefault(), { ...projectDefault!, llmProvider: '' }]) {
      const resolved = harness.resolveStored(selection, { purpose: 'turn' })
      expect(resolved).toMatchObject({ instanceId: 'codex', model: 'agent-model' })
      expect(resolved.movedFrom).toBeUndefined()
      await harness.startTurn(spec(await harness.bind(resolved, { mode: 'agent' }))).result
    }
    expect(agent.turns.map((turn) => [turn.instanceId, turn.model])).toEqual([['codex', 'agent-model'], ['codex', 'agent-model']])
    const snapshot = (await harness.instances.snapshots({ kind: 'device' })).find((entry) => entry.instanceId === 'pi:fake')
    expect(snapshot?.config).toMatchObject({ movedTo: 'codex' })
    await expect(harness.instances.move('pi:fake', 'codex')).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('refuses a move to another agent or of an entry with no row', async () => {
    const { harness } = fixture()
    await expect(harness.instances.move('codex', 'pi:fake')).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('a thread pinned to the old entry continues on the agent, with its history handed over and a notice once', async () => {
    const { harness, agent, notices, spec } = fixture()
    await harness.instances.move('pi:fake', 'codex')
    const pinned = { instanceId: 'pi:fake', llmProvider: 'fake', model: 'fake-model' }
    const resolved = harness.resolveStored(pinned, { purpose: 'turn' })
    // An unknown model runs as the agent's first one.
    expect(resolved).toMatchObject({ instanceId: 'codex', driver: 'codex', model: 'agent-model', movedFrom: 'pi:fake' })
    await harness.startTurn(spec(await harness.bind(resolved, { mode: 'agent' }))).result
    await harness.startTurn(spec(await harness.bind(harness.resolveStored(pinned, { purpose: 'turn' }), { mode: 'agent' }))).result
    expect(agent.turns.map((turn) => turn.instanceId)).toEqual(['codex', 'codex'])
    // The model the thread pinned is not the agent's: the notice says which one runs instead.
    expect(notices).toEqual([['pinned', 'fake moved to Test codex. This chat continues there with its history handed over. It runs Agent model instead of fake-model.']])
  })
})

describe('moving pi:anthropic to Claude Code on its API key', () => {
  function anthropicFixture(options: { exported?: string; claudeConfig?: Record<string, unknown> } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'mousse-move-anthropic-'))
    homes.push(home)
    let stored: Record<string, unknown> = {
      'pi:anthropic': { driver: 'pi', enabled: true },
      // The user's own Claude Code, an entry on a key of its own, and one stored without a home.
      claude: { driver: 'claude', enabled: true },
      'claude:api': { driver: 'claude', enabled: true, config: { home: 'private', loginMethod: 'api_key', displayName: 'Claude Code (API key)', ...options.claudeConfig } },
      'claude:old': { driver: 'claude', enabled: true, config: { home: 'default', loginMethod: 'api_key', displayName: 'Old key entry' } }
    }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances as Record<string, unknown> } } })
    const adopted: Array<[string, string]> = []
    const claude = new Agent('claude')
    // As the real driver: several entries, each API-key one in a home of its own.
    const claudeDriver = {
      ...adapterDriver(claude, {
        runtime: {
          models: () => [{ id: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'] }, { id: 'opus', label: 'Opus', efforts: ['high'] }],
          movedModel: claudeFamilyAlias,
          adoptApiKey: async (key: string) => void adopted.push(['claude:api', key])
        }
      }),
      multiInstance: true,
      privateHome: true,
      decodeConfig: (raw: Record<string, unknown> | undefined) => decodeInstanceConfig(raw, { privateHome: true })
    }
    const harness = testHarness({
      drivers: [adapterDriver(new Agent('pi'), { runtime: { exportApiKey: async () => options.exported } }), claudeDriver],
      instances,
      profileHome: home
    })
    const notices: Array<[string, string]> = []
    harness.setLiveHost({ notice: (threadId, text) => notices.push([threadId, text]) })
    harnesses.push(harness)
    new HarnessScopeStore(home).setDefaultSelection('project-1', { instanceId: 'pi:anthropic', model: 'claude-opus-4-1' })
    return { home, harness, claude, adopted, notices, stored: () => stored as Record<string, { enabled: boolean; config?: Record<string, unknown> }> }
  }

  it("never moves to the user's own Claude Code, nor to a key entry stored without a home of its own", async () => {
    const { harness, adopted, stored } = anthropicFixture({ exported: 'sk-ant-api03-saved' })
    await expect(harness.instances.move('pi:anthropic', 'claude', { copyKey: true })).rejects.toMatchObject({ code: 'unsupported' })
    await expect(harness.instances.move('pi:anthropic', 'claude:old')).rejects.toMatchObject({ code: 'unsupported' })
    expect(adopted).toEqual([])
    expect(stored()['pi:anthropic']).toEqual({ driver: 'pi', enabled: true })
    expect(stored().claude).toEqual({ driver: 'claude', enabled: true })
    expect(acceptsMove('anthropic', undefined)).toBe(false)
    expect(acceptsMove('anthropic', { loginMethod: 'api_key' })).toBe(true)
    // Other model APIs take any entry of their agent.
    expect(acceptsMove('xai', undefined)).toBe(true)
  })

  it('copies the key, turns pi:anthropic off keeping it, and maps pinned models to the family alias', async () => {
    const { home, harness, adopted, stored } = anthropicFixture({ exported: 'sk-ant-api03-saved' })
    const result = await harness.instances.move('pi:anthropic', 'claude:api', { copyKey: true })
    expect(adopted).toEqual([['claude:api', 'sk-ant-api03-saved']])
    // Off with movedTo, never deleted; its saved key is left where it was.
    expect(stored()['pi:anthropic']).toEqual({ driver: 'pi', enabled: false, config: { movedTo: 'claude:api' } })
    expect(result.rewritten).toEqual(['Project default (project-1): Opus instead of claude-opus-4-1'])
    expect(new HarnessScopeStore(home).project('project-1')?.defaultSelection).toEqual({ instanceId: 'claude:api', model: 'opus' })
    // A thread pinned to a full model id runs the same family; one of no family runs the default.
    expect(harness.resolveStored({ instanceId: 'pi:anthropic', llmProvider: 'anthropic', model: 'claude-sonnet-4-5-20250929' }, { purpose: 'turn' }))
      .toMatchObject({ instanceId: 'claude:api', driver: 'claude', model: 'sonnet', movedFrom: 'pi:anthropic', movedFromModel: 'claude-sonnet-4-5-20250929' })
    const same = harness.resolveStored({ instanceId: 'pi:anthropic', llmProvider: 'anthropic', model: 'opus' }, { purpose: 'turn' })
    expect(same).toMatchObject({ model: 'opus' })
    expect(same.movedFromModel).toBeUndefined()
    expect(harness.resolveStored({ instanceId: 'pi:anthropic', llmProvider: 'anthropic', model: 'some-other-model' }, { purpose: 'turn' })).toMatchObject({ model: 'sonnet' })
  })

  it('keeps an exact custom model and a reasoning effort the model takes', async () => {
    const { harness } = anthropicFixture()
    await harness.instances.setModelPrefs('claude:api', { custom: [{ id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5', capabilities: { efforts: ['high'], images: true } }] })
    await harness.instances.move('pi:anthropic', 'claude:api')
    const pin = (model: string) => harness.resolveStored({ instanceId: 'pi:anthropic', llmProvider: 'anthropic', model }, { purpose: 'turn' }).model
    // The user's own custom model of that id runs as is, its effort kept.
    expect(pin('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5-20250929')
    expect(pin('claude-sonnet-4-5-20250929:high')).toBe('claude-sonnet-4-5-20250929:high')
    // A family alias keeps an effort it takes, and drops one it does not.
    expect(pin('claude-opus-4-1:high')).toBe('opus:high')
    expect(pin('claude-opus-4-1:low')).toBe('opus')
    expect(pin('claude-haiku-4-5:low')).toBe('sonnet:low')
  })

  it('a key copied to an entry signed out in Mousse signs it in again', async () => {
    const { harness, adopted, stored } = anthropicFixture({ exported: 'sk-ant-api03-saved', claudeConfig: { signedOutInMousse: true } })
    await harness.instances.move('pi:anthropic', 'claude:api', { copyKey: true })
    expect(adopted).toEqual([['claude:api', 'sk-ant-api03-saved']])
    expect(stored()['claude:api']?.config?.signedOutInMousse).not.toBe(true)
    expect(harness.resolveStored({ instanceId: 'claude:api', llmProvider: '', model: 'sonnet' }, { purpose: 'turn' })).toMatchObject({ instanceId: 'claude:api' })
  })

  it('a moved thread is told which model runs when its pin changed', async () => {
    const { harness, claude, notices } = anthropicFixture()
    await harness.instances.move('pi:anthropic', 'claude:api')
    const resolved = harness.resolveStored({ instanceId: 'pi:anthropic', llmProvider: 'anthropic', model: 'claude-opus-4-1' }, { purpose: 'turn' })
    const binding = await harness.bind(resolved, { mode: 'agent' })
    await harness.startTurn({
      binding,
      input: { threadId: 'pinned', instanceId: binding.instanceId, llmProvider: '', model: binding.model, mode: 'agent', prompt: 'hi', signal: new AbortController().signal } as unknown as TurnInput,
      sink: { providerRef: () => {} } as unknown as TurnSpec['sink'],
      control: {} as TurnSpec['control'],
      host: {} as TurnSpec['host']
    }).result
    expect(claude.turns.map((turn) => turn.model)).toEqual(['opus'])
    expect(notices).toEqual([['pinned', 'anthropic moved to Claude Code (API key). This chat continues there with its history handed over. It runs Opus instead of claude-opus-4-1.']])
  })
})

describe('device defaults of a moved entry', () => {
  const to = { instanceId: 'claude:api', llmProvider: 'claude:api', model: (model: string) => claudeFamilyAlias(model) ?? 'sonnet' }

  it('the default model follows with the agent\'s model, and a title model on the entry becomes Automatic', () => {
    const { patch, rewritten } = rewriteMovedDefaults({
      provider: { llmProvider: 'anthropic', model: 'claude-opus-4-1' },
      title: { llmProvider: 'anthropic', model: 'claude-haiku-4-5', instanceId: 'pi:anthropic' }
    }, 'pi:anthropic', to)
    expect(patch).toEqual({
      provider: { llmProvider: 'claude:api', model: 'opus', instanceId: 'claude:api' },
      title: { llmProvider: '', model: '', instanceId: '' }
    })
    expect(rewritten).toEqual(['Default model: opus instead of claude-opus-4-1', 'Chat titles: Automatic'])
  })

  it('leaves defaults on other entries alone', () => {
    expect(rewriteMovedDefaults({
      provider: { llmProvider: 'openai', model: 'gpt-5', instanceId: 'pi:openai' },
      title: { llmProvider: '', model: '' }
    }, 'pi:anthropic', to)).toEqual({ rewritten: [] })
  })
})

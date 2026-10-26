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
import { HarnessScopeStore } from '../../src/mms/harness/scope'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { CODEX_CAPABILITIES } from '../../src/mms/run/adapters/codex/CodexAdapter'
import type { ProviderAdapter, TurnInput, TurnResult } from '../../src/mms/run/adapters/ProviderAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { FOLDED_INTO_AGENT } from '../../src/shared/harness/move'

class Agent implements ProviderAdapter {
  readonly capabilities = CODEX_CAPABILITIES
  readonly turns: TurnInput[] = []
  constructor(readonly driver: 'codex' | 'pi') {}
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
    expect(FOLDED_INTO_AGENT).toEqual({ cursor: 'cursor' })
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
    expect(notices).toEqual([['pinned', 'fake moved to Test codex. This chat continues there with its history handed over.']])
  })
})

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

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mousse-move-'))
  homes.push(home)
  let stored: Record<string, unknown> = { 'pi:fake': { driver: 'pi', enabled: true }, codex: { driver: 'codex', enabled: true } }
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances as Record<string, unknown> } } })
  // The device default named the model API; the profile's settings rewrite it.
  let deviceDefault = { instanceId: 'pi:fake', llmProvider: 'fake', model: 'fake-model' }
  const agent = new Agent('codex')
  const harness = testHarness({
    drivers: [
      adapterDriver(new Agent('pi')),
      adapterDriver(agent, { runtime: { models: () => [{ id: 'agent-model', label: 'Agent model' }] } })
    ],
    instances,
    profileHome: home,
    foldedInto: (providerId) => (providerId === 'fake' ? 'codex' : undefined),
    defaults: {
      rewrite: (from, to) => {
        if (deviceDefault.instanceId !== from) return []
        deviceDefault = { ...deviceDefault, ...to }
        return ['Default model']
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
  it('ships with no rows: each agent PR adds its own', () => {
    expect(FOLDED_INTO_AGENT).toEqual({})
  })

  it('never moves without the user: a pinned thread keeps the model API until then', () => {
    const { harness } = fixture()
    expect(harness.resolveStored({ instanceId: 'pi:fake', llmProvider: 'fake', model: 'fake-model' }, { purpose: 'turn' })).toMatchObject({ instanceId: 'pi:fake', driver: 'pi' })
  })

  it('turns the old entry off with movedTo, rewrites and lists the defaults that named it', async () => {
    const { home, harness, stored, deviceDefault } = fixture()
    const result = await harness.instances.move('pi:fake', 'codex')
    expect(result).toEqual({ from: 'pi:fake', to: 'codex', rewritten: ['Default model', 'Project default (project-1)'] })
    expect(stored()['pi:fake']).toEqual({ driver: 'pi', enabled: false, config: { movedTo: 'codex' } })
    expect(deviceDefault()).toMatchObject({ instanceId: 'codex', llmProvider: 'codex' })
    expect(new HarnessScopeStore(home).project('project-1')?.defaultSelection).toEqual({ instanceId: 'codex', model: 'fake-model' })
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

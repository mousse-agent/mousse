import { afterEach, describe, expect, it } from 'vitest'
import { PI_LEGACY_CAPS, PI_RPC_CAPS } from '../../src/mms/harness/drivers/pi'
import type { TurnSpec } from '../../src/mms/harness/gateway'
import { cleanupProfiles, intermediateProfile, read } from './openAiCodexFixture'

/**
 * The intermediate release (PR 2 §5, PR 3 "Intermediate-release fixture"): a ChatGPT user's profile
 * as the PR 2 build leaves it (`fixtures/pr2-openai-codex/`, scrubbed, dummy credentials only):
 *
 * - `instances.json`: the stored instance map, `pi:openai-codex` in it;
 * - `auth.json`: a dummy `openai-codex` OAuth credential;
 * - `defaults.json`: the default selection (`settings.provider`) pointing at it;
 * - `thread.json`: a thread pinned to it (its model override);
 * - `harness/state.json`, `models-cache.json`: the gateway's counters and the cached model list.
 *
 * With the Pi RPC engine available, `openai-codex` still resolves to the legacy loop and chats
 * through it (`piChatReplay`): no Pi process starts. `openAiCodexMigration` reads the same fixture.
 */

afterEach(cleanupProfiles)

const noop = () => {}

describe('openai-codex in the intermediate release', () => {
  it('the fixture is the scrubbed PR 2 profile PR 3 expects', () => {
    expect(read('instances.json').instances['pi:openai-codex']).toMatchObject({ driver: 'pi', enabled: true })
    expect(read('auth.json')['openai-codex']).toMatchObject({ type: 'oauth', access: expect.stringMatching(/^dummy-/), refresh: expect.stringMatching(/^dummy-/) })
    const pinned = read('thread.json').modelOverride
    expect(read('defaults.json').provider).toEqual(pinned)
    expect(pinned).toMatchObject({ instanceId: 'pi:openai-codex', llmProvider: 'openai-codex' })
    expect(read('models-cache.json')['openai-codex'].models.map((entry: { id: string }) => entry.id)).toContain(pinned.model)
    expect(read('harness/state.json').instances['pi:openai-codex']).toEqual({ configRevision: 0, accountGeneration: 0 })
  })

  it.each([undefined, 'rpc' as const])('the pinned selection resolves to the legacy loop (stored engine: %s)', async (storedEngine) => {
    const { harness } = await intermediateProfile(storedEngine ? { storedEngine } : {})
    const resolved = harness.resolveStored(read('thread.json').modelOverride, { purpose: 'turn' })
    expect(resolved).toMatchObject({ instanceId: 'pi:openai-codex', driver: 'pi', llmProvider: 'openai-codex' })
    expect(resolved.caps).toEqual(PI_LEGACY_CAPS)
    // Control: in the same profile an API-key provider the user switched runs on Pi's agent.
    harness.instanceMap.setEntry('pi:openai', { driver: 'pi', enabled: true, config: { engine: 'rpc' } })
    expect(harness.resolveStored({ instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt-5' }, { purpose: 'turn' }).caps).toEqual(PI_RPC_CAPS)
  })

  it('the pinned thread chats on the legacy loop through piChatReplay, and no Pi process starts', async () => {
    const { harness, transport, rpc } = await intermediateProfile()
    const pinned = read('thread.json')
    const resolved = harness.resolveStored(pinned.modelOverride, { purpose: 'turn' })
    const binding = await harness.bind(resolved, { mode: 'agent' })
    // The legacy loop keeps its home: the instance's bindings from before PR 2 stay valid.
    expect(binding).toMatchObject({ instanceId: 'pi:openai-codex', driver: 'pi', homeId: 'default', configRevision: 0, accountGeneration: 0 })
    const spec: TurnSpec = {
      binding,
      input: {
        runId: 'run-1', attemptId: 'attempt-1', threadId: pinned.id, cwd: null, instanceId: 'pi:openai-codex', model: pinned.modelOverride.model,
        llmProvider: 'openai-codex', modelPinned: true, mode: 'agent', prompt: 'Keep going',
        messages: [{ role: 'user', content: 'Keep going', timestamp: 1 }] as never, nativeHistory: '', signal: new AbortController().signal
      },
      sink: { text: noop, thinking: noop, tool: noop, nativeMessages: noop, compaction: noop, retry: noop, progress: noop, usage: noop, providerRef: noop, steerAccepted: noop, providerMetrics: noop, lineEdits: noop },
      control: { drainSteer: () => undefined, heartbeat: noop },
      host: { tools: {}, context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: () => '' } }
    }
    const result = await harness.startTurn(spec).result
    expect(result).toMatchObject({ text: 'Still on the loop', aborted: false })
    transport.assertDone()
    expect(rpc.starts).toEqual([])
  })
})

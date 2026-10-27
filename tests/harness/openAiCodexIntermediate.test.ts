import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PI_LEGACY_CAPS, PI_RPC_CAPS, piDriver } from '../../src/mms/harness/drivers/pi'
import { createHarnessGateway, type TurnSpec } from '../../src/mms/harness/gateway'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { replayPiChat, PI_CHAT_BOUNDARY } from '../../src/mms/run/testkit/piChatReplay'
import { replayPiRpc, type PiRpcReplay } from '../../src/mms/run/testkit/piRpcReplay'
import { parseTranscript, ReplayTransport, type TranscriptFrame } from '../../src/mms/run/testkit/ReplayTransport'

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
 * through it (`piChatReplay`): no Pi process starts. PR 3's `openAiCodexMigration` reads the same
 * fixture.
 */

const FIXTURE = join(__dirname, 'fixtures', 'pr2-openai-codex')
const read = (name: string) => JSON.parse(readFileSync(join(FIXTURE, name), 'utf8')) as Record<string, any>

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const noop = () => {}

/** One pi-loop chat call for the pinned thread's next message, as `LlmClient.chat` sees it. */
function chatTranscript(model: string): string {
  const frames: TranscriptFrame[] = [
    { dir: 'out', frame: { kind: 'chat', messages: [{ role: 'user', content: 'Keep going' }], options: { mode: 'agent', llmProvider: 'openai-codex', model } } },
    { dir: 'in', frame: { kind: 'text', event: { phase: 'start', content: '', contentIndex: 0 } } },
    { dir: 'in', frame: { kind: 'text', event: { phase: 'complete', content: 'Still on the loop', contentIndex: 0 } } },
    {
      dir: 'in',
      frame: {
        kind: 'result',
        result: { text: 'Still on the loop', usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, modelName: model, totalResponseTimeMs: 10, totalTokensUsed: 7, tokensPerSecond: 1, contextInputs: { systemPromptText: '', mcpToolsText: '', otherToolsText: '', signature: 'replay-sig', modelKey: `openai-codex:${model}` }, toolEvents: [] },
        append: [{ role: 'assistant', content: [{ type: 'text', text: 'Still on the loop' }], api: 'openai-codex-responses', provider: 'openai-codex', model, stopReason: 'stop' }]
      }
    }
  ]
  const header = { kind: 'transcript', adapter: 'pi', scenario: 'openai-codex-intermediate', boundary: PI_CHAT_BOUNDARY, recordedAt: 'hand-authored', version: 1 }
  return [header, ...frames].map((line) => JSON.stringify(line)).join('\n')
}

async function intermediateProfile(options: { storedEngine?: 'rpc' | 'legacy' } = {}) {
  const profileHome = mkdtempSync(join(tmpdir(), 'mousse-pr2-openai-codex-'))
  cleanups.push(() => rmSync(profileHome, { recursive: true, force: true }))
  cpSync(FIXTURE, profileHome, { recursive: true })
  const stored = read('instances.json')
  const auth = read('auth.json')
  let instances: Record<string, unknown> = stored.instances
  if (options.storedEngine) {
    const entry = instances['pi:openai-codex'] as { config?: Record<string, unknown> }
    instances = { ...instances, 'pi:openai-codex': { ...entry, config: { ...entry.config, engine: options.storedEngine } } }
  }
  const instanceMap = new ProviderInstanceService({ store: { read: () => ({ instances, seedVersion: stored.seedVersion }), write: (next) => { instances = next.instances } } })
  const model = read('thread.json').modelOverride.model as string
  const transport = new ReplayTransport(parseTranscript(chatTranscript(model)))
  // The RPC engine is available (the packaged runtime exists): only the table keeps openai-codex off it.
  const rpc: PiRpcReplay = await replayPiRpc(new ReplayTransport(parseTranscript(JSON.stringify({ kind: 'transcript', adapter: 'pi-rpc', scenario: 'none', boundary: 'none', recordedAt: 'hand-authored', version: 1 }))))
  cleanups.push(() => rpc.close())
  const harness = createHarnessGateway({
    profileHome,
    installationHome: profileHome,
    instanceMap,
    questions: new UserQuestionService(),
    shellPath: async () => ({ entries: [], source: 'failed' }),
    drivers: [
      piDriver({
        client: () => replayPiChat(transport),
        credentials: () => ({ has: (providerId: string) => providerId in auth }),
        rpc: rpc.driverOptions()
      })
    ]
  })
  cleanups.push(() => harness.stop())
  return { harness, transport, rpc, profileHome }
}

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

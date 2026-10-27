import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { piDriver, type PiCredentials } from '../../src/mms/harness/drivers/pi'
import { createHarnessGateway, type Harness, type HarnessGatewayOptions } from '../../src/mms/harness/gateway'
import type { HarnessDriver } from '../../src/mms/harness/driver'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { replayPiChat, PI_CHAT_BOUNDARY } from '../../src/mms/run/testkit/piChatReplay'
import { replayPiRpc, type PiRpcReplay } from '../../src/mms/run/testkit/piRpcReplay'
import { parseTranscript, ReplayTransport, type TranscriptFrame } from '../../src/mms/run/testkit/ReplayTransport'

/**
 * A ChatGPT user's profile as the PR 2 build leaves it (`fixtures/pr2-openai-codex/`, scrubbed, dummy
 * credentials only), shared by the intermediate-release and the move tests.
 */
export const FIXTURE = join(__dirname, 'fixtures', 'pr2-openai-codex')
export const read = (name: string) => JSON.parse(readFileSync(join(FIXTURE, name), 'utf8')) as Record<string, any>

const cleanups: Array<() => unknown> = []
/** Call from `afterEach`. */
export async function cleanupProfiles(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
}

/** One pi-loop chat call for the pinned thread's next message, as `LlmClient.chat` sees it. */
export function chatTranscript(model: string): string {
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

export interface IntermediateProfileOptions {
  storedEngine?: 'rpc' | 'legacy'
  /** Entries added to the stored instance map next to `pi:openai-codex`. */
  extraInstances?: Record<string, unknown>
  /** Drivers next to the pi driver (a fake Codex). */
  drivers?: HarnessDriver[]
  /** Credential calls the pi driver may make beyond `has` (a move deletes the sign-in with `logout`). */
  credentials?: (auth: Record<string, unknown>) => PiCredentials
  gateway?: Partial<HarnessGatewayOptions>
}

/** The fixture's profile with the PR 2 pi driver: the loop answers a chat from `chatTranscript`, no Pi process starts. */
export async function intermediateProfile(options: IntermediateProfileOptions = {}) {
  const profileHome = mkdtempSync(join(tmpdir(), 'mousse-pr2-openai-codex-'))
  cleanups.push(() => rmSync(profileHome, { recursive: true, force: true }))
  cpSync(FIXTURE, profileHome, { recursive: true })
  const stored = read('instances.json')
  const auth = read('auth.json')
  let instances: Record<string, unknown> = { ...stored.instances, ...(options.extraInstances ?? {}) }
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
  const harness: Harness = createHarnessGateway({
    profileHome,
    installationHome: profileHome,
    instanceMap,
    questions: new UserQuestionService(),
    shellPath: async () => ({ entries: [], source: 'failed' }),
    drivers: [
      piDriver({
        client: () => replayPiChat(transport),
        credentials: () => options.credentials?.(auth) ?? { has: (providerId: string) => providerId in auth },
        rpc: rpc.driverOptions()
      }),
      ...(options.drivers ?? [])
    ],
    ...options.gateway
  })
  cleanups.push(() => harness.stop())
  return { harness, transport, rpc, profileHome, auth, instanceMap, stored: () => instances }
}

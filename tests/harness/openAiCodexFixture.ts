import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { piDriver, type PiCredentials } from '../../src/mms/harness/drivers/pi'
import { createHarnessGateway, type Harness, type HarnessGatewayOptions } from '../../src/mms/harness/gateway'
import type { HarnessDriver } from '../../src/mms/harness/driver'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { PI_RPC_BOUNDARY, replayPiRpc, type PiRpcReplay } from '../../src/mms/run/testkit/piRpcReplay'
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

/** One Pi RPC turn for the pinned thread's next message, as Pi's agent would answer it. */
export function rpcTranscript(model: string): string {
  const reply = { role: 'assistant', content: [{ type: 'text', text: 'Still running' }], api: 'openai-codex-responses', provider: 'openai-codex', model, stopReason: 'stop' }
  const frames: TranscriptFrame[] = [
    { dir: 'out', frame: { kind: 'command', command: { type: 'prompt', message: 'Keep going' } } },
    { dir: 'in', frame: { type: 'agent_start' } },
    { dir: 'in', frame: { type: 'message_end', message: reply } },
    { dir: 'in', frame: { type: 'agent_end', messages: [] } },
    { dir: 'in', frame: { type: 'agent_settled' } }
  ]
  const header = { kind: 'transcript', adapter: 'pi-rpc', scenario: 'openai-codex-intermediate', boundary: PI_RPC_BOUNDARY, recordedAt: 'hand-authored', version: 1 }
  return [header, ...frames].map((line) => JSON.stringify(line)).join('\n')
}

export interface IntermediateProfileOptions {
  /** Entries added to the stored instance map next to `pi:openai-codex`. */
  extraInstances?: Record<string, unknown>
  /** Drivers next to the pi driver (a fake Codex). */
  drivers?: HarnessDriver[]
  /** Credential calls the pi driver may make beyond `has` (a move deletes the sign-in with `logout`). */
  credentials?: (auth: Record<string, unknown>) => PiCredentials
  gateway?: Partial<HarnessGatewayOptions>
}

/** The fixture's profile with the pi driver on a replayed Pi agent (`rpcTranscript`); no real Pi process starts. */
export async function intermediateProfile(options: IntermediateProfileOptions = {}) {
  const profileHome = mkdtempSync(join(tmpdir(), 'mousse-pr2-openai-codex-'))
  cleanups.push(() => rmSync(profileHome, { recursive: true, force: true }))
  cpSync(FIXTURE, profileHome, { recursive: true })
  const stored = read('instances.json')
  const auth = read('auth.json')
  let instances: Record<string, unknown> = { ...stored.instances, ...(options.extraInstances ?? {}) }
  const instanceMap = new ProviderInstanceService({ store: { read: () => ({ instances, seedVersion: stored.seedVersion }), write: (next) => { instances = next.instances } } })
  const model = read('thread.json').modelOverride.model as string
  // Pi's agent would answer the pinned thread's next message from `transport`; a retired entry never reaches it.
  const transport = new ReplayTransport(parseTranscript(rpcTranscript(model)))
  const rpc: PiRpcReplay = await replayPiRpc(transport)
  cleanups.push(() => rpc.close())
  const harness: Harness = createHarnessGateway({
    profileHome,
    installationHome: profileHome,
    instanceMap,
    questions: new UserQuestionService(),
    shellPath: async () => ({ entries: [], source: 'failed' }),
    drivers: [
      piDriver({
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

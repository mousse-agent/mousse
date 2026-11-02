/**
 * The MCP relay at turn start (SPEC §15.5): the gateway attaches `mousse-relay` only when the driver
 * declares a relay and the turn's app context turns it on for that runtime, never for pi or a bot.
 * The relay rides on the turn's bearer without changing its generation, so turning it on or off, or
 * a new catalogue revision, keeps the token; the credential carries the driver's relay approvals.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TurnAppContext, TurnSpec } from '../../src/mms/harness/gateway'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import { CODEX_CAPABILITIES } from '../../src/mms/harness/drivers/codex/adapter'
import type { AdapterHost, ProviderAdapter } from '../../src/mms/harness/adapter'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { McpCredentials, type BearerTurn } from '../../src/mms/run/mcp/McpCredentials'
import { RELAY_SESSION_INSTRUCTION, sessionInstructions } from '../../src/mms/run/mcp/appTools/assemble'
import { mousseOrchestrationInstructions } from '../../src/mms/run/mcp/instructions'
import type { McpAttachmentProvider } from '../../src/mms/run/mcp/MousseMcpServer'
import { RunStore } from '../../src/mms/run/RunStore'
import { testHarness } from '../../src/mms/run/testkit/harness'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'
import type { McpRelayRuntime } from '../../src/shared/integrations'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import { PI_TEST_CAPABILITIES } from '../support/piStub'

const homes: string[] = []
const databases: ProfileDatabase[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const URL = 'http://127.0.0.1:1/mcp'
const RELAY_URL = 'http://127.0.0.1:1/mcp/relay'
/** Every relay runtime on, as `completeAppTurn` gives the effective map. */
const ALL_ON: Partial<Record<McpRelayRuntime, boolean>> = { claude: true, codex: true, cursor: true, acp: true, antigravity: true, grok: true }

/** A runtime that records the host it was given. */
function runtime(driver: ProviderDriverKind, capabilities: ProviderAdapter['capabilities']) {
  const hosts: AdapterHost[] = []
  const adapter: ProviderAdapter = {
    driver,
    capabilities,
    configured: () => true,
    startTurn: async (input, _sink, _ctl, host) => {
      hosts.push(host)
      return { text: 'ok', aborted: false, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef: { provider: 'p' } }
    },
    interrupt: async () => 'not_active'
  }
  return { adapter, hosts }
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'mousse-relay-turn-start-'))
  homes.push(home)
  const db = new ProfileDatabase({ profileHome: home, clock: () => Date.parse('2026-10-30T00:00:00.000Z') })
  databases.push(db)
  const credentials = new McpCredentials(new RunStore(db))
  // The Mousse MCP server's `bearerForTurn`, over real credentials, without a listener.
  const bearers: BearerTurn[] = []
  const provider: McpAttachmentProvider = {
    bearerForTurn: (input) => {
      bearers.push(input)
      const { token, tokenHash } = credentials.bearerForTurn(input)
      return { url: URL, token, tokenHash, relayUrl: RELAY_URL }
    },
    turnEnded: (input) => credentials.turnEnded(input),
    revokeThread: () => {}
  }
  const claude = runtime('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES)
  const codex = runtime('codex', CODEX_CAPABILITIES)
  // A pi runtime that attaches the Mousse MCP server, as the pi RPC engine does.
  const pi = runtime('pi', { ...PI_TEST_CAPABILITIES, mcp: true })
  let stored: unknown = { claude: { driver: 'claude', enabled: true }, codex: { driver: 'codex', enabled: true }, 'pi:fake': { driver: 'pi', enabled: true } }
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
  const harness = testHarness({ adapters: [pi.adapter, claude.adapter, codex.adapter], instances, profileHome: home })
  harness.setMcpAttachment(provider)
  const app = (overrides: Partial<TurnAppContext> = {}): TurnAppContext => ({
    turnToken: 'turn-token',
    modeCeiling: 'default',
    mcpEligible: true,
    instructions: (mcp, relay) => ({ sessionInstructions: `mcp=${mcp} relay=${relay === true}`, turnPreamble: '' }),
    ...overrides
  })
  const spec = async (instanceId: string, app: TurnAppContext, runId: string): Promise<TurnSpec> => {
    const binding = await harness.bind(harness.resolveStored({ instanceId, llmProvider: '', model: 'm' }, { purpose: 'turn' }), { mode: 'agent' })
    const noop = () => {}
    return {
      binding,
      input: { runId, attemptId: 'a', threadId: 'thread-1', cwd: null, instanceId, model: 'm', llmProvider: instanceId, modelPinned: true, mode: 'agent', prompt: 'hi', messages: [], signal: new AbortController().signal },
      sink: { text: noop, thinking: noop, tool: noop, nativeMessages: noop, compaction: noop, retry: noop, progress: noop, usage: noop, providerRef: noop, steerAccepted: noop, providerMetrics: noop, lineEdits: noop },
      control: { drainSteer: () => undefined, heartbeat: noop },
      host: { tools: {}, context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: () => '' } },
      app
    }
  }
  let runs = 0
  const turn = async (instanceId: string, overrides: Partial<TurnAppContext> = {}) => harness.startTurn(await spec(instanceId, app(overrides), `run-${++runs}`)).result
  return { harness, credentials, bearers, claude, codex, pi, app, spec, turn }
}

describe('MCP relay at turn start', () => {
  it('attaches the relay when the driver declares one and the runtime is on, with the revision and the driver\'s approvals', async () => {
    const s = setup()
    await s.turn('claude', { relay: { revision: 'rev-1', runtimes: ALL_ON } })
    // (Before the thread moves to Codex, which revokes its Claude bearer.)
    expect(s.credentials.resolve(s.claude.hosts[0].bridge!.mcp!.token)?.relay).toEqual({ approvals: 'runtime' })
    await s.turn('codex', { relay: { revision: 'rev-1', runtimes: ALL_ON } })
    expect(s.claude.hosts[0].bridge?.mcp).toEqual({ url: URL, token: expect.any(String), relay: { url: RELAY_URL, revision: 'rev-1' } })
    expect(s.codex.hosts[0].bridge?.mcp).toMatchObject({ relay: { url: RELAY_URL, revision: 'rev-1' } })
    // The session text names the relay only when it is attached.
    expect(s.claude.hosts[0].bridge?.sessionInstructions).toBe('mcp=true relay=true')
    expect(s.bearers.map((bearer) => bearer.relay)).toEqual([{ approvals: 'runtime' }, { approvals: 'mousse' }])
    expect(s.credentials.resolve(s.codex.hosts[0].bridge!.mcp!.token)?.relay).toEqual({ approvals: 'mousse' })
  })

  it('attaches no relay when the runtime is off, absent from the map, or the turn has no relay context', async () => {
    const s = setup()
    await s.turn('claude', { relay: { revision: 'rev-1', runtimes: { ...ALL_ON, claude: false } } })
    await s.turn('claude', { relay: { revision: 'rev-1', runtimes: { codex: true } } })
    await s.turn('claude')
    for (const host of s.claude.hosts) {
      expect(host.bridge?.mcp).toEqual({ url: URL, token: expect.any(String) })
      expect(host.bridge?.sessionInstructions).toBe('mcp=true relay=false')
    }
    expect(s.bearers.map((bearer) => bearer.relay)).toEqual([undefined, undefined, undefined])
    expect(s.credentials.resolve(s.claude.hosts[0].bridge!.mcp!.token)).not.toHaveProperty('relay')
  })

  it('never attaches the relay to pi, whatever the context says', async () => {
    const s = setup()
    await s.turn('pi:fake', { relay: { revision: 'rev-1', runtimes: { ...ALL_ON, pi: true } as Partial<Record<McpRelayRuntime, boolean>> } })
    expect(s.pi.hosts[0].bridge?.mcp).toEqual({ url: URL, token: expect.any(String) })
    expect(s.bearers[0].relay).toBeUndefined()
  })

  it('never attaches the relay to a bot turn, whatever the context says', async () => {
    const s = setup()
    const spec = await s.spec('claude', s.app({ relay: { revision: 'rev-1', runtimes: ALL_ON }, bot: {} as BotAuthority }), 'run-bot')
    // The bridge a bot turn would get (admission of a bot turn is `claudeLockedProfile`'s concern).
    const gateway = s.harness as unknown as { record(id: string): unknown; mintBridge(record: unknown, spec: TurnSpec): { bridge: NonNullable<AdapterHost['bridge']> } }
    const minted = gateway.mintBridge(gateway.record('claude'), spec)
    expect(minted.bridge.mcp).toEqual({ url: URL, token: expect.any(String) })
    expect(minted.bridge.sessionInstructions).toBe('mcp=true relay=false')
    expect(s.bearers[0].relay).toBeUndefined()
  })

  it('keeps the bearer generation and the token with the relay on, off, and across revisions', async () => {
    const s = setup()
    await s.turn('claude')
    await s.turn('claude', { relay: { revision: 'rev-1', runtimes: ALL_ON } })
    await s.turn('claude', { relay: { revision: 'rev-2', runtimes: ALL_ON } })
    await s.turn('claude')
    expect(new Set(s.bearers.map((bearer) => bearer.generation))).toEqual(new Set(['claude|default|0|0']))
    const tokens = s.claude.hosts.map((host) => host.bridge!.mcp!.token)
    expect(new Set(tokens).size).toBe(1)
    expect(s.claude.hosts.map((host) => host.bridge?.mcp?.relay?.revision ?? null)).toEqual([null, 'rev-1', 'rev-2', null])
    expect(s.credentials.resolve(tokens[0])).not.toHaveProperty('relay')
  })

  it('the session text gains one sentence for the relay, and stays the same without it', () => {
    const plain = sessionInstructions({ mcp: true, appletGuidance: 'APPLETS' })
    expect(plain).toBe(`${mousseOrchestrationInstructions()}\n\nAPPLETS`)
    expect(sessionInstructions({ mcp: true, relay: false, appletGuidance: 'APPLETS' })).toBe(plain)
    expect(sessionInstructions({ mcp: true, relay: true, appletGuidance: 'APPLETS' })).toBe(`${mousseOrchestrationInstructions()}\n\n${RELAY_SESSION_INSTRUCTION}\n\nAPPLETS`)
    expect(RELAY_SESSION_INSTRUCTION).toBe('The user\'s MCP servers set up in Mousse are also available through the "mousse-relay" server as <server>__<tool>.')
    // No Mousse server, no relay sentence.
    expect(sessionInstructions({ mcp: false, relay: true })).toBe('')
  })
})

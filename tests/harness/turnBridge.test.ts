/**
 * PR 2 §2 `TurnBridge`: the gateway mints each turn's bridge (the orchestrator's former `mcpFor`):
 * a bearer under the driver's turn binding when the instance can attach the Mousse MCP server, the
 * session text and preamble the caller computed, and the turn's end for the bearer (the
 * drained-turn check, from what the adapter reports).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TurnAppContext, TurnSpec } from '../../src/mms/harness/gateway'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import { CODEX_CAPABILITIES } from '../../src/mms/run/adapters/codex/CodexAdapter'
import { PiStubAdapter } from '../support/piStub'
import type { AdapterHost, ProviderAdapter, TurnResult } from '../../src/mms/run/adapters/ProviderAdapter'
import type { BearerTurn, TurnSettlement } from '../../src/mms/run/mcp/McpCredentials'
import type { McpAttachmentProvider } from '../../src/mms/run/mcp/MousseMcpServer'
import { testHarness } from '../../src/mms/run/testkit/harness'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** A runtime that records the host it was given and ends as `outcome` says. */
function runtime(driver: ProviderDriverKind, capabilities: ProviderAdapter['capabilities']) {
  const hosts: AdapterHost[] = []
  let outcome: (input: { signal: AbortSignal }) => Promise<Partial<TurnResult>> = async () => ({})
  const adapter: ProviderAdapter = {
    driver,
    capabilities,
    configured: () => true,
    startTurn: async (input, _sink, _ctl, host) => {
      hosts.push(host)
      const extra = await outcome(input)
      return { text: 'ok', aborted: false, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef: { provider: 'p' }, ...extra }
    },
    interrupt: async () => 'not_active'
  }
  return { adapter, hosts, endWith: (next: typeof outcome) => { outcome = next } }
}

/** A Mousse MCP server stand-in that records bearer requests and turn ends. */
function attachment() {
  const bearers: BearerTurn[] = []
  const ends: Array<{ threadId: string; runId: string; tokenHash?: string; settlement: TurnSettlement }> = []
  let failing = false
  const provider: McpAttachmentProvider = {
    bearerForTurn: (input) => {
      if (failing) throw new Error('database locked')
      bearers.push(input)
      return { url: 'http://127.0.0.1:1/mcp', token: `tok-${bearers.length}`, tokenHash: `hash-${bearers.length}` }
    },
    turnEnded: (input) => {
      ends.push(input)
      return 'kept'
    },
    revokeThread: () => {}
  }
  return { provider, bearers, ends, fail: () => { failing = true } }
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'mousse-turn-bridge-'))
  homes.push(home)
  const pi = new PiStubAdapter()
  const claude = runtime('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES)
  const codex = runtime('codex', CODEX_CAPABILITIES)
  let stored: unknown
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored }), write: (next) => { stored = next.instances } } })
  const harness = testHarness({ adapters: [pi, claude.adapter, codex.adapter], instances, profileHome: home })
  const mcp = attachment()
  harness.setMcpAttachment(mcp.provider)
  const app = (overrides: Partial<TurnAppContext> = {}): TurnAppContext => ({
    turnToken: 'turn-token',
    modeCeiling: 'default',
    mcpEligible: true,
    instructions: (attached) => ({ sessionInstructions: attached ? 'SESSION+MCP' : 'SESSION', turnPreamble: 'PREAMBLE' }),
    ...overrides
  })
  const turn = async (instanceId: string, extra: { app?: TurnAppContext | null; signal?: AbortSignal; runId?: string } = {}) => {
    const binding = await harness.bind(harness.resolveStored({ instanceId, llmProvider: '', model: 'm' }, { purpose: 'turn' }), { mode: 'agent' })
    const noop = () => {}
    const spec: TurnSpec = {
      binding,
      input: { runId: extra.runId ?? 'run-1', attemptId: 'a', threadId: 'thread-1', cwd: null, instanceId, model: 'm', llmProvider: instanceId, modelPinned: true, mode: 'agent', prompt: 'hi', messages: [], signal: extra.signal ?? new AbortController().signal },
      sink: { text: noop, thinking: noop, tool: noop, nativeMessages: noop, compaction: noop, retry: noop, progress: noop, usage: noop, providerRef: noop, steerAccepted: noop, providerMetrics: noop, lineEdits: noop },
      control: { drainSteer: () => undefined, heartbeat: noop },
      host: { tools: {}, context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: () => '' } },
      ...(extra.app === null ? {} : { app: extra.app ?? app() })
    }
    return harness.startTurn(spec).result
  }
  return { harness, claude, codex, mcp, app, turn }
}

describe('TurnBridge (PR 2 §2)', () => {
  it('mints a bearer under the driver\'s turn binding, with the caller\'s texts and the turn token', async () => {
    const s = setup()
    await s.turn('claude')
    await s.turn('codex', { runId: 'run-2' })
    expect(s.mcp.bearers).toEqual([
      expect.objectContaining({ threadId: 'thread-1', instanceId: 'claude', runId: 'run-1', modeCeiling: 'default', binding: 'per_call', generation: 'claude|default|0|0' }),
      expect.objectContaining({ instanceId: 'codex', runId: 'run-2', binding: 'drained_turn', generation: 'codex|default|0|0' })
    ])
    expect(s.claude.hosts[0].bridge).toMatchObject({
      mcp: { url: 'http://127.0.0.1:1/mcp', token: 'tok-1' },
      turnToken: 'turn-token',
      sessionInstructions: 'SESSION+MCP',
      turnPreamble: 'PREAMBLE',
      userMcp: 'native'
    })
    // The turn's permission requests are answered through the thread's questions.
    expect(typeof s.claude.hosts[0].bridge?.permission?.choose).toBe('function')
  })

  it('a different agent access level is a different runtime generation, so a reused runtime takes the new tool list; the default adds nothing', async () => {
    const s = setup()
    await s.turn('claude')
    await s.turn('claude', { runId: 'run-2', app: s.app({ accessLevel: 'read' }) })
    await s.turn('claude', { runId: 'run-3', app: s.app({ accessLevel: 'manage' }) })
    await s.turn('claude', { runId: 'run-4', app: s.app({ accessLevel: 'lineage' }) })
    expect(s.mcp.bearers.map((bearer) => [bearer.accessLevel, bearer.generation])).toEqual([
      [undefined, 'claude|default|0|0'],
      ['read', 'claude|default|0|0|access:read'],
      ['manage', 'claude|default|0|0|access:manage'],
      ['lineage', 'claude|default|0|0']
    ])
  })

  it('settles the bearer from how the turn ended and what the runtime reported', async () => {
    const s = setup()
    s.codex.endWith(async () => ({ drain: { mousseCalls: 2 } }))
    await s.turn('codex')
    expect(s.mcp.ends.at(-1)).toEqual({ threadId: 'thread-1', runId: 'run-1', tokenHash: 'hash-1', settlement: { status: 'completed', drain: { mousseCalls: 2 } } })
    s.codex.endWith(async () => { throw new Error('boom') })
    await expect(s.turn('codex', { runId: 'run-2' })).rejects.toThrow('boom')
    expect(s.mcp.ends.at(-1)).toMatchObject({ runId: 'run-2', settlement: { status: 'failed' } })
    const stop = new AbortController()
    s.codex.endWith(async () => {
      stop.abort()
      return { aborted: true }
    })
    await s.turn('codex', { runId: 'run-3', signal: stop.signal })
    expect(s.mcp.ends.at(-1)).toMatchObject({ runId: 'run-3', settlement: { status: 'aborted' } })
  })

  it.each([
    ['returns an aborted result', async () => ({ aborted: true })],
    ['throws', async () => { throw new Error('killed') }]
  ] as const)('a turn stopped because its instance was turned off settles its bearer once as aborted and fails with the typed error when the adapter %s', async (_name, ending) => {
    const s = setup()
    s.codex.endWith(async (input) => {
      await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      return ending()
    })
    const result = s.turn('codex', { runId: 'run-stop' })
    const failed = result.then(() => undefined, (error: { code?: string }) => error.code)
    await vi.waitFor(() => expect(s.codex.hosts).toHaveLength(1))
    await s.harness.instances.setEnabled('codex', { kind: 'device' }, false)
    expect(await failed).toBe('instance_disabled')
    expect(s.mcp.ends.filter((end) => end.runId === 'run-stop')).toEqual([expect.objectContaining({ settlement: { status: 'aborted' } })])
  })

  it('attaches nothing to an instance that cannot attach the server, or a turn that may not, but still gives the texts', async () => {
    const s = setup()
    await s.turn('claude', { app: s.app({ mcpEligible: false }) })
    expect(s.claude.hosts[0].bridge).toMatchObject({ mcp: null, sessionInstructions: 'SESSION', turnPreamble: 'PREAMBLE' })
    expect(s.mcp.bearers).toEqual([])
    expect(s.mcp.ends).toEqual([])
    // No app context: no bridge at all (the caller gave the turn none).
    await s.turn('claude', { app: null, runId: 'run-2' })
    expect(s.claude.hosts[1].bridge).toBeUndefined()
  })

  it('a bearer that cannot be minted leaves the turn without Mousse tools instead of failing it', async () => {
    const s = setup()
    s.mcp.fail()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await s.turn('claude')
    expect(s.claude.hosts[0].bridge).toMatchObject({ mcp: null, sessionInstructions: 'SESSION' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be minted'), expect.anything())
    warn.mockRestore()
  })

  it('no server attached: no bearer', async () => {
    const s = setup()
    s.harness.setMcpAttachment(null)
    await s.turn('claude')
    expect(s.claude.hosts[0].bridge?.mcp).toBeNull()
  })
})

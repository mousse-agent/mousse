/**
 * The generic `acp` driver behind the gateway (agent CLIs plan §3): a Custom command is added and
 * checked with an `initialize`-only handshake, runs only for interactive purposes, and a sign-in
 * changed from outside between two turns forgets the thread's native session.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acpDriver } from '../../src/mms/harness/drivers/acp'
import type { Harness, TurnSpec } from '../../src/mms/harness/gateway'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { inProcessAgent } from '../../src/mms/run/testkit/acpAgent'
import { testHarness } from '../../src/mms/run/testkit/harness'
import type { TurnInput } from '../../src/mms/run/adapters/ProviderAdapter'

const homes: string[] = []
const harnesses: Harness[] = []
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mousse-acp-driver-'))
  homes.push(home)
  const calls: string[] = []
  const agent = inProcessAgent((app) => {
    app
      .onRequest(methods.agent.initialize, () => {
        calls.push('initialize')
        return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: 'fake', version: '1.2.3' }, agentCapabilities: { loadSession: false }, authMethods: [] }
      })
      .onRequest(methods.agent.session.new, () => {
        calls.push('session/new')
        return { sessionId: `s${calls.length}` }
      })
      .onRequest(methods.agent.session.prompt, async (c) => {
        calls.push(`prompt ${c.params.sessionId}`)
        await c.client.notify(methods.client.session.update, { sessionId: c.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } })
        return { stopReason: 'end_turn' }
      })
  })
  let stored: unknown = {}
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
  const notices: string[] = []
  const harness = testHarness({ drivers: [acpDriver({ connect: (_context, request) => agent.connect(request) })], instances, profileHome: home })
  harness.setLiveHost({ notice: (_threadId, text) => notices.push(text) })
  harnesses.push(harness)
  const sink = Object.fromEntries(['text', 'thinking', 'tool', 'nativeMessages', 'compaction', 'retry', 'progress', 'usage', 'providerRef', 'steerAccepted', 'providerMetrics', 'lineEdits'].map((name) => [name, vi.fn()])) as unknown as TurnSpec['sink']
  // Each turn hands over the history the previous one committed (`hello` per turn).
  const spec = (binding: TurnSpec['binding'], previous?: TurnSpec['binding'], nativeHistory = previous ? 'hello' : ''): TurnSpec => ({
    binding,
    ...(previous ? { previous } : {}),
    input: { threadId: 't', instanceId: binding.instanceId, llmProvider: '', model: binding.model, mode: 'agent', prompt: 'hi', cwd: home, nativeHistory, signal: new AbortController().signal } as unknown as TurnInput,
    sink,
    control: { drainSteer: () => undefined, heartbeat: () => {} } as unknown as TurnSpec['control'],
    host: { mcp: null, context: { nativeHistoryAfterTurn: (text: string) => text } } as unknown as TurnSpec['host']
  })
  return { home, harness, calls, agent, notices, spec }
}

describe('the generic ACP driver', () => {
  it('adds a Custom command and checks it with an initialize-only handshake that never opens a session', async () => {
    const { harness, calls, agent } = fixture()
    const added = await harness.instances.add({ driver: 'acp', config: { displayName: 'Fake agent', binaryPath: process.execPath, args: ['agent.js'] } })
    expect(added.instanceId).toBe('acp:fake-agent')
    await vi.waitFor(async () => {
      const [snapshot] = await harness.instances.snapshots({ kind: 'device' })
      expect(snapshot).toMatchObject({ runs: { state: 'yes' }, binary: { version: '1.2.3', source: 'override' }, caps: { toolControl: 'uncontrolled', planMode: false }, auth: { state: 'not_required' } })
    })
    expect(calls).toEqual(['initialize'])
    expect(agent.connections.every((connection) => connection.request.purpose === 'handshake' && connection.killed)).toBe(true)
  })

  it('reports a command that cannot run as runs: no, never a fallback', async () => {
    const { harness } = fixture()
    await harness.instances.add({ driver: 'acp', config: { displayName: 'Missing', binaryPath: 'mousse-no-such-agent-command' } })
    await vi.waitFor(async () => {
      const [snapshot] = await harness.instances.snapshots({ kind: 'device' })
      expect(snapshot.runs).toMatchObject({ state: 'no', failure: 'override_not_found' })
    })
  })

  it('runs a person’s turn, refuses delegation, and tells the thread it approves tools itself', async () => {
    const { harness, calls, notices, spec } = fixture()
    await harness.instances.add({ driver: 'acp', config: { displayName: 'Fake agent', binaryPath: process.execPath } })
    const resolved = harness.resolveStored({ instanceId: 'acp:fake-agent', llmProvider: '', model: 'default' }, { purpose: 'turn' })
    expect(resolved.llmProvider).toBe('')
    expect(() => harness.resolveStored({ instanceId: 'acp:fake-agent', llmProvider: '', model: 'default' }, { purpose: 'delegate_task' })).toThrow(/approves tools itself/)
    const binding = await harness.bind(resolved, { mode: 'agent' })
    await expect(harness.startTurn(spec(binding)).result).resolves.toMatchObject({ text: 'hello' })
    expect(calls.filter((call) => call.startsWith('prompt'))).toHaveLength(1)
    expect(notices).toEqual(['Fake agent approves tools itself.'])
  })

  it('never resumes across turns: the account is unknown, so each turn hands the history to a new session', async () => {
    const { harness, calls, spec } = fixture()
    await harness.instances.add({ driver: 'acp', config: { displayName: 'Fake agent', binaryPath: process.execPath } })
    const resolved = () => harness.resolveStored({ instanceId: 'acp:fake-agent', llmProvider: '', model: 'default' }, { purpose: 'turn' })
    const first = await harness.bind(resolved(), { mode: 'agent' })
    // Mousse cannot read which account an arbitrary agent runs as.
    expect(first.accountId).toBeUndefined()
    await harness.startTurn(spec(first)).result
    const second = await harness.bind(resolved(), { mode: 'agent' })
    await harness.startTurn(spec(second, first)).result
    expect(calls.filter((call) => call === 'session/new')).toHaveLength(2)
    const prompted = calls.filter((call) => call.startsWith('prompt'))
    expect(prompted).toHaveLength(2)
    expect(prompted[0]).not.toBe(prompted[1])
  })
})

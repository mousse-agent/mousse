/**
 * The generic `acp` driver behind the gateway (agent CLIs plan §3): a Custom command is added and
 * checked with an `initialize`-only handshake, runs only for interactive purposes and titles, and a sign-in
 * changed from outside between two turns forgets the thread's native session.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AcpConnection } from '../../src/mms/harness/acp/connection'
import { acpDriver } from '../../src/mms/harness/drivers/acp'
import type { Harness, TurnSpec } from '../../src/mms/harness/gateway'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { instanceStateDir } from '../../src/mms/harness/instances'
import { inProcessAgent } from '../../src/mms/run/testkit/acpAgent'
import { testHarness } from '../../src/mms/run/testkit/harness'
import { describeStatus } from '../../src/shared/harness/status'
import type { TurnInput } from '../../src/mms/harness/adapter'

const homes: string[] = []
const harnesses: Harness[] = []
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

type Update = Record<string, unknown>
const say = (text: string): Update => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

/**
 * The connection as the SDK runs it over stdio: an update reaches `onUpdate` only after its handler chain (some
 * microtasks), while the answer to a request settles at once. An update written just before an answer lands after it.
 */
function lateUpdates(connection: AcpConnection): AcpConnection {
  let handler: AcpConnection['onUpdate']
  return Object.defineProperty(connection, 'onUpdate', {
    get: () => (update: unknown, sessionId?: string) => {
      let chain = Promise.resolve()
      for (let step = 0; step < 50; step++) chain = chain.then(() => undefined)
      void chain.then(() => handler?.(update, sessionId))
    },
    set: (next: AcpConnection['onUpdate']) => { handler = next }
  })
}

function fixture(authMethods: unknown[] = [], options: { starts?: () => boolean; lateUpdates?: boolean; updates?: Update[]; model?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-acp-driver-'))
  homes.push(home)
  const calls: string[] = []
  const sessionCwds: string[] = []
  const agent = inProcessAgent((app) => {
    app
      .onRequest(methods.agent.initialize, () => {
        calls.push('initialize')
        if (options.starts && !options.starts()) throw new Error('agent crashed on start')
        return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: 'fake', version: '1.2.3' }, agentCapabilities: { loadSession: false }, authMethods: authMethods as never }
      })
      .onRequest(methods.agent.authenticate, () => {
        calls.push('authenticate')
        return {}
      })
      .onRequest(methods.agent.logout, () => {
        calls.push('logout')
        return {}
      })
      .onRequest(methods.agent.session.new, (c) => {
        calls.push('session/new')
        sessionCwds.push(c.params.cwd)
        return {
          sessionId: `s${calls.length}`,
          ...(options.model ? { configOptions: [{
            id: 'model', name: 'Model', category: 'model', type: 'select',
            currentValue: options.model, options: [{ value: options.model, name: 'Listed model' }]
          }] } : {})
        }
      })
      .onRequest(methods.agent.session.prompt, async (c) => {
        calls.push(`prompt ${c.params.sessionId}`)
        for (const update of options.updates ?? [say('hello')])
          await c.client.notify(methods.client.session.update, { sessionId: c.params.sessionId, update: update as never })
        return { stopReason: 'end_turn' }
      })
  })
  let stored: unknown = {}
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
  const notices: string[] = []
  let clock = Date.now()
  const connect = (request: Parameters<typeof agent.connect>[0]) => options.lateUpdates ? lateUpdates(agent.connect(request)) : agent.connect(request)
  const harness = testHarness({ drivers: [acpDriver({ connect: (_context, request) => connect(request) })], instances, profileHome: home, now: () => clock })
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
  return { home, harness, calls, sessionCwds, agent, notices, spec, tick: (ms: number) => { clock += ms } }
}

describe('the generic ACP driver', () => {
  it('checks a new Custom command with an initialize-only handshake and then lists its models', async () => {
    const { harness, calls, agent } = fixture([], { model: 'listed' })
    const added = await harness.instances.add({ driver: 'acp', config: { displayName: 'Fake agent', binaryPath: process.execPath, args: ['agent.js'] } })
    expect(added.instanceId).toBe('acp:fake-agent')
    await vi.waitFor(async () => {
      const [snapshot] = await harness.instances.snapshots({ kind: 'device' })
      expect(snapshot).toMatchObject({ runs: { state: 'yes' }, binary: { version: '1.2.3', source: 'override' }, caps: { toolControl: 'uncontrolled', planMode: false }, auth: { state: 'not_required' } })
      expect(snapshot?.models.entries.some((model) => model.id === 'listed')).toBe(true)
      expect(agent.connections.map(({ request, killed }) => [request.purpose, killed])).toEqual([['handshake', true], ['models', true]])
    })
    expect(calls).toEqual(['initialize', 'initialize', 'session/new'])
  })

  it('offers Sign in from Settings before the account is checked, and Sign out after a Mousse sign-in', async () => {
    const { harness, calls } = fixture([{ id: 'browser', name: 'Sign in with your account' }])
    await harness.instances.add({ driver: 'acp', config: { displayName: 'Fake agent', binaryPath: process.execPath } })
    const snapshot = async () => (await harness.instances.snapshots({ kind: 'device' }))[0]!
    await vi.waitFor(async () => expect((await snapshot()).auth).toMatchObject({ state: 'unknown', canSignIn: true }))
    expect(describeStatus(await snapshot()).nextStep).toMatchObject({ action: 'sign_in', label: 'Sign in' })
    await harness.instances.signIn('acp:fake-agent')
    await vi.waitFor(async () => expect((await snapshot()).auth).toMatchObject({ state: 'signed_in', methodLabel: 'Sign in with your account', canSignOut: true }))
    expect(calls).toContain('authenticate')
    await harness.instances.signOut('acp:fake-agent')
    expect(calls).toContain('logout')
    expect((await snapshot()).auth.state).not.toBe('signed_in')
  })

  it('keeps a failed start-up check until the next one succeeds, through periodic checks', async () => {
    let starts = false
    const { harness, tick } = fixture([], { starts: () => starts })
    await harness.instances.add({ driver: 'acp', config: { displayName: 'Fake agent', binaryPath: process.execPath } })
    const snapshot = async () => (await harness.instances.snapshots({ kind: 'device' }))[0]!
    await vi.waitFor(async () => expect((await snapshot()).runs).toMatchObject({ state: 'no', failure: 'exited' }))
    // A periodic check runs no start-up check for a command without a version flag.
    tick(11 * 60_000)
    await snapshot()
    await vi.waitFor(async () => expect((await snapshot()).checkedAt).toBeDefined())
    tick(11 * 60_000)
    await harness.instances.snapshots({ kind: 'device' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await snapshot()).runs).toMatchObject({ state: 'no', failure: 'exited' })
    starts = true
    await harness.instances.recheck('acp:fake-agent')
    expect((await snapshot()).runs).toMatchObject({ state: 'yes' })
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
    const binding = await harness.bind(resolved, { mode: 'agent', permissionMode: 'full' })
    await expect(harness.startTurn(spec(binding)).result).resolves.toMatchObject({ text: 'hello' })
    expect(calls.filter((call) => call.startsWith('prompt'))).toHaveLength(1)
    expect(notices).toEqual(['Fake agent approves tools itself.'])
  })

  it('names chats: listed for titles, and a title runs on a process of its own in an empty folder removed afterwards', async () => {
    const { home, harness, calls, sessionCwds, agent } = fixture([], { updates: [say('Login bug')] })
    await harness.instances.add({ driver: 'acp', config: { displayName: 'Fake agent', binaryPath: process.execPath } })
    const listed = (await harness.llmProviders({ kind: 'device' })).find((provider) => provider.instanceId === 'acp:fake-agent')
    expect(listed?.oneShot).toBe(true)
    const answer = await harness.oneShot({ selection: { instanceId: 'acp:fake-agent', llmProvider: '', model: 'default' }, purpose: 'title', system: 'You name chats.', prompt: 'fix the login bug', maxChars: 80 })
    expect(answer).toEqual({ text: 'Login bug' })
    const oneShot = agent.connections.find(({ request }) => request.purpose === 'one_shot')!
    expect(oneShot.killed).toBe(true)
    expect(calls.filter((call) => call.startsWith('prompt'))).toHaveLength(1)
    const cwd = sessionCwds.at(-1)!
    expect(relative(join(instanceStateDir(home, 'acp:fake-agent'), 'one-shot'), cwd).startsWith('..')).toBe(false)
    expect(existsSync(cwd)).toBe(false)
  })

  it('ends a title request as refused when the agent reports a tool call', async () => {
    const { harness, agent } = fixture([], { updates: [{ sessionUpdate: 'tool_call', toolCallId: 'x', title: 'Run command', status: 'pending' }, say('Login bug')] })
    await harness.instances.add({ driver: 'acp', config: { displayName: 'Fake agent', binaryPath: process.execPath } })
    await expect(harness.oneShot({ selection: { instanceId: 'acp:fake-agent', llmProvider: '', model: 'default' }, purpose: 'title', system: 'You name chats.', prompt: 'fix the login bug', maxChars: 80 }))
      .rejects.toMatchObject({ code: 'policy_unenforceable' })
    expect(agent.connections.find(({ request }) => request.purpose === 'one_shot')?.killed).toBe(true)
  })

  it('shows the agent’s thoughts as they come, one row before each tool call and one after, then its reply', async () => {
    const thought = (text: string): Update => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } })
    const { harness, spec } = fixture([], {
      updates: [
        thought('Reading the '), thought('switcher.'),
        { sessionUpdate: 'tool_call', toolCallId: 'read1', title: 'Read SideChatsPanel.tsx', status: 'in_progress' },
        { sessionUpdate: 'tool_call_update', toolCallId: 'read1', status: 'completed' },
        thought('Found the race.'),
        say('Fixed.')
      ]
    })
    await harness.instances.add({ driver: 'acp', config: { displayName: 'Fake agent', binaryPath: process.execPath } })
    const binding = await harness.bind(harness.resolveStored({ instanceId: 'acp:fake-agent', llmProvider: '', model: 'default' }, { purpose: 'turn' }), { mode: 'agent', permissionMode: 'full' })
    const turn = spec(binding)
    await expect(harness.startTurn(turn).result).resolves.toMatchObject({ text: 'Fixed.' })
    const thinking = vi.mocked(turn.sink.thinking).mock.calls.map(([event]) => event)
    const rows = thinking.filter((event) => event.phase === 'complete').map((event) => event.content)
    expect(rows).toEqual(['Reading the switcher.', 'Found the race.'])
    // The first thought is on screen before the tool call starts, not held to the end of the turn.
    const firstThought = vi.mocked(turn.sink.thinking).mock.invocationCallOrder[0]!
    const toolStart = vi.mocked(turn.sink.tool).mock.invocationCallOrder[0]!
    expect(firstThought).toBeLessThan(toolStart)
    // A thought is never the reply.
    expect(vi.mocked(turn.sink.text).mock.calls.map(([event]) => event).filter((event) => event.phase === 'complete').map((event) => event.content)).toEqual(['Fixed.'])
  })

  it('keeps the reply an agent writes just before it answers the prompt', async () => {
    const { harness, spec } = fixture([], { lateUpdates: true })
    await harness.instances.add({ driver: 'acp', config: { displayName: 'Fake agent', binaryPath: process.execPath } })
    const binding = await harness.bind(harness.resolveStored({ instanceId: 'acp:fake-agent', llmProvider: '', model: 'default' }, { purpose: 'turn' }), { mode: 'agent', permissionMode: 'full' })
    await expect(harness.startTurn(spec(binding)).result).resolves.toMatchObject({ text: 'hello' })
  })

  it('never resumes across turns: the account is unknown, so each turn hands the history to a new session', async () => {
    const { harness, calls, spec } = fixture()
    await harness.instances.add({ driver: 'acp', config: { displayName: 'Fake agent', binaryPath: process.execPath } })
    const resolved = () => harness.resolveStored({ instanceId: 'acp:fake-agent', llmProvider: '', model: 'default' }, { purpose: 'turn' })
    const first = await harness.bind(resolved(), { mode: 'agent', permissionMode: 'full' })
    // Mousse cannot read which account an arbitrary agent runs as.
    expect(first.accountId).toBeUndefined()
    await harness.startTurn(spec(first)).result
    const second = await harness.bind(resolved(), { mode: 'agent', permissionMode: 'full' })
    await harness.startTurn(spec(second, first)).result
    expect(calls.filter((call) => call === 'session/new')).toHaveLength(2)
    const prompted = calls.filter((call) => call.startsWith('prompt'))
    expect(prompted).toHaveLength(2)
    expect(prompted[0]).not.toBe(prompted[1])
  })

  it('runs a standalone turn (cwd: null) in a private per-thread workspace inside the instance state dir', async () => {
    const { home, harness, sessionCwds, spec } = fixture()
    await harness.instances.add({ driver: 'acp', config: { displayName: 'Fake agent', binaryPath: process.execPath } })
    const binding = await harness.bind(harness.resolveStored({ instanceId: 'acp:fake-agent', llmProvider: '', model: 'default' }, { purpose: 'turn' }), { mode: 'agent', permissionMode: 'full' })
    const turn = spec(binding)
    turn.input.cwd = null
    turn.input.threadId = '../../outside'
    await expect(harness.startTurn(turn).result).resolves.toMatchObject({ text: 'hello' })
    const expected = harness.standaloneWorkspace('acp:fake-agent', '../../outside')
    expect(expected).toBeTruthy()
    expect(sessionCwds).toEqual([expected])
    expect(existsSync(expected!)).toBe(true)
    expect(statSync(expected!).isDirectory()).toBe(true)
    expect(relative(home, expected!).startsWith('..')).toBe(false)
  })
})

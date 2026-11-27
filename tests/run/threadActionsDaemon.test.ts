/**
 * `thread_send`, `thread_wait`, `thread_interrupt` and `thread_steer` end to end (docs/run-engine/SPEC.md
 * §15.1): a real `OrchestratorService`, Run Engine, effect worker and Mousse MCP server, with scripted
 * provider runtimes whose turns call the tools over HTTP. Covers what the target thread's model reads and
 * stores, the caller's permission mode bounding the target's turn, queued messages keeping it across a
 * restart, steering and stopping, stale run ids, paused, archived and asking threads, loops and caps.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import { readDurableQueue } from '../../src/mms/queue/durableQueue'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import { AGENT_MESSAGE_PREFIX, agentMessage, agentMessageText, TURN_TOKEN_KEY } from '../../src/mms/run/mcp/appTools'
import { AGENT_REPEAT_WINDOW_MS } from '../../src/mms/run/mcp/appTools/thread'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { BOUNDARY_NOTICE_HEADER, MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import type { ChatMessage } from '../../src/shared/types'
import { agentMessageWords } from '../../src/shared/agentMessageWords'
import type { PermissionMode } from '../../src/shared/permissionMode'
import { refusalOfResponse } from './appToolsFixture'
import { spendChain } from './chainFixture'
import { phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'

vi.setConfig({ testTimeout: 60_000 })

type Mcp = { url: string; token: string; turnToken?: string }
type Script = (input: TurnInput, mcp: Mcp | undefined, d: Phase6Daemon, adapter: VendorAdapter) => Promise<string>

/** A provider stand-in whose script gets the turn's MCP bridge, and whose turns can be held and interrupted. */
class VendorAdapter implements ProviderAdapter {
  readonly turns: TurnInput[] = []
  readonly abortedRuns = new Set<string>()
  /** The control of each turn, so a script can drain and hand back steers the way a provider does. */
  readonly controls = new Map<string, TurnControl>()
  private readonly interruptListeners = new Set<() => void>()
  constructor(readonly driver: ProviderDriverKind, readonly capabilities: ProviderCapabilities, private readonly script: (input: TurnInput, host: AdapterHost, adapter: VendorAdapter) => Promise<string>) {}

  configured(): boolean {
    return true
  }

  /** Holds the turn until `release` settles or the runtime is interrupted (a Stop), the way a live turn would end. */
  async hold(input: TurnInput, release: Promise<void>): Promise<void> {
    await Promise.race([
      release,
      new Promise<void>((resolve) => {
        const listener = (): void => {
          this.abortedRuns.add(input.runId)
          this.interruptListeners.delete(listener)
          resolve()
        }
        this.interruptListeners.add(listener)
      })
    ])
  }

  async startTurn(input: TurnInput, sink: TurnSink, ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.turns.push(input)
    this.controls.set(input.runId, ctl)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    const text = await this.script(input, host, this)
    const aborted = this.abortedRuns.has(input.runId)
    if (!aborted) sink.text({ phase: 'complete', content: text, contentIndex: 0 })
    const native = this.capabilities.historyInjection === 'native'
    if (!native && !aborted) host.context.nativeHistoryAfterTurn(text)
    return {
      text: aborted ? '' : text,
      aborted,
      modelName: 'Scripted',
      totalResponseTimeMs: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextSignature: 'scripted',
      nativeMessages: native ? [...input.messages, { role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now() } as never] : [],
      providerRef
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    for (const listener of [...this.interruptListeners]) listener()
    return 'interrupted'
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function rpc(mcp: Mcp, method: string, params: Record<string, unknown>, id = 1) {
  const response = await fetch(mcp.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mcp.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  })
  return await response.json() as {
    result?: { content?: Array<{ text: string }>; tools?: Array<{ name: string }>; isError?: boolean }
    error?: { code: number; message: string; data?: { reason: string; conflict?: string; [key: string]: unknown } }
  }
}

const call = (mcp: Mcp, name: string, args: Record<string, unknown> = {}) =>
  rpc(mcp, 'tools/call', { name, arguments: mcp.turnToken ? { ...args, [TURN_TOKEN_KEY]: mcp.turnToken } : args })
const parse = (response: Awaited<ReturnType<typeof rpc>>): Record<string, unknown> => {
  if (response.error) throw new Error(`rpc error ${response.error.code}: ${response.error.message}`)
  if (response.result?.isError) throw new Error(response.result.content?.[0]?.text ?? 'tool error')
  return JSON.parse(response.result!.content![0].text)
}

describe('thread_send, thread_wait, thread_interrupt and thread_steer end to end (SPEC §15.1)', () => {
  let home: string | undefined
  let previousHome: string | undefined
  const stops: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop().catch(() => undefined)
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  const MODEL = { llmProvider: 'claude-subscription', model: 'vendor-model' }

  /**
   * A daemon whose threads all run on one scripted runtime that talks to the real MCP server. `parent`
   * is the usual caller and `other` the usual target; more threads are made with `thread`.
   */
  const world = (script: Script) => {
    home = mkdtempSync(join(tmpdir(), 'mousse-thread-actions-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    mkdirSync(join(home, 'project'))
    let created: Phase6Daemon | undefined
    const adapter: VendorAdapter = new VendorAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, async (input, host, self) => {
      const bridge = host.bridge
      return script(input, bridge?.mcp ? { ...bridge.mcp, turnToken: bridge.turnToken } : undefined, created!, self)
    })
    const d = phase6Daemon(home, [adapter])
    created = d
    const credentials = new McpCredentials(d.engine.store)
    const server = new MousseMcpServer({ credentials, registry: d.orch.mcpToolRegistry(), boundary: d.orch.mcpToolBoundary() })
    stops.push(async () => {
      d.orch.setMcpAttachment(null)
      await server.stop()
      await d.stop()
    })
    const project = d.projects.openProject(join(home, 'project'))
    const thread = (name: string, mode?: PermissionMode) => {
      const made = d.store.createThread(name, project.id)
      d.orch.setThreadModelOverride(made.id, MODEL)
      if (mode) d.orch.setThreadPermissionMode(made.id, mode)
      return made
    }
    const parent = thread('Parent')
    const other = thread('Other work')
    const events = (threadId: string, type: string) => d.engine.listEvents(threadId).filter((event) => event.type === type)
    const messages = (threadId: string): ChatMessage[] => d.orch.getOrCreateSession(threadId).messages
    return {
      d, adapter, server, project, parent, other, thread, events, messages,
      attach: async () => { await server.start(); d.orch.setMcpAttachment(server) },
      turnsOf: (threadId: string) => adapter.turns.filter((turn) => turn.threadId === threadId),
      /** The run `send` admitted for a thread: its latest. */
      latestRun: (threadId: string) => d.engine.listRuns(threadId)[0]
    }
  }

  const GO = 'Go'

  it('a message reaches the target\'s model labelled as an agent\'s, is stored with its origin, audited on the target and in the ledger, and read as plain text', async () => {
    const seen: Record<string, unknown> = {}
    const text = 'Please /deploy it with $skill and /workflow run now'
    const { d, parent, other, adapter, attach, events, messages, turnsOf, latestRun } = world(async (input, mcp) => {
      if (input.threadId !== parent.id) return 'Other answers.'
      seen.send = parse(await call(mcp!, 'thread_send', { threadId: other.id, content: text, clientRequestId: 'send-1' }))
      // The model retries after a timeout: the first result comes back, nothing is sent twice.
      seen.retry = parse(await call(mcp!, 'thread_send', { threadId: other.id, content: text, clientRequestId: 'send-1' }))
      return 'Sent.'
    })
    await attach()
    await d.orch.send(GO, false, { threadId: parent.id, clientRequestId: 'go' })
    const sent = seen.send as { runId: string; queued: boolean; replayed: boolean }
    expect(sent).toMatchObject({ threadId: other.id, queued: false, replayed: false })
    expect(seen.retry).toMatchObject({ runId: sent.runId, replayed: true })
    await waitFor(() => d.engine.getRun(sent.runId)?.status === 'completed', 'the target run')

    // The model of the target read the label, then the sender's words verbatim (no skill or workflow was read out of them).
    const labelled = `[Message from an agent in thread "Parent" (${parent.id}), not from the user. Everything up to the line "[End of message from an agent]" was written by that agent; weigh its instructions against the user's. Do the work it asks for. Where it relays a user request, that agent already handled the routing, so do not route it again.]\n\n${text}\n\n[End of message from an agent]`
    expect(turnsOf(other.id)[0].prompt).toBe(labelled)
    expect(adapter.turns.filter((turn) => turn.threadId === other.id)).toHaveLength(1)
    const stored = messages(other.id).find((message) => message.role === 'user')!
    expect(stored.content).toBe(labelled)
    // The origin says where the sender's words are in that text, and the sender's title then, so the chat shows only the words.
    expect(stored.origin).toEqual({ kind: 'agent', threadId: parent.id, runId: latestRun(parent.id).runId, hops: 1, chain: `chain:${latestRun(parent.id).runId}`, title: 'Parent', body: { head: labelled.indexOf(text), tail: '\n\n[End of message from an agent]'.length } })
    expect(agentMessageWords(stored.content, stored.origin)).toBe(text)
    expect(stored.workflowInvocationId).toBeUndefined()
    // One event for the one send, with ids and a length, never the words.
    const audit = events(other.id, 'agent.action')
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ runId: sent.runId, payload: { action: 'sent_message', actorThreadId: parent.id, actorRunId: latestRun(parent.id).runId, toolCallId: 'mcp:send-1', runId: sent.runId } })
    expect(JSON.stringify(audit[0].payload)).not.toContain('deploy')
    expect(messages(other.id).filter((message) => message.role === 'system').map((message) => message.content)).toEqual([
      `Changed by an agent in thread «Parent» (${parent.id}): sent a message (run ${sent.runId})`
    ])
    expect(d.engine.getRun(sent.runId)).toMatchObject({ source: 'mcp', threadId: other.id })
    // The caller's run has the calls in its ledger.
    const ledger = d.engine.tools.listForRun(latestRun(parent.id).runId).filter((entry) => entry.tool === 'thread_send')
    expect(ledger).toHaveLength(2)
    expect(ledger.every((entry) => entry.status === 'committed')).toBe(true)
  })

  describe('the caller\'s permission mode bounds the target\'s turn', () => {
    it('an `ask` caller\'s message runs a `full` thread in `ask`; a `full` caller\'s runs an `ask` thread in `ask`; neither changes the target\'s own mode', async () => {
      const sends: Record<string, { runId: string }> = {}
      const ids: { fullCaller?: string; askTarget?: string } = {}
      const w = world(async (input, mcp) => {
        if (input.threadId === w.parent.id) sends.fromAsk = parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'work' })) as never
        if (input.threadId === ids.fullCaller) sends.fromFull = parse(await call(mcp!, 'thread_send', { threadId: ids.askTarget!, content: 'work' })) as never
        return 'ok'
      })
      const fullCaller = w.thread('Full caller', 'full')
      const askTarget = w.thread('Ask target', 'ask')
      ids.fullCaller = fullCaller.id
      ids.askTarget = askTarget.id
      w.d.orch.setThreadPermissionMode(w.parent.id, 'ask')
      w.d.orch.setThreadPermissionMode(w.other.id, 'full')
      await w.attach()
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go-1' })
      await w.d.orch.send(GO, false, { threadId: fullCaller.id, clientRequestId: 'go-2' })
      await waitFor(() => ['fromAsk', 'fromFull'].every((key) => sends[key] && w.d.engine.getRun(sends[key].runId)?.status === 'completed'), 'both target runs')

      expect(w.turnsOf(w.other.id)[0].permissionMode).toBe('ask')
      expect(w.d.engine.bindingForRun(sends.fromAsk.runId)?.policy.permissionMode).toBe('ask')
      expect(w.turnsOf(askTarget.id)[0].permissionMode).toBe('ask')
      expect(w.d.engine.bindingForRun(sends.fromFull.runId)?.policy.permissionMode).toBe('ask')
      // A send never widens or rewrites the thread's own setting.
      expect(w.d.store.getThread(w.other.id)?.permissionMode).toBe('full')
      expect(w.d.store.getThread(askTarget.id)?.permissionMode).toBe('ask')
      // The thread's own turn still runs as it was set.
      await w.d.orch.send('by hand', false, { threadId: w.other.id, clientRequestId: 'hand' })
      expect(w.turnsOf(w.other.id).at(-1)?.permissionMode).toBe('full')
    })

    it('a message that waited in the queue keeps the caller\'s mode and its origin on disk, and runs narrowed even when the target was raised to `full` meanwhile', async () => {
      const release = deferred()
      const seen: Record<string, unknown> = {}
      const w = world(async (input, mcp, _d, adapter) => {
        if (input.threadId === w.other.id && input.prompt === 'hold') {
          await adapter.hold(input, release.promise)
          return 'held done'
        }
        if (input.threadId === w.parent.id) seen.send = parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'later work' }))
        return 'ok'
      })
      w.d.orch.setThreadPermissionMode(w.parent.id, 'ask')
      await w.attach()
      const busy = await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the busy turn')
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      const sent = seen.send as { runId: string; queued: boolean }
      expect(sent.queued).toBe(true)

      // What a restarted daemon would read: the item with its mode and sender, from disk.
      const item = readDurableQueue(new ThreadDataStore(w.d.projects), w.other.id).find((entry) => entry.runId === sent.runId)!
      expect(item).toMatchObject({ source: 'mcp', permissionMode: 'ask', origin: { kind: 'agent', threadId: w.parent.id } })
      expect(item.content.startsWith(AGENT_MESSAGE_PREFIX)).toBe(true)
      // It waits behind the running turn: never a steer of it.
      expect(w.messages(w.other.id).filter((message) => message.origin)).toEqual([])

      w.d.orch.setThreadPermissionMode(w.other.id, 'full')
      release.resolve()
      await waitFor(() => w.d.engine.getRun(sent.runId)?.status === 'completed', 'the queued run')
      expect(w.d.engine.getRun(busy.runId!)?.status).toBe('completed')
      expect(w.turnsOf(w.other.id)[1].permissionMode).toBe('ask')
      expect(w.d.engine.bindingForRun(sent.runId)?.policy.permissionMode).toBe('ask')
      expect(w.messages(w.other.id).find((message) => message.origin)?.origin).toEqual(item.origin)
      expect(agentMessageWords(item.content, item.origin)).toBe('later work')
    })

    it('a message that waited in the queue when the daemon died runs after the restart showing only the sender\'s words, with the sender\'s title kept', async () => {
      const w = world(async () => 'ok')
      // Queued as thread_send queues it behind a busy turn (the test above): the labelled text, and the origin that says where the words are.
      const letter = agentMessage(w.parent.id, 'Parent', 'after the restart')
      const origin = { kind: 'agent' as const, threadId: w.parent.id, runId: 'run:sender', hops: 1, title: 'Parent', body: { head: letter.head, tail: letter.tail } }
      w.d.orch.enqueueForThread(w.other.id, { content: letter.text }, { source: 'mcp', permissionMode: 'ask', origin })
      await w.d.crash()

      const d2 = phase6Daemon(home!, [w.adapter], { pid: 2, orchestratorBoot: true })
      stops.push(async () => { await d2.stop() })
      ;(d2.orch as unknown as { scheduleQueueDrain(session: unknown): void }).scheduleQueueDrain(d2.orch.getOrCreateSession(w.other.id))
      await waitFor(() => w.turnsOf(w.other.id).length === 1 && d2.engine.listRuns(w.other.id).every((run) => run.status === 'completed'), 'the queued message after the restart', 30_000)
      expect(w.turnsOf(w.other.id)[0]).toMatchObject({ prompt: letter.text, permissionMode: 'ask', fromAgent: true })
      const stored = d2.orch.getOrCreateSession(w.other.id).messages.find((message) => message.role === 'user' && message.origin)!
      expect(stored.origin).toEqual(origin)
      expect(agentMessageWords(stored.content, stored.origin)).toBe('after the restart')
    })
  })

  describe('thread_steer', () => {
    it('an `ask` caller cannot steer a run that runs in `full`; a `full` caller can steer one that runs in `ask`', async () => {
      const release = deferred()
      const seen: Record<string, unknown> = {}
      const ids: { fullTarget?: string; askTarget?: string; fullCaller?: string } = {}
      const w = world(async (input, mcp, d, adapter) => {
        if (input.prompt === 'hold') {
          await adapter.hold(input, release.promise)
          return 'held done'
        }
        if (input.threadId === w.parent.id) {
          const run = d.engine.getActiveRun(ids.fullTarget!)!
          seen.refused = await call(mcp!, 'thread_steer', { threadId: ids.fullTarget!, runId: run.runId, text: 'do it differently' })
        }
        if (input.threadId === ids.fullCaller) {
          const run = d.engine.getActiveRun(ids.askTarget!)!
          seen.accepted = parse(await call(mcp!, 'thread_steer', { threadId: ids.askTarget!, runId: run.runId, text: 'also check the tests', clientRequestId: 'steer-1' }))
        }
        return 'ok'
      })
      const fullTarget = w.thread('Full target', 'full')
      const askTarget = w.thread('Ask target', 'ask')
      const fullCaller = w.thread('Full caller', 'full')
      Object.assign(ids, { fullTarget: fullTarget.id, askTarget: askTarget.id, fullCaller: fullCaller.id })
      w.d.orch.setThreadPermissionMode(w.parent.id, 'ask')
      await w.attach()
      await w.d.orch.send('hold', false, { threadId: fullTarget.id, clientRequestId: 'hold-1', awaitMode: 'ack' })
      await w.d.orch.send('hold', false, { threadId: askTarget.id, clientRequestId: 'hold-2', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(fullTarget.id).length === 1 && w.turnsOf(askTarget.id).length === 1, 'both held turns')
      const fullRun = w.latestRun(fullTarget.id)
      const askRun = w.latestRun(askTarget.id)
      expect(w.d.engine.bindingForRun(fullRun.runId)?.policy.permissionMode).toBe('full')
      expect(w.d.engine.bindingForRun(askRun.runId)?.policy.permissionMode).toBe('ask')

      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go-1' })
      const refused = seen.refused as Awaited<ReturnType<typeof rpc>>
      expect(refusalOfResponse(refused)).toMatchObject({ code: 'mousse_conflict', details: { reason: 'mousse_conflict', conflict: 'ceiling_exceeded', callerMode: 'ask', targetMode: 'full' } })
      // Nothing reached the running turn: no steer row, no audit row.
      expect(w.messages(fullTarget.id).filter((message) => message.origin)).toEqual([])
      expect(w.events(fullTarget.id, 'agent.action')).toEqual([])

      await w.d.orch.send(GO, false, { threadId: fullCaller.id, clientRequestId: 'go-2' })
      expect(seen.accepted).toMatchObject({ runId: askRun.runId, replayed: false })
      const steered = w.messages(askTarget.id).find((message) => message.origin)!
      expect(steered).toMatchObject({ steered: true, origin: { kind: 'agent', threadId: fullCaller.id } })
      expect(steered.content).toBe(agentMessageText(fullCaller.id, 'Full caller', 'also check the tests'))
      expect(w.events(askTarget.id, 'agent.action')).toEqual([
        expect.objectContaining({ runId: askRun.runId, payload: expect.objectContaining({ action: 'steered_run', toolCallId: 'mcp:steer-1', actorThreadId: fullCaller.id }) })
      ])
      expect(w.messages(askTarget.id).filter((message) => message.role === 'system').map((message) => message.content)).toEqual([
        expect.stringContaining(`Changed by an agent in thread «Full caller»`)
      ])
      release.resolve()
      await waitFor(() => [fullRun, askRun].every((run) => w.d.engine.getRun(run.runId)?.status === 'completed'), 'the held runs')
    })
  })

  describe('thread_interrupt', () => {
    it('stops the named active run; it ends interrupted by the agent, with an audit row and a transcript row, and a replay stops nothing more', async () => {
      const release = deferred()
      const seen: Record<string, unknown> = {}
      const w = world(async (input, mcp, d, adapter) => {
        if (input.prompt === 'hold') {
          await adapter.hold(input, release.promise)
          return 'held done'
        }
        const run = d.engine.getActiveRun(w.other.id)!
        seen.first = parse(await call(mcp!, 'thread_interrupt', { threadId: w.other.id, runId: run.runId, clientRequestId: 'stop-1' }))
        seen.again = parse(await call(mcp!, 'thread_stop', { threadId: w.other.id, runId: run.runId, clientRequestId: 'stop-1' }))
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the held turn')
      const run = w.latestRun(w.other.id)
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      expect(seen.first).toMatchObject({ runId: run.runId, replayed: false })
      expect(seen.again).toMatchObject({ runId: run.runId, replayed: true })
      await waitFor(() => w.d.engine.getRun(run.runId)?.status === 'interrupted', 'the stopped run')
      expect(w.d.engine.getRun(run.runId)?.outcome).toMatchObject({ interruptedBy: 'agent', stopRequested: true, stopRequestedBy: 'agent' })
      expect(w.events(w.other.id, 'agent.action')).toEqual([
        expect.objectContaining({ runId: run.runId, payload: expect.objectContaining({ action: 'stopped_run', actorThreadId: w.parent.id, toolCallId: 'mcp:stop-1' }) })
      ])
      expect(w.messages(w.other.id).filter((message) => message.role === 'system' && message.content.startsWith('Changed by an agent')).map((message) => message.content)).toEqual([
        `Changed by an agent in thread «Parent» (${w.parent.id}): stopped run ${run.runId}`
      ])
      // Both calls are in the caller's ledger under the new name; the old name and the new one are one request, so only the first stopped anything.
      expect(w.d.engine.tools.listForRun(w.latestRun(w.parent.id).runId).filter((entry) => entry.tool === 'thread_stop')).toHaveLength(2)
    })

    it('a run that ended, with another one active now, is a conflict that names the active run, and the active run is untouched', async () => {
      const gates = { a: deferred(), b: deferred() }
      const seen: Record<string, unknown> = {}
      const w = world(async (input, mcp, d, adapter) => {
        if (input.prompt === 'A') {
          await adapter.hold(input, gates.a.promise)
          return 'A done'
        }
        if (input.prompt === 'B') {
          await adapter.hold(input, gates.b.promise)
          return 'B done'
        }
        // The caller read run A as the active one; before it acts, A ends and B starts.
        const a = d.engine.getRun(seen.aRunId as string)!
        gates.a.resolve()
        await waitFor(() => d.engine.getRun(a.runId)?.status === 'completed', 'run A')
        const b = await d.orch.send('B', false, { threadId: w.other.id, clientRequestId: 'b', awaitMode: 'ack' })
        seen.bRunId = b.runId
        await waitFor(() => d.engine.getActiveRun(w.other.id)?.runId === b.runId, 'run B')
        seen.stale = await call(mcp!, 'thread_interrupt', { threadId: w.other.id, runId: a.runId })
        seen.staleSteer = await call(mcp!, 'thread_steer', { threadId: w.other.id, runId: a.runId, text: 'late guidance' })
        return 'ok'
      })
      await w.attach()
      const a = await w.d.orch.send('A', false, { threadId: w.other.id, clientRequestId: 'a', awaitMode: 'ack' })
      seen.aRunId = a.runId
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'run A')
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })

      for (const key of ['stale', 'staleSteer'] as const)
        expect(refusalOfResponse(seen[key] as Awaited<ReturnType<typeof rpc>>), key).toMatchObject({
          code: 'mousse_conflict',
          details: { conflict: 'run_not_active', expectedRunId: a.runId, activeRunId: seen.bRunId }
        })
      // B was neither stopped nor steered, and nothing was audited as an agent's change.
      expect(w.d.engine.getRun(seen.bRunId as string)?.outcome?.stopRequested).toBeUndefined()
      expect(w.events(w.other.id, 'agent.action')).toEqual([])
      expect(w.messages(w.other.id).filter((message) => message.origin)).toEqual([])
      gates.b.resolve()
      await waitFor(() => w.d.engine.getRun(seen.bRunId as string)?.status === 'completed', 'run B')
    })
  })

  describe('the state of the target thread', () => {
    it('a thread waiting on a question is refused, and its question is left to the user; once answered the send goes through', async () => {
      const seen: Record<string, Awaited<ReturnType<typeof rpc>>> = {}
      const w = world(async (input, mcp) => {
        if (input.threadId === w.parent.id) seen[input.prompt] = await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'a note' })
        return 'ok'
      })
      await w.attach()
      const question = (w.d.orch as unknown as { questions: { requestAnswers(questions: unknown, threadId: string, options: unknown): Promise<unknown>; listPendingForThread(threadId: string): Array<{ requestId: string }>; submitAnswers(requestId: string, answers: unknown): boolean } }).questions
      const asked = question.requestAnswers([{ id: 'q', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }], w.other.id, {})
      expect(question.listPendingForThread(w.other.id)).toHaveLength(1)
      await w.d.orch.send('first', false, { threadId: w.parent.id, clientRequestId: 'go-1' })
      expect(refusalOfResponse(seen.first)).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'questions_pending' } })
      // Nothing was admitted, nothing was answered for the user, and the thread has no run.
      expect(question.listPendingForThread(w.other.id)).toHaveLength(1)
      expect(w.d.engine.listRuns(w.other.id)).toEqual([])
      expect(w.events(w.other.id, 'agent.action')).toEqual([])

      question.submitAnswers(question.listPendingForThread(w.other.id)[0].requestId, { q: 'a' })
      await asked
      await w.d.orch.send('second', false, { threadId: w.parent.id, clientRequestId: 'go-2' })
      expect(parse(seen.second)).toMatchObject({ threadId: w.other.id, replayed: false })
    })

    it('a question raised after the message was admitted is neither rejected nor steered: the message stays queued and the turn goes on', async () => {
      const release = deferred()
      const seen: Record<string, unknown> = {}
      const w = world(async (input, mcp, _d, adapter) => {
        if (input.threadId === w.other.id && input.prompt === 'hold') {
          await adapter.hold(input, release.promise)
          return 'held done'
        }
        if (input.threadId === w.parent.id) seen.send = parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'a note' }))
        return 'ok'
      })
      await w.attach()
      const busy = await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the busy turn')
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      const sent = seen.send as { runId: string; queued: boolean }
      expect(sent.queued).toBe(true)

      // The running turn asks the user something after the message was admitted.
      const questions = (w.d.orch as unknown as { questions: { requestAnswers(questions: unknown, threadId: string, options: unknown): Promise<unknown>; listPendingForThread(threadId: string): Array<{ requestId: string }>; submitAnswers(requestId: string, answers: unknown): boolean } }).questions
      const asked = questions.requestAnswers([{ id: 'q', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }], w.other.id, {})
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(questions.listPendingForThread(w.other.id)).toHaveLength(1)
      expect(w.d.engine.getRun(busy.runId!)?.status).toBe('running')
      expect(w.d.engine.getRun(busy.runId!)?.outcome?.stopRequested).toBeUndefined()
      expect(readDurableQueue(w.d.store, w.other.id).map((item) => item.runId)).toEqual([sent.runId])
      expect(w.messages(w.other.id).filter((message) => message.origin)).toEqual([])

      questions.submitAnswers(questions.listPendingForThread(w.other.id)[0].requestId, { q: 'a' })
      await asked
      release.resolve()
      await waitFor(() => w.d.engine.getRun(sent.runId)?.status === 'completed', 'the queued message')
      expect(w.messages(w.other.id).find((message) => message.origin)?.origin).toMatchObject({ kind: 'agent', threadId: w.parent.id })
    })

    it('a paused thread refuses the message and keeps its pause; thread_steer is told the run is paused; thread_interrupt ends it as the agent\'s Stop', async () => {
      const seen: Record<string, Awaited<ReturnType<typeof rpc>>> = {}
      const w = world(async (input, mcp, d) => {
        const run = d.engine.listRuns(w.other.id)[0]
        seen.send = await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'a note' })
        seen.steer = await call(mcp!, 'thread_steer', { threadId: w.other.id, runId: run.runId, text: 'x' })
        seen.wait = await call(mcp!, 'thread_wait', { threadId: w.other.id, runId: run.runId, timeoutMs: 100 })
        seen.stop = await call(mcp!, 'thread_interrupt', { threadId: w.other.id, runId: run.runId })
        return 'ok'
      })
      await w.attach()
      const sent = await w.d.engine.dispatch({ kind: 'send', threadId: w.other.id, clientRequestId: 'paused-run', source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      w.d.engine.markStarting(sent.runId)
      w.d.engine.markRunning(sent.runId)
      w.d.engine.pauseRun({ runId: sent.runId, pause: { reason: 'usage_limit', until: '2026-10-12T05:00:00.000Z', estimated: true, count: 1, autoResume: false } })
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })

      expect(refusalOfResponse(seen.send)).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'thread_paused' }, refused: { retry: 'later' } })
      expect(refusalOfResponse(seen.steer)).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'run_paused', expectedRunId: sent.runId } })
      expect(parse(seen.wait)).toMatchObject({ status: 'paused', run: { runId: sent.runId, status: 'paused' } })
      expect(parse(seen.stop)).toMatchObject({ runId: sent.runId, replayed: false })
      expect(w.d.engine.getRun(sent.runId)).toMatchObject({ status: 'cancelled', outcome: { interruptedBy: 'agent', pause: { endedBy: 'stop' } } })
      expect(w.d.engine.listRuns(w.other.id)).toHaveLength(1)
      expect(w.events(w.other.id, 'agent.action').map((event) => (event.payload as { action: string }).action)).toEqual(['stopped_run'])
    })

    it('an archived thread takes no message or steer, but may be stopped', async () => {
      const seen: Array<Awaited<ReturnType<typeof rpc>>> = []
      const w = world(async (input, mcp) => {
        seen.push(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'x' }))
        seen.push(await call(mcp!, 'thread_steer', { threadId: w.other.id, runId: 'run:any', text: 'x' }))
        seen.push(await call(mcp!, 'thread_interrupt', { threadId: w.other.id, runId: 'run:any' }))
        return input.prompt
      })
      await w.attach()
      w.d.store.setThreadArchived(w.other.id, true)
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      expect(seen.map((response) => refusalOfResponse(response)?.details)).toEqual([
        expect.objectContaining({ conflict: 'thread_archived' }),
        expect.objectContaining({ conflict: 'thread_archived' }),
        // The Stop is not refused for the thread's state; there is simply no such run.
        expect.objectContaining({ conflict: 'run_not_found' })
      ])
      expect(w.d.engine.listRuns(w.other.id)).toEqual([])
    })
  })

  describe('thread_wait', () => {
    it('returns the answer of the run the send created, after waiting for it', async () => {
      const release = deferred()
      const seen: Record<string, unknown> = {}
      const w = world(async (input, mcp, _d, adapter) => {
        if (input.threadId === w.other.id) {
          await adapter.hold(input, release.promise)
          return 'the other answer'
        }
        const sent = parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'what is the answer?' })) as { runId: string }
        // Not done yet: the wait times out and says to call again.
        seen.early = parse(await call(mcp!, 'thread_wait', { threadId: w.other.id, runId: sent.runId, timeoutMs: 50 }))
        release.resolve()
        seen.late = parse(await call(mcp!, 'thread_wait', { threadId: w.other.id, runId: sent.runId, timeoutMs: 30_000 }))
        return 'Waited.'
      })
      await w.attach()
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      expect(seen.early).toMatchObject({ status: 'timeout', hint: expect.stringContaining('call thread_wait again') })
      expect(seen.late).toMatchObject({ status: 'finished', run: { status: 'completed' }, resultText: 'the other answer' })
    })

    it('ends with caller_ended when the caller\'s run is stopped while it waits', async () => {
      const seen: Record<string, unknown> = {}
      const w = world(async (input, mcp, d, adapter) => {
        if (input.threadId === w.other.id) {
          await adapter.hold(input, new Promise<void>(() => undefined))
          return 'never'
        }
        const run = d.engine.getActiveRun(w.other.id)!
        // The model leaves the long wait running and ends its turn.
        seen.waiting = call(mcp!, 'thread_wait', { threadId: w.other.id, runId: run.runId, timeoutMs: 120_000 })
        await new Promise((resolve) => setTimeout(resolve, 100))
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the held turn')
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      // The caller's turn ended, which ended the wait it left running; it did not wait the 120 s out.
      const started = Date.now()
      const ended = await Promise.race([seen.waiting as Promise<Awaited<ReturnType<typeof rpc>>>, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 10_000))])
      expect(ended).not.toBe('hung')
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(parse(ended as Awaited<ReturnType<typeof rpc>>)).toMatchObject({ status: 'caller_ended' })
      // The target was not interrupted by the caller's wait or by the caller's end.
      expect(w.d.engine.getRun(w.latestRun(w.other.id).runId)?.status).toBe('running')
      await w.d.orch.stopThread(w.other.id, 'user')
    })
  })

  describe('loops and caps', () => {
    it('A sends to B, which sends back to A: the reply waits behind A\'s running turn, never steers it, and runs as A\'s next turn labelled as B\'s', async () => {
      const seen: Record<string, unknown> = {}
      const w = world(async (input, mcp, d) => {
        if (input.threadId === w.parent.id && input.prompt === GO) {
          const sent = parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'ping' })) as { runId: string }
          const waited = parse(await call(mcp!, 'thread_wait', { threadId: w.other.id, runId: sent.runId, timeoutMs: 30_000 }))
          seen.waited = waited
          // B's reply is in A's queue behind this turn, not in this turn.
          seen.queuedWhileRunning = readDurableQueue(d.store, w.parent.id).map((item) => ({ source: item.source, origin: item.origin }))
          seen.steeredWhileRunning = d.orch.getOrCreateSession(w.parent.id).messages.filter((message) => message.origin).length
          return 'A sent a ping.'
        }
        if (input.threadId === w.other.id) {
          seen.bPrompt = input.prompt
          seen.reply = parse(await call(mcp!, 'thread_send', { threadId: w.parent.id, content: 'pong' }))
          return 'B replied.'
        }
        seen.aSecondPrompt = input.prompt
        return 'A got the pong.'
      })
      await w.attach()
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      await waitFor(() => w.turnsOf(w.parent.id).length === 2, 'A\'s second turn')
      const reply = seen.reply as { runId: string; queued: boolean }
      expect(reply.queued).toBe(true)
      expect(seen.waited).toMatchObject({ status: 'finished', resultText: 'B replied.' })
      expect(seen.queuedWhileRunning).toMatchObject([{ source: 'mcp', origin: { kind: 'agent', threadId: w.other.id, runId: w.latestRun(w.other.id).runId, hops: 2 } }])
      expect(seen.steeredWhileRunning).toBe(0)
      await waitFor(() => w.d.engine.getRun(reply.runId)?.status === 'completed', 'A\'s second run')
      // A's second turn read B's message with B's label; B's first turn read A's.
      expect(String(seen.aSecondPrompt)).toBe(agentMessageText(w.other.id, 'Other work', 'pong'))
      expect(String(seen.bPrompt)).toContain(`"Parent" (${w.parent.id})`)
      expect(w.messages(w.parent.id).find((message) => message.origin)?.origin).toMatchObject({ kind: 'agent', threadId: w.other.id })
      // Two sends in all, one from each thread: the exchange stopped where the scripts stopped it.
      const sends = (threadId: string) => w.d.engine.listRuns(threadId).flatMap((run) => w.d.engine.tools.listForRun(run.runId)).filter((entry) => entry.tool === 'thread_send')
      expect(sends(w.parent.id)).toHaveLength(1)
      expect(sends(w.other.id)).toHaveLength(1)
    })

    it('a handoff from A to B to C to D, and D\'s report back to A, all go in A\'s chain: the fourth agent message is not refused', async () => {
      const replies: Array<Record<string, unknown>> = []
      const threads: string[] = []
      const w = world(async (input, mcp) => {
        const at = threads.indexOf(input.threadId)
        // A's second turn reads D's report and ends the handoff.
        if (at === 0 && input.prompt !== GO) return 'done'
        replies.push(parse(await call(mcp!, 'thread_send', { threadId: threads[(at + 1) % threads.length], content: `handoff from ${at}` })))
        return 'passed on'
      })
      threads.push(w.parent.id, w.other.id, w.thread('C').id, w.thread('D').id)
      await w.attach()
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      await waitFor(() => w.turnsOf(w.parent.id).length === 2, 'D\'s report to reach A', 60_000)
      const chainId = `chain:${w.d.engine.listRuns(w.parent.id).at(-1)!.runId}`
      expect(replies.map((reply) => reply.delivery)).toEqual(['started', 'started', 'started', 'started'])
      expect(replies.map((reply) => w.d.engine.getRun(String(reply.runId))?.outcome?.agentChain)).toEqual(Array(4).fill(chainId))
      expect(w.d.engine.chains.get(chainId)).toMatchObject({ rootThreadId: w.parent.id, used: 4 })
    })

    it('the message past the chain\'s budget is held, not dropped: its sender is told to end its turn, a retry finds the same hold, and the target gets nothing', async () => {
      const seen: Record<string, Record<string, unknown>> = {}
      const w = world(async (input, mcp, d) => {
        if (input.threadId !== w.parent.id) return 'ok'
        // One message is left in this chain's budget, as if eleven went before.
        spendChain(d.engine, `chain:${input.runId}`, w.parent.id, w.other.id, 1)
        seen.last = parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'Message twelve.', clientRequestId: 'twelve' }))
        seen.held = parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'Message thirteen.', clientRequestId: 'thirteen' }))
        seen.retry = parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'Message thirteen.', clientRequestId: 'thirteen' }))
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      await waitFor(() => seen.retry !== undefined, 'the sends')
      const chainId = `chain:${w.d.engine.listRuns(w.parent.id).at(-1)!.runId}`
      expect(seen.last).toMatchObject({ delivery: 'started' })
      expect(seen.held).toMatchObject({ status: 'held', delivery: 'held_for_person', chainId, rootThreadId: w.parent.id, replayed: false })
      expect(String(seen.held.note)).toContain('End your turn')
      expect(seen.retry).toMatchObject({ status: 'held', holdId: seen.held.holdId, replayed: true })
      // Kept with what Continue needs to send it.
      expect(w.d.engine.chains.heldFor(chainId)).toMatchObject([{ holdId: seen.held.holdId, targetThreadId: w.other.id, payload: { input: { content: 'Message thirteen.' } } }])
      await waitFor(() => w.d.engine.listRuns(w.other.id).every((run) => run.status === 'completed'), 'the twelfth message to run')
      expect(w.turnsOf(w.other.id).map((turn) => String(turn.prompt))).toEqual([expect.stringContaining('Message twelve.')])
    })

    describe('the person answers a held chain', () => {
      /** A world whose parent, at `GO`, spends its chain's budget and sends two messages to `other`, both held. */
      const heldWorld = async () => {
        const held: Array<Record<string, unknown>> = []
        const w = world(async (input, mcp, d) => {
          if (input.threadId === w.parent.id && input.prompt === GO) {
            spendChain(d.engine, `chain:${input.runId}`, w.parent.id, w.other.id)
            for (const content of ['First held.', 'Second held.']) held.push(parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content })))
          }
          return 'ok'
        })
        await w.attach()
        await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
        await waitFor(() => held.length === 2, 'both messages to be held')
        expect(held.map((reply) => reply.status)).toEqual(['held', 'held'])
        await waitFor(() => w.d.engine.listRuns(w.parent.id).every((run) => run.status === 'completed'), 'the sender\'s turn to end')
        return { w, chainId: String(held[0].chainId) }
      }
      const answerTwice = (w: Awaited<ReturnType<typeof heldWorld>>['w'], chainId: string, answer: 'continue' | 'stop') =>
        Promise.allSettled([w.d.orch.answerChainHold(w.parent.id, chainId, answer), w.d.orch.answerChainHold(w.parent.id, chainId, answer)])

      it('Continue sends what was held, in order and once, in a new budget', async () => {
        const { w, chainId } = await heldWorld()
        const [first, second] = await answerTwice(w, chainId, 'continue')
        expect(first).toMatchObject({ status: 'fulfilled', value: { sent: 2, stopped: 0, failed: 0 } })
        expect(second).toMatchObject({ status: 'rejected', reason: { reason: 'conflict' } })
        await waitFor(() => w.turnsOf(w.other.id).length === 2 && w.d.engine.listRuns(w.other.id).every((run) => run.status === 'completed'), 'both held messages to run', 30_000)
        expect(w.turnsOf(w.other.id).map((turn) => String(turn.prompt))).toEqual([expect.stringContaining('First held.'), expect.stringContaining('Second held.')])
        expect(w.d.engine.listRuns(w.other.id).map((run) => run.outcome?.agentChain)).toEqual([chainId, chainId])
        expect(w.d.engine.chains.get(chainId)?.used).toBe(2)
        expect(w.d.engine.chains.heldFor(chainId)).toEqual([])
      })

      it('while Continue sends, what it has not sent yet stays held, and a message the chain sends meanwhile waits behind it and goes last', async () => {
        const { w, chainId } = await heldWorld()
        const [, second] = w.d.engine.chains.heldFor(chainId)
        const gate = deferred()
        const seen: { held?: string[]; late?: string } = {}
        const dispatch = w.d.engine.dispatch.bind(w.d.engine)
        vi.spyOn(w.d.engine, 'dispatch').mockImplementation(async (command, options) => {
          if (command.kind === 'send' && command.chainHold === second!.holdId && !seen.held) {
            // What a restart now would find: the second message, not sent yet, still held.
            seen.held = w.d.engine.chains.heldFor(chainId).map((hold) => hold.holdId)
            // The chain sends again meanwhile: it waits behind what Continue has not sent yet.
            const late = w.d.engine.chains.admit({
              chainId, senderThreadId: second!.senderThreadId, senderRunId: second!.senderRunId, targetThreadId: w.other.id, kind: 'work', requestKey: 'late',
              payload: { ...(second!.payload as Record<string, unknown>), input: { content: 'Sent meanwhile.', mode: 'agent' }, clientRequestId: 'late' }
            })
            seen.late = late.status
            await gate.promise
          }
          return dispatch(command, options)
        })
        const answering = w.d.orch.answerChainHold(w.parent.id, chainId, 'continue')
        await waitFor(() => seen.held !== undefined, 'the second held message to be sent')
        expect(seen.held).toEqual([second!.holdId])
        expect(seen.late).toBe('held')
        gate.resolve()
        expect(await answering).toMatchObject({ sent: 3, failed: 0 })
        await waitFor(() => w.turnsOf(w.other.id).length === 3, 'all three to run', 30_000)
        expect(w.turnsOf(w.other.id).map((turn) => String(turn.prompt))).toEqual([expect.stringContaining('First held.'), expect.stringContaining('Second held.'), expect.stringContaining('Sent meanwhile.')])
        expect(w.d.engine.chains.get(chainId)?.used).toBe(3)
      })

      it('one card where the chain started, for as long as anything is held: its batch, how many messages and who is talking; it goes once answered', async () => {
        const { w, chainId } = await heldWorld()
        const shown = w.d.orch.getTurnState(w.parent.id)
        expect(shown.chainHold).toEqual({
          chainId, holdId: w.d.engine.chains.heldFor(chainId)[0]!.holdId, used: 12, held: 2, between: [{ threadId: w.parent.id, title: 'Parent' }, { threadId: w.other.id, title: 'Other work' }]
        })
        await new Promise((resolve) => setTimeout(resolve, 5))
        await w.d.orch.answerChainHold(w.parent.id, chainId, 'stop')
        const after = w.d.orch.getTurnState(w.parent.id)
        expect(after.chainHold).toBeUndefined()
        // A window that compares turn states by time after a gap sees that the card went.
        expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(shown.updatedAt))
      })

      it('an answer names the card\'s batch: one for a batch already settled is refused and leaves what was held later', async () => {
        const { w, chainId } = await heldWorld()
        const stale = w.d.orch.getTurnState(w.parent.id).chainHold!.holdId
        await w.d.orch.answerChainHold(w.parent.id, chainId, 'stop', { holdId: stale })
        // The chain holds again: a new batch, and a new card.
        const sender = w.d.engine.listRuns(w.parent.id)[0]!
        const note = { kind: 'agent_note', senderThreadId: w.parent.id, senderRunId: sender.runId, senderTitle: 'Parent', senderAccess: 'agent', from: 'sibling', text: 'Later.', attention: 'needed' }
        expect(w.d.engine.chains.admit({ chainId, senderThreadId: w.parent.id, senderRunId: sender.runId, targetThreadId: w.other.id, kind: 'note', requestKey: 'later', payload: note })).toMatchObject({ status: 'held' })
        await expect(w.d.orch.answerChainHold(w.parent.id, chainId, 'stop', { holdId: stale })).rejects.toMatchObject({ reason: 'hold_settled' })
        expect(w.d.engine.chains.heldFor(chainId)).toHaveLength(1)
      })

      it('a Continue from a device limited below what a held message would run with is refused, and nothing is sent', async () => {
        const { w, chainId } = await heldWorld()
        await expect(w.d.orch.answerChainHold(w.parent.id, chainId, 'continue', { deviceLimit: 'ask' })).rejects.toMatchObject({ code: 'permission_mode_above_ceiling', details: { reason: 'device_limit' } })
        expect(w.d.engine.chains.heldFor(chainId)).toHaveLength(2)
        expect(w.d.engine.chains.get(chainId)?.used).toBe(12)
        expect(w.d.orch.getTurnState(w.parent.id).chainHold).toMatchObject({ held: 2 })
      })

      it('a card settled while a question waited does not come back when the question clears', async () => {
        const { w, chainId } = await heldWorld()
        ;(w.d.orch as any).setTurnPhase(w.parent.id, 'stopped')
        w.d.orch.setAwaitingInput(w.parent.id)
        await w.d.orch.answerChainHold(w.parent.id, chainId, 'stop')
        w.d.orch.inputAnswered(w.parent.id)
        expect(w.d.orch.getTurnState(w.parent.id)).toMatchObject({ phase: 'stopped' })
        expect(w.d.orch.getTurnState(w.parent.id).chainHold).toBeUndefined()
      })

      it('Continue posts a held note that asks for attention, which wakes its thread in the chain', async () => {
        const w = world(async () => 'ok')
        await w.attach()
        await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
        await waitFor(() => w.d.engine.listRuns(w.parent.id).every((run) => run.status === 'completed'), 'the sender\'s turn')
        const sender = w.d.engine.listRuns(w.parent.id)[0]!
        const chainId = `chain:${sender.runId}`
        spendChain(w.d.engine, chainId, w.parent.id, w.other.id)
        // A note that asks for attention, past the budget (the tool path: `admitAgentNote`).
        const note = { kind: 'agent_note', senderThreadId: w.parent.id, senderRunId: sender.runId, senderTitle: 'Parent', senderAccess: 'agent', from: 'sibling', text: 'A held note.', attention: 'needed' }
        expect(w.d.engine.chains.admit({ chainId, senderThreadId: w.parent.id, senderRunId: sender.runId, targetThreadId: w.other.id, kind: 'note', requestKey: 'note-key', payload: note })).toMatchObject({ status: 'held' })
        expect(await w.d.orch.answerChainHold(w.parent.id, chainId, 'continue')).toMatchObject({ sent: 1 })
        await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the note to wake its thread', 30_000)
        expect(String(w.turnsOf(w.other.id)[0]!.prompt)).toContain('A held note.')
        expect(w.d.engine.listRuns(w.other.id)[0]).toMatchObject({ source: 'wake', outcome: { agentChain: chainId } })
        expect(w.d.engine.chains.get(chainId)?.used).toBe(1)
      })

      it('Stop drops what was held, once, and tells the sender with a note that starts no turn', async () => {
        const { w, chainId } = await heldWorld()
        const [first, second] = await answerTwice(w, chainId, 'stop')
        expect(first).toMatchObject({ status: 'fulfilled', value: { sent: 0, stopped: 2, failed: 0 } })
        expect(second).toMatchObject({ status: 'rejected', reason: { reason: 'conflict' } })
        expect(w.d.engine.listRuns(w.other.id)).toEqual([])
        const told = w.d.engine.inbox.listPending(w.parent.id).map((row) => row.payload as { from?: string; attention?: string; text?: string })
        expect(told).toMatchObject([{ from: 'relay', attention: 'none' }, { from: 'relay', attention: 'none' }])
        expect(told.map((payload) => payload.text)).toEqual([expect.stringContaining('First held.'), expect.stringContaining('Second held.')])
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(w.turnsOf(w.parent.id)).toHaveLength(1)
      })
    })

    it('a thread holds only a few messages from each sending thread in its queue: the next is refused, another sender still gets in, and a person\'s Stop clears them, leaving what a person queued', async () => {
      const release = deferred()
      const results: Array<Awaited<ReturnType<typeof rpc>>> = []
      const fromThird: Array<Awaited<ReturnType<typeof rpc>>> = []
      let third = ''
      const w = world(async (input, mcp, _d, adapter) => {
        if (input.threadId === w.other.id) {
          await adapter.hold(input, release.promise)
          return 'held'
        }
        if (input.threadId === third) {
          fromThird.push(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'note from the third thread' }))
          return 'Sent.'
        }
        for (let index = 0; index < 4; index += 1) results.push(await call(mcp!, 'thread_send', { threadId: w.other.id, content: `note ${index}` }))
        return 'Sent.'
      })
      third = w.thread('Third').id
      await w.attach()
      await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the held turn')
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      expect(results.slice(0, 3).map((response) => parse(response).delivery)).toEqual(['queued', 'queued', 'queued'])
      expect(refusalOfResponse(results[3])).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'agent_queue_full_per_sender' } })
      // One chatty sender does not shut the others out: the third thread's message still joins the queue.
      await w.d.orch.send(GO, false, { threadId: third, clientRequestId: 'go-third' })
      expect(parse(fromThird[0])).toMatchObject({ queued: true, delivery: 'queued' })
      const queuedRuns = [...results.slice(0, 3), fromThird[0]].map((response) => (parse(response) as { runId: string }).runId)
      const person = w.d.orch.enqueueForThread(w.other.id, { content: 'a note I typed' }, { source: 'gui' })
      expect(readDurableQueue(w.d.store, w.other.id).map((item) => item.origin?.kind === 'agent' ? item.origin.threadId : 'person'))
        .toEqual([w.parent.id, w.parent.id, w.parent.id, third, 'person'])

      // The person presses Stop: the running turn ends and the agents' queued messages go with it.
      await w.d.orch.stopThread(w.other.id, 'user')
      await waitFor(() => queuedRuns.every((runId) => w.d.engine.getRun(runId)?.status === 'cancelled'), 'the queued agent runs to be cancelled')
      expect(readDurableQueue(w.d.store, w.other.id).map((item) => item.id)).toEqual([person.id])
      expect(w.messages(w.other.id).filter((message) => message.origin)).toEqual([])
      release.resolve()
    })

    it('the same text from the same thread again within the window is refused as a repeat and runs once; a retry with the first key returns the first result; another thread may send the same words', async () => {
      const seen: Record<string, Awaited<ReturnType<typeof rpc>>> = {}
      let third = ''
      const w = world(async (input, mcp) => {
        if (input.threadId === w.parent.id && input.prompt === GO) {
          seen.first = await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'Run the checks.', clientRequestId: 'first' })
          seen.repeat = await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'Run the checks.', clientRequestId: 'second' })
          seen.retry = await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'Run the checks.', clientRequestId: 'first' })
          seen.reworded = await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'Run the checks again, please.', clientRequestId: 'third' })
        }
        if (input.threadId === third) seen.otherSender = await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'Run the checks.' })
        return 'ok'
      })
      third = w.thread('Third').id
      await w.attach()
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      const first = parse(seen.first) as { runId: string; delivery: string }
      expect(first.delivery).toBe('started')
      const repeat = refusalOfResponse(seen.repeat)
      expect(repeat).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'duplicate_message', retryAfterMs: expect.any(Number) }, refused: { retry: 'later' } })
      expect(repeat!.details.retryAfterMs as number).toBeGreaterThan(0)
      expect(repeat!.details.retryAfterMs as number).toBeLessThanOrEqual(AGENT_REPEAT_WINDOW_MS)
      expect(repeat!.refused.retryAfterSeconds).toBe(Math.ceil((repeat!.details.retryAfterMs as number) / 1000))
      expect(parse(seen.retry)).toMatchObject({ runId: first.runId, replayed: true })
      expect(seen.reworded.result?.isError).toBeUndefined()
      await w.d.orch.send(GO, false, { threadId: third, clientRequestId: 'go-third' })
      expect(seen.otherSender.result?.isError).toBeUndefined()
      // The repeated words reached the other thread's model once from the parent: its first message, and the reworded one.
      await waitFor(() => w.d.engine.listRuns(w.other.id).every((run) => run.status === 'completed') && w.turnsOf(w.other.id).length === 3, 'the other thread\'s turns')
      const fromParent = w.turnsOf(w.other.id).filter((turn) => String(turn.prompt).includes(`(${w.parent.id})`))
      expect(fromParent.map((turn) => String(turn.prompt).includes('Run the checks.\n'))).toEqual([true, false])
    })

    it('an agent\'s own Stop of a run leaves the messages other agents queued on that thread', async () => {
      const release = deferred()
      const seen: Record<string, unknown> = {}
      const w = world(async (input, mcp, d, adapter) => {
        if (input.threadId === w.other.id) {
          await adapter.hold(input, release.promise)
          return 'held'
        }
        if (input.threadId === w.parent.id) {
          seen.queued = parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'queued by an agent' }))
          seen.stop = parse(await call(mcp!, 'thread_interrupt', { threadId: w.other.id, runId: d.engine.getActiveRun(w.other.id)!.runId }))
        }
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the held turn')
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      const queued = seen.queued as { runId: string }
      expect(seen.stop).toMatchObject({ replayed: false })
      await waitFor(() => w.turnsOf(w.other.id).length >= 1 && w.d.engine.listRuns(w.other.id).some((run) => run.status === 'interrupted'), 'the stopped run')
      // The agent stopped one run; it did not clear what another agent queued on the thread (only a person's Stop does).
      expect(readDurableQueue(w.d.store, w.other.id).map((item) => [item.runId, item.origin?.kind])).toEqual([[queued.runId, 'agent']])
      expect(w.d.engine.getRun(queued.runId)?.status).toBe('queued')
      release.resolve()
    })
  })

  describe('an agent\'s message never runs with more than its sender\'s mode, on every path', () => {
    /** `other` is stored `full`; `parent` runs `ask`. */
    const asks = (script: Script) => {
      const w = world(script)
      w.d.orch.setThreadPermissionMode(w.parent.id, 'ask')
      w.d.orch.setThreadPermissionMode(w.other.id, 'full')
      return w
    }
    const originOf = (messages: ChatMessage[]) => messages.filter((message) => message.origin).map((message) => message.origin)

    it('a steer into a run whose turn has not started (no mode bound yet) is refused, and is not delivered later under the thread\'s own mode', async () => {
      const seen: Record<string, Awaited<ReturnType<typeof rpc>>> = {}
      const ids: { runId?: string } = {}
      const w = asks(async (input, mcp) => {
        if (input.threadId === w.parent.id) seen.steer = await call(mcp!, 'thread_steer', { threadId: w.other.id, runId: ids.runId!, text: 'do the risky thing' })
        return 'ok'
      })
      await w.attach()
      // The run is `starting`: admitted and begun, its turn not yet bound to a mode.
      const sent = await w.d.engine.dispatch({ kind: 'send', threadId: w.other.id, clientRequestId: 'starting', source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      w.d.engine.markStarting(sent.runId)
      ids.runId = sent.runId
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      expect(refusalOfResponse(seen.steer)).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'steer_target_not_ready', expectedRunId: sent.runId } })
      expect(w.events(w.other.id, 'agent.action')).toEqual([])
      expect(w.d.engine.outbox.listForRun(sent.runId).filter((effect) => effect.kind === 'turn.steer')).toEqual([])
      expect(w.d.engine.getRun(sent.runId)?.status).toBe('starting')
      w.d.engine.markTerminal(sent.runId, 'cancelled')
    })

    it.each([
      ['never read by the turn', false],
      ['read, then handed back by the provider', true]
    ])('a steer the turn does not take (%s) runs as a turn of its own under the sender\'s mode, labelled as the agent\'s and apart from a person\'s text', async (_name, handBack) => {
      const release = deferred()
      const seen: Record<string, unknown> = {}
      const w = asks(async (input, mcp, d, adapter) => {
        if (input.prompt === 'hold') {
          await adapter.hold(input, release.promise)
          if (handBack) {
            const ctl = adapter.controls.get(input.runId)!
            const drained = ctl.drainSteerEntry?.()
            if (drained) ctl.returnSteer?.(drained.text, drained.token)
          }
          return 'held done'
        }
        if (input.threadId === w.parent.id) seen.steer = parse(await call(mcp!, 'thread_steer', { threadId: w.other.id, runId: d.engine.getActiveRun(w.other.id)!.runId, text: 'also drop the tables', clientRequestId: 'steer-1' }))
        return 'ok'
      })
      await w.attach()
      // The target runs `ask` although its own mode is `full` (a narrowed turn, as an earlier agent's message leaves it).
      await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack', permissionMode: 'ask' })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the held turn')
      expect(w.turnsOf(w.other.id)[0].permissionMode).toBe('ask')
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      expect(seen.steer).toMatchObject({ replayed: false })
      // A person steers the same turn too; their text must not be merged with the agent's.
      w.d.orch.steerActiveTurn('a note from me', w.other.id)
      release.resolve()
      await waitFor(() => w.turnsOf(w.other.id).length === 3, 'the two follow-up turns', 30_000)
      await waitFor(() => w.d.engine.listRuns(w.other.id).every((run) => run.status === 'completed'), 'the follow-ups to finish')
      const followUps = w.turnsOf(w.other.id).slice(1)
      const agentTurn = followUps.find((turn) => turn.prompt.startsWith(AGENT_MESSAGE_PREFIX))!
      const personTurn = followUps.find((turn) => !turn.prompt.startsWith(AGENT_MESSAGE_PREFIX))!
      expect(agentTurn.prompt).toBe(agentMessageText(w.parent.id, 'Parent', 'also drop the tables'))
      expect(agentTurn.permissionMode).toBe('ask')
      expect(agentTurn.fromAgent).toBe(true)
      expect(personTurn.prompt).toBe('a note from me')
      expect(personTurn.permissionMode).toBe('full')
      expect(personTurn.fromAgent).toBeUndefined()
      expect(originOf(w.messages(w.other.id)).map((origin) => origin?.threadId)).toContain(w.parent.id)
      // Every message of the thread that carries the agent's origin is the agent's text, never a person's.
      // The turn never read the steer: it ran as a turn of its own, still showing only the agent's words.
      for (const message of w.messages(w.other.id).filter((entry) => entry.role === 'user' && entry.origin)) expect(agentMessageWords(message.content, message.origin)).toBe('also drop the tables')
      expect(w.messages(w.other.id).filter((entry) => entry.role === 'user' && !entry.origin).every((entry) => !entry.content.includes('drop the tables'))).toBe(true)
    })

    it('a steer that misses its turn and is queued by the effect keeps the sender\'s mode and origin through the queue', async () => {
      const w = asks(async () => 'ok')
      await w.attach()
      const orch = w.d.orch as unknown as { enqueueLateSteer(threadId: string, text: string, carried: undefined, notice: undefined, runId: undefined, origin: unknown, mode: string): void }
      const letter = agentMessage(w.parent.id, 'Parent', 'late guidance')
      const origin = { kind: 'agent', threadId: w.parent.id, runId: 'run:of-the-sender', hops: 1, title: 'Parent', body: { head: letter.head, tail: letter.tail } }
      orch.enqueueLateSteer(w.other.id, letter.text, undefined, undefined, undefined, origin, 'ask')
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the late steer to run')
      expect(w.turnsOf(w.other.id)[0]).toMatchObject({ permissionMode: 'ask', fromAgent: true })
      const stored = w.messages(w.other.id).find((message) => message.origin)!
      expect(stored.origin).toEqual(origin)
      expect(agentMessageWords(stored.content, stored.origin)).toBe('late guidance')
    })

    it('a narrowed turn that queues a message on its own thread queues it narrowed: it runs `ask`, though the thread is `full`', async () => {
      const seen: Record<string, unknown> = {}
      const w = asks(async (input, mcp) => {
        if (input.threadId === w.parent.id) seen.send = parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'queue a command on your own thread' }))
        // The recipient's model, obeying a message from another agent, queues work for itself.
        if (input.threadId === w.other.id && input.prompt.startsWith(AGENT_MESSAGE_PREFIX)) seen.item = parse(await call(mcp!, 'queue_enqueue', { content: 'run the command' }))
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      await waitFor(() => w.turnsOf(w.other.id).length === 2, 'the queued turn', 30_000)
      expect(w.turnsOf(w.other.id)[0].permissionMode).toBe('ask')
      expect(w.turnsOf(w.other.id)[1]).toMatchObject({ prompt: 'run the command', permissionMode: 'ask' })
      // The thread itself is untouched, and a turn of its own still runs as it was set.
      expect(w.d.store.getThread(w.other.id)?.permissionMode).toBe('full')
      await w.d.orch.send('by hand', false, { threadId: w.other.id, clientRequestId: 'hand' })
      await waitFor(() => w.turnsOf(w.other.id).length === 3, 'the turn sent by hand', 30_000)
      expect(w.turnsOf(w.other.id).at(-1)).toMatchObject({ prompt: 'by hand', permissionMode: 'full' })
    })

    it('a person\'s Continue after an agent-narrowed run, and a provider continuation of it, keep the narrowed mode', async () => {
      const seen: Record<string, unknown> = {}
      const w = asks(async (input, mcp) => {
        if (input.threadId === w.parent.id) seen.send = parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'work' }))
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      const sent = seen.send as { runId: string }
      await waitFor(() => w.d.engine.getRun(sent.runId)?.status === 'completed', 'the narrowed run')
      expect(w.d.engine.bindingForRun(sent.runId)?.policy.permissionMode).toBe('ask')
      // Continue (the run this send continues is the narrowed one).
      const continued = await w.d.orch.send({ content: 'continue' }, false, { threadId: w.other.id, clientRequestId: 'continue', continuationOfRunId: sent.runId })
      await waitFor(() => w.d.engine.getRun(continued.runId!)?.status === 'completed', 'the continued run')
      expect(w.d.engine.bindingForRun(continued.runId!)?.policy.permissionMode).toBe('ask')
      // A turn the provider starts itself after the narrowed run: the run that continues it is bound to its mode.
      const providerRun = await w.d.engine.dispatch({ kind: 'send', threadId: w.other.id, clientRequestId: 'provider', source: 'provider-continuation' })
      if (providerRun.status !== 'accepted') throw new Error('send rejected')
      const helper = w.d.orch as unknown as { continuedPermissionMode(runId: string, threadId: string): string | undefined }
      expect(helper.continuedPermissionMode(providerRun.runId, w.other.id)).toBe('ask')
      // A run that continues nothing is not limited by anything but its own thread.
      expect(helper.continuedPermissionMode(sent.runId, w.other.id)).toBeUndefined()
      // And never to a mode a person set after: the thread itself is still `full`.
      expect(w.d.store.getThread(w.other.id)?.permissionMode).toBe('full')
    })

    it('a provider continuation passes over a run refused before it ran: it stays at the mode of the run that did, at most Ask', async () => {
      const seen: Record<string, unknown> = {}
      const w = asks(async (input, mcp) => {
        if (input.threadId === w.parent.id) seen.send = parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'work' }))
        return 'ok'
      })
      await w.attach()
      // A: bound to Ask (an agent narrowed it); it would leave a background task behind.
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      const a = seen.send as { runId: string }
      await waitFor(() => w.d.engine.getRun(a.runId)?.status === 'completed', 'run A')
      expect(w.d.engine.bindingForRun(a.runId)?.policy.permissionMode).toBe('ask')
      // The thread is set to Full access for future work.
      expect(w.d.store.getThread(w.other.id)?.permissionMode).toBe('full')
      // B: a send refused as busy after its run was admitted: cancelled, never bound.
      const b = await w.d.engine.dispatch({ kind: 'send', threadId: w.other.id, clientRequestId: 'refused', source: 'gui' })
      if (b.status !== 'accepted') throw new Error('send rejected')
      w.d.engine.markTerminal(b.runId, 'cancelled', { error: 'cancelled_before_start' })
      expect(w.d.engine.bindingForRun(b.runId)).toBeFalsy()
      // C: the turn A's background task starts.
      const c = await w.d.engine.dispatch({ kind: 'send', threadId: w.other.id, clientRequestId: 'provider-c', source: 'provider-continuation' })
      if (c.status !== 'accepted') throw new Error('send rejected')
      const helper = w.d.orch as unknown as { continuedPermissionMode(runId: string, threadId: string): string | undefined }
      expect(helper.continuedPermissionMode(c.runId, w.other.id)).toBe('ask')
    })

    it('a provider continuation with no earlier run that bound a turn takes the strictest mode', async () => {
      const w = asks(async () => 'ok')
      await w.attach()
      const refused = await w.d.engine.dispatch({ kind: 'send', threadId: w.other.id, clientRequestId: 'refused-only', source: 'gui' })
      if (refused.status !== 'accepted') throw new Error('send rejected')
      w.d.engine.markTerminal(refused.runId, 'cancelled', { error: 'cancelled_before_start' })
      const c = await w.d.engine.dispatch({ kind: 'send', threadId: w.other.id, clientRequestId: 'provider-only', source: 'provider-continuation' })
      if (c.status !== 'accepted') throw new Error('send rejected')
      const helper = w.d.orch as unknown as { continuedPermissionMode(runId: string, threadId: string): string | undefined }
      expect(helper.continuedPermissionMode(c.runId, w.other.id)).toBe('ask')
    })

    it('a recipient that continues a subagent it already had cannot widen the sender\'s mode: the follow-up runs `ask`', async () => {
      const seen: Record<string, unknown> = {}
      const w = asks(async (input, mcp, d) => {
        if (input.threadId === w.parent.id) seen.send = parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'ask your reviewer again' }))
        else if (input.threadId === w.other.id && input.prompt === 'make a reviewer') {
          const started = parse(await call(mcp!, 'delegate_task', { prompt: 'Look', title: 'Reviewer', workspace: 'shared', role: 'research', instanceId: 'claude' })) as { childRunId: string; childThreadId: string }
          seen.child = started
          await waitFor(() => d.engine.getRun(started.childRunId)?.status === 'completed', 'the first task')
        } else if (input.threadId === w.other.id && input.prompt.startsWith(AGENT_MESSAGE_PREFIX)) {
          seen.follow = parse(await call(mcp!, 'continue_subagent', { subagent: 'Reviewer', prompt: 'look again' }))
        }
        return 'ok'
      })
      await w.attach()
      // The recipient made its reviewer in a turn of its own (`full`), before any agent wrote to it.
      await w.d.orch.send('make a reviewer', false, { threadId: w.other.id, clientRequestId: 'make' })
      const child = seen.child as { childRunId: string; childThreadId: string }
      expect(w.d.engine.bindingForRun(child.childRunId)?.policy.permissionMode).toBe('full')
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      await waitFor(() => Boolean(seen.follow), 'the follow-up', 30_000)
      const follow = seen.follow as { childRunId: string; started?: boolean; code?: string }
      expect(follow.code).toBeUndefined()
      await waitFor(() => w.d.engine.getRun(follow.childRunId)?.status === 'completed', 'the follow-up run', 30_000)
      expect(w.d.engine.bindingForRun(follow.childRunId)?.policy.permissionMode).toBe('ask')
      // The reviewer's own setting is not rewritten.
      expect(w.d.store.getThread(child.childThreadId)?.permissionMode).toBe('full')
    })
  })

  describe('a usage pause and the thread\'s waiting work', () => {
    const pause = { reason: 'usage_limit' as const, until: '2099-01-01T00:00:00.000Z', estimated: true, count: 1, autoResume: false }

    it('a message an agent queued before a usage pause stays queued while the thread is paused, and does not cancel the pause; it runs once the pause is over', async () => {
      const w = world(async () => 'ok')
      await w.attach()
      const paused = await w.d.engine.dispatch({ kind: 'send', threadId: w.other.id, clientRequestId: 'paused-run', source: 'gui' })
      if (paused.status !== 'accepted') throw new Error('send rejected')
      w.d.engine.markStarting(paused.runId)
      w.d.engine.markRunning(paused.runId)
      // An agent's message was admitted while the thread was busy, and sits in its queue.
      const item = w.d.orch.enqueueForThread(w.other.id, { content: 'queued by an agent' }, { source: 'mcp', origin: { kind: 'agent', threadId: w.parent.id, runId: 'run:sender', hops: 1 } })
      w.d.engine.pauseRun({ runId: paused.runId, pause })
      const drain = () => (w.d.orch as unknown as { scheduleQueueDrain(session: unknown): void }).scheduleQueueDrain(w.d.orch.getOrCreateSession(w.other.id))
      drain()
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(w.d.engine.getRun(paused.runId)).toMatchObject({ status: 'paused' })
      expect(readDurableQueue(w.d.store, w.other.id).map((entry) => [entry.id, entry.state])).toEqual([[item.id, 'pending']])
      expect(w.turnsOf(w.other.id)).toEqual([])
      // The pause ends (a Stop of the run, here); the held message goes on.
      w.d.engine.endPause(paused.runId, 'cancel')
      drain()
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the queued agent message', 30_000)
      expect(w.turnsOf(w.other.id)[0].prompt).toBe('queued by an agent')
    })

    it('a message an agent queued does not run while a question or an approval waits on the thread, at startup too, and goes on once it is answered', async () => {
      const w = world(async () => 'ok')
      await w.attach()
      const questions = (w.d.orch as unknown as { questions: { requestAnswers(questions: unknown, threadId: string, options: unknown): Promise<unknown>; listPendingForThread(threadId: string): Array<{ requestId: string }>; submitAnswers(requestId: string, answers: unknown): boolean } }).questions
      const asked = questions.requestAnswers([{ id: 'q', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }], w.other.id, {})
      const item = w.d.orch.enqueueForThread(w.other.id, { content: 'queued by an agent' }, { source: 'mcp', origin: { kind: 'agent', threadId: w.parent.id, runId: 'run:sender', hops: 1 } })
      const drain = () => (w.d.orch as unknown as { scheduleQueueDrain(session: unknown): void }).scheduleQueueDrain(w.d.orch.getOrCreateSession(w.other.id))
      drain()
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(w.turnsOf(w.other.id)).toEqual([])
      expect(readDurableQueue(w.d.store, w.other.id).map((entry) => [entry.id, entry.state])).toEqual([[item.id, 'pending']])
      expect(questions.listPendingForThread(w.other.id)).toHaveLength(1)
      questions.submitAnswers(questions.listPendingForThread(w.other.id)[0].requestId, { q: 'a' })
      await asked
      drain()
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the queued agent message', 30_000)
    })
  })

  describe('what an agent\'s send does with the target\'s own chat mode', () => {
    it('a thread whose last message was stored in the retired Plan mode takes the message as an agent turn', async () => {
      const seen: Record<string, unknown> = {}
      const w = world(async (input, mcp) => {
        if (input.threadId === w.parent.id) seen.send = parse(await call(mcp!, 'thread_send', { threadId: w.other.id, content: 'implement it' }))
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send({ content: 'let us plan first', mode: 'plan' }, false, { threadId: w.other.id, clientRequestId: 'plan' })
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      await waitFor(() => w.turnsOf(w.other.id).length === 2, 'the agent message turn')
      expect(w.turnsOf(w.other.id).map((turn) => turn.mode)).toEqual(['agent', 'agent'])
      expect(seen.send).not.toHaveProperty('mode')
    })
  })

  describe('a parent and its own subagent', () => {
    const isChild = (w: { parent: { id: string }; other: { id: string } }, threadId: string) => threadId !== w.parent.id && threadId !== w.other.id

    it('thread_send to your own subagent is a tracked follow-up that shares continue_subagent\'s retry key; search finds the subagent; another thread may not send to it', async () => {
      const seen: Record<string, unknown> = {}
      const w = world(async (input, mcp, d) => {
        if (isChild(w, input.threadId)) return `helper did: ${input.prompt.includes('second job') ? 'second' : 'first'}`
        if (input.threadId === w.other.id) {
          seen.foreign = await call(mcp!, 'thread_send', { threadId: (seen.child as { childThreadId: string }).childThreadId, content: 'do my job instead' })
          return 'tried'
        }
        const child = parse(await call(mcp!, 'delegate_task', { prompt: 'first job', title: 'Helper', workspace: 'shared', role: 'research', instanceId: 'claude' })) as { childRunId: string; childThreadId: string }
        seen.child = child
        await waitFor(() => d.engine.getRun(child.childRunId)?.status === 'completed', 'the first task')
        seen.send = parse(await call(mcp!, 'thread_send', { threadId: child.childThreadId, content: 'second job', clientRequestId: 'next-1' }))
        // The same request under the other name starts nothing new.
        seen.retry = parse(await call(mcp!, 'continue_subagent', { subagent: 'Helper', prompt: 'second job', clientRequestId: 'next-1' }))
        seen.search = parse(await call(mcp!, 'thread_search', { query: 'Helper' }))
        return 'sent'
      })
      await w.attach()
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      const child = seen.child as { childThreadId: string }
      const send = seen.send as { runId: string; subagent: boolean; delegationId: string; title: string }
      expect(send).toMatchObject({ threadId: child.childThreadId, subagent: true, title: 'Helper' })
      expect(seen.retry).toMatchObject({ childRunId: send.runId, delegationId: send.delegationId, replayed: true })
      await waitFor(() => w.d.engine.getRun(send.runId)?.status === 'completed', 'the follow-up')
      // One follow-up turn, tracked as a task of the parent: two tasks in all.
      expect(w.turnsOf(child.childThreadId).filter((turn) => turn.prompt.includes('second job'))).toHaveLength(1)
      expect(w.d.engine.delegations.listForParentThread(w.parent.id)).toHaveLength(2)
      expect(w.d.engine.getRun(send.runId)).toMatchObject({ source: 'delegation' })
      const hits = (seen.search as { results: Array<{ threadId: string; subagent?: boolean; parentThreadId?: string }> }).results
      expect(hits.find((hit) => hit.threadId === child.childThreadId)).toMatchObject({ subagent: true, parentThreadId: w.parent.id })

      await w.d.orch.send('poke', false, { threadId: w.other.id, clientRequestId: 'poke' })
      expect(refusalOfResponse(seen.foreign as Awaited<ReturnType<typeof rpc>>)).toMatchObject({ code: 'mousse_scope_denied', message: expect.stringContaining('only its parent') })
      expect(w.turnsOf(child.childThreadId)).toHaveLength(2)
    })

    it('a parent waiting on its subagent hears the subagent\'s question at once, answers it, and then gets the result (#657)', async () => {
      const seen: Record<string, unknown> = {}
      const w = world(async (input, mcp) => {
        if (isChild(w, input.threadId)) {
          const answer = JSON.parse((await call(mcp!, 'question_ask', { questions: [{ id: 'which', prompt: 'A or B?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] })).result!.content![0].text) as Record<string, unknown>
          return `picked ${String(answer.which)}`
        }
        const child = parse(await call(mcp!, 'delegate_task', { prompt: 'Pick one', title: 'Asker', workspace: 'shared', role: 'research', instanceId: 'claude' })) as { childRunId: string; childThreadId: string }
        const started = Date.now()
        const asked = await call(mcp!, 'thread_wait', { threadId: child.childThreadId, runId: child.childRunId, timeoutMs: 60_000 })
        seen.waitedMs = Date.now() - started
        seen.asked = parse(asked)
        seen.status = parse(await call(mcp!, 'task_status', { subagent: 'Asker' }))
        const requestId = (seen.asked as { pendingRequests: Array<{ requestId: string }> }).pendingRequests[0].requestId
        seen.answer = parse(await call(mcp!, 'answer_subagent', { subagent: 'Asker', requestId, answers: { which: 'b' }, clientRequestId: 'answer-1' }))
        const done = await call(mcp!, 'thread_wait', { threadId: child.childThreadId, runId: child.childRunId, timeoutMs: 60_000 })
        seen.done = parse(done)
        seen.doneBlocks = done.result!.content!.length
        return 'answered'
      })
      await w.attach()
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      expect(seen.waitedMs).toBeLessThan(30_000)
      expect(seen.asked).toMatchObject({
        status: 'needs_input',
        needsInput: true,
        pendingRequests: [{ questions: [expect.objectContaining({ id: 'which', prompt: 'A or B?' })] }],
        hint: expect.stringContaining('answer_subagent')
      })
      expect(seen.status).toMatchObject({ needsInput: true, pendingQuestion: expect.anything() })
      expect(seen.done).toMatchObject({ status: 'finished', resultText: 'picked b' })
      // The result read by the wait is acknowledged: the same response carries no notice repeating it, and no wake turn follows.
      expect(seen.doneBlocks).toBe(1)
      const childResults = w.d.engine.inbox.listForThread(w.parent.id).filter((row) => row.kind === 'child_result')
      expect(childResults.map((row) => row.status)).toEqual(['acknowledged'])
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(w.turnsOf(w.parent.id)).toHaveLength(1)
    })

    it('a busy parent on a runtime that steers by restarting gets its subagent\'s result with its next Mousse tool call, as a separate block, once', async () => {
      const seen: Record<string, Awaited<ReturnType<typeof rpc>>> = {}
      const w = world(async (input, mcp, d) => {
        if (isChild(w, input.threadId)) return 'the zebra report'
        if (input.prompt !== GO) return 'woken'
        const child = parse(await call(mcp!, 'delegate_task', { prompt: 'Report', title: 'Reporter', workspace: 'shared', role: 'research', instanceId: 'claude', wake: 'always' })) as { childRunId: string }
        await waitFor(() => d.engine.getRun(child.childRunId)?.status === 'completed' && d.engine.inbox.listPending(w.parent.id).length === 1, 'the result row')
        seen.first = await call(mcp!, 'list_subagents')
        seen.second = await call(mcp!, 'list_subagents')
        return 'busy work done'
      })
      await w.attach()
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      // The tool's own result stays the first block and parses as before; the notice follows it.
      expect(parse(seen.first)).toMatchObject([expect.objectContaining({ title: 'Reporter' })])
      expect(seen.first.result!.content).toHaveLength(2)
      expect(seen.first.result!.content![1].text.startsWith(BOUNDARY_NOTICE_HEADER)).toBe(true)
      expect(seen.first.result!.content![1].text).toContain('the zebra report')
      expect(seen.second.result!.content).toHaveLength(1)
      // The parent's run read it: acknowledged when the run completed, and no wake turn follows.
      const parentRun = w.latestRun(w.parent.id)
      expect(w.d.engine.getRun(parentRun.runId)?.status).toBe('completed')
      expect(w.d.engine.inbox.listForThread(w.parent.id).map((row) => row.status)).toEqual(['acknowledged'])
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(w.turnsOf(w.parent.id)).toHaveLength(1)
    })
  })
})

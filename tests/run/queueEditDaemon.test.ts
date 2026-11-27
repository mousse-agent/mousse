/**
 * `queue_enqueue`, `queue_edit`, `queue_remove`, `queue_reorder` and `queue_promote_to_steer` end to end
 * (docs/run-engine/SPEC.md §15.1): a real `OrchestratorService`, Run Engine, effect worker and Mousse MCP server, with
 * scripted provider runtimes whose turns call the tools over HTTP. Covers each operation on the caller's own
 * thread and on another's, the queue revision (a stale one is refused and nothing changes), receipts that survive a
 * restart, the mode and origin a queued message keeps through an edit, a reorder and a promotion, and a promotion
 * into a running, paused or replaced run.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readDurableQueue } from '../../src/mms/queue/durableQueue'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import { AGENT_MESSAGE_PREFIX, agentMessageText, TURN_TOKEN_KEY } from '../../src/mms/run/mcp/appTools'
import { AGENT_QUEUE_MAX_PER_SENDER, AGENT_QUEUE_MAX_PER_THREAD } from '../../src/mms/run/mcp/appTools/thread'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import type { ChatMessage, QueuedMessage } from '../../src/shared/types'
import { agentMessageWords } from '../../src/shared/agentMessageWords'
import type { PermissionMode } from '../../src/shared/permissionMode'
import { refusalOfResponse as refusal } from './appToolsFixture'
import { phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'
import { spendChain } from './chainFixture'

vi.setConfig({ testTimeout: 60_000 })

type Mcp = { url: string; token: string; turnToken?: string }
type Script = (input: TurnInput, mcp: Mcp | undefined, d: Phase6Daemon, adapter: VendorAdapter) => Promise<string>
type Response = Awaited<ReturnType<typeof rpc>>

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
const parse = (response: Response): Record<string, unknown> => {
  if (response.error) throw new Error(`rpc error ${response.error.code}: ${response.error.message}`)
  if (response.result?.isError) throw new Error(response.result.content?.[0]?.text ?? 'tool error')
  return JSON.parse(response.result!.content![0].text)
}
/** What a call came to: `ok`, or the reason it was refused (`mousse_scope_denied`, `mousse_conflict`, ...), or `error` for any other error result. */
const verdict = (response: Response): string => {
  if (response.error) return response.error.data?.reason ?? 'error'
  const reason = refusal(response)?.details.reason
  return typeof reason === 'string' ? reason : response.result?.isError ? 'error' : 'ok'
}
const conflictOf = (response: Response): unknown => refusal(response)?.details.conflict

describe('queue tools that change other threads\' queues and the caller\'s own (SPEC §15.1)', () => {
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
  const GO = 'Go'

  /**
   * A daemon whose threads all run on one scripted runtime that talks to the real MCP server. `parent` is the
   * usual caller and `other` the usual target; more threads are made with `thread`.
   */
  const world = (script: Script) => {
    home = mkdtempSync(join(tmpdir(), 'mousse-queue-edit-'))
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
    const server = new MousseMcpServer({ credentials, registry: d.orch.mcpToolRegistry() })
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
    const queue = (threadId: string): QueuedMessage[] => readDurableQueue(d.store, threadId)
    return {
      d, adapter, credentials, server, project, parent, other, thread, events, messages, queue,
      attach: async () => { await server.start(); d.orch.setMcpAttachment(server) },
      turnsOf: (threadId: string) => adapter.turns.filter((turn) => turn.threadId === threadId),
      latestRun: (threadId: string) => d.engine.listRuns(threadId)[0],
      /** A person's typed message on a thread's queue. */
      typed: (threadId: string, content: string) => d.orch.enqueueForThread(threadId, { content }, { source: 'gui' })
    }
  }

  /** The queue of `threadId` as the caller reads it, and its revision. */
  const list = async (mcp: Mcp, threadId?: string) => parse(await call(mcp, 'queue_list', threadId ? { threadId } : {})) as { items: Array<Record<string, unknown>>; claimed: Array<Record<string, unknown>>; revision: string; open: boolean }

  describe('each operation', () => {
    it('on the caller\'s own thread: its own messages and a message a person queued are its to change', async () => {
      const seen: Record<string, Response> = {}
      const ids: Record<string, string> = {}
      const w = world(async (input, mcp, d) => {
        if (input.threadId !== w.parent.id || input.prompt !== GO) return 'ok'
        const own = parse(await call(mcp!, 'queue_enqueue', { content: 'my own note' })) as { item: { id: string }; revision: string }
        ids.own = own.item.id
        ids.person = w.typed(w.parent.id, 'typed by the user').id
        let rev = (await list(mcp!)).revision
        seen.editOwn = await call(mcp!, 'queue_edit', { itemId: ids.own, content: 'my own note, v2', expectedRevision: rev })
        rev = (await list(mcp!)).revision
        seen.editPerson = await call(mcp!, 'queue_edit', { itemId: ids.person, content: 'the agent rewrote this', expectedRevision: rev })
        rev = (await list(mcp!)).revision
        seen.reorder = await call(mcp!, 'queue_reorder', { orderedIds: [ids.person, ids.own], expectedRevision: rev })
        rev = (await list(mcp!)).revision
        seen.promote = await call(mcp!, 'queue_promote_to_steer', { itemId: ids.person, expectedRevision: rev, expectedRunId: d.engine.getActiveRun(w.parent.id)!.runId })
        rev = (await list(mcp!)).revision
        seen.removeOwn = await call(mcp!, 'queue_remove', { itemId: ids.own, expectedRevision: rev })
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })

      expect(verdict(seen.editOwn)).toBe('ok')
      expect(verdict(seen.editPerson)).toBe('ok')
      expect(verdict(seen.reorder)).toBe('ok')
      expect(verdict(seen.promote)).toBe('ok')
      expect(verdict(seen.removeOwn)).toBe('ok')
      const actions = w.events(w.parent.id, 'agent.action').map((event) => (event.payload as { action: string }).action)
      // Changes to a message the agent wrote itself leave no audit row (a removal always does, with the removed text); a change
      // to a person's message always does. The agent rewrote the person's message first, so it is the agent's own then.
      expect(actions).toEqual(['edited_queued_message', 'removed_queued_message'])
      const edited = parse(seen.promote) as { outcome: string }
      expect(edited.outcome).toBe('promoted')
      const stored = w.messages(w.parent.id).find((message) => message.steered)
      expect(stored?.content).toBe(agentMessageText(w.parent.id, 'Parent', 'the agent rewrote this'))
    })

    it('on another thread: it reads the text and does all five, each recorded on that thread', async () => {
      const release = deferred()
      const seen: Record<string, Response> = {}
      const ids: Record<string, string> = {}
      const w = world(async (input, mcp, d, adapter) => {
        if (input.prompt === 'hold') {
          await adapter.hold(input, release.promise)
          return 'held'
        }
        if (input.threadId !== w.parent.id) return 'ok'
        const revision = async () => (parse(await call(mcp!, 'queue_list', { threadId: w.other.id })) as { revision: string }).revision
        seen.list = await call(mcp!, 'queue_list', { threadId: w.other.id })
        const rev = revision
        seen.enqueue = await call(mcp!, 'queue_enqueue', { threadId: w.other.id, content: 'a note from me', expectedRevision: await rev() })
        const queued = (parse(seen.enqueue) as { item: { id: string } }).item.id
        seen.edit = await call(mcp!, 'queue_edit', { threadId: w.other.id, itemId: ids.one, content: 'reworded', expectedRevision: await rev() })
        seen.reorder = await call(mcp!, 'queue_reorder', { threadId: w.other.id, orderedIds: [ids.two, ids.one, queued], expectedRevision: await rev() })
        seen.promote = await call(mcp!, 'queue_promote_to_steer', { threadId: w.other.id, itemId: ids.two, expectedRevision: await rev(), expectedRunId: d.engine.getActiveRun(w.other.id)!.runId })
        seen.remove = await call(mcp!, 'queue_remove', { threadId: w.other.id, itemId: ids.one, expectedRevision: await rev() })
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the held turn')
      ids.one = w.typed(w.other.id, 'typed one').id
      ids.two = w.typed(w.other.id, 'typed two').id
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })

      for (const name of ['list', 'enqueue', 'edit', 'reorder', 'promote', 'remove']) expect(verdict(seen[name]), name).toBe('ok')
      expect((parse(seen.list) as { items: Array<{ content: string }> }).items.map((item) => item.content)).toEqual(['typed one', 'typed two'])
      expect(w.events(w.other.id, 'agent.action').map((event) => (event.payload as { action: string }).action)).toEqual([
        'queued_message', 'edited_queued_message', 'reordered_queue', 'promoted_queued_message', 'removed_queued_message'
      ])
      expect(w.messages(w.other.id).filter((message) => message.role === 'system' && message.content.startsWith('Changed by an agent')).map((message) => message.content)).toHaveLength(5)
      release.resolve()
    })
  })

  describe('the queue revision', () => {
    it('refuses every command that names a revision the queue has moved past, and nothing changes: no event, no journal entry, no cancelled run', async () => {
      const release = deferred()
      const seen: Record<string, Response> = {}
      const ids: Record<string, string> = {}
      const w = world(async (input, mcp, d, adapter) => {
        if (input.prompt === 'hold') {
          await adapter.hold(input, release.promise)
          return 'held'
        }
        if (input.threadId !== w.parent.id) return 'ok'
        const stale = (await list(mcp!, w.other.id)).revision
        // Someone (a person, by hand) changes the queue after the agent read it.
        ids.late = w.typed(w.other.id, 'typed after you read').id
        seen.revision = await call(mcp!, 'queue_list', { threadId: w.other.id })
        const to = { threadId: w.other.id, expectedRevision: stale }
        seen.enqueue = await call(mcp!, 'queue_enqueue', { ...to, content: 'x' })
        seen.edit = await call(mcp!, 'queue_edit', { ...to, itemId: ids.one, content: 'x' })
        seen.reorder = await call(mcp!, 'queue_reorder', { ...to, orderedIds: [ids.two, ids.one, ids.late] })
        seen.remove = await call(mcp!, 'queue_remove', { ...to, itemId: ids.one })
        seen.promote = await call(mcp!, 'queue_promote_to_steer', { ...to, itemId: ids.one, expectedRunId: d.engine.getActiveRun(w.other.id)!.runId })
        seen.fresh = await call(mcp!, 'queue_edit', { threadId: w.other.id, itemId: ids.one, content: 'now with the current revision', expectedRevision: (parse(seen.revision) as { revision: string }).revision })
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the held turn')
      ids.one = w.typed(w.other.id, 'typed one').id
      ids.two = w.typed(w.other.id, 'typed two').id
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })

      const current = (parse(seen.revision) as { revision: string }).revision
      for (const name of ['enqueue', 'edit', 'reorder', 'remove', 'promote']) {
        expect(refusal(seen[name]), name).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'revision_mismatch', revision: current } })
        expect(refusal(seen[name])!.details.expectedRevision, name).not.toBe(current)
      }
      // Only the fresh edit reached the queue, with its own journal entry and event.
      expect(verdict(seen.fresh)).toBe('ok')
      expect(w.queue(w.other.id).map((item) => [item.id, item.content, item.state])).toEqual([
        [ids.one, agentMessageText(w.parent.id, 'Parent', 'now with the current revision'), 'pending'],
        [ids.two, 'typed two', 'pending'],
        [ids.late, 'typed after you read', 'pending']
      ])
      expect(w.d.engine.store.db.statement('SELECT COUNT(*) AS n FROM queue_commands').get()).toEqual({ n: 1 })
      expect(w.events(w.other.id, 'agent.action')).toHaveLength(1)
      release.resolve()
    })

    it('two commands that name the same revision: exactly one wins, the other is told the queue changed', async () => {
      const release = deferred()
      const seen: Response[] = []
      const ids: Record<string, string> = {}
      const w = world(async (input, mcp, _d, adapter) => {
        if (input.prompt === 'hold') {
          await adapter.hold(input, release.promise)
          return 'held'
        }
        if (input.threadId !== w.parent.id) return 'ok'
        const { revision } = await list(mcp!, w.other.id)
        seen.push(...await Promise.all([
          call(mcp!, 'queue_edit', { threadId: w.other.id, itemId: ids.one, content: 'first writer', expectedRevision: revision }),
          call(mcp!, 'queue_edit', { threadId: w.other.id, itemId: ids.two, content: 'second writer', expectedRevision: revision })
        ]))
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the held turn')
      ids.one = w.typed(w.other.id, 'typed one').id
      ids.two = w.typed(w.other.id, 'typed two').id
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      expect(seen.map(verdict).sort()).toEqual(['mousse_conflict', 'ok'])
      expect(w.queue(w.other.id).filter((item) => item.origin?.kind === 'agent')).toHaveLength(1)
      release.resolve()
    })

    it('the protocol edit, remove, reorder and promote take the same revision, and queue.list hands it out', async () => {
      const w = world(async () => 'ok')
      await w.attach()
      const a = w.typed(w.other.id, 'a')
      const b = w.typed(w.other.id, 'b')
      const { revision } = w.d.orch.queueSnapshot(w.other.id)
      w.typed(w.other.id, 'c')
      const stale = { expectedRevision: revision }
      expect(() => w.d.orch.editQueuedItem(w.other.id, a.id, { content: 'a2' }, stale)).toThrow(expect.objectContaining({ code: 'revision_mismatch' }))
      expect(() => w.d.orch.removeQueuedItem(w.other.id, a.id, stale)).toThrow(expect.objectContaining({ code: 'revision_mismatch' }))
      expect(() => w.d.orch.reorderQueue(w.other.id, [b.id, a.id], stale)).toThrow(expect.objectContaining({ code: 'revision_mismatch' }))
      expect(() => w.d.orch.promoteQueueItemToSteer(w.other.id, a.id, stale)).toThrow(expect.objectContaining({ code: 'revision_mismatch' }))
      expect(w.queue(w.other.id).map((item) => item.content)).toEqual(['a', 'b', 'c'])
      const now = w.d.orch.queueSnapshot(w.other.id)
      expect(now).toMatchObject({ open: true, items: expect.any(Array), claimed: [] })
      expect(w.d.orch.editQueuedItem(w.other.id, a.id, { content: 'a2' }, { expectedRevision: now.revision }).content).toBe('a2')
    })
  })

  describe('receipts', () => {
    it('a retry with the same clientRequestId returns the first result whatever the queue looks like now, and records the change once', async () => {
      const release = deferred()
      const seen: Record<string, Response> = {}
      const ids: Record<string, string> = {}
      const w = world(async (input, mcp, _d, adapter) => {
        if (input.prompt === 'hold') {
          await adapter.hold(input, release.promise)
          return 'held'
        }
        if (input.threadId !== w.parent.id) return 'ok'
        const { revision } = await list(mcp!, w.other.id)
        seen.first = await call(mcp!, 'queue_edit', { threadId: w.other.id, itemId: ids.one, content: 'edited once', expectedRevision: revision, clientRequestId: 'edit-1' })
        // The queue moves on (the item is removed), and the model retries the call it never saw the answer to.
        const after = (await list(mcp!, w.other.id)).revision
        seen.remove = await call(mcp!, 'queue_remove', { threadId: w.other.id, itemId: ids.one, expectedRevision: after })
        seen.retry = await call(mcp!, 'queue_edit', { threadId: w.other.id, itemId: ids.one, content: 'edited once', expectedRevision: revision, clientRequestId: 'edit-1' })
        // The same key for another command is a mistake of the caller, not a retry.
        seen.reused = await call(mcp!, 'queue_remove', { threadId: w.parent.id, itemId: ids.one, expectedRevision: revision, clientRequestId: 'edit-1' })
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the held turn')
      ids.one = w.typed(w.other.id, 'typed one').id
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })

      expect(verdict(seen.first)).toBe('ok')
      expect(verdict(seen.remove)).toBe('ok')
      expect(parse(seen.retry)).toMatchObject({ outcome: 'edited', itemId: ids.one, replayed: true, effectsSettled: true })
      expect(parse(seen.retry).revision).toBe(parse(seen.first).revision)
      expect(w.queue(w.other.id)).toEqual([])
      // One edit, one removal: nothing was recorded twice.
      expect(w.events(w.other.id, 'agent.action').map((event) => (event.payload as { action: string }).action)).toEqual(['edited_queued_message', 'removed_queued_message'])
      // The retry is still a call in the caller's ledger.
      expect(w.d.engine.tools.listForRun(w.latestRun(w.parent.id).runId).filter((entry) => entry.tool === 'queue_edit')).toHaveLength(2)
      release.resolve()
    })

    it('survive a daemon restart: a finished command replays its result, and one a crash cut short is finished from its journal entry alone', async () => {
      const w = world(async () => 'ok')
      const actor = { kind: 'agent' as const, threadId: w.parent.id, runId: 'run:caller', toolCallId: 'mcp:t1' }
      const a = w.typed(w.other.id, 'typed a')
      const b = w.typed(w.other.id, 'typed b')
      const command = (host: ReturnType<typeof w.d.orch.mcpToolHost>, key: string, content: string, itemId: string) =>
        host.queueCommand!(w.other.id, { op: 'edit', itemId, content, expectedRevision: host.queueSnapshot!(w.other.id).revision }, { clientRequestId: key, actor })
      const first = command(w.d.orch.mcpToolHost(), 'queue_edit:caller:1', 'a, rewritten', a.id)
      expect(first).toMatchObject({ outcome: 'edited', itemId: a.id, replayed: false, effectsSettled: true })

      // The daemon dies after the journal entry of a second command and before the queue file changed.
      const save = vi.spyOn(w.d.store, 'saveMessageQueue').mockImplementationOnce(() => { throw new Error('the daemon died here') })
      expect(() => command(w.d.orch.mcpToolHost(), 'queue_edit:caller:2', 'b, rewritten', b.id)).toThrow(/died here/)
      save.mockRestore()
      expect(w.queue(w.other.id).find((item) => item.id === b.id)?.content).toBe('typed b')
      expect(w.d.engine.store.db.statement("SELECT status FROM queue_commands WHERE command_key = 'queue_edit:caller:2'").get()).toEqual({ status: 'pending' })
      await w.d.crash()

      const d2 = phase6Daemon(home!, [w.adapter])
      stops.push(async () => { await d2.stop() })
      d2.orch.recoverQueueCommandsOnBoot()
      // Finished by the boot, from the entry alone: the edit is in the file, with who made it and the limit it carries.
      const recovered = readDurableQueue(d2.store, w.other.id).find((item) => item.id === b.id)!
      expect(recovered).toMatchObject({ content: agentMessageText(w.parent.id, 'Parent', 'b, rewritten'), origin: { kind: 'agent', threadId: w.parent.id, title: 'Parent' }, permissionMode: 'ask' })
      // The edit's origin says where the agent's words are, so the chat shows them without the label.
      expect(agentMessageWords(recovered.content, recovered.origin)).toBe('b, rewritten')
      expect(d2.engine.store.db.statement("SELECT status FROM queue_commands WHERE command_key = 'queue_edit:caller:2'").get()).toEqual({ status: 'applied' })

      // The retries, with other arguments, return what the commands did; neither changes the queue again.
      const host2 = d2.orch.mcpToolHost()
      expect(command(host2, 'queue_edit:caller:1', 'a, rewritten', a.id)).toMatchObject({ outcome: 'edited', itemId: a.id, replayed: true, revision: first.revision })
      expect(command(host2, 'queue_edit:caller:2', 'b, rewritten', b.id)).toMatchObject({ outcome: 'edited', itemId: b.id, replayed: true })
      // The same key with other fields is a mistake, not a retry: nothing is replayed and nothing changes.
      expect(() => command(host2, 'queue_edit:caller:1', 'something else entirely', a.id)).toThrow(expect.objectContaining({ code: 'request_conflict' }))
      expect(() => command(host2, 'queue_edit:caller:1', 'a, rewritten', b.id)).toThrow(expect.objectContaining({ code: 'request_conflict' }))
      expect(readDurableQueue(d2.store, w.other.id).map((item) => item.content)).toEqual([
        agentMessageText(w.parent.id, 'Parent', 'a, rewritten'),
        agentMessageText(w.parent.id, 'Parent', 'b, rewritten')
      ])
    })

    it('an enqueue that a crash cut short still replays its original item, from the journal, after the queue was drained', async () => {
      const w = world(async () => 'ok')
      const actor = { kind: 'agent' as const, threadId: w.parent.id, runId: 'run:caller', toolCallId: 'mcp:t1' }
      const host = w.d.orch.mcpToolHost()
      const save = vi.spyOn(w.d.store, 'saveMessageQueue').mockImplementationOnce(() => { throw new Error('the daemon died here') })
      expect(() => host.queueCommand!(w.other.id, { op: 'enqueue', content: 'remember this', mode: 'agent', expectedRevision: host.queueSnapshot!(w.other.id).revision }, { clientRequestId: 'queue_enqueue:caller:1', actor })).toThrow(/died here/)
      save.mockRestore()
      expect(w.queue(w.other.id)).toEqual([])
      await w.d.crash()

      const d2 = phase6Daemon(home!, [w.adapter])
      stops.push(async () => { await d2.stop() })
      d2.orch.recoverQueueCommandsOnBoot()
      const item = readDurableQueue(d2.store, w.other.id)
      expect(item).toHaveLength(1)
      expect(item[0]).toMatchObject({ source: 'mcp', permissionMode: 'ask', origin: { kind: 'agent', threadId: w.parent.id } })
      expect(item[0].content).toBe(agentMessageText(w.parent.id, 'Parent', 'remember this'))
      // A retry (a second daemon is the same caller) returns that very item, however the arguments are retyped.
      const again = d2.orch.mcpToolHost().queueCommand!(w.other.id, { op: 'enqueue', content: 'remember this', mode: 'agent', expectedRevision: 'whatever' }, { clientRequestId: 'queue_enqueue:caller:1', actor })
      expect(again).toMatchObject({ replayed: true, outcome: 'enqueued', item: { id: item[0].id } })
      expect(() => d2.orch.mcpToolHost().queueCommand!(w.other.id, { op: 'enqueue', content: 'retyped', mode: 'agent', expectedRevision: 'whatever' }, { clientRequestId: 'queue_enqueue:caller:1', actor })).toThrow(expect.objectContaining({ code: 'request_conflict' }))
      expect(readDurableQueue(d2.store, w.other.id)).toHaveLength(1)
    })
  })

  describe('mode and origin', () => {
    /** `other` is stored `full`; the two callers run `ask` and `full`. */
    const callers = (script: Script) => {
      const w = world(script)
      const askCaller = w.thread('Ask caller', 'ask')
      const fullCaller = w.thread('Full caller', 'full')
      const target = w.thread('Full target', 'full')
      return { w, askCaller, fullCaller, target }
    }
    const hold = async (w: ReturnType<typeof world>, threadId: string) => {
      await w.d.orch.send('hold', false, { threadId, clientRequestId: `hold-${threadId}`, awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(threadId).length === 1, 'the held turn')
    }

    it('a queued agent message keeps its sender and mode limit through a reorder; a person\'s edit makes it the person\'s, another agent\'s edit makes it that agent\'s, never under a looser mode; it runs under the limit it carries', async () => {
      const release = deferred()
      const seen: Record<string, Response> = {}
      const ids: Record<string, string> = {}
      const c = callers(async (input, mcp, _d, adapter) => {
        if (input.prompt === 'hold') {
          await adapter.hold(input, release.promise)
          return 'held'
        }
        if (input.prompt !== GO) return 'ok'
        const rev = async () => (await list(mcp!, c.target.id)).revision
        if (input.threadId === c.askCaller.id) {
          seen.enqueue = await call(mcp!, 'queue_enqueue', { threadId: c.target.id, content: 'run the migration', expectedRevision: await rev() })
          ids.item = (parse(seen.enqueue) as { item: { id: string } }).item.id
          seen.plan = await call(mcp!, 'queue_enqueue', { threadId: c.target.id, content: 'only plan the cleanup', mode: 'plan', expectedRevision: await rev() })
          ids.plan = (parse(seen.plan) as { item: { id: string } }).item.id
        }
        if (input.threadId === c.fullCaller.id) {
          seen.reorder = await call(mcp!, 'queue_reorder', { threadId: c.target.id, orderedIds: [ids.plan, ids.item], expectedRevision: await rev() })
          // Another writer cannot turn a plan turn into an agent turn.
          seen.widen = await call(mcp!, 'queue_edit', { threadId: c.target.id, itemId: ids.plan, mode: 'agent', expectedRevision: await rev() })
          seen.edit = await call(mcp!, 'queue_edit', { threadId: c.target.id, itemId: ids.item, content: 'run the migration, and drop the old tables', expectedRevision: await rev() })
        }
        return 'ok'
      })
      const { w, askCaller, fullCaller, target } = c
      await w.attach()
      await hold(w, target.id)
      const heldRun = w.latestRun(target.id)

      await w.d.orch.send(GO, false, { threadId: askCaller.id, clientRequestId: 'go-ask' })
      const queued = w.queue(target.id).find((item) => item.id === ids.item)!
      expect(queued).toMatchObject({ source: 'mcp', permissionMode: 'ask', origin: { kind: 'agent', threadId: askCaller.id, hops: 1 } })
      expect(queued.content).toBe(agentMessageText(askCaller.id, 'Ask caller', 'run the migration'))
      expect(agentMessageWords(queued.content, queued.origin)).toBe('run the migration')

      // A person's new words make it the person's message: no agent origin (so no hop, no hold, no clearing by a Stop), but the
      // limit it carried stays.
      const edited = w.d.orch.editQueuedItem(target.id, ids.item, { content: 'run the migration, and keep a backup' })
      expect(edited).toMatchObject({ content: 'run the migration, and keep a backup', permissionMode: 'ask' })
      expect(edited.origin).toBeUndefined()
      expect(w.queue(target.id).find((item) => item.id === ids.item)?.origin).toBeUndefined()

      await w.d.orch.send(GO, false, { threadId: fullCaller.id, clientRequestId: 'go-full' })
      expect(verdict(seen.reorder)).toBe('ok')
      expect(verdict(seen.widen)).toBe('mousse_scope_denied')
      expect(verdict(seen.edit)).toBe('ok')
      const rewritten = w.queue(target.id).find((item) => item.id === ids.item)!
      // The words are the full-mode agent's now, said so on the message; the limit is the stricter of the two, and it only tightens.
      expect(rewritten.content).toBe(agentMessageText(fullCaller.id, 'Full caller', 'run the migration, and drop the old tables'))
      expect(rewritten).toMatchObject({ permissionMode: 'ask', origin: { kind: 'agent', threadId: fullCaller.id, hops: 1, title: 'Full caller' } })
      expect(agentMessageWords(rewritten.content, rewritten.origin)).toBe('run the migration, and drop the old tables')
      // The plan turn is still a plan turn from the ask agent; the reorder changed the order and nothing else.
      expect(w.queue(target.id).map((item) => item.id)).toEqual([ids.plan, ids.item])
      expect(w.queue(target.id)[0]).toMatchObject({ mode: 'plan', permissionMode: 'ask', origin: { kind: 'agent', threadId: askCaller.id } })

      release.resolve()
      await waitFor(() => w.turnsOf(target.id).length === 3, 'both queued turns', 30_000)
      // Each runs as its sender's, under the limit it carries though the thread is `full`.
      expect(w.turnsOf(target.id).slice(1)).toEqual([
        expect.objectContaining({ prompt: agentMessageText(askCaller.id, 'Ask caller', 'only plan the cleanup'), mode: 'plan', permissionMode: 'ask', fromAgent: true }),
        expect.objectContaining({ prompt: rewritten.content, permissionMode: 'ask', fromAgent: true })
      ])
      await waitFor(() => w.d.engine.listRuns(target.id).every((run) => run.status === 'completed'), 'the runs')
      const runs = w.d.engine.listRuns(target.id).sort((a, b) => a.ordinal - b.ordinal)
      expect(runs[0].runId).toBe(heldRun.runId)
      // The run an agent's queued message became counts toward the chain of agent messages, as one sent directly does.
      expect(runs.slice(1).map((run) => [run.outcome?.sentByAgent, run.outcome?.agentHops])).toEqual([[true, 1], [true, 1]])
      expect(w.messages(target.id).filter((message) => message.origin).map((message) => message.origin)).toEqual([
        expect.objectContaining({ threadId: askCaller.id }),
        expect.objectContaining({ threadId: fullCaller.id })
      ])
    })

    it('an agent that edits a message a person queued makes it the agent\'s own words under the agent\'s mode: the person\'s limit-free message cannot launder the agent\'s edit', async () => {
      const release = deferred()
      const seen: Record<string, Response> = {}
      const ids: Record<string, string> = {}
      const c = callers(async (input, mcp, _d, adapter) => {
        if (input.prompt === 'hold') {
          await adapter.hold(input, release.promise)
          return 'held'
        }
        if (input.threadId === c.askCaller.id && input.prompt === GO)
          seen.edit = await call(mcp!, 'queue_edit', { threadId: c.target.id, itemId: ids.typed, content: 'actually, wipe it', expectedRevision: (await list(mcp!, c.target.id)).revision })
        return 'ok'
      })
      const { w, askCaller, target } = c
      await w.attach()
      await hold(w, target.id)
      ids.typed = w.typed(target.id, 'tidy the logs').id
      await w.d.orch.send(GO, false, { threadId: askCaller.id, clientRequestId: 'go-ask' })
      expect(verdict(seen.edit)).toBe('ok')
      expect(w.queue(target.id)[0]).toMatchObject({
        content: agentMessageText(askCaller.id, 'Ask caller', 'actually, wipe it'),
        permissionMode: 'ask',
        origin: { kind: 'agent', threadId: askCaller.id }
      })
      expect(w.events(target.id, 'agent.action')).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ action: 'edited_queued_message', actorThreadId: askCaller.id, itemId: ids.typed, wasOrigin: 'gui' }) })
      ])
      release.resolve()
      await waitFor(() => w.turnsOf(target.id).length === 2, 'the edited message to run', 30_000)
      expect(w.turnsOf(target.id)[1]).toMatchObject({ permissionMode: 'ask', fromAgent: true })
    })

    it('an agent cannot change a scheduled prompt: it keeps the text of its job', async () => {
      const seen: Record<string, Response> = {}
      const ids: Record<string, string> = {}
      const w = world(async (input, mcp) => {
        if (input.threadId !== w.parent.id || input.prompt !== GO) return 'ok'
        seen.schedule = await call(mcp!, 'queue_edit', { itemId: ids.schedule, content: 'mine now', expectedRevision: (await list(mcp!)).revision })
        return 'ok'
      })
      await w.attach()
      // The parent's own queue while it runs: a scheduled prompt.
      w.d.orch.bindThread(w.parent.id, [], undefined, [])
      const scheduled = w.d.orch.enqueueForThread(w.parent.id, { content: 'nightly report' }, { source: 'schedule', origin: { kind: 'schedule', jobId: 'job-1', occurrenceKey: 'k-1' } })
      ids.schedule = scheduled.id
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      // Refused as a message that cannot be edited.
      expect(verdict(seen.schedule)).toBe('error')
      expect(seen.schedule.result?.content?.[0].text).toMatch(/scheduled prompt/)
      // Nothing was edited: the prompt was queued behind the turn, and ran as it was.
      await waitFor(() => w.turnsOf(w.parent.id).length === 2, 'the queued turn', 30_000)
      expect(w.turnsOf(w.parent.id)[1].prompt).toBe('nightly report')
    })
  })

  describe('a promotion into a running, paused or replaced run', () => {
    /** Four threads: callers that run `ask` and `full`, and held targets that run `ask` and `full`. */
    const rig = async (script: (input: TurnInput, mcp: Mcp | undefined, d: Phase6Daemon, adapter: VendorAdapter, t: { release: ReturnType<typeof deferred> }) => Promise<string>) => {
      const release = deferred()
      const w = world((input, mcp, d, adapter) => script(input, mcp, d, adapter, { release }))
      const askCaller = w.thread('Ask caller', 'ask')
      const fullCaller = w.thread('Full caller', 'full')
      const askTarget = w.thread('Ask target', 'ask')
      const fullTarget = w.thread('Full target', 'full')
      await w.attach()
      for (const target of [askTarget, fullTarget]) {
        await w.d.orch.send('hold', false, { threadId: target.id, clientRequestId: `hold-${target.id}`, awaitMode: 'ack' })
        await waitFor(() => w.turnsOf(target.id).length === 1, 'a held turn')
      }
      return { w, release, askCaller, fullCaller, askTarget, fullTarget }
    }

    it('joins the run it was checked against: the caller\'s mode may not be stricter than the run\'s, nor the message\'s own limit; a refused promotion changes nothing', async () => {
      const seen: Record<string, Response> = {}
      const ids: Record<string, string> = {}
      const r = await rig(async (input, mcp, d, adapter, { release }) => {
        if (input.prompt === 'hold') {
          await adapter.hold(input, release.promise)
          return 'held'
        }
        if (input.prompt !== GO) return 'ok'
        const promote = async (threadId: string, itemId: string) =>
          call(mcp!, 'queue_promote_to_steer', { threadId, itemId, expectedRevision: (await list(mcp!, threadId)).revision, expectedRunId: d.engine.getActiveRun(threadId)!.runId })
        if (input.threadId === r.askCaller.id) {
          seen.askIntoFull = await promote(r.fullTarget.id, ids.typedFull)
          seen.askIntoAsk = await promote(r.askTarget.id, ids.typedAsk)
        }
        if (input.threadId === r.fullCaller.id) {
          // A message an ask agent wrote carries its limit: a full run would read it with more authority than its writer has.
          seen.limitedIntoFull = await promote(r.fullTarget.id, ids.agentWritten)
          seen.fullIntoAsk = await promote(r.askTarget.id, ids.typedAsk)
        }
        return 'ok'
      })
      const { w, askCaller, fullCaller, askTarget, fullTarget } = r
      ids.typedFull = w.typed(fullTarget.id, 'typed for the full run').id
      ids.typedAsk = w.typed(askTarget.id, 'typed for the ask run').id
      ids.agentWritten = w.d.orch.enqueueForThread(fullTarget.id, { content: 'written by an ask agent' }, { source: 'mcp', permissionMode: 'ask', origin: { kind: 'agent', threadId: askCaller.id, runId: 'run:ask', hops: 1 } }).id
      const fullRun = w.latestRun(fullTarget.id)
      const askRun = w.latestRun(askTarget.id)
      expect(w.d.engine.bindingForRun(fullRun.runId)?.policy.permissionMode).toBe('full')
      expect(w.d.engine.bindingForRun(askRun.runId)?.policy.permissionMode).toBe('ask')

      await w.d.orch.send(GO, false, { threadId: askCaller.id, clientRequestId: 'go-ask' })
      expect(refusal(seen.askIntoFull)).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'ceiling_exceeded', callerMode: 'ask', targetMode: 'full' } })
      // The ask caller's own mode is no bar to a run that is as strict.
      expect(parse(seen.askIntoAsk)).toMatchObject({ outcome: 'promoted', itemId: ids.typedAsk })
      await w.d.orch.send(GO, false, { threadId: fullCaller.id, clientRequestId: 'go-full' })
      expect(refusal(seen.limitedIntoFull)).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'ceiling_exceeded', callerMode: 'ask', targetMode: 'full' } })
      // The message is promoted already (the ask agent did it); the full caller finds it steering.
      expect(refusal(seen.fullIntoAsk)).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'item_steering' } })

      // The refused ones are exactly as they were: pending, no run bound, nothing cancelled, nothing recorded.
      expect(w.queue(fullTarget.id).map((item) => [item.id, item.state, item.intent, item.steerRunId])).toEqual([
        [ids.typedFull, 'pending', 'normal', undefined],
        [ids.agentWritten, 'pending', 'normal', undefined]
      ])
      expect(w.events(fullTarget.id, 'agent.action')).toEqual([])
      // The accepted one is steering, bound to the run it was checked against, and its text reached that run.
      expect(w.queue(askTarget.id)).toEqual([expect.objectContaining({ id: ids.typedAsk, state: 'steering', intent: 'steer', steerRunId: askRun.runId })])
      const ctl = w.adapter.controls.get(askRun.runId)!
      const drained = ctl.drainSteerEntry?.()
      expect(drained?.text).toBe('typed for the ask run')
      expect(w.d.orch.getOrCreateSession(askTarget.id).drainedExternalSteerIds.has(ids.typedAsk)).toBe(true)
      // The person's own promotion of the agent-written message is held to the same limit.
      expect(() => w.d.orch.promoteQueueItemToSteer(fullTarget.id, ids.agentWritten)).toThrow(expect.objectContaining({ code: 'ceiling_exceeded', details: expect.objectContaining({ callerMode: 'ask', targetMode: 'full' }) }))
      r.release.resolve()
    })

    it('a run that ended with another one active now is a conflict naming the active run, and the message stays where it was', async () => {
      const seen: Record<string, Response> = {}
      const ids: Record<string, string> = {}
      const gates = { a: deferred(), b: deferred() }
      const w = world(async (input, mcp, d, adapter) => {
        if (input.prompt === 'A') {
          await adapter.hold(input, gates.a.promise)
          return 'A done'
        }
        if (input.prompt === 'B') {
          await adapter.hold(input, gates.b.promise)
          return 'B done'
        }
        if (input.prompt !== GO) return 'ok'
        const revision = async () => (await list(mcp!, w.other.id)).revision
        const aRunId = ids.a
        // The caller read run A as the active one; A ends and B starts before it acts. It has read the queue again
        // since (B left it when it started), so only the run it names is out of date.
        gates.a.resolve()
        await waitFor(() => d.engine.getRun(aRunId)?.status === 'completed' && d.engine.getActiveRun(w.other.id)?.runId !== undefined, 'B to become active')
        seen.replaced = await call(mcp!, 'queue_promote_to_steer', { threadId: w.other.id, itemId: ids.item, expectedRevision: await revision(), expectedRunId: aRunId })
        return 'ok'
      })
      await w.attach()
      const a = await w.d.orch.send('A', false, { threadId: w.other.id, clientRequestId: 'run-a', awaitMode: 'ack' })
      ids.a = a.runId!
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'run A')
      // B is queued behind A, with the message after it in the queue: B starts when A ends, the message stays.
      const b = await w.d.orch.send('B', false, { threadId: w.other.id, clientRequestId: 'run-b', awaitMode: 'ack' })
      ids.item = w.typed(w.other.id, 'typed note').id
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      expect(refusal(seen.replaced)).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'run_not_active', expectedRunId: a.runId, activeRunId: b.runId } })
      // The message is where it was, and run B (now active) never saw it.
      expect(w.queue(w.other.id).find((item) => item.id === ids.item)).toMatchObject({ state: 'pending', intent: 'normal' })
      expect(w.events(w.other.id, 'agent.action')).toEqual([])
      expect(w.d.engine.getActiveRun(w.other.id)?.runId).toBe(b.runId)
      gates.b.resolve()
    })

    it('a paused run is not a run to steer: the message stays queued and the tool says the run is paused', async () => {
      const seen: Record<string, Response> = {}
      const ids: Record<string, string> = {}
      const w = world(async (input, mcp) => {
        if (input.threadId !== w.parent.id) return 'ok'
        seen.paused = await call(mcp!, 'queue_promote_to_steer', { threadId: w.other.id, itemId: ids.item, expectedRevision: (await list(mcp!, w.other.id)).revision, expectedRunId: ids.run })
        return 'ok'
      })
      await w.attach()
      const sent = await w.d.engine.dispatch({ kind: 'send', threadId: w.other.id, clientRequestId: 'paused-run', source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      w.d.engine.markStarting(sent.runId)
      w.d.engine.markRunning(sent.runId)
      ids.run = sent.runId
      ids.item = w.typed(w.other.id, 'typed note').id
      w.d.engine.pauseRun({ runId: sent.runId, pause: { reason: 'usage_limit', until: '2099-01-01T00:00:00.000Z', estimated: true, count: 1, autoResume: false } })
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      expect(refusal(seen.paused)).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'run_paused', expectedRunId: sent.runId } })
      expect(w.queue(w.other.id)).toEqual([expect.objectContaining({ id: ids.item, state: 'pending', intent: 'normal' })])
      expect(w.d.engine.getRun(sent.runId)).toMatchObject({ status: 'paused' })
      expect(w.events(w.other.id, 'agent.action')).toEqual([])
    })

    it('a message promoted into a run whose turn never reads it goes back to the queue and runs exactly once as its own turn, with its sender and its mode limit, apart from a person\'s text; also when the provider read it and handed it back', async () => {
      for (const handBack of [false, true]) {
        const seen: Record<string, Response> = {}
        const ids: Record<string, string> = {}
        const r = await rig(async (input, mcp, d, adapter, { release }) => {
          if (input.prompt === 'hold') {
            await adapter.hold(input, release.promise)
            if (handBack && input.threadId === r.askTarget.id) {
              const ctl = adapter.controls.get(input.runId)!
              const drained = ctl.drainSteerEntry?.()
              if (drained) ctl.returnSteer?.(drained.text, drained.token)
            }
            return 'held done'
          }
          if (input.threadId === r.fullCaller.id && input.prompt === GO)
            seen.promote = await call(mcp!, 'queue_promote_to_steer', { threadId: r.askTarget.id, itemId: ids.item, expectedRevision: (await list(mcp!, r.askTarget.id)).revision, expectedRunId: d.engine.getActiveRun(r.askTarget.id)!.runId })
          return 'ok'
        })
        const { w, fullCaller, askTarget } = r
        // A message an agent queued (limit `ask`) and a plain steer a person typed into the same turn.
        const sender = { kind: 'agent' as const, threadId: fullCaller.id, runId: 'run:full', hops: 1, title: 'Full caller', body: { head: 0, tail: 0 } }
        ids.item = w.d.orch.enqueueForThread(askTarget.id, { content: 'written by an agent' }, { source: 'mcp', permissionMode: 'ask', origin: sender }).id
        await w.d.orch.send(GO, false, { threadId: fullCaller.id, clientRequestId: 'go-full' })
        expect(parse(seen.promote)).toMatchObject({ outcome: 'promoted' })
        expect(w.d.orch.steerThread(askTarget.id, 'and a person\'s own steer')).toBe(true)
        r.release.resolve()
        await waitFor(() => w.turnsOf(askTarget.id).length === 3, `the follow-up turns (handBack ${handBack})`, 30_000)
        await waitFor(() => w.d.engine.getActiveRun(askTarget.id) === null && w.queue(askTarget.id).length === 0, 'the queue to drain', 30_000)
        const followUps = w.turnsOf(askTarget.id).slice(1)
        // The agent's message is a turn of its own with its origin and limit; the person's text is another, never merged.
        expect(followUps.map((turn) => turn.prompt).sort()).toEqual(['and a person\'s own steer', 'written by an agent'].sort())
        const agentTurn = followUps.find((turn) => turn.prompt === 'written by an agent')!
        expect(agentTurn).toMatchObject({ permissionMode: 'ask', fromAgent: true })
        // Its origin is the one it was queued with, where its words are and its sender's title included.
        expect(w.messages(askTarget.id).filter((message) => message.origin && !message.steered).map((message) => message.origin)).toEqual([sender])
        expect(w.turnsOf(askTarget.id).filter((turn) => turn.prompt === 'written by an agent')).toHaveLength(1)
        await w.d.stop()
        for (const stop of stops.splice(0).reverse()) await stop().catch(() => undefined)
        rmSync(home!, { recursive: true, force: true })
      }
    })

    it('a promotion bound to one run is never delivered to another: its steer drain reverts it to a pending message before any text is taken', async () => {
      const release = deferred()
      const seen: Record<string, unknown> = {}
      const ids: Record<string, string> = {}
      const w = world(async (input, _mcp, d, adapter) => {
        if (input.prompt === 'hold') {
          await adapter.hold(input, release.promise)
          // The run drains its steers: the item is bound to another run (a daemon that restarted, a replacement run).
          const ctl = adapter.controls.get(input.runId)!
          seen.drained = ctl.drainSteerEntry?.()
          seen.during = d.orch.getOrCreateSession(w.other.id).queue.find((item) => item.id === ids.item)
          return 'held done'
        }
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the held turn')
      const item = w.d.orch.enqueueForThread(w.other.id, { content: 'checked against run A' }, { source: 'mcp', permissionMode: 'ask', origin: { kind: 'agent', threadId: w.parent.id, runId: 'run:p', hops: 1 } })
      ids.item = item.id
      // What a crash between the promotion and its delivery leaves on disk: steering, bound to a run that is not this one.
      const { mutateDurableQueue } = await import('../../src/mms/queue/durableQueue')
      const { promoteQueuedMessageToSteer } = await import('../../src/mms/queue/ThreadMessageQueue')
      mutateDurableQueue(w.d.store, w.other.id, (items) => promoteQueuedMessageToSteer(items, item.id, { steerRunId: 'run:another', permissionMode: 'ask' }).items)
      expect(w.queue(w.other.id)[0]).toMatchObject({ state: 'steering', steerRunId: 'run:another' })
      release.resolve()
      await waitFor(() => w.turnsOf(w.other.id).length === 2, 'the reverted message to run as its own turn', 30_000)
      // No text reached the run that drained; the message was back to pending (with its origin and limit, no bound run) and ran later.
      expect(seen.drained).toBeUndefined()
      expect(seen.during).toMatchObject({ id: item.id, state: 'pending', intent: 'normal', permissionMode: 'ask', origin: { kind: 'agent', threadId: w.parent.id } })
      expect((seen.during as QueuedMessage).steerRunId).toBeUndefined()
      expect(w.turnsOf(w.other.id)[1]).toMatchObject({ prompt: 'checked against run A', permissionMode: 'ask', fromAgent: true })
    })
  })

  describe('what an agent queues on its own thread is the agent\'s message', () => {
    const PAUSE = { reason: 'usage_limit' as const, until: '2099-01-01T00:00:00.000Z', estimated: true, count: 1, autoResume: false }
    type World = ReturnType<typeof world>
    const actorOf = (w: World, runId: string) => ({ kind: 'agent' as const, threadId: w.other.id, runId, toolCallId: 'mcp:t' })
    const drain = (w: World) => (w.d.orch as unknown as { scheduleQueueDrain(session: unknown): void }).scheduleQueueDrain(w.d.orch.getOrCreateSession(w.other.id))
    /** A run of `other` that an agent's message started, `hops` messages deep. */
    const agentRun = (w: World, hops: number) => w.d.engine.store.createRun({ threadId: w.other.id, source: 'mcp', outcome: { sentByAgent: true, agentHops: hops } })
    const pausedRun = async (w: World) => {
      const sent = await w.d.engine.dispatch({ kind: 'send', threadId: w.other.id, clientRequestId: 'paused-run', source: 'gui' })
      if (sent.status !== 'accepted') throw new Error('send rejected')
      w.d.engine.markStarting(sent.runId)
      w.d.engine.markRunning(sent.runId)
      w.d.engine.pauseRun({ runId: sent.runId, pause: PAUSE })
      return sent.runId
    }

    it('carries the writing run\'s hop count and mode limit, counts in its sender\'s cap of three, waits behind a usage pause, and runs as an agent\'s run; and stays in the chain of the run that wrote it: its own queue counts nothing and starts no fresh chain', async () => {
      const w = world(async () => 'ok')
      await w.attach()
      const writer = agentRun(w, 2)
      const host = w.d.orch.mcpToolHost()
      const enqueue = (content: string, key: string, runId = writer.runId) => host.queueCommand!(w.other.id, { op: 'enqueue', content, mode: 'agent' }, { clientRequestId: key, actor: actorOf(w, runId) })
      const paused = await pausedRun(w)

      const first = enqueue('note to myself', 'k1')
      expect(first).toMatchObject({ outcome: 'enqueued', item: { content: 'note to myself', source: 'mcp', permissionMode: 'ask', origin: { kind: 'agent', threadId: w.other.id, runId: writer.runId, hops: 3 } } })
      // The item keeps the writer's chain, and a note in its own queue is no message of that chain.
      expect(first.item?.origin).toMatchObject({ chain: `chain:${writer.runId}` })
      expect(w.d.engine.chains.get(`chain:${writer.runId}`)).toBeNull()
      enqueue('second note', 'k2')
      enqueue('third note', 'k3')
      // The cap of three queued messages per sending thread counts them, whoever's thread they are on.
      expect(() => enqueue('fourth note', 'k4')).toThrow(expect.objectContaining({ code: 'agent_queue_full_per_sender' }))
      expect(w.queue(w.other.id).map((item) => item.content)).toEqual(['note to myself', 'second note', 'third note'])

      // Behind a usage pause only a person's message goes on: the notes wait, and the pause stays.
      drain(w)
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(w.turnsOf(w.other.id)).toEqual([])
      expect(w.d.engine.getRun(paused)).toMatchObject({ status: 'paused' })
      expect(w.queue(w.other.id)).toHaveLength(3)

      w.d.engine.endPause(paused, 'cancel')
      drain(w)
      await waitFor(() => w.turnsOf(w.other.id).length === 3, 'the three notes to run', 30_000)
      // Each runs as an agent's message with the limit it carries, and its run counts the hops that led to it.
      expect(w.turnsOf(w.other.id)[0]).toMatchObject({ prompt: 'note to myself', fromAgent: true, permissionMode: 'ask' })
      const noteRun = w.d.engine.listRuns(w.other.id).find((run) => run.outcome?.sentByAgent && run.outcome.agentHops === 3 && run.status !== 'queued' && run.runId !== writer.runId)!
      expect(noteRun).toBeDefined()
      // The chain does not restart: the note's turn is in the writer's chain.
      expect(noteRun.outcome?.agentChain).toBe(`chain:${writer.runId}`)
    })

    it('is held while the user has a question or approval waiting, and a person\'s Stop clears it, leaving what a person queued', async () => {
      const release = deferred()
      const w = world(async (input, _mcp, _d, adapter) => {
        if (input.prompt === 'hold') {
          await adapter.hold(input, release.promise)
          return 'held'
        }
        return 'ok'
      })
      await w.attach()
      const host = w.d.orch.mcpToolHost()
      const writer = agentRun(w, 0)
      const enqueue = (content: string, key: string) => host.queueCommand!(w.other.id, { op: 'enqueue', content, mode: 'agent' }, { clientRequestId: key, actor: actorOf(w, writer.runId) })

      // A question waits on the thread: the note stays queued, at startup too.
      const questions = (w.d.orch as unknown as { questions: { requestAnswers(questions: unknown, threadId: string, options: unknown): Promise<unknown>; listPendingForThread(threadId: string): Array<{ requestId: string }>; submitAnswers(requestId: string, answers: unknown): boolean } }).questions
      const asked = questions.requestAnswers([{ id: 'q', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }], w.other.id, {})
      enqueue('note while asked', 'k1')
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(w.turnsOf(w.other.id)).toEqual([])
      expect(w.queue(w.other.id).map((item) => item.state)).toEqual(['pending'])
      questions.submitAnswers(questions.listPendingForThread(w.other.id)[0].requestId, { q: 'a' })
      await asked
      drain(w)
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the note to run once the answer is in', 30_000)
      await waitFor(() => w.queue(w.other.id).length === 0, 'the queue to empty')

      // A running turn, a note and a person's message queued behind it; the person presses Stop.
      await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(w.other.id).length === 2, 'the held turn')
      enqueue('a note to clear', 'k2')
      const person = w.typed(w.other.id, 'a message I typed')
      expect(w.queue(w.other.id).map((item) => item.origin?.kind)).toEqual(['agent', undefined])
      await w.d.orch.stopThread(w.other.id, 'user')
      await waitFor(() => w.queue(w.other.id).every((item) => item.origin === undefined), 'the note to be cleared')
      expect(w.queue(w.other.id).map((item) => item.id)).toEqual([person.id])
      release.resolve()
    })

    it('an own note edited by its writer carries the editing run\'s hop count too, and a message with no agent origin is never taken for the agent\'s own whatever its source says', async () => {
      const w = world(async () => 'ok')
      await w.attach()
      const host = w.d.orch.mcpToolHost()
      const paused = await pausedRun(w)
      const early = agentRun(w, 0)
      const late = agentRun(w, 2)
      const note = host.queueCommand!(w.other.id, { op: 'enqueue', content: 'first words', mode: 'agent' }, { clientRequestId: 'e1', actor: actorOf(w, early.runId) })
      expect(w.queue(w.other.id)[0].origin).toMatchObject({ hops: 1 })
      host.queueCommand!(w.other.id, { op: 'edit', itemId: note.itemId, content: 'better words', expectedRevision: host.queueSnapshot!(w.other.id).revision }, { clientRequestId: 'e2', actor: actorOf(w, late.runId) })
      expect(w.queue(w.other.id)[0]).toMatchObject({ content: 'better words', origin: { kind: 'agent', threadId: w.other.id, runId: late.runId, hops: 3 } })
      // A message a person typed whose source says `mcp` (only a label) is still a person's: an agent's edit of it is labelled
      // as the agent's words and recorded, as for any message the agent did not write.
      const lookalike = w.d.orch.enqueueForThread(w.other.id, { content: 'typed, labelled mcp' }, { source: 'mcp' })
      host.queueCommand!(w.other.id, { op: 'edit', itemId: lookalike.id, content: 'mine', expectedRevision: host.queueSnapshot!(w.other.id).revision }, { clientRequestId: 'e3', actor: actorOf(w, early.runId) })
      expect(w.queue(w.other.id).find((item) => item.id === lookalike.id)?.content).toBe(agentMessageText(w.other.id, 'Other work', 'mine'))
      expect(w.events(w.other.id, 'agent.action').map((event) => event.payload)).toEqual([expect.objectContaining({ action: 'edited_queued_message', itemId: lookalike.id, wasOrigin: 'mcp' })])
      w.d.engine.endPause(paused, 'cancel')
    })
  })

  describe('what removing or reordering leaves for the person, and no promotion into a question', () => {
    it('every removal records the text it took out, a person\'s message and the agent\'s own note alike', async () => {
      const seen: Record<string, Response> = {}
      const ids: Record<string, string> = {}
      const w = world(async (input, mcp) => {
        if (input.threadId !== w.parent.id || input.prompt !== GO) return 'ok'
        const rev = async () => (await list(mcp!)).revision
        seen.own = await call(mcp!, 'queue_enqueue', { content: 'my own note' })
        ids.own = (parse(seen.own) as { item: { id: string } }).item.id
        ids.person = w.typed(w.parent.id, 'stop doing X, and do not push').id
        seen.person = await call(mcp!, 'queue_remove', { itemId: ids.person, expectedRevision: await rev() })
        seen.removeOwn = await call(mcp!, 'queue_remove', { itemId: ids.own, expectedRevision: await rev(), clientRequestId: 'rm-1' })
        ids.left = w.queue(w.parent.id).map((item) => item.id).join(',')
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      expect(verdict(seen.person)).toBe('ok')
      expect(parse(seen.removeOwn)).toMatchObject({ outcome: 'removed', removedText: 'my own note' })
      expect(ids.left).toBe('')
      // The person can read what was removed, from the event and the transcript, and put it back.
      const removals = w.events(w.parent.id, 'agent.action').filter((event) => (event.payload as { action: string }).action === 'removed_queued_message')
      expect(removals.map((event) => event.payload)).toEqual([
        expect.objectContaining({ itemId: ids.person, removedText: 'stop doing X, and do not push', wasOrigin: 'gui' }),
        expect.objectContaining({ itemId: ids.own, removedText: 'my own note', wasOrigin: 'agent' })
      ])
      for (const text of ['stop doing X, and do not push', 'my own note'])
        expect(w.messages(w.parent.id).some((message) => message.role === 'system' && message.content.includes('removed queued message') && message.content.includes(text)), text).toBe(true)
    })

    it('a reorder of a queue that holds a person\'s message is recorded', async () => {
      const seen: Record<string, Response> = {}
      const m = world(async (input, mcp) => {
        if (input.threadId !== m.parent.id || input.prompt !== GO) return 'ok'
        const first = (parse(await call(mcp!, 'queue_enqueue', { content: 'note a' })) as { item: { id: string } }).item.id
        const person = m.typed(m.parent.id, 'typed by the user').id
        seen.managed = await call(mcp!, 'queue_reorder', { orderedIds: [person, first].reverse(), expectedRevision: (await list(mcp!)).revision })
        return 'ok'
      })
      await m.attach()
      await m.d.orch.send(GO, false, { threadId: m.parent.id, clientRequestId: 'go' })
      expect(verdict(seen.managed)).toBe('ok')
      expect(m.events(m.parent.id, 'agent.action').map((event) => (event.payload as { action: string }).action)).toEqual(['reordered_queue'])
    })

    it('a promotion refuses while the user has a question or approval waiting; a steer an agent caused is not handed to the provider while one waits, and goes once it is answered', async () => {
      const release = deferred()
      const seen: Record<string, Response> = {}
      const ids: Record<string, string> = {}
      const w = world(async (input, mcp, d, adapter) => {
        if (input.prompt === 'hold') {
          await adapter.hold(input, release.promise)
          return 'held'
        }
        if (input.threadId === w.parent.id && input.prompt === GO)
          seen.promote = await call(mcp!, 'queue_promote_to_steer', { threadId: w.other.id, itemId: ids.typed, expectedRevision: (await list(mcp!, w.other.id)).revision, expectedRunId: d.engine.getActiveRun(w.other.id)!.runId })
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the held turn')
      ids.typed = w.typed(w.other.id, 'typed by the user').id
      const questions = (w.d.orch as unknown as { questions: { requestAnswers(questions: unknown, threadId: string, options: unknown): Promise<unknown>; listPendingForThread(threadId: string): Array<{ requestId: string }>; submitAnswers(requestId: string, answers: unknown): boolean } }).questions
      const asked = questions.requestAnswers([{ id: 'q', prompt: 'Allow it?', options: [{ id: 'a', label: 'Allow' }] }], w.other.id, {})
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      expect(refusal(seen.promote)).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'questions_pending' } })
      expect(w.queue(w.other.id)).toEqual([expect.objectContaining({ id: ids.typed, state: 'pending', intent: 'normal' })])
      expect(questions.listPendingForThread(w.other.id)).toHaveLength(1)

      // The question was raised after the promotion: the steer waits in the turn instead of reaching a provider that would settle it.
      const session = w.d.orch.getOrCreateSession(w.other.id)
      const turn = session.activeTurn!
      turn.pendingSteer.push({ text: 'a promoted message', itemId: 'item-x', byAgent: true }, { text: 'from an agent', origin: { kind: 'agent', threadId: w.parent.id, runId: 'run:p', hops: 1 }, permissionMode: 'ask' }, { text: 'what I typed' })
      const drainSteer = (w.d.orch as unknown as { drainSteerForSession(session: unknown, turn: unknown): { entries: Array<{ text: string }> } | undefined }).drainSteerForSession
      expect(drainSteer.call(w.d.orch, session, turn)?.entries.map((entry) => entry.text)).toEqual(['what I typed'])
      expect(turn.pendingSteer.map((entry) => entry.text)).toEqual(['a promoted message', 'from an agent'])
      expect(questions.listPendingForThread(w.other.id)).toHaveLength(1)
      // Answered: nothing is lost, and the held steers are taken in order.
      questions.submitAnswers(questions.listPendingForThread(w.other.id)[0].requestId, { q: 'a' })
      await asked
      expect(drainSteer.call(w.d.orch, session, turn)?.entries.map((entry) => entry.text)).toEqual(['a promoted message', 'from an agent'])
      release.resolve()
    })
  })

  describe('approval_respond and the questions-pending guard of a promotion', () => {
    const approvalTag = { action: 'command', permissionKey: 'claude:command', options: [{ id: 'allow', decision: 'allow', scope: 'once' }, { id: 'reject', decision: 'reject' }], tool: { name: 'Bash', input: { command: 'npm test' }, cwd: '/work/app' } }
    const approvalQuestion = [{ id: 'permission', prompt: 'Allow Claude Code to run a command (Bash)?\nnpm test', options: [{ id: 'allow', label: 'Allow once' }, { id: 'reject', label: 'Reject' }] }]

    /** A target whose held turn was started by `source`, with a typed message queued, and a caller that may answer approvals. */
    const setup = async (source: 'gui' | 'mcp', script: Script) => {
      const release = deferred()
      const w = world(async (input, mcp, d, adapter) => {
        if (input.prompt === 'hold') {
          await adapter.hold(input, release.promise)
          return 'held'
        }
        return input.threadId === w.parent.id && input.prompt === GO ? script(input, mcp, d, adapter) : 'ok'
      })
      const settings = (w.d.orch as unknown as { settingsStore: { get(): { agentAccess: Record<string, unknown> } } }).settingsStore.get()
      settings.agentAccess = { ...settings.agentAccess, answerApprovals: true }
      w.d.orch.setThreadPermissionMode(w.parent.id, 'full')
      await w.attach()
      await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack', source })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the held turn')
      return { w, release, item: w.typed(w.other.id, 'typed by the user').id }
    }
    const respond = (mcp: Mcp, threadId: string, requestId: string, key: string) =>
      call(mcp, 'approval_respond', { threadId, requestId, answers: { permission: 'allow' }, clientRequestId: key })
    const promote = async (mcp: Mcp, d: Phase6Daemon, threadId: string, itemId: string) =>
      call(mcp, 'queue_promote_to_steer', { threadId, itemId, expectedRevision: (await list(mcp, threadId)).revision, expectedRunId: d.engine.getActiveRun(threadId)!.runId })

    it('no way round it where the user is asked: a turn a person started and a plain question stay the user\'s, so the promotion keeps refusing', async () => {
      const seen: Record<string, Response> = {}
      const ids: Record<string, string> = {}
      const { w, release, item } = await setup('gui', async (_input, mcp, d) => {
        seen.promoteBefore = await promote(mcp!, d, w.other.id, ids.item!)
        // Answering the approval is the other way to clear the question; a person's turn is refused.
        seen.answerPerson = await respond(mcp!, w.other.id, ids.approval!, 'k-person')
        seen.promoteAfter = await promote(mcp!, d, w.other.id, ids.item!)
        // And a plain question is no approval at all.
        seen.answerPlain = await respond(mcp!, w.other.id, ids.plain!, 'k-plain')
        return 'ok'
      })
      ids.item = item
      const approval = w.d.questions.requestAnswers(approvalQuestion, w.other.id, { approval: approvalTag as never })
      approval.catch(() => undefined)
      ids.approval = w.d.questions.listPendingForThread(w.other.id).at(-1)!.requestId
      const plain = w.d.questions.requestAnswers([{ id: 'q', prompt: 'Which one?', options: [{ id: 'a', label: 'A' }] }], w.other.id)
      plain.catch(() => undefined)
      ids.plain = w.d.questions.listPendingForThread(w.other.id).at(-1)!.requestId
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })

      expect(conflictOf(seen.promoteBefore!)).toBe('questions_pending')
      expect(refusal(seen.answerPerson!)?.details).toMatchObject({ ok: false, reason: 'person_turn' })
      expect(conflictOf(seen.promoteAfter!)).toBe('questions_pending')
      expect(verdict(seen.answerPlain!)).toBe('mousse_scope_denied')
      expect(w.d.questions.listPendingForThread(w.other.id)).toHaveLength(2)
      expect(w.queue(w.other.id)).toEqual([expect.objectContaining({ id: item, state: 'pending', intent: 'normal' })])
      release.resolve()
    })

    it('where no person is asking, an agent that may answer clears the approval and then promotes: each step within its own limits, and recorded', async () => {
      const seen: Record<string, Response> = {}
      const ids: Record<string, string> = {}
      const { w, release, item } = await setup('mcp', async (_input, mcp, d) => {
        seen.promoteBefore = await promote(mcp!, d, w.other.id, ids.item!)
        seen.answer = await respond(mcp!, w.other.id, ids.approval!, 'k-answer')
        seen.promoteAfter = await promote(mcp!, d, w.other.id, ids.item!)
        return 'ok'
      })
      ids.item = item
      const approval = w.d.questions.requestAnswers(approvalQuestion, w.other.id, { approval: approvalTag as never })
      ids.approval = w.d.questions.listPendingForThread(w.other.id).at(-1)!.requestId
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })

      expect(conflictOf(seen.promoteBefore!)).toBe('questions_pending')
      expect(JSON.parse(seen.answer!.result!.content![0]!.text)).toMatchObject({ ok: true, decision: 'allow' })
      await approval
      expect(verdict(seen.promoteAfter!)).toBe('ok')
      // Both are on the record: the answer by the approval's own event, the promotion by the thread's agent action.
      expect(w.events(w.other.id, 'approval.answered')).toHaveLength(1)
      expect(w.events(w.other.id, 'agent.action').map((event) => (event.payload as { action: string }).action)).toContain('promoted_queued_message')
      release.resolve()
    })
  })

  describe('a promoted message put back, a Plan thread, and the journal\'s upkeep', () => {
    it('a promoted message the turn never read comes back with its own chat mode and its images, also when it is queued again from its entry', async () => {
      const release = deferred()
      const seen: Record<string, Response> = {}
      const ids: Record<string, string> = {}
      const w = world(async (input, mcp, d, adapter) => {
        if (input.prompt === 'hold') {
          await adapter.hold(input, release.promise)
          return 'held'
        }
        if (input.threadId === w.parent.id && input.prompt === GO)
          seen.promote = await call(mcp!, 'queue_promote_to_steer', { threadId: w.other.id, itemId: ids.item, expectedRevision: (await list(mcp!, w.other.id)).revision, expectedRunId: d.engine.getActiveRun(w.other.id)!.runId })
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the held turn')
      const image = { data: 'aGk=', mimeType: 'image/png' }
      ids.item = w.d.orch.enqueueForThread(w.other.id, { content: 'only plan the cleanup', mode: 'plan', images: [image] }, { source: 'gui' }).id
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      expect(verdict(seen.promote)).toBe('ok')
      const session = w.d.orch.getOrCreateSession(w.other.id)
      // The entry carries what the message was, for the case the item is gone when the turn ends.
      expect(session.activeTurn!.pendingSteer).toEqual([expect.objectContaining({ itemId: ids.item, mode: 'plan', images: [image], byAgent: true })])
      const entry = session.activeTurn!.pendingSteer[0]
      const settle = (w.d.orch as unknown as { settleUnreadItems(session: unknown, entries: unknown[], mode: string): void }).settleUnreadItems
      // An acknowledgement dropped the item while its drain was out: the entry queues it again.
      w.d.orch.removeQueuedItem(w.other.id, ids.item)
      settle.call(w.d.orch, session, [entry], 'agent')
      expect(w.queue(w.other.id)).toEqual([expect.objectContaining({ content: 'only plan the cleanup', mode: 'plan', images: [image], state: 'pending' })])
      release.resolve()
    })

    it('an agent that rewrites a message on a thread a person keeps in Plan leaves it a plan message', async () => {
      const release = deferred()
      const seen: Record<string, Response> = {}
      const ids: Record<string, string> = {}
      const w = world(async (input, mcp, _d, adapter) => {
        if (input.prompt === 'hold') {
          await adapter.hold(input, release.promise)
          return 'held'
        }
        if (input.threadId === w.parent.id && input.prompt === GO)
          seen.edit = await call(mcp!, 'queue_edit', { threadId: w.other.id, itemId: ids.item, content: 'now implement it', expectedRevision: (await list(mcp!, w.other.id)).revision })
        return 'ok'
      })
      await w.attach()
      // The person keeps the thread in Plan, and queues a message in agent mode while a turn runs.
      await w.d.orch.send({ content: 'hold', mode: 'plan' }, false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the held turn')
      ids.item = w.d.orch.enqueueForThread(w.other.id, { content: 'typed in agent mode', mode: 'agent' }, { source: 'gui' }).id
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      expect(verdict(seen.edit)).toBe('ok')
      expect(w.queue(w.other.id)[0]).toMatchObject({ mode: 'plan', origin: { kind: 'agent', threadId: w.parent.id } })
      release.resolve()
    })

    it('a request id reused with other fields is refused, not replayed, through the tool', async () => {
      const release = deferred()
      const seen: Record<string, Response> = {}
      const ids: Record<string, string> = {}
      const w = world(async (input, mcp, _d, adapter) => {
        if (input.prompt === 'hold') {
          await adapter.hold(input, release.promise)
          return 'held'
        }
        if (input.threadId !== w.parent.id || input.prompt !== GO) return 'ok'
        const rev = async () => (await list(mcp!, w.other.id)).revision
        seen.first = await call(mcp!, 'queue_remove', { threadId: w.other.id, itemId: ids.x, expectedRevision: await rev(), clientRequestId: 'rm-1' })
        // Another message, the same request id: the agent must not believe it is gone.
        seen.other = await call(mcp!, 'queue_remove', { threadId: w.other.id, itemId: ids.y, expectedRevision: await rev(), clientRequestId: 'rm-1' })
        seen.retry = await call(mcp!, 'queue_remove', { threadId: w.other.id, itemId: ids.x, expectedRevision: await rev(), clientRequestId: 'rm-1' })
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the held turn')
      ids.x = w.typed(w.other.id, 'x').id
      ids.y = w.typed(w.other.id, 'y').id
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      expect(verdict(seen.first)).toBe('ok')
      expect(refusal(seen.other)).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'request_conflict' } })
      expect(parse(seen.retry)).toMatchObject({ itemId: ids.x, replayed: true })
      expect(w.queue(w.other.id).map((item) => item.id)).toEqual([ids.y])
      release.resolve()
    })

    it('the bot wall holds in the queue command itself, for every operation, also on the bot\'s own thread', async () => {
      const w = world(async () => 'ok')
      await w.attach()
      const host = w.d.orch.mcpToolHost()
      const typed = w.typed(w.other.id, 'a message')
      const second = w.typed(w.other.id, 'another')
      ;(w.d.orch as unknown as { botDispatcher: { ownerOf(threadId: string): string | undefined } }).botDispatcher = { ownerOf: (id) => (id === w.other.id ? 'bot-1' : undefined) }
      const actor = { kind: 'agent' as const, threadId: w.parent.id, runId: 'run:p', toolCallId: 'mcp:t' }
      const own = { kind: 'agent' as const, threadId: w.other.id, runId: 'run:b', toolCallId: 'mcp:t' }
      const rev = () => host.queueSnapshot!(w.other.id).revision
      for (const who of [actor, own]) {
        for (const command of [
          { op: 'remove', itemId: typed.id, expectedRevision: rev() },
          { op: 'reorder', orderedIds: [second.id, typed.id], expectedRevision: rev() },
          { op: 'edit', itemId: typed.id, content: 'x', expectedRevision: rev() },
          { op: 'enqueue', content: 'x', mode: 'agent' }
        ] as const)
          expect(() => host.queueCommand!(w.other.id, command, { clientRequestId: `k-${who.threadId}-${command.op}`, actor: who }), `${who.threadId} ${command.op}`).toThrow(expect.objectContaining({ code: 'bot_thread_read_only' }))
      }
      expect(w.queue(w.other.id).map((item) => item.id)).toEqual([typed.id, second.id])
    })
  })

  describe('limits on what agents put in a thread\'s queue (the caps of thread_send)', () => {
    it('a thread keeps three queued messages from each sending thread, whether they were sent or queued: the fourth is refused, and so is an edit that would make a person\'s message the fourth; a person\'s Stop clears them', async () => {
      const release = deferred()
      const seen: Response[] = []
      const ids: Record<string, string> = {}
      const w = world(async (input, mcp, _d, adapter) => {
        if (input.prompt === 'hold') {
          await adapter.hold(input, release.promise)
          return 'held'
        }
        if (input.threadId !== w.parent.id || input.prompt !== GO) return 'ok'
        for (let index = 0; index < 4; index += 1)
          seen.push(await call(mcp!, 'queue_enqueue', { threadId: w.other.id, content: `note ${index}`, expectedRevision: (await list(mcp!, w.other.id)).revision }))
        seen.push(await call(mcp!, 'queue_edit', { threadId: w.other.id, itemId: ids.typed, content: 'make this the fourth', expectedRevision: (await list(mcp!, w.other.id)).revision }))
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the held turn')
      ids.typed = w.typed(w.other.id, 'a note I typed').id
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      expect(seen.slice(0, 3).map(verdict)).toEqual(['ok', 'ok', 'ok'])
      expect(refusal(seen[3])).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'agent_queue_full_per_sender' } })
      expect(refusal(seen[4])).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'agent_queue_full_per_sender' } })
      expect(w.queue(w.other.id).map((item) => item.origin?.kind)).toEqual([undefined, 'agent', 'agent', 'agent'])
      expect(w.queue(w.other.id)[0].content).toBe('a note I typed')

      // A person presses Stop: the running turn ends and the agents' queued messages go with it; theirs stays.
      await w.d.orch.stopThread(w.other.id, 'user')
      await waitFor(() => w.queue(w.other.id).every((item) => item.origin === undefined), 'the agent messages to be cleared')
      expect(w.queue(w.other.id).map((item) => item.content)).toEqual(['a note I typed'])
      release.resolve()
    })

    it(`a thread keeps ${AGENT_QUEUE_MAX_PER_THREAD} queued messages from all agents together: past it every sender is refused, a person is not`, async () => {
      const release = deferred()
      const w = world(async (input, _mcp, _d, adapter) => {
        if (input.prompt === 'hold') await adapter.hold(input, release.promise)
        return 'ok'
      })
      await w.attach()
      await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the held turn')
      const host = w.d.orch.mcpToolHost()
      // Enough sending threads to reach the total with none of them past its own cap.
      const senders = Array.from({ length: Math.ceil(AGENT_QUEUE_MAX_PER_THREAD / AGENT_QUEUE_MAX_PER_SENDER) + 1 }, (_, index) => {
        const sender = w.thread(`Sender ${index}`)
        return { kind: 'agent' as const, threadId: sender.id, runId: w.d.engine.store.createRun({ threadId: sender.id, source: 'gui' }).runId, toolCallId: 'mcp:t' }
      })
      const enqueue = (actor: (typeof senders)[number], key: string) => () => host.queueCommand!(w.other.id, { op: 'enqueue', content: key, mode: 'agent' }, { clientRequestId: key, actor })
      let queued = 0
      for (const [index, actor] of senders.entries())
        for (let note = 0; note < AGENT_QUEUE_MAX_PER_SENDER && queued < AGENT_QUEUE_MAX_PER_THREAD; note += 1, queued += 1) enqueue(actor, `s${index}-n${note}`)()
      expect(w.queue(w.other.id)).toHaveLength(AGENT_QUEUE_MAX_PER_THREAD)
      // The last sender has room under its own cap, yet the thread is full; the first sender is past its own cap first.
      expect(enqueue(senders.at(-1)!, 'one more')).toThrow(expect.objectContaining({ code: 'agent_queue_full' }))
      expect(enqueue(senders[0], 'and another')).toThrow(expect.objectContaining({ code: 'agent_queue_full_per_sender' }))
      // A person's message is never held to the agents' caps.
      w.typed(w.other.id, 'a note I typed')
      expect(w.queue(w.other.id)).toHaveLength(AGENT_QUEUE_MAX_PER_THREAD + 1)
      release.resolve()
    })

    it('a chain at its budget cannot queue or edit a message on another thread (neither can wait for the person); under it, a message queued there counts', async () => {
      const w = world(async () => 'ok')
      await w.attach()
      const third = w.d.engine.store.createRun({ threadId: w.parent.id, source: 'mcp', outcome: { sentByAgent: true, agentHops: 3 } })
      spendChain(w.d.engine, `chain:${third.runId}`, w.parent.id, w.other.id)
      const second = w.d.engine.store.createRun({ threadId: w.parent.id, source: 'mcp', outcome: { sentByAgent: true, agentHops: 2 } })
      const typed = w.typed(w.other.id, 'a note I typed')
      const host = w.d.orch.mcpToolHost()
      const actor = (runId: string) => ({ kind: 'agent' as const, threadId: w.parent.id, runId, toolCallId: 'mcp:t' })
      const revision = () => host.queueSnapshot!(w.other.id).revision
      const options = (runId: string, key: string) => ({ clientRequestId: key, actor: actor(runId) })
      expect(() => host.queueCommand!(w.other.id, { op: 'enqueue', content: 'one hop too many', mode: 'agent', expectedRevision: revision() }, options(third.runId, 'k1')))
        .toThrow(expect.objectContaining({ code: 'agent_hops_exceeded' }))
      expect(() => host.queueCommand!(w.other.id, { op: 'edit', itemId: typed.id, content: 'one hop too many', expectedRevision: revision() }, options(third.runId, 'k2')))
        .toThrow(expect.objectContaining({ code: 'agent_hops_exceeded' }))
      expect(w.queue(w.other.id).map((item) => item.content)).toEqual(['a note I typed'])
      // The second hop may: its message is the third, and it carries the count.
      const ok = host.queueCommand!(w.other.id, { op: 'enqueue', content: 'the third hop', mode: 'agent', expectedRevision: revision() }, options(second.runId, 'k3'))
      expect(ok.item?.origin).toMatchObject({ kind: 'agent', hops: 3, chain: `chain:${second.runId}` })
      expect(w.d.engine.chains.get(`chain:${second.runId}`)?.used).toBe(1)
    })
  })
})

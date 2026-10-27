/**
 * `queue_enqueue`, `queue_edit`, `queue_remove`, `queue_reorder` and `queue_promote_to_steer` end to end
 * (docs/run-engine/SPEC.md §15.1): a real `OrchestratorService`, Run Engine, effect worker and Mousse MCP server, with
 * scripted provider runtimes whose turns call the tools over HTTP. Covers each access level on the caller's own
 * thread and on another's, the queue revision (a stale one is refused and nothing changes), receipts that survive a
 * restart, the mode and origin a queued message keeps through an edit, a reorder and a promotion, and a promotion
 * into a running, paused or replaced run.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readDurableQueue } from '../../src/mms/queue/durableQueue'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { AGENT_MESSAGE_PREFIX, agentMessageText, TURN_TOKEN_KEY } from '../../src/mms/run/mcp/appTools'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MCP_ERROR_CODES, MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import type { AgentAccessLevel } from '../../src/shared/settings'
import type { ChatMessage, QueuedMessage } from '../../src/shared/types'
import type { PermissionMode } from '../../src/shared/permissionMode'
import { phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'

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
/** What a call came to: `ok`, or the reason it was refused (`mousse_scope_denied`, `mousse_conflict`, ...), or `error` for a tool error result. */
const verdict = (response: Response): string => response.error ? response.error.data?.reason ?? 'error' : response.result?.isError ? 'error' : 'ok'
const conflictOf = (response: Response): string | undefined => response.error?.data?.conflict

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
  const world = (script: Script, level: AgentAccessLevel = 'manage') => {
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
    const setProfile = (next: AgentAccessLevel, projectIds: string[] = []): void => {
      ;(d.orch as unknown as { settingsStore: { get(): { agentAccess: unknown } } }).settingsStore.get().agentAccess = { level: next, projectIds, answerApprovals: false }
    }
    setProfile(level)
    const events = (threadId: string, type: string) => d.engine.listEvents(threadId).filter((event) => event.type === type)
    const messages = (threadId: string): ChatMessage[] => d.orch.getOrCreateSession(threadId).messages
    const queue = (threadId: string): QueuedMessage[] => readDurableQueue(d.store, threadId)
    return {
      d, adapter, credentials, server, project, parent, other, thread, setProfile, events, messages, queue,
      attach: async () => { await server.start(); d.orch.setMcpAttachment(server) },
      turnsOf: (threadId: string) => adapter.turns.filter((turn) => turn.threadId === threadId),
      latestRun: (threadId: string) => d.engine.listRuns(threadId)[0],
      /** A person's typed message on a thread's queue. */
      typed: (threadId: string, content: string) => d.orch.enqueueForThread(threadId, { content }, { source: 'gui' })
    }
  }

  /** The queue of `threadId` as the caller reads it, and its revision. */
  const list = async (mcp: Mcp, threadId?: string) => parse(await call(mcp, 'queue_list', threadId ? { threadId } : {})) as { items: Array<Record<string, unknown>>; claimed: Array<Record<string, unknown>>; revision: string; open: boolean }

  describe('each operation under each access level', () => {
    const LEVELS: AgentAccessLevel[] = ['lineage', 'read', 'manage']

    it.each(LEVELS)('on the caller\'s own thread at %s: its own messages are its to change; a message a person queued can be edited only with manage', async (level) => {
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
      }, level)
      await w.attach()
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })

      expect(verdict(seen.editOwn)).toBe('ok')
      expect(verdict(seen.editPerson)).toBe(level === 'manage' ? 'ok' : 'mousse_scope_denied')
      expect(verdict(seen.reorder)).toBe('ok')
      expect(verdict(seen.promote)).toBe('ok')
      expect(verdict(seen.removeOwn)).toBe('ok')
      const actions = w.events(w.parent.id, 'agent.action').map((event) => (event.payload as { action: string }).action)
      // Changes to a message the agent wrote itself leave no audit row; a change to a person's message always does.
      // With manage the agent rewrote the person's message first, so it is the agent's own from then on.
      if (level === 'manage') expect(actions).toEqual(['edited_queued_message'])
      else expect(actions).toEqual(['reordered_queue', 'promoted_queued_message'])
      // Without manage the person's text is untouched (it was promoted into the turn as it was typed).
      const edited = parse(seen.promote) as { outcome: string }
      expect(edited.outcome).toBe('promoted')
      const stored = w.messages(w.parent.id).find((message) => message.steered)
      expect(stored?.content).toBe(level === 'manage' ? agentMessageText(w.parent.id, 'Parent', 'the agent rewrote this') : 'typed by the user')
    })

    it.each(LEVELS)('on another thread at %s: nothing below manage reads its text or changes its queue; manage does all five, each recorded on that thread', async (level) => {
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
        const rev = () => (level === 'lineage' ? 'unread' : revision())
        seen.enqueue = await call(mcp!, 'queue_enqueue', { threadId: w.other.id, content: 'a note from me', expectedRevision: await rev() })
        const queued = level === 'manage' ? (parse(seen.enqueue) as { item: { id: string } }).item.id : ids.one
        seen.edit = await call(mcp!, 'queue_edit', { threadId: w.other.id, itemId: ids.one, content: 'reworded', expectedRevision: await rev() })
        seen.reorder = await call(mcp!, 'queue_reorder', { threadId: w.other.id, orderedIds: [ids.two, ids.one, queued].filter(Boolean), expectedRevision: await rev() })
        seen.promote = await call(mcp!, 'queue_promote_to_steer', { threadId: w.other.id, itemId: ids.two, expectedRevision: await rev(), expectedRunId: d.engine.getActiveRun(w.other.id)!.runId })
        seen.remove = await call(mcp!, 'queue_remove', { threadId: w.other.id, itemId: ids.one, expectedRevision: await rev() })
        return 'ok'
      }, level)
      await w.attach()
      await w.d.orch.send('hold', false, { threadId: w.other.id, clientRequestId: 'hold', awaitMode: 'ack' })
      await waitFor(() => w.turnsOf(w.other.id).length === 1, 'the held turn')
      ids.one = w.typed(w.other.id, 'typed one').id
      ids.two = w.typed(w.other.id, 'typed two').id
      const before = w.queue(w.other.id).map((item) => [item.id, item.content, item.state])
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })

      if (level === 'manage') {
        for (const name of ['list', 'enqueue', 'edit', 'reorder', 'promote', 'remove']) expect(verdict(seen[name]), name).toBe('ok')
        expect((parse(seen.list) as { items: Array<{ content: string }> }).items.map((item) => item.content)).toEqual(['typed one', 'typed two'])
        expect(w.events(w.other.id, 'agent.action').map((event) => (event.payload as { action: string }).action)).toEqual([
          'queued_message', 'edited_queued_message', 'reordered_queue', 'promoted_queued_message', 'removed_queued_message'
        ])
        expect(w.messages(w.other.id).filter((message) => message.role === 'system' && message.content.startsWith('Changed by an agent')).map((message) => message.content)).toHaveLength(5)
      } else {
        // A read-level agent sees where messages stand and how big they are, never their text.
        if (level === 'read') {
          const listed = parse(seen.list) as { items: Array<Record<string, unknown>> }
          expect(listed.items.map((item) => item.contentLength)).toEqual(['typed one'.length, 'typed two'.length])
          expect(JSON.stringify(listed)).not.toContain('typed one')
        } else expect(verdict(seen.list)).toBe('mousse_scope_denied')
        for (const name of ['enqueue', 'edit', 'reorder', 'promote', 'remove']) expect(verdict(seen[name]), name).toBe('mousse_scope_denied')
        expect(w.queue(w.other.id).map((item) => [item.id, item.content, item.state])).toEqual(before)
        expect(w.events(w.other.id, 'agent.action')).toEqual([])
      }
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
        expect(seen[name].error, name).toMatchObject({ code: MCP_ERROR_CODES.mousse_conflict, data: { conflict: 'revision_mismatch', revision: current } })
        expect(seen[name].error!.data!.expectedRevision, name).not.toBe(current)
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
      expect(() => w.d.orch.promoteQueueItemToSteer(w.other.id, a.id, stale)).toThrow(/No active turn|revision/)
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
        host.queueCommand!(w.other.id, { op: 'edit', itemId, content, expectedRevision: host.queueSnapshot!(w.other.id).revision }, { clientRequestId: key, actor, level: 'manage' })
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
      expect(recovered).toMatchObject({ content: agentMessageText(w.parent.id, 'Parent', 'b, rewritten'), origin: { kind: 'agent', threadId: w.parent.id }, permissionMode: 'ask' })
      expect(d2.engine.store.db.statement("SELECT status FROM queue_commands WHERE command_key = 'queue_edit:caller:2'").get()).toEqual({ status: 'applied' })

      // The retries, with other arguments, return what the commands did; neither changes the queue again.
      const host2 = d2.orch.mcpToolHost()
      expect(command(host2, 'queue_edit:caller:1', 'something else entirely', a.id)).toMatchObject({ outcome: 'edited', itemId: a.id, replayed: true, revision: first.revision })
      expect(command(host2, 'queue_edit:caller:2', 'something else entirely', b.id)).toMatchObject({ outcome: 'edited', itemId: b.id, replayed: true })
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
      expect(() => host.queueCommand!(w.other.id, { op: 'enqueue', content: 'remember this', mode: 'agent', expectedRevision: host.queueSnapshot!(w.other.id).revision }, { clientRequestId: 'queue_enqueue:caller:1', actor, level: 'manage' })).toThrow(/died here/)
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
      const again = d2.orch.mcpToolHost().queueCommand!(w.other.id, { op: 'enqueue', content: 'retyped', mode: 'agent', expectedRevision: 'whatever' }, { clientRequestId: 'queue_enqueue:caller:1', actor, level: 'manage' })
      expect(again).toMatchObject({ replayed: true, outcome: 'enqueued', item: { id: item[0].id } })
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

    it('a queued agent message keeps its sender and mode limit through a person\'s edit and a reorder; another agent\'s edit makes it that agent\'s, never under a looser mode; it runs under the limit it carries', async () => {
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

      // A person's edit changes the words only: whose message it is and what it may do stay.
      const edited = w.d.orch.editQueuedItem(target.id, ids.item, { content: `${queued.content}\n\n(and keep a backup)` })
      expect(edited).toMatchObject({ source: 'mcp', permissionMode: 'ask', origin: queued.origin })
      expect(w.queue(target.id).find((item) => item.id === ids.item)).toMatchObject({ permissionMode: 'ask', origin: queued.origin })

      await w.d.orch.send(GO, false, { threadId: fullCaller.id, clientRequestId: 'go-full' })
      expect(verdict(seen.reorder)).toBe('ok')
      expect(verdict(seen.widen)).toBe('mousse_scope_denied')
      expect(verdict(seen.edit)).toBe('ok')
      const rewritten = w.queue(target.id).find((item) => item.id === ids.item)!
      // The words are the full-mode agent's now, said so on the message; the limit is the stricter of the two, and it only tightens.
      expect(rewritten.content).toBe(agentMessageText(fullCaller.id, 'Full caller', 'run the migration, and drop the old tables'))
      expect(rewritten).toMatchObject({ permissionMode: 'ask', origin: { kind: 'agent', threadId: fullCaller.id, hops: 1 } })
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

    it('an agent cannot hand a person\'s or another agent\'s message words of its own below manage, nor change a scheduled prompt at all', async () => {
      const seen: Record<string, Response> = {}
      const ids: Record<string, string> = {}
      const w = world(async (input, mcp) => {
        if (input.threadId !== w.parent.id || input.prompt !== GO) return 'ok'
        const rev = async () => (await list(mcp!)).revision
        seen.person = await call(mcp!, 'queue_edit', { itemId: ids.typed, content: 'mine now', expectedRevision: await rev() })
        seen.other = await call(mcp!, 'queue_edit', { itemId: ids.agent, content: 'mine now', expectedRevision: await rev() })
        seen.schedule = await call(mcp!, 'queue_edit', { itemId: ids.schedule, content: 'mine now', expectedRevision: await rev() })
        return 'ok'
      }, 'read')
      await w.attach()
      // The parent's own queue while it runs: a typed message, one another thread's agent sent, and a scheduled prompt.
      const seed = deferred()
      void seed
      w.d.orch.bindThread(w.parent.id, [], undefined, [])
      const typed = w.typed(w.parent.id, 'typed by the user')
      const agent = w.d.orch.enqueueForThread(w.parent.id, { content: 'from someone else' }, { source: 'mcp', origin: { kind: 'agent', threadId: w.other.id, runId: 'run:x', hops: 1 }, permissionMode: 'ask' })
      const scheduled = w.d.orch.enqueueForThread(w.parent.id, { content: 'nightly report' }, { source: 'schedule', origin: { kind: 'schedule', jobId: 'job-1', occurrenceKey: 'k-1' } })
      Object.assign(ids, { typed: typed.id, agent: agent.id, schedule: scheduled.id })
      const before = w.queue(w.parent.id).map((item) => [item.id, item.content])
      await w.d.orch.send(GO, false, { threadId: w.parent.id, clientRequestId: 'go' })
      expect(verdict(seen.person)).toBe('mousse_scope_denied')
      expect(verdict(seen.other)).toBe('mousse_scope_denied')
      // A scheduled prompt keeps the text of its job whatever the level: refused as a message that cannot be edited.
      expect(verdict(seen.schedule)).toBe('error')
      expect(seen.schedule.result?.content?.[0].text).toMatch(/scheduled prompt/)
      expect(before).toHaveLength(3)
      // Nothing was edited: the same three messages were queued behind the turn, and ran as they were.
      await waitFor(() => w.turnsOf(w.parent.id).length === 4, 'the three queued turns', 30_000)
      expect(w.turnsOf(w.parent.id).slice(1).map((turn) => turn.prompt).sort()).toEqual(['from someone else', 'nightly report', 'typed by the user'].sort())
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
      expect(seen.askIntoFull.error).toMatchObject({ code: MCP_ERROR_CODES.mousse_conflict, data: { conflict: 'ceiling_exceeded', callerMode: 'ask', targetMode: 'full' } })
      // The ask caller's own mode is no bar to a run that is as strict.
      expect(parse(seen.askIntoAsk)).toMatchObject({ outcome: 'promoted', itemId: ids.typedAsk })
      await w.d.orch.send(GO, false, { threadId: fullCaller.id, clientRequestId: 'go-full' })
      expect(seen.limitedIntoFull.error).toMatchObject({ code: MCP_ERROR_CODES.mousse_conflict, data: { conflict: 'ceiling_exceeded', callerMode: 'ask', targetMode: 'full' } })
      // The message is promoted already (the ask agent did it); the full caller finds it steering.
      expect(seen.fullIntoAsk.error).toMatchObject({ code: MCP_ERROR_CODES.mousse_conflict, data: { conflict: 'item_steering' } })

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
      expect(seen.replaced.error).toMatchObject({ code: MCP_ERROR_CODES.mousse_conflict, data: { conflict: 'run_not_active', expectedRunId: a.runId, activeRunId: b.runId } })
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
      expect(seen.paused.error).toMatchObject({ code: MCP_ERROR_CODES.mousse_conflict, data: { conflict: 'run_paused', expectedRunId: sent.runId } })
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
        ids.item = w.d.orch.enqueueForThread(askTarget.id, { content: 'written by an agent' }, { source: 'mcp', permissionMode: 'ask', origin: { kind: 'agent', threadId: fullCaller.id, runId: 'run:full', hops: 1 } }).id
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
        expect(w.messages(askTarget.id).filter((message) => message.origin && !message.steered).map((message) => message.origin)).toEqual([expect.objectContaining({ threadId: fullCaller.id })])
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

  describe('limits on what agents put in a thread\'s queue (the caps of thread_send)', () => {
    it('a thread keeps three queued messages from agents, whether they were sent or queued: the fourth is refused, and so is an edit that would make a person\'s message the fourth; a person\'s Stop clears them', async () => {
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
      expect(seen[3].error).toMatchObject({ code: MCP_ERROR_CODES.mousse_conflict, data: { conflict: 'agent_queue_full' } })
      expect(seen[4].error).toMatchObject({ code: MCP_ERROR_CODES.mousse_conflict, data: { conflict: 'agent_queue_full' } })
      expect(w.queue(w.other.id).map((item) => item.origin?.kind)).toEqual([undefined, 'agent', 'agent', 'agent'])
      expect(w.queue(w.other.id)[0].content).toBe('a note I typed')

      // A person presses Stop: the running turn ends and the agents' queued messages go with it; theirs stays.
      await w.d.orch.stopThread(w.other.id, 'user')
      await waitFor(() => w.queue(w.other.id).every((item) => item.origin === undefined), 'the agent messages to be cleared')
      expect(w.queue(w.other.id).map((item) => item.content)).toEqual(['a note I typed'])
      release.resolve()
    })

    it('the chain of agent messages in a row has a limit that queueing and editing respect: a run that is the third hop cannot queue or edit another agent\'s message', async () => {
      const w = world(async () => 'ok')
      await w.attach()
      const third = w.d.engine.store.createRun({ threadId: w.parent.id, source: 'mcp', outcome: { sentByAgent: true, agentHops: 3 } })
      const second = w.d.engine.store.createRun({ threadId: w.parent.id, source: 'mcp', outcome: { sentByAgent: true, agentHops: 2 } })
      const typed = w.typed(w.other.id, 'a note I typed')
      const host = w.d.orch.mcpToolHost()
      const actor = (runId: string) => ({ kind: 'agent' as const, threadId: w.parent.id, runId, toolCallId: 'mcp:t' })
      const revision = () => host.queueSnapshot!(w.other.id).revision
      const options = (runId: string, key: string) => ({ clientRequestId: key, actor: actor(runId), level: 'manage' as const })
      expect(() => host.queueCommand!(w.other.id, { op: 'enqueue', content: 'one hop too many', mode: 'agent', expectedRevision: revision() }, options(third.runId, 'k1')))
        .toThrow(expect.objectContaining({ code: 'agent_hops_exceeded' }))
      expect(() => host.queueCommand!(w.other.id, { op: 'edit', itemId: typed.id, content: 'one hop too many', expectedRevision: revision() }, options(third.runId, 'k2')))
        .toThrow(expect.objectContaining({ code: 'agent_hops_exceeded' }))
      expect(w.queue(w.other.id).map((item) => item.content)).toEqual(['a note I typed'])
      // The second hop may: its message is the third, and it carries the count.
      const ok = host.queueCommand!(w.other.id, { op: 'enqueue', content: 'the third hop', mode: 'agent', expectedRevision: revision() }, options(second.runId, 'k3'))
      expect(ok.item?.origin).toMatchObject({ kind: 'agent', hops: 3 })
    })
  })
})

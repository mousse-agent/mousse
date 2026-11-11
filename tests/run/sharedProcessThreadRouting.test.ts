/**
 * One provider process serves several threads (Codex runs one app-server per profile). Its output events run in the
 * async context of the turn that spawned it, as a child's stdout does, so a turn's events must reach its own thread
 * whatever context delivers them: the sink, control and context calls a runtime makes belong to the turn they were
 * given to, never to the thread that happened to start the process.
 */
import { AsyncResource } from 'node:async_hooks'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import { currentWorkScope, threadScope, type WorkScope } from '../../src/mms/execution/workScope'
import type { AdapterHost, ProviderAdapter, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import { CursorHostClient, type CursorHostTransport } from '../../src/mms/harness/cursor/hostClient'
import { CursorSessions, type SavedCursorAgent } from '../../src/mms/harness/cursor/session'
import { CursorAdapter } from '../../src/mms/harness/drivers/cursor/adapter'
import type { OrchestratorService } from '../../src/mms/orchestrator/OrchestratorService'
import { FakeCursorHost } from '../harness/fakeCursorHost'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import { createOrchestrator, waitFor } from './phase6Fixture'

/** A runtime whose one process outlives turns and threads, its output delivered in the spawning turn's context. */
class SharedProcessAdapter implements ProviderAdapter {
  readonly driver = 'pi' as const
  readonly capabilities = PI_TEST_CAPABILITIES
  /** The process's output pipe: created by the first turn, as `spawn` creates it. */
  private stdout: AsyncResource | undefined
  /** Each turn's sink, by prompt: a test may call one after its turn ended. */
  readonly sinks = new Map<string, TurnSink>()
  /** Runs inside a turn whose prompt it names, before the turn replies. */
  readonly during = new Map<string, () => Promise<void> | void>()

  configured(): boolean {
    return true
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.sinks.set(input.prompt, sink)
    await this.during.get(input.prompt)?.()
    this.stdout ??= new AsyncResource('SharedProcessStdout')
    const stdout = this.stdout
    const reply = `Reply to ${input.prompt}`
    sink.providerRef({ provider: input.llmProvider, model: input.model, sessionId: `native-${input.threadId}` })
    // The process answers later, on its own output.
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    stdout.runInAsyncScope(() => {
      sink.thinking({ phase: 'start', content: '' })
      sink.thinking({ phase: 'complete', content: `Thinking about ${input.prompt}` })
      sink.tool({ kind: 'mcp_tool_call', phase: 'start', callId: `cmd-${input.prompt}`, title: `Running sleep for ${input.prompt}`, summary: 'Bash', details: [] })
      sink.tool({ kind: 'mcp_tool_call', phase: 'complete', callId: `cmd-${input.prompt}`, title: `Running sleep for ${input.prompt}`, summary: 'Bash', details: [] })
      sink.text({ phase: 'start', content: '', contentIndex: 0 })
      sink.text({ phase: 'delta', content: reply, contentIndex: 0 })
      sink.text({ phase: 'complete', content: reply, contentIndex: 0 })
      host.context.nativeHistoryAfterTurn(reply)
    })
    return {
      text: reply,
      aborted: false,
      modelName: 'Shared',
      totalResponseTimeMs: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextSignature: 'shared',
      nativeMessages: [],
      providerRef: { provider: input.llmProvider, model: input.model, sessionId: `native-${input.threadId}` }
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

describe('a provider process shared by threads', () => {
  let home: string
  let store: ThreadDataStore
  let orch: OrchestratorService
  let adapter: SharedProcessAdapter

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-shared-proc-'))
    process.env.MOUSSE_HOME = home
    store = new ThreadDataStore(new ProjectManager())
    adapter = new SharedProcessAdapter()
    orch = createOrchestrator(home, store, [adapter])
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  const texts = (threadId: string): string[] =>
    orch.getMessages(threadId).map((message) => `${message.content ?? ''}${message.thinking?.content ?? ''}${message.toolCall?.title ?? ''}`)

  it('saves each turn in its own thread, not in the thread whose turn started the process', async () => {
    const a = store.createThread('A')
    const b = store.createThread('B')
    const c = store.createThread('C')

    await orch.send('first in A', false, { threadId: a.id })
    await orch.send('first in B', false, { threadId: b.id })
    await orch.send('first in C', false, { threadId: c.id })

    for (const [thread, prompt] of [[a, 'first in A'], [b, 'first in B'], [c, 'first in C']] as const) {
      const own = texts(thread.id)
      expect(own).toContain(`Reply to ${prompt}`)
      expect(own).toContain(`Thinking about ${prompt}`)
      expect(own).toContain(`Running sleep for ${prompt}`)
      // Nothing of another thread's turn.
      for (const other of ['first in A', 'first in B', 'first in C'].filter((entry) => entry !== prompt))
        expect(own.filter((text) => text.includes(other))).toEqual([])
    }
    // Every turn ended: no thread is left working, and no row is left open.
    for (const thread of [a, b, c]) {
      expect(orch.isTurnActive(thread.id)).toBe(false)
      expect(orch.getMessages(thread.id).filter((message) => message.toolCall?.status === 'running' || message.thinking?.status === 'processing')).toEqual([])
    }
  })

  it('keeps a later turn in its own thread while the first thread runs again', async () => {
    const a = store.createThread('A')
    const b = store.createThread('B')
    await orch.send('opening in A', false, { threadId: a.id })
    await Promise.all([
      orch.send('again in A', false, { threadId: a.id }),
      orch.send('meanwhile in B', false, { threadId: b.id })
    ])
    expect(texts(a.id).filter((text) => text.includes('meanwhile in B'))).toEqual([])
    expect(texts(b.id)).toContain('Reply to meanwhile in B')
    expect(texts(a.id)).toContain('Reply to again in A')
  })

  it("runs a turn's events in that turn's work scope, not in the scope of the thread that started the process", async () => {
    const a = store.createThread('A')
    const b = store.createThread('B')
    /** The work scope each tool event was handled in: work it starts is counted under that scope's threads. */
    const scopes: Array<{ title: string | undefined; scope: WorkScope | null }> = []
    const internals = orch as unknown as { handleStreamingToolEvent(event: { title?: string }): void }
    const handle = internals.handleStreamingToolEvent.bind(orch)
    internals.handleStreamingToolEvent = (event) => {
      scopes.push({ title: event.title, scope: currentWorkScope() })
      handle(event)
    }

    await orch.send('first in A', false, { threadId: a.id })
    await orch.send('first in B', false, { threadId: b.id })

    const ofB = scopes.filter((entry) => entry.title?.includes('first in B'))
    expect(ofB).toHaveLength(2)
    for (const entry of ofB) expect(entry.scope).toEqual(threadScope(b.id))
    for (const entry of scopes.filter((item) => item.title?.includes('first in A'))) expect(entry.scope).toEqual(threadScope(a.id))
  })

  it('drops a call a runtime makes for a turn that ended, while a newer turn runs in the thread', async () => {
    const a = store.createThread('A')
    await orch.send('first in A', false, { threadId: a.id })
    const stale = adapter.sinks.get('first in A')!
    let during: string[] = []
    adapter.during.set('second in A', () => {
      // The newer turn has its assistant row open when the ended turn's sink is called.
      const sink = adapter.sinks.get('second in A')!
      sink.text({ phase: 'start', content: '', contentIndex: 0 })
      sink.text({ phase: 'delta', content: 'Partial reply', contentIndex: 0 })
      stale.text({ phase: 'delta', content: 'LATE text of the first turn', contentIndex: 0 })
      stale.thinking({ phase: 'complete', content: 'LATE thinking of the first turn' })
      stale.tool({ kind: 'mcp_tool_call', phase: 'start', callId: 'late-cmd', title: 'LATE command of the first turn', summary: 'Bash', details: [] })
      during = texts(a.id)
    })
    await orch.send('second in A', false, { threadId: a.id })

    expect(during).toContain('Partial reply')
    expect(during.filter((text) => text.includes('LATE'))).toEqual([])
    expect(texts(a.id).filter((text) => text.includes('LATE'))).toEqual([])
    expect(texts(a.id)).toContain('Reply to second in A')
    expect(orch.isTurnActive(a.id)).toBe(false)
  })
})

describe("Cursor's one host shared by threads", () => {
  let home: string
  let store: ThreadDataStore
  let orch: OrchestratorService
  let host: FakeCursorHost
  let client: CursorHostClient

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-shared-cursor-'))
    process.env.MOUSSE_HOME = home
    store = new ThreadDataStore(new ProjectManager())
    // Each run streams its thinking and reply, naming its prompt, after its send is answered.
    host = new FakeCursorHost({
      create: (_params, fake) => ({ agentId: `agent-${fake.calls('create').length}` }),
      send: (params, fake) => {
        const runId = `run-${fake.calls('send').length}`
        const prompt = String(params.text ?? '')
        setTimeout(() => fake.emit({ event: 'delta', runId, update: { type: 'thinking-delta', text: `Thinking about ${prompt}` } }), 2)
        setTimeout(() => fake.emit({ event: 'delta', runId, update: { type: 'text-delta', text: `Reply to ${prompt}` } }), 3)
        setTimeout(() => fake.emit({ event: 'run_end', runId, status: 'finished' }), 5)
        return { runId }
      }
    })
    // The host writes every line from the context it was started in: the first chat that needed it.
    client = new CursorHostClient((): CursorHostTransport => {
      const transport = host.connect()
      const stdout = new AsyncResource('CursorHostStdout')
      return { ...transport, onLine: (listener) => transport.onLine((line) => stdout.runInAsyncScope(() => listener(line))) }
    })
    const saved = new Map<string, SavedCursorAgent>()
    const sessions = new CursorSessions({
      label: 'Cursor',
      host: client,
      storeDir: join(home, 'cursor-store'),
      apiKey: () => 'key',
      settingSources: [],
      store: {
        saved: (threadId) => saved.get(threadId),
        threads: () => [...saved.keys()],
        setSaved: (threadId, next) => void (next ? saved.set(threadId, next) : saved.delete(threadId))
      },
      markSignedOut: () => undefined,
      signInRequiredMessage: 'sign in'
    })
    const cursor = new CursorAdapter(() => ({
      chat: (input) => sessions.chat(input),
      commitConversation: (threadId, history) => sessions.commitConversation(threadId, history),
      configured: () => true,
      interrupt: (agentId) => sessions.interrupt(agentId)
    }))
    // The real Cursor adapter, served under the test's default model; a thread without a project runs in `home`.
    const served: ProviderAdapter = {
      driver: 'pi',
      capabilities: PI_TEST_CAPABILITIES,
      configured: () => true,
      startTurn: (input, sink, ctl, adapterHost) => cursor.startTurn({ ...input, cwd: input.cwd ?? home }, sink, ctl, adapterHost),
      interrupt: (id) => cursor.interrupt(id)
    }
    orch = createOrchestrator(home, store, [served])
  })

  afterEach(() => {
    client.stop()
    rmSync(home, { recursive: true, force: true })
    delete process.env.MOUSSE_HOME
  })

  const texts = (threadId: string): string[] =>
    orch.getMessages(threadId).map((message) => `${message.content ?? ''}${message.thinking?.content ?? ''}`)

  it("saves a second thread's run in that thread, not in the thread that started the host", async () => {
    const a = store.createThread('A')
    const b = store.createThread('B')
    await orch.send('first in A', false, { threadId: a.id })
    await orch.send('first in B', false, { threadId: b.id })
    await waitFor(() => !orch.isTurnActive(a.id) && !orch.isTurnActive(b.id), 'both turns to end')

    expect(host.transports).toHaveLength(1)
    expect(texts(b.id).some((text) => text.includes('Reply to first in B'))).toBe(true)
    expect(texts(b.id).some((text) => text.includes('Thinking about first in B'))).toBe(true)
    expect(texts(a.id).filter((text) => text.includes('first in B'))).toEqual([])
    expect(texts(b.id).filter((text) => text.includes('first in A'))).toEqual([])
  })
})

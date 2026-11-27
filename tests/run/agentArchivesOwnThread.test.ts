/**
 * A thread's agent archives its own thread when the user asks it to ("archive yourself when done"): a real
 * `OrchestratorService`, Run Engine and effect worker, with a scripted provider whose turn calls `thread_archive`
 * through the Mousse MCP registry, as a provider does. The thread is archived only after the turn ends well, through the
 * app's own Archive; a turn that fails or is stopped, a message waiting in the queue, or a turn no person started leave it
 * open. Another thread it names is archived at once.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import type { AdapterHost, ProviderAdapter, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import type { ChatMessage } from '../../src/shared/types'
import { ARCHIVE_AFTER_TURN_KEPT } from '../../src/mms/orchestrator/OrchestratorService'
import { appTurn } from './appToolsFixture'
import { phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'

vi.setConfig({ testTimeout: 60_000 })

const MODEL = { llmProvider: 'claude-subscription', model: 'vendor-model' }

/** What the scripted turn does after it called `thread_archive`. */
type After = 'reply' | 'fail' | 'hold'

/** A provider whose turn for a prompt starting with "archive" calls `thread_archive`, then does `after`. */
class ArchivingAdapter implements ProviderAdapter {
  readonly driver = 'claude' as const
  readonly capabilities = CLAUDE_SUBSCRIPTION_CAPABILITIES
  readonly prompts: string[] = []
  /** What each `thread_archive` call answered, in order. */
  readonly answers: Array<{ text: string; isError?: boolean }> = []
  after: After = 'reply'
  /** Called with the turn's ids once its `thread_archive` answered, before the turn goes on. */
  onArchived: ((threadId: string) => Promise<void> | void) | undefined
  /** Lets a turn for a prompt starting with "wait" end with its reply; it waits until then. */
  release: (() => void) | undefined
  constructor(private readonly daemon: () => Phase6Daemon) {}

  configured(): boolean {
    return true
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.prompts.push(input.prompt)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    if (input.prompt.startsWith('archive')) {
      const orch = this.daemon().orch
      if (!orch.appToolTurns.get(input.runId)) orch.appToolTurns.register(appTurn({ threadId: input.threadId, runId: input.runId }))
      const answer = await orch.mcpToolRegistry().call('thread_archive', {}, {
        credential: { threadId: input.threadId, runId: input.runId, provider: 'claude', accessLevel: 'lineage', binding: 'drained_turn', current: () => true },
        toolCallId: `call-${this.prompts.length}`,
        signal: input.signal
      }).catch((error: Error) => ({ text: error.message, isError: true }))
      this.answers.push(answer)
      await this.onArchived?.(input.threadId)
      if (this.after === 'fail') throw new Error('provider failed')
      if (this.after === 'hold') {
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve()
          else input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return { text: '', aborted: true, modelName: 'Scripted', totalResponseTimeMs: 1, contextSignature: 'scripted', nativeMessages: [], providerRef }
      }
    }
    if (input.prompt.startsWith('wait')) {
      await new Promise<void>((resolve) => {
        this.release = resolve
        if (input.signal.aborted) resolve()
        else input.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      if (input.signal.aborted) return { text: '', aborted: true, modelName: 'Scripted', totalResponseTimeMs: 1, contextSignature: 'scripted', nativeMessages: [], providerRef }
    }
    const text = `reply to ${input.prompt}`
    sink.text({ phase: 'complete', content: text, contentIndex: 0 })
    host.context.nativeHistoryAfterTurn(text)
    return { text, aborted: false, modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted', nativeMessages: [], providerRef }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

describe('a thread\'s agent archives its own thread when its turn ends', () => {
  let home: string | undefined
  let previousHome: string | undefined
  let daemon: Phase6Daemon | undefined

  afterEach(async () => {
    await daemon?.stop().catch(() => undefined)
    daemon = undefined
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  const world = () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-archive-own-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    mkdirSync(join(home, 'project'))
    const adapter = new ArchivingAdapter(() => d)
    const d = phase6Daemon(home, [adapter])
    daemon = d
    const project = d.projects.openProject(join(home, 'project'))
    const thread = d.store.createThread('Done work', project.id)
    d.orch.setThreadModelOverride(thread.id, MODEL)
    let sends = 0
    // As the app's composer sends (`source: 'gui'`): a person's message. `internal`: what no person sent.
    const send = (text: string, source = 'gui') => d.orch.send(text, false, { threadId: thread.id, clientRequestId: `send-${++sends}`, source })
    const archived = () => Boolean(d.store.getThread(thread.id)?.archivedAt)
    const actions = () => d.engine.store.listEvents(thread.id).filter((event) => event.type === 'agent.action').map((event) => (event.payload as { action: string }).action)
    const lines = () => d.orch.getOrCreateSession(thread.id).messages.filter((message: ChatMessage) => message.role === 'system').map((message) => message.content)
    const idle = () => waitFor(() => !d.orch.isActiveTurnRunning(thread.id) && d.engine.getActiveRun(thread.id) === null, 'turn ended')
    return { d, adapter, thread, send, archived, actions, lines, idle }
  }

  /** Long enough for the archive that follows a turn's end, had it been going to happen. */
  const afterTurnEnd = () => new Promise((resolve) => setTimeout(resolve, 150))

  it('a person\'s turn that asks is archived once it ends well, through the app\'s Archive, not while it still runs', async () => {
    const w = world()
    const archivedEvents: string[] = []
    w.d.orch.on('thread-archived', (event: { threadId: string }) => archivedEvents.push(event.threadId))
    let archivedDuringTurn: boolean | undefined
    w.adapter.onArchived = () => { archivedDuringTurn = w.archived() }
    await w.send('archive yourself when done')
    await waitFor(() => w.archived(), 'archived after the turn')

    expect(w.adapter.answers).toEqual([expect.objectContaining({ text: expect.stringContaining('after_this_turn') })])
    expect(w.adapter.answers[0]!.isError).toBeFalsy()
    // Not while the turn still ran: its reply was written first.
    expect(archivedDuringTurn).toBe(false)
    expect(w.d.orch.getOrCreateSession(w.thread.id).messages.some((message) => message.role === 'assistant' && message.content.includes('reply to archive'))).toBe(true)
    // The app's own Archive: the pull request watch hears it, and the change is recorded as the agent's.
    expect(archivedEvents).toEqual([w.thread.id])
    expect(w.actions()).toEqual(['archived_thread'])
  })

  it('a message sent while the turn ran keeps the thread open, says why, and runs', async () => {
    const w = world()
    w.adapter.onArchived = async () => {
      const queued = await w.send('one more thing')
      expect(queued.queued).toBe(true)
    }
    await w.send('archive yourself when done')
    await waitFor(() => w.adapter.prompts.includes('one more thing'), 'queued message ran')
    await w.idle()
    await afterTurnEnd()
    expect(w.archived()).toBe(false)
    expect(w.lines()).toContain(ARCHIVE_AFTER_TURN_KEPT)
    expect(w.actions()).toEqual([])
  })

  it('a subagent\'s queued turn keeps the thread open, and the subagent runs it', async () => {
    const w = world()
    const child = w.d.store.createThread('Worker', w.thread.projectId, undefined, { lineage: { parentThreadId: w.thread.id, rootThreadId: w.thread.id, relationship: 'subagent' } })
    w.d.orch.setThreadModelOverride(child.id, MODEL)
    // Queued on the subagent while the parent's turn runs, not started yet.
    w.adapter.onArchived = () => { w.d.orch.enqueueForThread(child.id, { content: 'child work' }, { source: 'internal', internal: true }) }
    await w.send('archive yourself when done')
    await w.idle()
    await afterTurnEnd()
    expect(w.archived()).toBe(false)
    expect(w.lines()).toContain(ARCHIVE_AFTER_TURN_KEPT)
    w.d.orch.resumeThreadQueue(child.id)
    await waitFor(() => w.adapter.prompts.includes('child work'), 'the subagent ran its queued turn')
  })

  it('a thread it launched that is still working keeps the thread open, and its run goes on', async () => {
    const w = world()
    const launched = w.d.store.createThread('Launched', w.thread.projectId, undefined, { started: true, createdByThreadId: w.thread.id })
    const run = w.d.engine.store.createRun({ threadId: launched.id, source: 'mcp', outcome: { sentByAgent: true, agentHops: 1 } })
    w.d.engine.markStarting(run.runId)
    w.d.engine.markRunning(run.runId)
    await w.send('archive yourself when done')
    await w.idle()
    await afterTurnEnd()
    expect(w.archived()).toBe(false)
    expect(w.lines()).toContain(ARCHIVE_AFTER_TURN_KEPT)
    expect(w.d.engine.getRun(run.runId)).toMatchObject({ status: 'running' })
    expect(w.d.engine.getRun(run.runId)?.outcome?.stopRequested).toBeFalsy()
  })

  it('a background command the provider still runs keeps the thread open', async () => {
    const w = world()
    w.adapter.onArchived = () => { w.d.orch.setProviderBackgroundWork(w.thread.id, true) }
    await w.send('archive yourself when done')
    await w.idle()
    await afterTurnEnd()
    expect(w.archived()).toBe(false)
    expect(w.lines()).toContain(ARCHIVE_AFTER_TURN_KEPT)
  })

  it('a turn started while the other computers are asked about its launches keeps the thread open, and runs on', async () => {
    const w = world()
    // The question to the other computers is the one wait before the archive: a person's message starts a turn meanwhile.
    let answer: ((working: number) => void) | undefined
    const asked = new Promise<void>((resolve) => {
      vi.spyOn((w.d.orch as unknown as { remoteThreads: { working: (id: string) => Promise<number> } }).remoteThreads, 'working').mockImplementation(() => {
        resolve()
        return new Promise<number>((done) => { answer = done })
      })
    })
    await w.send('archive yourself when done')
    await asked
    const sent = w.send('wait for this')
    await waitFor(() => w.adapter.release !== undefined, 'the new turn running')
    answer!(0)
    await afterTurnEnd()
    expect(w.archived()).toBe(false)
    expect(w.lines()).toContain(ARCHIVE_AFTER_TURN_KEPT)
    w.adapter.release!()
    await sent
    await w.idle()
    expect(w.d.orch.getOrCreateSession(w.thread.id).messages.some((message) => message.role === 'assistant' && message.content === 'reply to wait for this')).toBe(true)
  })

  it('a turn that fails after asking leaves the thread open', async () => {
    const w = world()
    w.adapter.after = 'fail'
    await w.send('archive yourself when done').catch(() => undefined)
    await w.idle()
    await afterTurnEnd()
    expect(w.adapter.answers[0]!.isError).toBeFalsy()
    expect(w.archived()).toBe(false)
  })

  it('a turn stopped after asking leaves the thread open', async () => {
    const w = world()
    w.adapter.after = 'hold'
    const sent = w.send('archive yourself when done')
    await waitFor(() => w.adapter.answers.length === 1, 'tool answered')
    await w.d.orch.stopThread(w.thread.id)
    await sent.catch(() => undefined)
    await w.idle()
    await afterTurnEnd()
    expect(w.archived()).toBe(false)
  })

  it('a turn no person started is refused, and the thread stays open', async () => {
    const w = world()
    await w.send('archive yourself when done', 'internal')
    await w.idle()
    await afterTurnEnd()
    expect(w.adapter.answers).toEqual([expect.objectContaining({ isError: true, text: expect.stringContaining('"lacks":"person"') })])
    expect(w.archived()).toBe(false)
  })

  it('archives another thread it names at once, while its own turn goes on', async () => {
    const w = world()
    const other = w.d.store.createThread('Someone else\'s work', w.d.store.getThread(w.thread.id)!.projectId)
    w.adapter.onArchived = undefined
    const orch = w.d.orch
    // A call that names another thread, from inside a person's running turn.
    w.adapter.after = 'hold'
    const sent = w.send('archive yourself when done')
    await waitFor(() => w.adapter.answers.length === 1, 'turn running')
    const runId = w.d.engine.getActiveRun(w.thread.id)!.runId
    const archived = await orch.mcpToolRegistry().call('thread_archive', { threadId: other.id }, {
      credential: { threadId: w.thread.id, runId, provider: 'claude', accessLevel: 'lineage', binding: 'drained_turn', current: () => true },
      toolCallId: 'call-other',
      signal: new AbortController().signal
    })
    expect(archived.isError).toBeFalsy()
    expect(JSON.parse(archived.text)).toMatchObject({ threadId: other.id, archived: true, changed: true })
    expect(w.d.store.getThread(other.id)?.archivedAt).toBeDefined()
    expect(w.d.engine.getActiveRun(w.thread.id)?.runId).toBe(runId)
    await orch.stopThread(w.thread.id)
    await sent.catch(() => undefined)
    await w.idle()
    expect(w.archived()).toBe(false)
  })
})

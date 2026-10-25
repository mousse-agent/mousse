/**
 * Issue #142: a Claude subagent's background helper outlives its turn, and the parent hears about
 * the helper's result through a continuation run of the subagent. A real orchestrator, run engine,
 * effect worker, Claude adapter and provider service; only the Claude Code process is replaced
 * (`FakeClaudeCli`). The parent is a scripted adapter.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DelegationToolHost } from '../../src/mms/orchestrator/LlmClient'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { ClaudeSubscriptionAdapter } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import { Reconciler } from '../../src/mms/run/Reconciler'
import { ThreadRuntimeManager } from '../../src/mms/runtime/ThreadRuntimeManager'
import { FakeClaudeCli, notification, resultFrame, roster, textDelta } from './fakeClaudeCli'
import { phase6Daemon, waitFor } from './phase6Fixture'
import { ScriptedPi, type Json } from './subagentWorld'

describe('Claude background helpers through the orchestrator (issue #142)', () => {
  let home: string | undefined
  let previousHome: string | undefined
  const stops: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await Promise.resolve(stop()).catch(() => undefined)
    vi.restoreAllMocks()
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  /** The parent starts the Claude subagent "Builder", whose first turn starts a background shell and ends. */
  const scene = async (options: { manager?: ThreadRuntimeManager } = {}) => {
    home = mkdtempSync(join(tmpdir(), 'mousse-claude-helpers-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const binary = join(home, 'claude')
    writeFileSync(binary, 'fixture')
    chmodSync(binary, 0o755)
    mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
    writeFileSync(join(home, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))

    const cli = new FakeClaudeCli()
    cli.reply = (message, process) => {
      const text = process.text(process.inputs.length - 1)
      if (text.includes('Review Builder')) process.emit(roster({ id: 'build-1' }))
      process.answer(String(message.uuid), 'Started the build.')
    }
    const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      query: cli.query,
      runAuth: vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    })
    stops.push(() => service.stop())

    const out: Json = {}
    let parentId = ''
    const parentTurns: string[] = []
    const parentAdapter = new ScriptedPi(async (input, delegation: DelegationToolHost | undefined) => {
      if (input.threadId !== parentId) throw new Error('only the parent runs on the scripted adapter')
      parentTurns.push(input.prompt)
      if (input.prompt === 'go')
        out.builder = await delegation!.delegateTask(
          { prompt: 'Review Builder', title: 'Builder', workspace: 'shared', role: 'research', instanceId: 'claude', model: 'sonnet' } as never,
          { toolCallId: 'start:Builder' }
        )
      return 'Parent done.'
    })
    const d = phase6Daemon(home, [parentAdapter, new ClaudeSubscriptionAdapter(() => service)])
    stops.push(d.stop)
    d.orch.setClaudeSubscriptionProvider(service)
    if (options.manager) d.orch.setRuntimeManager(options.manager)
    const parent = d.store.createThread('Parent')
    parentId = parent.id
    const reconciler = new Reconciler({ store: d.engine.store, outbox: d.engine.outbox, tools: d.engine.tools, capabilitiesFor: (id) => d.orch.capabilitiesForThread(id) })

    await d.orch.send('go', false, { threadId: parent.id, clientRequestId: 'go' })
    const builder = out.builder as Json
    await waitFor(() => d.engine.getRun(builder.childRunId)?.status === 'completed', 'the Builder\'s first turn')
    const task = () => d.engine.delegations.get(builder.delegationId)!
    return { d, cli, service, parent, builder, task, reconciler, parentTurns, childThread: builder.childThreadId as string }
  }

  it('a helper outlives the turn, and its result reaches the parent through a continuation run', async () => {
    const s = await scene()
    // The Builder ended its turn but its shell still runs: the task is not finished and the parent is not woken.
    expect(s.service.hasBackgroundWork(s.childThread)).toBe(true)
    expect(s.task().status).toBe('running')
    expect(s.reconciler.runOnce().wakes.wakes).toEqual([])
    expect(s.parentTurns).toEqual(['go'])

    // The shell finishes; Claude starts a turn of its own to read the report.
    s.cli.last.emit(notification('build-1'), textDelta('The build passed.'), resultFrame({ text: 'The build passed.', origin: 'task-notification' }))
    await waitFor(() => s.task().status !== 'running', 'the task to publish')
    const runs = s.d.engine.listRuns(s.childThread)
    expect(runs.map((run) => run.source)).toContain('provider-continuation')
    const continuation = runs.find((run) => run.source === 'provider-continuation')!
    expect(continuation.status).toBe('completed')
    expect(s.task()).toMatchObject({ status: 'result_available', result: { runStatus: 'completed', text: 'The build passed.', runId: continuation.runId } })
    expect(s.service.hasBackgroundWork(s.childThread)).toBe(false)
    expect(s.cli.processes).toHaveLength(1)

    // The parent is woken once, with the helper's result.
    const wake = s.reconciler.runOnce().wakes.wakes[0]
    await waitFor(() => s.d.engine.getRun(wake)?.status === 'completed', 'the parent\'s wake')
    expect(s.parentTurns).toHaveLength(2)
    expect(s.parentTurns[1]).toContain('The build passed.')
    expect(s.reconciler.runOnce().wakes.wakes).toEqual([])
  })

  it('a wake with no model turn ends the continuation run, and the task settles with the subagent\'s last words', async () => {
    const s = await scene()
    s.cli.last.emit(notification('build-1'), resultFrame({ text: '', origin: 'task-notification', numTurns: 0 }))
    await waitFor(() => s.task().status !== 'running', 'the task to publish')
    const continuation = s.d.engine.listRuns(s.childThread).find((run) => run.source === 'provider-continuation')!
    expect(continuation.status).toBe('completed')
    expect(s.task().result?.runStatus).toBe('completed')
    expect(s.service.hasBackgroundWork(s.childThread)).toBe(false)
  })

  it('Stop on a thread whose turn already ended ends its background work and releases the task', async () => {
    const s = await scene()
    expect(s.service.hasBackgroundWork(s.childThread)).toBe(true)
    expect(await s.d.orch.stopProviderWork(s.childThread)).toBe(true)
    expect(s.cli.last.closed).toBe(true)
    expect(s.service.hasBackgroundWork(s.childThread)).toBe(false)
    // Nothing is left to wait for, so the task publishes the subagent's last words.
    await waitFor(() => s.task().status !== 'running', 'the task to publish')
    expect(s.d.engine.listRuns(s.childThread).map((run) => run.source)).not.toContain('provider-continuation')
  })

  it('a model change is refused while background work exists, with a message that says what to do', async () => {
    const s = await scene()
    s.d.orch.setThreadModelOverride(s.childThread, { llmProvider: 'claude-subscription', model: 'opus' })
    await s.d.orch.send('switch', false, { threadId: s.childThread, clientRequestId: 'switch' }).catch(() => undefined)
    const refused = s.d.engine.listRuns(s.childThread).find((run) => run.status === 'failed')
    expect(refused?.outcome?.error).toMatch(/claude_background_work_blocks_change.*Stop/)
    expect(s.cli.processes).toHaveLength(1)
    expect(s.service.hasBackgroundWork(s.childThread)).toBe(true)
  })

  it('shows the thread as Waiting while Claude has background work, and clears it when the work ends', async () => {
    const manager = new ThreadRuntimeManager()
    const s = await scene({ manager })
    // The Builder's turn is over, but its shell still runs.
    expect(manager.getActivity(s.childThread)).toBe('waiting')
    s.cli.last.emit(notification('build-1'), textDelta('done'), resultFrame({ text: 'done', origin: 'task-notification' }))
    await waitFor(() => s.task().status !== 'running', 'the task to publish')
    await waitFor(() => manager.getActivity(s.childThread) !== 'waiting', 'Waiting to clear')
    expect(manager.getActivity(s.childThread)).toBe('completed')
  })

  it('writes a note into the thread when Claude says a helper\'s result may not have arrived', async () => {
    const s = await scene()
    ;(s.service as any).liveHost.notice(s.childThread, 'A helper finished while a message was being cancelled; its result may not have been delivered.')
    const messages = s.d.orch.getOrCreateSession(s.childThread).messages
    expect(messages.some((message) => message.content.includes('may not have been delivered'))).toBe(true)
  })

  it('boot cancels a continuation run whose effect died with the daemon', async () => {
    const s = await scene()
    const run = s.d.engine.store.createRun({ threadId: s.childThread, source: 'provider-continuation', clientRequestId: 'continuation:orphan' })
    expect(s.d.engine.getRun(run.runId)?.status).toBe('queued')
    s.d.engine.reconcileOnBoot()
    expect(s.d.engine.getRun(run.runId)?.status).toBe('cancelled')
  })
})

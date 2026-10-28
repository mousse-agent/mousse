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
import type { DelegationToolHost } from '../../src/mms/run/mcp/appTools/delegation'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
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

  /** Holds the making of the next continuation run until `release`, so a test decides what happens meanwhile. */
  const holdContinuationRun = (d: { engine: { dispatch: (command: never) => Promise<unknown> } }) => {
    const dispatch = d.engine.dispatch.bind(d.engine)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(d.engine as never, 'dispatch').mockImplementation((async (command: { kind: string; source?: string }) => {
      if (command.kind === 'send' && command.source === 'provider-continuation') await gate
      return dispatch(command as never)
    }) as never)
    return release
  }

  /** The parent starts the Claude subagent "Builder", whose first turn starts a background shell and ends. */
  const scene = async (options: { manager?: ThreadRuntimeManager; mcp?: boolean } = {}) => {
    home = mkdtempSync(join(tmpdir(), 'mousse-claude-helpers-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const binary = join(home, 'claude')
    writeFileSync(binary, 'fixture')
    chmodSync(binary, 0o755)
    mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
    writeFileSync(join(home, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))

    let signInGate: Promise<void> = Promise.resolve()
    const holdSignIn = (): (() => void) => {
      let open!: () => void
      signInGate = new Promise<void>((resolve) => { open = resolve })
      return () => { signInGate = Promise.resolve(); open() }
    }
    const cli = new FakeClaudeCli()
    cli.reply = (message, process) => {
      const text = process.text(process.inputs.length - 1)
      if (text.includes('Review Builder')) process.emit(roster({ id: 'build-1' }))
      process.answer(String(message.uuid), 'Started the build.')
    }
    const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      launchConfig: () => ({ binaryPath: binary }),
      query: cli.query,
      // A test can hold the sign-in check every turn makes before it pushes its prompt.
      runAuth: vi.fn(async () => {
        await signInGate
        return JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })
      })
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
    // The `claude` instance runs on this service through the real driver, live host included.
    const d = phase6Daemon(home, [parentAdapter], { drivers: [claudeCodeDriver({ builtIn: () => service })] })
    stops.push(d.stop)
    if (options.mcp) {
      const credentials = new McpCredentials(d.engine.store)
      const server = new MousseMcpServer({ credentials, registry: d.orch.mcpToolRegistry() })
      await server.start()
      d.orch.setMcpAttachment(server)
      stops.push(() => server.stop())
    }
    if (options.manager) d.orch.setRuntimeManager(options.manager)
    const parent = d.store.createThread('Parent')
    parentId = parent.id
    const reconciler = new Reconciler({ store: d.engine.store, outbox: d.engine.outbox, tools: d.engine.tools, capabilitiesFor: (id) => d.orch.capabilitiesForThread(id) })

    await d.orch.send('go', false, { threadId: parent.id, clientRequestId: 'go' })
    const builder = out.builder as Json
    await waitFor(() => d.engine.getRun(builder.childRunId)?.status === 'completed', 'the Builder\'s first turn')
    const task = () => d.engine.delegations.get(builder.delegationId)!
    const callMousse = async (name: string, args: Record<string, unknown> = {}) => {
      const options = cli.last.options
      const server = (options.mcpServers as Record<string, { url: string; headers: { Authorization: string } }>).mousse
      // Claude runs Mousse's PreToolUse hook before each call; the input the hook returns (stamped
      // with the turn's token) is what reaches the server.
      const hooked = await options.hooks!.PreToolUse![0].hooks[0](
        { hook_event_name: 'PreToolUse', tool_name: `mcp__mousse__${name}`, tool_input: args, tool_use_id: `use-${name}` } as never,
        `use-${name}`,
        { signal: new AbortController().signal }
      ) as { hookSpecificOutput?: { updatedInput?: Record<string, unknown> } }
      const response = await fetch(server.url, {
        method: 'POST',
        headers: { Authorization: server.headers.Authorization, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: hooked.hookSpecificOutput?.updatedInput ?? args } })
      })
      return await response.json() as { result?: unknown; error?: { message: string; data?: { reason?: string } } }
    }
    return { d, cli, service, parent, builder, task, reconciler, parentTurns, callMousse, holdSignIn, childThread: builder.childThreadId as string }
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

  it('a Mousse tool call Claude makes before the continuation run is active is attributed to the continuation run', async () => {
    const s = await scene({ mcp: true })
    // The previous run just ended, and the thread has no active run until the continuation's effect starts it.
    const release = holdContinuationRun(s.d)
    s.cli.last.emit(notification('build-1'), textDelta('checking'))
    await waitFor(() => (s.d.orch as any).pendingContinuations.size === 1, 'the wake report to reach the host')
    const call = s.callMousse('list_tasks')
    await new Promise((resolve) => setTimeout(resolve, 100))
    release()
    const response = await call
    expect(response.error).toBeUndefined()
    const continuation = s.d.engine.listRuns(s.childThread).find((run) => run.source === 'provider-continuation')!
    expect(s.d.engine.tools.listForRun(continuation.runId).map((invocation) => invocation.tool)).toContain('list_tasks')
    const earlier = s.d.engine.listRuns(s.childThread).find((run) => run.source === 'delegation')!
    expect(s.d.engine.tools.listForRun(earlier.runId).map((invocation) => invocation.tool)).not.toContain('list_tasks')
    s.cli.last.emit(resultFrame({ text: 'checked', origin: 'task-notification' }))
    await waitFor(() => s.task().status !== 'running', 'the task to publish')
  })

  it('a message sent between the wake report and the continuation\'s effect queues behind it, and both turns complete in order', async () => {
    const s = await scene()
    const order: string[] = []
    s.cli.reply = (message, process) => {
      const text = process.text(process.inputs.length - 1)
      order.push(text.includes('typed meanwhile') ? 'typed' : 'other')
      process.answer(String(message.uuid), 'typed answer')
    }
    // The wake report and a message typed right after it, while the continuation's run is still being made.
    const release = holdContinuationRun(s.d)
    s.cli.last.emit(notification('build-1'), textDelta('reading the report'))
    await waitFor(() => (s.d.orch as any).pendingContinuations.size === 1, 'the wake report to reach the host')
    const typed = s.d.orch.send('typed meanwhile', false, { threadId: s.childThread, clientRequestId: 'typed-1', source: 'gui' })
    typed.catch(() => undefined)
    await waitFor(() => s.d.engine.listRuns(s.childThread).some((run) => run.source === 'gui'), 'the typed message to be recorded')
    release()
    await waitFor(() => s.d.engine.listRuns(s.childThread).some((run) => run.source === 'provider-continuation'), 'the continuation run')
    s.cli.last.emit(resultFrame({ text: 'The report is read.', origin: 'task-notification' }))
    // The typed message was queued (the thread was the continuation's), not run first.
    expect((await typed).queued).toBe(true)
    const both = () => s.d.engine.listRuns(s.childThread).filter((run) => run.source === 'provider-continuation' || run.source === 'gui')
    await waitFor(() => both().length === 2 && both().every((run) => run.status === 'completed'), 'both turns to complete')
    const continuation = both().find((run) => run.source === 'provider-continuation')!
    const typedRun = both().find((run) => run.source === 'gui')!
    // The continuation went first and the typed turn started once it was over.
    expect(continuation.completedAt! <= typedRun.startedAt!).toBe(true)
    expect(order).toEqual(['typed'])
  }, 30_000)

  it('a wake that folded a waiting message in has no run of its own: the message gets the answer and no empty turn is written', async () => {
    const s = await scene()
    s.cli.reply = undefined
    // The message is sent on the subagent but its prompt is not pushed yet (the sign-in check is slow)...
    const openSignIn = s.holdSignIn()
    const typed = s.d.orch.send('typed meanwhile', false, { threadId: s.childThread, clientRequestId: 'typed-2', source: 'gui' })
    typed.catch(() => undefined)
    await waitFor(() => s.d.engine.listRuns(s.childThread).some((run) => run.source === 'gui'), 'the message to be recorded')
    // ...when the helper's notification arrives: Claude starts a turn of its own for it.
    s.cli.last.emit(notification('build-1'), textDelta('reading the report'))
    await waitFor(() => (s.d.orch as any).pendingContinuations.size === 1, 'the wake report to reach the host')
    openSignIn()
    await waitFor(() => s.cli.last.inputs.length === 2, 'the message to reach Claude')
    // Claude folds the message into the wake turn and echoes its id on the one result.
    const uuid = s.cli.last.uuid(1)
    s.cli.last.emit(textDelta('report and answer', uuid), resultFrame({ uuids: [uuid], text: 'report and answer', origin: 'task-notification' }))
    await typed
    await waitFor(() => s.task().status !== 'running', 'the task to publish')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const runs = s.d.engine.listRuns(s.childThread)
    // No continuation run executed: the folded wake has no turn of its own.
    expect(runs.filter((run) => run.source === 'provider-continuation').every((run) => run.status === 'cancelled')).toBe(true)
    expect(s.task().result?.text).toBe('report and answer')
    const messages = s.d.orch.getOrCreateSession(s.childThread).messages
    expect(messages.filter((message) => message.role === 'assistant' && (message.content === 'Done.' || message.content === ''))).toEqual([])
    expect(messages.some((message) => message.content.includes('A background task finished'))).toBe(false)
  })

  it('Stop aimed at a stale run id stops the process when only a queued continuation run is live', async () => {
    const s = await scene()
    const [older] = s.d.engine.listRuns(s.childThread)
    // A continuation run that is queued but whose effect has not run.
    const queued = s.d.engine.store.createRun({ threadId: s.childThread, source: 'provider-continuation', clientRequestId: 'continuation:stale' })
    expect(s.d.engine.getRun(queued.runId)?.status).toBe('queued')
    const result = await s.d.orch.abortRun(older.runId, 'stale-stop-1', s.childThread)
    expect(result.status).toBe('ignored')
    expect(s.cli.last.closed).toBe(true)
  })

  it('Stop aimed at a stale run id leaves the process alone when a continuation run is already claimed by the worker', async () => {
    const s = await scene()
    const [older] = s.d.engine.listRuns(s.childThread)
    await s.d.worker.stop()
    // A continuation run whose turn.start effect is claimed (running) but whose run is still queued: it is inside the turn.
    const queued = s.d.engine.store.createRun({ threadId: s.childThread, source: 'provider-continuation', clientRequestId: 'continuation:claimed' })
    s.d.engine.outbox.enqueue({ threadId: s.childThread, runId: queued.runId, kind: 'turn.start', payload: { kind: 'continuation', threadId: s.childThread, runId: queued.runId, continuationId: 'none', note: 'x' } })
    const claimed = s.d.engine.outbox.claimNext(s.d.engine.leaseOwner, new Date().toISOString())
    expect(claimed?.runId).toBe(queued.runId)
    const result = await s.d.orch.abortRun(older.runId, 'stale-stop-claimed', s.childThread)
    expect(result.status).toBe('ignored')
    expect(s.cli.last.closed).toBe(false)
    s.d.engine.markTerminal(queued.runId, 'cancelled')
  })

  it('the owner of a passed admission is not restored over an admission something else took meanwhile', async () => {
    const s = await scene()
    const session = s.d.orch.getOrCreateSession(s.childThread)
    // After the continuation's turn ends, a queue drain has already re-admitted the thread for its own run.
    const orch = s.d.orch as any
    const real = orch.runTurnOnSession.bind(orch)
    vi.spyOn(orch, 'runTurnOnSession').mockImplementation((async (...args: unknown[]) => {
      const response = await real(...args)
      session.turnAdmitted = true
      session.admissionRunId = 'queued-drain-run'
      return response
    }) as never)
    await s.d.worker.stop()
    const sent = await s.d.engine.dispatch({ kind: 'send', threadId: s.childThread, clientRequestId: 'admitted-2', source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send refused')
    session.turnAdmitted = true
    session.admissionRunId = sent.runId
    s.cli.last.emit(notification('build-1'), textDelta('reading the report'))
    await waitFor(() => s.d.engine.listRuns(s.childThread).some((run) => run.source === 'provider-continuation'), 'the continuation run')
    // The admitted turn's effect is made after the continuation's, and waits (its own delay).
    s.d.engine.outbox.enqueue({ threadId: s.childThread, runId: sent.runId, kind: 'turn.start', availableAt: new Date(Date.now() + 3_600_000).toISOString(), payload: { runId: sent.runId, threadId: s.childThread, input: { content: 'x', mode: 'agent' } } })
    s.cli.last.emit(resultFrame({ text: 'The report is read.', origin: 'task-notification' }))
    s.d.worker.start()
    await waitFor(() => s.d.engine.listRuns(s.childThread).some((run) => run.source === 'provider-continuation' && run.status === 'completed'), 'the continuation to complete')
    expect(session.admissionRunId).toBe('queued-drain-run')
    session.turnAdmitted = false
    s.d.engine.markTerminal(sent.runId, 'cancelled')
  }, 40_000)

  it('a continuation that cannot be recorded discards only its own turn, not a sibling waiting on the thread', async () => {
    const s = await scene()
    const live = (s.service as any).live.get(s.childThread)
    const first = (live as any).startContinuation([{ id: 'a' }])
    ;(live as any).continuation = undefined
    const second = (live as any).startContinuation([{ id: 'b' }])
    expect(s.service.hasContinuation(s.childThread, second.id)).toBe(true)
    s.service.discardContinuations(s.childThread, first.id)
    expect(s.service.hasContinuation(s.childThread, first.id)).toBe(false)
    expect(s.service.hasContinuation(s.childThread, second.id)).toBe(true)
  })

  it('a tool call waiting for a continuation run that never becomes active is refused, and nothing is recorded under another run', async () => {
    const s = await scene({ mcp: true })
    ;(s.d.orch as any).continuationCallWaitMs = 80
    holdContinuationRun(s.d)
    s.cli.last.emit(notification('build-1'), textDelta('checking'))
    await waitFor(() => (s.d.orch as any).pendingContinuations.size === 1, 'the wake report to reach the host')
    const response = await s.callMousse('list_tasks')
    expect(response.error?.message).toContain('did not become active')
    for (const run of s.d.engine.listRuns(s.childThread)) expect(s.d.engine.tools.listForRun(run.runId).map((invocation) => invocation.tool)).not.toContain('list_tasks')
  })

  it('an admitted turn whose send holds the admission and waits behind a continuation in the lane is passed by it, and keeps its place', async () => {
    const s = await scene()
    const session = s.d.orch.getOrCreateSession(s.childThread)
    // The lane is held while the situation is set up. The user's message is admitted through the real send
    // path, but its effect is made only after the continuation's.
    await s.d.worker.stop()
    const realEnqueue = (s.d.orch as any).enqueueTurnStart.bind(s.d.orch)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let admitted!: Promise<unknown>
    vi.spyOn(s.d.orch as any, 'enqueueTurnStart').mockImplementation(((payload: unknown) => {
      admitted = gate.then(() => realEnqueue(payload))
      admitted.catch(() => undefined)
      return admitted
    }) as never)
    s.cli.reply = (message, process) => process.answer(String(message.uuid), 'typed answer')
    await s.d.orch.send('admitted', false, { threadId: s.childThread, clientRequestId: 'admitted-1', source: 'gui', awaitMode: 'ack' })
    expect(session.turnAdmitted).toBe(true)
    const owner = session.admissionRunId
    expect(owner).toBeTruthy()
    s.cli.last.emit(notification('build-1'), textDelta('reading the report'))
    await waitFor(() => s.d.engine.listRuns(s.childThread).some((run) => run.source === 'provider-continuation'), 'the continuation run')
    release()
    s.cli.last.emit(resultFrame({ text: 'The report is read.', origin: 'task-notification' }))
    s.d.worker.start()
    await admitted
    const continuation = s.d.engine.listRuns(s.childThread).find((run) => run.source === 'provider-continuation')!
    const typed = s.d.engine.getRun(owner!)!
    expect([continuation.status, typed.status]).toEqual(['completed', 'completed'])
    // The continuation went first although it came second in the lane.
    expect(continuation.completedAt! <= typed.startedAt!).toBe(true)
  }, 40_000)

  it('a queue drain that holds the admission across the await that makes its run does not deadlock behind a continuation', async () => {
    const s = await scene()
    const orch = s.d.orch as any
    // A deferred continuation looks at the thread again quickly.
    orch.wakeBusyDeferMs = 50
    const real = orch.ensureQueueItemRun.bind(orch)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(orch, 'ensureQueueItemRun').mockImplementation((async (item: unknown) => {
      await gate
      return real(item)
    }) as never)
    s.cli.reply = (message, process) => process.answer(String(message.uuid), 'queued answer')
    const session = s.d.orch.getOrCreateSession(s.childThread)
    orch.enqueueForThread(s.childThread, { content: 'queued message', mode: 'agent' }, { source: 'gui' })
    orch.scheduleQueueDrain(session)
    await waitFor(() => session.turnAdmitted, 'the drain to reserve the admission')
    // A helper's wake is reported while the drain waits for its run record: its effect enters the lane first.
    s.cli.last.emit(notification('build-1'), textDelta('reading the report'))
    await waitFor(() => s.d.engine.listRuns(s.childThread).some((run) => run.source === 'provider-continuation'), 'the continuation run')
    // Its effect ran once and was deferred (the drain holds the thread); the deferral is over when the drain goes on.
    await new Promise((resolve) => setTimeout(resolve, 200))
    release()
    s.cli.last.emit(resultFrame({ text: 'The report is read.', origin: 'task-notification' }))
    // Nothing nudges the worker here: it wakes for the deferred continuation by itself, not at its 30 s poll.
    await waitFor(() => {
      const runs = s.d.engine.listRuns(s.childThread).filter((run) => run.source === 'provider-continuation' || run.source === 'queue' || run.source === 'gui')
      return runs.length === 2 && runs.every((run) => run.status === 'completed')
    }, 'both turns to complete', 8_000)
    const runs = s.d.engine.listRuns(s.childThread)
    const continuation = runs.find((run) => run.source === 'provider-continuation')!
    const queued = runs.find((run) => run.source !== 'provider-continuation' && run.source !== 'delegation')!
    expect(continuation.completedAt! <= queued.startedAt!).toBe(true)
  }, 40_000)

  it('calls made by the active run are not held by a continuation waiting behind it', async () => {
    const s = await scene({ mcp: true })
    ;(s.d.orch as any).continuationCallWaitMs = 100
    const openSignIn = s.holdSignIn()
    // A user turn is active in the engine, but its provider has not pushed it yet (the sign-in check is slow).
    s.cli.reply = undefined
    const typed = s.d.orch.send('typed', false, { threadId: s.childThread, clientRequestId: 'typed-5', source: 'gui', awaitMode: 'ack' })
    typed.catch(() => undefined)
    await waitFor(() => s.d.engine.getActiveRun(s.childThread)?.source === 'gui', 'the user turn to be active')
    // Claude runs the wake of a finished helper first; its continuation waits behind the user's turn.
    s.cli.last.emit(notification('build-1'), textDelta('reading the report'))
    await waitFor(() => (s.d.orch as any).pendingContinuations.size === 1, 'the wake report to reach the host')
    s.cli.last.emit(resultFrame({ text: 'The report is read.', origin: 'task-notification' }))
    openSignIn()
    await waitFor(() => s.cli.last.inputs.length === 2, "the user's message to reach Claude")
    const uuid = s.cli.last.uuid(1)
    s.cli.last.emit(textDelta('looking', uuid))
    // The user turn's own tool call, long after the continuation's wait would have run out.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const response = await s.callMousse('list_tasks')
    expect(response.error).toBeUndefined()
    const active = s.d.engine.getActiveRun(s.childThread)!
    expect(s.d.engine.tools.listForRun(active.runId).map((invocation) => invocation.tool)).toContain('list_tasks')
    s.cli.last.emit(resultFrame({ uuids: [uuid], text: 'done' }))
  }, 40_000)

  it('the gate is decided for the turn in flight, not for every continuation waiting on the thread', async () => {
    const s = await scene()
    const orch = s.d.orch as any
    const hold = (runId: string | null) => ({ threadId: s.childThread, reserved: false, done: Promise.resolve({ runId }), settle: () => undefined })
    orch.pendingContinuations.set('timed-out', hold(null))
    orch.pendingContinuations.set('active', hold('run-active'))
    const inFlight = vi.spyOn(s.service, 'inFlightContinuation')
    inFlight.mockReturnValue({ id: 'active', discarded: false })
    await expect(orch.continuationGate(s.childThread)).resolves.toEqual({ runId: 'run-active' })
    inFlight.mockReturnValue(undefined)
    expect(orch.continuationGate(s.childThread)).toBeUndefined()
    inFlight.mockReturnValue({ id: 'timed-out', discarded: false })
    await expect(orch.continuationGate(s.childThread)).resolves.toEqual({ runId: null })
    // A discarded wake has no run at all, so its calls are refused whatever entry exists.
    inFlight.mockReturnValue({ id: 'gone', discarded: true })
    await expect(orch.continuationGate(s.childThread)).resolves.toEqual({ runId: null })
    orch.pendingContinuations.clear()
  })

  it('an admission held by something the engine does not schedule is not passed: the continuation waits', async () => {
    const s = await scene()
    const session = s.d.orch.getOrCreateSession(s.childThread)
    ;(s.d.orch as any).wakeBusyDeferMs = 50
    // A queue drain or a channel turn holds the admission; no run of the engine owns it.
    session.turnAdmitted = true
    session.admissionRunId = undefined
    s.cli.last.emit(notification('build-1'), textDelta('reading the report'))
    await waitFor(() => s.d.engine.listRuns(s.childThread).some((run) => run.source === 'provider-continuation'), 'the continuation run')
    // Some other turn.start is pending on the thread (that alone must not make the admission passable).
    const other = await s.d.engine.dispatch({ kind: 'send', threadId: s.childThread, clientRequestId: 'unrelated-1', source: 'gui' })
    if (other.status !== 'accepted') throw new Error('send refused')
    s.d.engine.outbox.enqueue({ threadId: s.childThread, runId: other.runId, kind: 'turn.start', availableAt: new Date(Date.now() + 3_600_000).toISOString(), payload: { runId: other.runId, threadId: s.childThread, input: { content: 'x', mode: 'agent' } } })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(s.d.engine.listRuns(s.childThread).find((run) => run.source === 'provider-continuation')?.status).toBe('queued')
    // Cleanup: the run the unrelated effect belongs to is cancelled, and the admission is freed.
    s.d.engine.markTerminal(other.runId, 'cancelled')
    session.turnAdmitted = false
  }, 40_000)

  type Dispatch = (command: never) => Promise<{ status: string; runId?: string; reason?: string }>
  describe.each([
    ['the run cannot be recorded', (real: Dispatch): Dispatch => async (command: { kind: string; source?: string }) => {
      if (command.kind === 'send' && command.source === 'provider-continuation') {
        await new Promise((resolve) => setTimeout(resolve, 150))
        throw new Error('the engine is unavailable')
      }
      return real(command as never)
    }],
    ['the run is cancelled before it starts', (real: Dispatch, cancel: (runId: string) => void): Dispatch => async (command: { kind: string; source?: string }) => {
      if (command.kind === 'send' && command.source === 'provider-continuation') await new Promise((resolve) => setTimeout(resolve, 150))
      const result = await real(command as never)
      if (command.kind === 'send' && command.source === 'provider-continuation' && result.status === 'accepted') {
        // Cancelled in the same tick the run is made, before its effect can start it.
        cancel(result.runId!)
      }
      return result
    }]
  ] as const)('when %s', (_label, wrap) => {
    it('the reservation is released, and a message typed meanwhile runs', async () => {
      const s = await scene()
      const real = s.d.engine.dispatch.bind(s.d.engine) as unknown as Dispatch
      vi.spyOn(s.d.engine, 'dispatch').mockImplementation(wrap(real, (runId) => s.d.engine.markTerminal(runId, 'cancelled')) as never)
      s.cli.last.emit(notification('build-1'), textDelta('reading the report'))
      await waitFor(() => (s.d.orch as any).pendingContinuations.size === 1, 'the wake report to reach the host')
      const session = s.d.orch.getOrCreateSession(s.childThread)
      expect(session.turnAdmitted).toBe(true)
      s.cli.reply = (message, process) => process.answer(String(message.uuid), 'typed answer')
      const typed = await s.d.orch.send('typed meanwhile', false, { threadId: s.childThread, clientRequestId: 'typed-3', source: 'gui' })
      expect(typed.queued).toBe(true)
      await waitFor(() => s.d.engine.listRuns(s.childThread).some((run) => run.source === 'gui' && run.status === 'completed'), 'the typed message to run after the reservation was released', 20_000)
      expect((s.d.orch as any).pendingContinuations.size).toBe(0)
      expect(session.turnAdmitted).toBe(false)
      expect(session.admissionRunId).toBeUndefined()
    }, 40_000)
  })

  it('the thread note about a possibly lost result comes from a real cancel, once', async () => {
    const s = await scene()
    s.cli.reply = undefined
    const typed = s.d.orch.send('typed', false, { threadId: s.childThread, clientRequestId: 'typed-4', source: 'gui', awaitMode: 'ack' })
    typed.catch(() => undefined)
    await waitFor(() => s.cli.last.inputs.length === 2, 'the message to reach Claude')
    const claude = s.cli.last
    claude.emit(textDelta('working', claude.uuid(1)), notification('build-1'))
    expect(s.d.orch.steerThread(s.childThread, 'queued steer')).toBe(true)
    await waitFor(() => claude.inputs.length === 3, 'the steer to reach Claude')
    s.d.orch.abortActiveTurn(s.childThread)
    const notes = () => s.d.orch.getOrCreateSession(s.childThread).messages.filter((message) => message.content.includes('may not have been delivered'))
    await waitFor(() => notes().length === 1, 'the note', 15_000)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(notes()).toHaveLength(1)
    expect(notes()[0].content).toMatch(/Stop releases it now/)
  }, 40_000)

  it('boot cancels a continuation run whose effect died with the daemon', async () => {
    const s = await scene()
    const run = s.d.engine.store.createRun({ threadId: s.childThread, source: 'provider-continuation', clientRequestId: 'continuation:orphan' })
    expect(s.d.engine.getRun(run.runId)?.status).toBe('queued')
    s.d.engine.reconcileOnBoot()
    expect(s.d.engine.getRun(run.runId)?.status).toBe('cancelled')
  })
})

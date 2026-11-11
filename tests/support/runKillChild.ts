/**
 * A daemon in a child process, for `restartRecovery.test.ts`: the test kills it (SIGKILL) while a thread's turn is
 * cut off at one point, then starts a new daemon on the same home.
 *
 * `first <home> <scenario>`: thread T sends `cut` and, once the turn is at the scenario's point, a second message
 * `next` is queued behind it. Then the process kills itself. Scenarios:
 * - `starting`: right after the effect worker claims the turn's `turn.start`, before the turn reaches its provider;
 * - `accepted`: the turn has saved `cut` to the transcript and is about to mark its run starting;
 * - `streaming`: the provider has the prompt and has streamed part of a reply;
 * - `tool`: the provider is running a tool (an activity row is open and the tool ledger has it started);
 * - `uncertain`: as `tool`, with a tool that is not idempotent (`bash`), so the crash leaves its outcome unknown;
 * - `steer`: as `streaming`, and `next` was steered into the running turn (#873), which has not read it yet;
 * - `steer-taken`: as `steer`, and the provider took `next`: its acceptance is saved, and the process dies before the
 *   queue drops the item;
 * - `approval`: the provider waits for a saved approval;
 * - `question`: the provider waits for an answer to a question.
 *
 * `restart <home>`: a new daemon recovers as the profile does (`recoverRunEngineOnBoot`, a reconciler pass, the
 * startup queue drain), waits until the thread is idle, and writes what it finds to `result.json`.
 *
 * Every prompt a provider receives is appended to `prompts.log`, prefixed with the mode it ran in.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterHost, ProviderAdapter, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import { readDurableQueue } from '../../src/mms/queue/durableQueue'
import { EffectOutbox } from '../../src/mms/run/EffectOutbox'
import { Reconciler } from '../../src/mms/run/Reconciler'
import { isOpenActivityRow } from '../../src/mms/run/restartNote'
import type { ChatMessage } from '../../src/shared/types'
import { phase6Daemon } from '../run/phase6Fixture'

type Scenario = 'starting' | 'accepted' | 'streaming' | 'tool' | 'uncertain' | 'steer' | 'steer-taken' | 'approval' | 'question'
const [mode, home, scenario] = process.argv.slice(2) as ['first' | 'restart', string, Scenario | undefined]
process.env.MOUSSE_HOME = home
process.env.MOUSSE_SQLITE_THREAD_STORE = '1'
const MODEL = { llmProvider: 'claude-subscription', model: 'vendor-model' }
const marker = (name: string): string => join(home, name)

const waitFor = async (cond: () => boolean, label: string, timeoutMs = 20_000): Promise<void> => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A Claude-shaped provider: `cut` stops at the scenario's point and never ends; anything else replies at once. */
class KillAdapter implements ProviderAdapter {
  readonly driver = 'claude' as const
  readonly capabilities = CLAUDE_SUBSCRIPTION_CAPABILITIES
  ask: ((threadId: string, approval: boolean) => void) | null = null

  configured(): boolean {
    return true
  }

  async startTurn(input: TurnInput, sink: TurnSink, ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    appendFileSync(marker('prompts.log'), `${mode}:${input.prompt}\n`)
    sink.providerRef({ provider: input.llmProvider, model: input.model })
    if (mode === 'first' && input.prompt.startsWith('cut')) {
      sink.text({ phase: 'start', content: '', contentIndex: 0 })
      sink.text({ phase: 'delta', content: 'partial reply', contentIndex: 0 })
      sink.progress()
      if (scenario === 'tool' || scenario === 'uncertain') {
        host.tools.toolLedger?.start({ id: 'call-read', name: scenario === 'tool' ? 'read_file' : 'bash', arguments: { path: 'a.txt' } } as never)
        sink.tool({
          kind: 'mcp_tool_call', phase: 'start', callId: 'call-read', title: 'Read', summary: 'Read a.txt', details: [],
          activity: { kind: 'tool', toolName: 'Read' }
        } as never)
      }
      if (scenario === 'approval' || scenario === 'question') this.ask?.(input.threadId, scenario === 'approval')
      writeFileSync(marker('at-point'), '')
      if (scenario === 'steer-taken') {
        // The provider takes the steer once it is there; the acceptance saves, and the acknowledgement kills.
        await waitFor(() => existsSync(marker('take')), 'the steer to take', 20_000)
        let entry: ReturnType<NonNullable<TurnControl['drainSteerEntry']>>
        await waitFor(() => Boolean((entry = ctl.drainSteerEntry?.())), 'the steer drained', 20_000)
        sink.steerAccepted(entry!.text)
      }
      return new Promise<TurnResult>(() => undefined)
    }
    const text = `reply to ${input.prompt}`
    sink.text({ phase: 'complete', content: text, contentIndex: 0 })
    return {
      text, aborted: false, modelName: 'Scripted', totalResponseTimeMs: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted', nativeMessages: [],
      providerRef: { provider: input.llmProvider, model: input.model }
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

const daemon = (pid: number, adapter: KillAdapter) => {
  const d = phase6Daemon(home, [adapter], { pid, orchestratorBoot: true })
  d.store.setSqliteStoreEnabled(true)
  const save = (threadId: string | null): void => {
    if (!threadId || !d.store.getThread(threadId) || !d.orch.hasSession(threadId)) return
    d.store.mutateThreadData(threadId, () => ({ messages: d.orch.liveMessagesForSave(threadId) as ChatMessage[], llmContext: d.orch.getNativeContext(threadId) }))
  }
  d.orch.setPersistCallback(save)
  return Object.assign(d, { save })
}

const die = (): never => {
  process.kill(process.pid, 'SIGKILL')
  throw new Error('unreachable')
}

async function first(): Promise<void> {
  const adapter = new KillAdapter()
  if (scenario === 'starting' || scenario === 'accepted') {
    // Once armed, the turn's `turn.start` waits unclaimed until `go`; the process is killed the moment the worker's
    // claim of it has committed, so the turn never starts.
    const claim = EffectOutbox.prototype.claimNext
    EffectOutbox.prototype.claimNext = function (this: EffectOutbox, ...args: Parameters<EffectOutbox['claimNext']>) {
      if (existsSync(marker('armed')) && !existsSync(marker('go'))) return null
      const effect = claim.apply(this, args)
      if (effect?.kind === 'turn.start' && existsSync(marker('armed')) && scenario === 'starting') die()
      return effect
    }
  }
  const d = daemon(1, adapter)
  adapter.ask = (threadId, approval) => {
    const questions = [{ id: 'permission', prompt: 'Allow Claude Code to run a command (Bash)?', options: [{ id: 'allow', label: 'Allow once' }, { id: 'reject', label: 'Reject' }] }]
    const tool = { name: 'Bash', input: { command: 'npm test' }, cwd: home }
    const options = approval
      ? { approval: { action: 'command' as const, permissionKey: 'claude:command', options: [{ id: 'allow', decision: 'allow' as const, scope: 'once' as const }, { id: 'reject', decision: 'reject' as const }], tool } }
      : {}
    void d.questions.requestAnswers(questions, threadId, options).catch(() => undefined)
  }
  mkdirSync(join(home, 'project'), { recursive: true })
  const project = d.projects.openProject(join(home, 'project'))
  const thread = d.store.createThread('T', project.id)
  d.orch.setThreadModelOverride(thread.id, MODEL)
  writeFileSync(marker('thread.json'), JSON.stringify({ id: thread.id }))

  // A finished turn first, so the thread has history.
  await d.orch.send('earlier', false, { threadId: thread.id, clientRequestId: 'c-0' })
  await waitFor(() => !d.orch.isActiveTurnRunning(thread.id) && d.engine.getActiveRun(thread.id) === null, 'first turn done')

  if (scenario === 'accepted') {
    // Killed as the turn marks its run starting: its message is saved in the transcript, the run is still queued.
    const orch = d.orch as unknown as { markRunStarting: (runId: string | undefined) => void }
    orch.markRunStarting = () => {
      d.save(thread.id)
      die()
    }
  }
  if (scenario === 'starting' || scenario === 'accepted') {
    writeFileSync(marker('armed'), '')
    void d.orch.send('cut', false, { threadId: thread.id, clientRequestId: 'c-1' })
    await waitFor(() => d.engine.listRuns(thread.id).length === 2, 'the run of cut')
    const queued = await d.orch.send('next', false, { threadId: thread.id, clientRequestId: 'c-2' })
    if (!queued.queued || readDurableQueue(d.store, thread.id).length !== 1) throw new Error('nothing was queued')
    writeFileSync(marker('go'), '')
    d.worker.notify()
    await new Promise<void>((resolve) => setTimeout(resolve, 20_000))
    throw new Error('the claim did not kill the process')
  }
  void d.orch.send('cut', false, { threadId: thread.id, clientRequestId: 'c-1' })
  await waitFor(() => existsSync(marker('at-point')), 'the turn at its point')
  if (scenario === 'approval' || scenario === 'question') await waitFor(() => d.questions.listPendingForThread(thread.id).length === 1, 'the pending question')
  const queued = await d.orch.send('next', false, { threadId: thread.id, clientRequestId: 'c-2' })
  if (!queued.queued || readDurableQueue(d.store, thread.id).length !== 1) throw new Error('nothing was queued')
  if (scenario === 'steer') {
    if (!d.orch.promoteQueueItem(thread.id, queued.queueItem!.id).ok) throw new Error('the steer was refused')
  }
  if (scenario === 'steer-taken') {
    if (!d.orch.promoteQueueItem(thread.id, queued.queueItem!.id).ok) throw new Error('the steer was refused')
    const orch = d.orch as unknown as { acknowledgeDrainedSteers: () => void }
    orch.acknowledgeDrainedSteers = () => die()
    writeFileSync(marker('take'), '')
    await new Promise<void>((resolve) => setTimeout(resolve, 20_000))
    throw new Error('the steer was not taken')
  }
  // What the thread saved so far reaches disk before the kill, as it would during a long turn.
  d.save(thread.id)
  writeFileSync(marker('killed'), '')
  die()
}

async function restart(): Promise<void> {
  const adapter = new KillAdapter()
  const d = daemon(2, adapter)
  const { id } = JSON.parse(readFileSync(marker('thread.json'), 'utf-8')) as { id: string }
  // As the profile does after boot: questions of the dead process are gone, then the reconciler and the startup queue
  // recovery (`scheduleStartupQueueRecovery`, which reads each thread in the read worker) run.
  d.questions.markInterruptedByDaemonRestart()
  const repairs = new Reconciler({ store: d.engine.store, outbox: d.engine.outbox, tools: d.engine.tools }).runOnce()
  d.orch.scheduleStartupQueueRecovery()
  const idle = (): boolean =>
    readDurableQueue(d.store, id).length === 0 && d.engine.getActiveRun(id) === null && !d.orch.isActiveTurnRunning(id) &&
    !d.engine.store.listQueuedRuns(id).some((run) => d.engine.outbox.listForRun(run.runId).some((effect) => effect.kind === 'turn.start' && (effect.status === 'pending' || effect.status === 'running')))
  const timedOut = await waitFor(idle, 'the thread idle').then(() => false, () => true)
  // Nothing more starts: a second reconciler pass and a moment of quiet.
  const later = new Reconciler({ store: d.engine.store, outbox: d.engine.outbox, tools: d.engine.tools }).runOnce()
  await new Promise((resolve) => setTimeout(resolve, 500))
  if (!timedOut) await waitFor(idle, 'the thread idle again')
  const visible = (message: ChatMessage): boolean => !message.hidden
  writeFileSync(marker('result.json'), JSON.stringify({
    timedOut,
    transcript: d.store.loadThreadData(id).messages.filter(visible).map((message) => `${message.role}:${message.content}`),
    live: d.orch.getMessages(id).filter(visible).map((message) => `${message.role}:${message.content}`),
    runs: d.engine.listRuns(id).map((run) => ({ clientRequestId: run.clientRequestId, status: run.status, interruptedBy: run.outcome?.interruptedBy ?? null })),
    queue: readDurableQueue(d.store, id).length,
    active: d.engine.getActiveRun(id) !== null || d.orch.isActiveTurnRunning(id),
    nonTerminal: d.engine.store.listNonTerminalRuns().filter((run) => run.threadId === id).map((run) => run.status),
    restarted: [...repairs.queuedStarts, ...later.queuedStarts],
    open: d.orch.getMessages(id).filter((message) => isOpenActivityRow(message) || message.streaming === true).length,
    note: d.engine.store.listEvents(id).filter((event) => event.type === 'restart.note').map((event) => event.payload)
  }))
  await d.stop()
  process.exit(0)
}

void (mode === 'first' ? first() : restart()).catch((error: unknown) => {
  writeFileSync(marker('error.txt'), error instanceof Error ? `${error.message}\n${error.stack}` : String(error))
  process.exit(3)
})

/**
 * A usage limit pauses the run and continues it when the limit resets (docs/run-engine/SPEC.md §5, §16.4):
 * a real `OrchestratorService`, Run Engine and effect worker over a temporary profile, with scripted
 * adapters in place of providers. The reset is a moment ahead on the real clock; a restart is a second
 * daemon over the same profile home.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatPullRequestNotice } from '../../src/mms/git/pullRequestWatch'
import { usageLimitError } from '../../src/mms/orchestrator/providerErrors'
import { readDurableQueue } from '../../src/mms/queue/durableQueue'
import { PI_LOOP_CAPABILITIES } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import { startedByPerson } from '../../src/mms/run/approvalRights'
import { CONTINUE_TEXT, pauseProviderName, pausedLine } from '../../src/mms/run/pauseText'
import { BRIDGE_THREAD_EVENT_TYPES } from '../../src/shared/net/envelope'
import { isRetriesExhausted } from '../../src/shared/harness/types'
import { Reconciler } from '../../src/mms/run/Reconciler'
import { ToolInvocations } from '../../src/mms/run/ToolInvocations'
import type { EffectRecord, RunRecord } from '../../src/mms/run/types'
import { AppError } from '../../src/shared/errors'
import type { RunSettings } from '../../src/shared/settings'
import { CLAUDE, PI, ScriptedAdapter, claudeAdapter, phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './phase6Fixture'

vi.setConfig({ testTimeout: 30_000 })

/** How far ahead the scripted limit resets: long enough to look at the pause, short enough to wait for. */
const RESET_MS = 700

const resetIn = (ms = RESET_MS): string => new Date(Date.now() + ms).toISOString()
const limit = (over: { provider?: string; ms?: number; limitKind?: string; resetsAt?: string } = {}): AppError =>
  usageLimitError({ provider: over.provider ?? 'claude', resetsAt: over.resetsAt ?? resetIn(over.ms), estimated: false, limitKind: over.limitKind ?? 'five_hour' })

/** What a managed Codex throws: the gateway's `rate_limited`, with the typed limit as its cause. */
const managedCodexLimit = (): AppError =>
  new AppError({ code: 'rate_limited', message: 'Rate limited', errorInfo: { category: 'unavailable', retryable: false } }, limit({ provider: 'codex' }))

/** One turn of a scripted adapter: it fails with the error (built when the turn runs, so its reset is still ahead), waits on a gate, or replies. */
type Step = { fail?: () => Error; gate?: Promise<void> }

const rowId = (threadId: string): string => `inbox:pr-update:${threadId}:1:0`

/** The notice a watched pull request writes into a thread's inbox, and a phrase that appears in it once. */
const NOTICE = formatPullRequestNotice([{ kind: 'checks_failed', checks: [{ name: 'build', state: 'failing', url: null }] }], { number: 7, title: 'Add thing', url: 'https://github.com/acme/app/pull/7', headSha: 'abcdef0123', authorAssociation: 'OWNER' }, 'act')
const NOTICE_MARK = 'Add thing'

describe('a usage limit pauses the run', () => {
  let previousHome: string | undefined
  const homes: string[] = []
  const daemons: Phase6Daemon[] = []

  afterEach(async () => {
    vi.useRealTimers()
    for (const daemon of daemons.splice(0).reverse()) await daemon.stop().catch(() => undefined)
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  const newHome = (): string => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-pause-'))
    previousHome ??= process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    homes.push(home)
    return home
  }

  /** A pi-shaped adapter that follows `steps`, one per turn: fail with an error, wait on a gate, or reply. */
  const scripted = (steps: Step[]): ScriptedAdapter =>
    piAdapter(async (input) => {
      const step = steps.shift()
      if (step?.gate) await step.gate
      if (step?.fail) throw step.fail()
      return `reply: ${input.prompt}`
    })

  const boot = (home: string, adapters: ScriptedAdapter[], options: { pid?: number; runs?: Partial<RunSettings>; fault?: (point: string) => void } = {}): Phase6Daemon => {
    const daemon = phase6Daemon(home, adapters, { pid: options.pid ?? 1, runs: { resumeAfterUsageLimit: true, ...options.runs }, ...(options.fault ? { fault: options.fault } : {}) })
    daemons.push(daemon)
    return daemon
  }

  const deferred = () => {
    let release!: () => void
    const promise = new Promise<void>((resolve) => { release = resolve })
    return { promise, release }
  }

  const runsOf = (d: Phase6Daemon, threadId: string): RunRecord[] => [...d.engine.listRuns(threadId)].sort((a, b) => a.ordinal - b.ordinal)
  const effectsOf = (d: Phase6Daemon, runId: string, kind: string): EffectRecord[] => d.engine.outbox.listForRun(runId).filter((effect) => effect.kind === kind)
  const systemLines = (d: Phase6Daemon, threadId: string): string[] => d.orch.getMessages(threadId).filter((message) => message.role === 'system').map((message) => message.content)
  const queueOf = (d: Phase6Daemon, threadId: string) => readDurableQueue(d.store, threadId)
  const settled = (d: Phase6Daemon, threadId: string) => runsOf(d, threadId).every((run) => ['completed', 'failed', 'cancelled', 'interrupted', 'uncertain'].includes(run.status))

  /** What `thread_send` does: another thread's agent writes to `threadId`. */
  const agentSend = (d: Phase6Daemon, threadId: string, clientRequestId: string) =>
    (d.orch as any).sendToThreadAsAgent(threadId, { content: 'second', mode: 'agent' }, { clientRequestId, actor: { kind: 'agent', threadId: 'other-thread', runId: 'run:other:1', toolCallId: 'call-1' } })

  /** A thread whose first message hit a usage limit; the run is paused. */
  const paused = async (d: Phase6Daemon, pi: ScriptedAdapter, title = 'Limited') => {
    const thread = d.store.createThread(title)
    d.orch.setThreadModelOverride(thread.id, PI)
    const response = await d.orch.send('Do the work', false, { threadId: thread.id, clientRequestId: `first:${thread.id}` })
    const run = d.engine.getRun(response.runId!)!
    expect(run.status).toBe('paused')
    return { thread, run, pi, response }
  }

  describe('each provider\'s limit', () => {
    const cases: Array<{ name: string; adapter: () => ScriptedAdapter; model: typeof PI; error: () => AppError; provider: string; window: string }> = [
      { name: 'Claude', adapter: () => claudeAdapter(() => 'unused'), model: CLAUDE as typeof PI, error: () => limit({ provider: 'claude', limitKind: 'five_hour' }), provider: 'Claude', window: '5-hour' },
      { name: 'Pi', adapter: () => piAdapter(() => 'unused'), model: PI, error: () => limit({ provider: 'openai', limitKind: 'seven_day' }), provider: 'OpenAI', window: '7-day' },
      { name: 'Codex (not managed)', adapter: () => piAdapter(() => 'unused'), model: PI, error: () => limit({ provider: 'codex', limitKind: 'five_hour' }), provider: 'Codex', window: '5-hour' },
      { name: 'Codex (managed)', adapter: () => piAdapter(() => 'unused'), model: PI, error: managedCodexLimit, provider: 'Codex', window: '5-hour' }
    ]
    it.each(cases)('$name pauses the run instead of failing it', async ({ adapter, model, error, provider, window }) => {
      const adapterUnderTest = adapter()
      const d = boot(newHome(), [adapterUnderTest])
      const events: string[] = []
      for (const name of ['turn-paused', 'turn-completed', 'turn-failed']) d.orch.on(name, () => events.push(name))
      const thread = d.store.createThread('Limited')
      d.orch.setThreadModelOverride(thread.id, model)
      adapterUnderTest.failNext = error()

      const response = await d.orch.send('Do the work', false, { threadId: thread.id, clientRequestId: 'first' })

      const run = d.engine.getRun(response.runId!)!
      expect(run.status).toBe('paused')
      expect(run.outcome?.pause).toMatchObject({ reason: 'usage_limit', estimated: false, count: 1, autoResume: true, limitKind: expect.any(String) })
      // The delegation-facing facts: non-terminal, no active run, the pause is what the thread's runs show.
      expect(d.engine.getActiveRun(thread.id)).toBeNull()
      expect(d.engine.store.getPausedRun(thread.id)?.runId).toBe(run.runId)
      expect(events).toEqual(['turn-paused'])
      const state = d.orch.getTurnState(thread.id)
      expect(state).toMatchObject({ phase: 'paused', turnId: run.runId, pause: { runId: run.runId, estimated: false, autoResume: true } })
      const line = systemLines(d, thread.id).find((text) => text.startsWith('Paused until'))
      expect(line).toContain(`${provider}'s ${window} limit was reached`)
      expect(line).toContain(`time reported by ${provider}`)
      expect(line).toContain('continues by itself')
      // The timer waits for the reset, in its own lane.
      expect(effectsOf(d, run.runId, 'run.resume')).toEqual([expect.objectContaining({ status: 'pending', availableAt: run.outcome!.pause!.until })])
      expect(adapterUnderTest.turns).toHaveLength(1)
    })
  })

  it('with the setting off the pause arms no timer and says to press Resume now', async () => {
    const pi = scripted([{ fail: () => limit() }])
    const d = boot(newHome(), [pi], { runs: { resumeAfterUsageLimit: false } })
    const { thread, run } = await paused(d, pi)
    expect(run.outcome!.pause).toMatchObject({ autoResume: false })
    expect(effectsOf(d, run.runId, 'run.resume')).toEqual([])
    expect(systemLines(d, thread.id).find((text) => text.startsWith('Paused until'))).toContain('Press Resume now or send a message to continue.')
    await new Promise((resolve) => setTimeout(resolve, RESET_MS + 300))
    expect(d.engine.getRun(run.runId)!.status).toBe('paused')
    expect(pi.turns).toHaveLength(1)
  })

  it('a limit with no usable reset time pauses until an estimate and says so', async () => {
    const pi = scripted([{ fail: () => usageLimitError({ provider: 'claude', estimated: true, limitKind: 'five_hour' }) }])
    const d = boot(newHome(), [pi])
    const { run } = await paused(d, pi)
    expect(run.outcome!.pause).toMatchObject({ estimated: true })
    expect(Date.parse(run.outcome!.pause!.until) - Date.now()).toBeGreaterThan(4 * 3_600_000)
  })

  describe('at the reset time', () => {
    it('continues once, as a new run that opens with the note, and a second timer fire changes nothing', async () => {
      const pi = scripted([{ fail: () => limit() }])
      const d = boot(newHome(), [pi])
      const { thread, run } = await paused(d, pi)
      expect(pi.turns).toHaveLength(1)

      await waitFor(() => runsOf(d, thread.id).length === 2 && settled(d, thread.id), 'the continuation to finish')

      const [first, continued] = runsOf(d, thread.id)
      expect(first).toMatchObject({ runId: run.runId, status: 'interrupted', outcome: { interruptedBy: 'provider', pause: { endedBy: 'resume' } } })
      expect(continued).toMatchObject({
        status: 'completed',
        source: 'resume',
        clientRequestId: `queue:resume:${run.runId}`,
        outcome: { continuationOf: run.runId, resumedFromPause: 'auto' }
      })
      // The provider saw the fixed text, no replay of the paused turn.
      expect(pi.turns.map((turn) => turn.prompt)).toEqual(['Do the work', CONTINUE_TEXT])
      expect(systemLines(d, thread.id)).toContain('Continuing run 1 after the usage limit reset.')
      expect(queueOf(d, thread.id)).toEqual([])
      expect(effectsOf(d, run.runId, 'run.resume').map((effect) => effect.status)).toEqual(['succeeded'])
      expect(d.orch.getTurnState(thread.id).phase).toBe('completed')

      // The timer fires again (a duplicate delivery): it finds the pause handed over and does nothing.
      const [timer] = effectsOf(d, run.runId, 'run.resume')
      await (d.orch as any).executeResumeEffect(timer)
      expect(runsOf(d, thread.id)).toHaveLength(2)
      expect(pi.turns).toHaveLength(2)
    })

    it('does not continue before the reset', async () => {
      const pi = scripted([{ fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi])
      const { thread } = await paused(d, pi)
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(runsOf(d, thread.id)).toHaveLength(1)
      expect(queueOf(d, thread.id)).toEqual([])
      expect(pi.turns).toHaveLength(1)
    })
  })

  it('a Stop that came before the limit stays a Stop: the run is interrupted by the user and never paused', async () => {
    const gate = deferred()
    const pi = scripted([{ gate: gate.promise, fail: () => limit({ ms: 60_000 }) }])
    const d = boot(newHome(), [pi])
    const thread = d.store.createThread('Stopping')
    d.orch.setThreadModelOverride(thread.id, PI)
    const first = await d.orch.send('Do the work', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => pi.turns.length === 1, 'the turn')

    const stopping = d.orch.stopThread(thread.id, 'user')
    await waitFor(() => d.engine.getRun(first.runId!)!.outcome?.stopRequested === true, 'the Stop to be recorded')
    gate.release()
    await stopping
    await waitFor(() => d.engine.getRun(first.runId!)!.status === 'interrupted', 'the run to end')

    expect(d.engine.getRun(first.runId!)).toMatchObject({ status: 'interrupted', outcome: { interruptedBy: 'user' } })
    expect(d.engine.store.getPausedRun(thread.id)).toBeNull()
    expect(effectsOf(d, first.runId!, 'run.resume')).toEqual([])
  })

  describe('Resume now', () => {
    it('continues a pause that arms no timer, as the person\'s own continuation', async () => {
      const pi = scripted([{ fail: () => limit() }])
      const d = boot(newHome(), [pi], { runs: { resumeAfterUsageLimit: false } })
      const { thread, run } = await paused(d, pi)

      await d.orch.resumePausedRun(run.runId)
      await waitFor(() => runsOf(d, thread.id).length === 2 && settled(d, thread.id), 'the continuation to finish')

      expect(runsOf(d, thread.id)[1]).toMatchObject({ source: 'resume_now', status: 'completed', outcome: { continuationOf: run.runId, resumedFromPause: 'user' } })
      expect(d.engine.getRun(run.runId)!.outcome!.pause).toMatchObject({ endedBy: 'resume_now' })
      expect(pi.turns.map((turn) => turn.prompt)).toEqual(['Do the work', CONTINUE_TEXT])
    })

    it('replaces the waiting timer: one item and one run, however often it is pressed', async () => {
      const pi = scripted([{ fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi])
      const { thread, run } = await paused(d, pi)

      await Promise.all([d.orch.resumePausedRun(run.runId), d.orch.resumePausedRun(run.runId)])
      await waitFor(() => runsOf(d, thread.id).length === 2 && settled(d, thread.id), 'the continuation to finish')
      // A press after the hand-over is refused, so the banner learns it is stale.
      await expect(d.orch.resumePausedRun(run.runId)).rejects.toMatchObject({ reason: 'conflict' })

      expect(runsOf(d, thread.id)).toHaveLength(2)
      expect(pi.turns).toHaveLength(2)
      const timers = effectsOf(d, run.runId, 'run.resume')
      expect(timers.filter((effect) => effect.status === 'cancelled')).toHaveLength(1)
      expect(timers.filter((effect) => (effect.payload as { manual?: true }).manual)).toHaveLength(1)
    })
  })

  describe('Stop and Cancel while paused', () => {
    it('a Stop ends the pause and its timer; nothing continues', async () => {
      const pi = scripted([{ fail: () => limit({ ms: 2_000 }) }])
      const d = boot(newHome(), [pi])
      const { thread, run } = await paused(d, pi)

      await d.orch.stopThread(thread.id, 'user')

      expect(d.engine.getRun(run.runId)).toMatchObject({ status: 'cancelled', outcome: { interruptedBy: 'user', pause: { endedBy: 'stop' } } })
      expect(effectsOf(d, run.runId, 'run.resume').map((effect) => effect.status)).toEqual(['cancelled'])
      expect(d.orch.getTurnState(thread.id).phase).toBe('idle')
      expect(systemLines(d, thread.id)).toContain('Paused run stopped.')
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(runsOf(d, thread.id)).toHaveLength(1)
      expect(pi.turns).toHaveLength(1)
    })

    it('Cancel ends the pause without a continuation and says so', async () => {
      const pi = scripted([{ fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi])
      const { thread, run } = await paused(d, pi)

      await d.orch.cancelPausedRun(run.runId)

      expect(d.engine.getRun(run.runId)).toMatchObject({ status: 'cancelled', outcome: { pause: { endedBy: 'cancel' } } })
      expect(effectsOf(d, run.runId, 'run.resume').map((effect) => effect.status)).toEqual(['cancelled'])
      expect(systemLines(d, thread.id)).toContain('Paused run cancelled.')
      expect(d.orch.getTurnState(thread.id).phase).toBe('idle')
      await expect(d.orch.cancelPausedRun(run.runId)).rejects.toMatchObject({ reason: 'conflict' })
      expect(pi.turns).toHaveLength(1)
    })

    it('deleting the thread ends the pause at once', async () => {
      const pi = scripted([{ fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi])
      const { thread, run } = await paused(d, pi)
      d.orch.markThreadDeleted(thread.id)
      expect(d.engine.getRun(run.runId)).toMatchObject({ status: 'cancelled', outcome: { pause: { endedBy: 'deleted' } } })
      expect(effectsOf(d, run.runId, 'run.resume').map((effect) => effect.status)).toEqual(['cancelled'])
    })
  })

  describe('a restart while paused', () => {
    it('continues once when the reset passed while the daemon was off', async () => {
      const home = newHome()
      const pi = scripted([{ fail: () => limit({ ms: 1500 }) }])
      const first = boot(home, [pi], { pid: 1 })
      const { thread, run } = await paused(first, pi)
      await first.crash()
      await new Promise((resolve) => setTimeout(resolve, 1700))

      const second = boot(home, [pi], { pid: 2 })
      // The pause survived the restart untouched.
      expect(second.engine.getRun(run.runId)!.status).toBe('paused')
      await waitFor(() => runsOf(second, thread.id).length === 2 && settled(second, thread.id), 'the continuation to finish')

      expect(runsOf(second, thread.id).filter((entry) => entry.source === 'resume')).toHaveLength(1)
      expect(pi.turns.map((turn) => turn.prompt)).toEqual(['Do the work', CONTINUE_TEXT])
    })

    it('shows the pause again after boot, and keeps the timer for the reset', async () => {
      const home = newHome()
      const pi = scripted([{ fail: () => limit({ ms: 60_000 }) }])
      const first = boot(home, [pi], { pid: 1 })
      const { thread, run } = await paused(first, pi)
      await first.crash()

      const second = boot(home, [pi], { pid: 2 })
      second.orch.restorePausedTurnStates()
      expect(second.orch.getTurnState(thread.id)).toMatchObject({ phase: 'paused', turnId: run.runId, pause: { runId: run.runId, until: run.outcome!.pause!.until, autoResume: true } })
      expect(effectsOf(second, run.runId, 'run.resume').map((effect) => effect.status)).toEqual(['pending'])
      expect(second.engine.getActiveRun(thread.id)).toBeNull()
    })

    it('a timer that fires more than a day after the reset does not continue; Resume now still does', async () => {
      const home = newHome()
      const pi = scripted([{ fail: () => limit({ ms: 1500 }) }])
      const first = boot(home, [pi], { pid: 1 })
      const { thread, run } = await paused(first, pi)
      await first.crash()

      // Two days later.
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * 24 * 3_600_000 })
      const second = boot(home, [pi], { pid: 2 })
      await waitFor(() => second.engine.getRun(run.runId)!.outcome!.pause!.stale === true, 'the stale ruling')
      expect(second.engine.getRun(run.runId)).toMatchObject({ status: 'paused', outcome: { pause: { autoResume: false, stale: true } } })
      expect(systemLines(second, thread.id)).toContain('The usage limit reset while Mousse was off. Press Resume now or send a message to continue.')
      expect(pi.turns).toHaveLength(1)
      // The run is still paused, so the thread still shows it, now with no timer to wait for.
      expect(second.orch.getTurnState(thread.id)).toMatchObject({ phase: 'paused', turnId: run.runId, pause: { runId: run.runId, autoResume: false, stale: true } })

      await second.orch.resumePausedRun(run.runId)
      await waitFor(() => runsOf(second, thread.id).length === 2 && settled(second, thread.id), 'the continuation to finish')
      expect(runsOf(second, thread.id)[1]).toMatchObject({ source: 'resume_now', status: 'completed' })
    })
  })

  describe('the repeat cap', () => {
    it('fails the run once the limit was hit again after the cap, and says how often', async () => {
      const pi = scripted([{ fail: () => limit() }, { fail: () => limit() }, { fail: () => limit() }])
      const d = boot(newHome(), [pi], { runs: { usageLimitPauseCap: 2 } })
      const { thread } = await paused(d, pi)

      await waitFor(() => runsOf(d, thread.id).length >= 2 && runsOf(d, thread.id)[1].status === 'paused', 'the second pause')
      expect(runsOf(d, thread.id)[1].outcome!.pause).toMatchObject({ count: 2 })
      await waitFor(() => runsOf(d, thread.id).length === 3 && runsOf(d, thread.id)[2].status === 'failed', 'the third hit to fail')

      expect(runsOf(d, thread.id)[2].outcome!.error).toContain('Usage limit reached 3 times in a row')
      expect(d.engine.store.getPausedRun(thread.id)).toBeNull()
      expect(pi.turns).toHaveLength(3)
    })

    it('a Resume now starts the count again', async () => {
      const pi = scripted([{ fail: () => limit() }, { fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi], { runs: { usageLimitPauseCap: 1, resumeAfterUsageLimit: false } })
      const { thread, run } = await paused(d, pi)

      await d.orch.resumePausedRun(run.runId)
      await waitFor(() => runsOf(d, thread.id).length === 2 && d.engine.getRun(runsOf(d, thread.id)[1].runId)!.status === 'paused', 'the second pause')

      // Past the cap of one an automatic resume would have failed; a person's press is a fresh chain.
      expect(runsOf(d, thread.id)[1].outcome!.pause).toMatchObject({ count: 1 })
    })
  })

  describe('a message sent during the pause', () => {
    it('a person\'s message ends it: the timer goes and the message runs once', async () => {
      const pi = scripted([{ fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi])
      const { thread, run } = await paused(d, pi)
      await d.orch.send('try another way', false, { threadId: thread.id, clientRequestId: 'person-1', source: 'gui' })

      expect(d.engine.getRun(run.runId)).toMatchObject({ status: 'cancelled', outcome: { interruptedBy: 'user', pause: { endedBy: 'user_message' } } })
      expect(effectsOf(d, run.runId, 'run.resume').map((effect) => effect.status)).toEqual(['cancelled'])
      expect(pi.turns.map((turn) => turn.prompt)).toEqual(['Do the work', 'try another way'])
      expect(d.orch.getTurnState(thread.id).phase).toBe('completed')
      expect(queueOf(d, thread.id)).toEqual([])
    })

    it('a steer that names no run is kept as a held message: the text is not lost and the pause stays', async () => {
      const pi = scripted([{ fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi], { runs: { resumeAfterUsageLimit: false } })
      const { thread, run } = await paused(d, pi)

      expect(d.orch.steerThreadOrEnqueueExternal(thread.id, 'also check the logs')).toEqual({ steered: false, queued: true })

      expect(d.engine.getRun(run.runId)!.status).toBe('paused')
      expect(queueOf(d, thread.id).map((item) => [item.source, item.content])).toEqual([['steer-late', 'also check the logs']])
      await d.orch.resumePausedRun(run.runId)
      await waitFor(() => pi.turns.length === 3 && settled(d, thread.id), 'the continue turn and the steer')
      expect(pi.turns.map((turn) => turn.prompt)).toEqual(['Do the work', CONTINUE_TEXT, 'also check the logs'])
    })

    it('a scheduled send neither ends the pause nor starts the count again', async () => {
      const pi = scripted([{ fail: () => limit({ ms: 1200 }) }, { fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi])
      const { thread, run } = await paused(d, pi)

      await expect(d.orch.send('Weekly report', false, { threadId: thread.id, clientRequestId: 'schedule:job:1', source: 'schedule', preemptQuestions: false })).rejects.toMatchObject({ code: 'thread_paused' })
      expect(d.engine.getRun(run.runId)!.status).toBe('paused')
      expect(runsOf(d, thread.id)).toHaveLength(1)
      expect(effectsOf(d, run.runId, 'run.resume').map((effect) => effect.status)).toEqual(['pending'])

      // The chain of automatic resumes goes on as if it had not been sent: the next pause is the second.
      await waitFor(() => runsOf(d, thread.id).length === 2 && runsOf(d, thread.id)[1].status === 'paused', 'the second pause')
      expect(runsOf(d, thread.id)[1].outcome!.pause).toMatchObject({ count: 2 })
    })

    it('a message another thread\'s agent sends is refused too: it never ends the pause', async () => {
      const pi = scripted([{ fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi])
      const { thread, run } = await paused(d, pi)

      await expect(agentSend(d, thread.id, 'agent-1')).rejects.toMatchObject({ code: 'thread_paused' })

      expect(d.engine.getRun(run.runId)!.status).toBe('paused')
      expect(effectsOf(d, run.runId, 'run.resume').map((effect) => effect.status)).toEqual(['pending'])
      expect(runsOf(d, thread.id)).toHaveLength(1)
    })

    it('a scheduled run admitted before the pause waits: starting it neither ends the pause nor runs beside it', async () => {
      const gate = deferred()
      const pi = scripted([{ gate: gate.promise, fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi])
      const thread = d.store.createThread('Busy')
      d.orch.setThreadModelOverride(thread.id, PI)
      const first = await d.orch.send('Do the work', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
      await waitFor(() => pi.turns.length === 1, 'the first turn')
      const queued = await d.engine.dispatch({ kind: 'send', threadId: thread.id, clientRequestId: 'schedule:job:2', source: 'schedule' })
      if (queued.status !== 'accepted') throw new Error('send rejected')
      gate.release()
      await waitFor(() => d.engine.getRun(first.runId!)!.status === 'paused', 'the pause')

      expect(() => d.engine.markStarting(queued.runId)).toThrow(/paused/)
      expect(d.engine.getRun(first.runId!)!.status).toBe('paused')
      expect(d.engine.getRun(queued.runId)!.status).toBe('queued')
    })
  })

  describe('nothing runs beside the pause', () => {
    it('work started on the thread\'s behalf is refused while paused, and the pause stays', async () => {
      const pi = scripted([{ fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi])
      const { thread, run } = await paused(d, pi)

      for (const source of ['wake', 'provider-continuation', 'integration', 'delegation', 'steer-late']) {
        const result = await d.engine.dispatch({ kind: 'send', threadId: thread.id, clientRequestId: `behalf:${source}`, source })
        expect(result).toMatchObject({ status: 'rejected', reason: 'thread_paused' })
      }
      expect(d.engine.getRun(run.runId)!.status).toBe('paused')
      expect(effectsOf(d, run.runId, 'run.resume').map((effect) => effect.status)).toEqual(['pending'])
      expect(runsOf(d, thread.id)).toHaveLength(1)
    })

    it('a row that arrives while paused wakes nothing, and the continue turn carries it once', async () => {
      const pi = scripted([{ fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi])
      const { thread, run } = await paused(d, pi)
      const reconciler = new Reconciler({ store: d.engine.store, outbox: d.engine.outbox, tools: new ToolInvocations(d.engine.store), now: () => new Date().toISOString(), capabilitiesFor: () => PI_LOOP_CAPABILITIES })
      d.engine.inbox.append({ inboxId: `inbox:pr-update:${thread.id}:1:0`, threadId: thread.id, kind: 'pr_update', payload: { text: NOTICE, number: 7, headSha: 'abcdef0123', changes: ['checks_failed'] } })

      expect(reconciler.runOnce().wakes.wakes).toEqual([])
      expect(d.engine.inbox.listForThread(thread.id)[0]).toMatchObject({ status: 'pending' })

      await d.orch.resumePausedRun(run.runId)
      await waitFor(() => runsOf(d, thread.id).length === 2 && settled(d, thread.id), 'the continuation to finish')

      expect(pi.turns).toHaveLength(2)
      expect(pi.turns[1].prompt).toContain(CONTINUE_TEXT)
      expect(pi.turns[1].prompt.split(NOTICE_MARK).length - 1).toBe(1)
      expect(d.engine.inbox.listForThread(thread.id)[0]).toMatchObject({ status: 'acknowledged' })
      expect(reconciler.runOnce().wakes.wakes).toEqual([])
      expect(d.engine.inbox.listDeliveredByQueue()).toEqual([])
    })

    it('a wake admitted before the limit does not start while paused; its rows reach the continue turn once', async () => {
      const gate = deferred()
      const pi = scripted([{ gate: gate.promise, fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi])
      ;(d.orch as any).wakeBusyDeferMs = 50
      const thread = d.store.createThread('Busy')
      d.orch.setThreadModelOverride(thread.id, PI)
      const first = await d.orch.send('Do the work', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
      await waitFor(() => pi.turns.length === 1, 'the first turn')
      // The wake was admitted while the thread was busy: its run is queued and its effect waits.
      const rowId = `inbox:pr-update:${thread.id}:1:0`
      d.engine.inbox.append({ inboxId: rowId, threadId: thread.id, kind: 'pr_update', payload: { text: NOTICE, number: 7, headSha: 'abcdef0123', changes: ['checks_failed'] } })
      const wake = await d.engine.dispatch({ kind: 'send', threadId: thread.id, clientRequestId: 'wake:1', source: 'wake' })
      if (wake.status !== 'accepted') throw new Error('send rejected')
      const effect = d.engine.outbox.enqueue({ threadId: thread.id, runId: wake.runId, kind: 'turn.start', payload: { kind: 'wake', threadId: thread.id, runId: wake.runId, inboxIds: [rowId] } })
      d.engine.inbox.markDelivered([rowId], effect.effectId)

      gate.release()
      await waitFor(() => d.engine.getRun(first.runId!)!.status === 'paused', 'the pause')
      await waitFor(() => d.engine.getRun(wake.runId)!.status === 'cancelled', 'the wake to end without starting')

      expect(pi.turns).toHaveLength(1)
      expect(d.engine.getRun(first.runId!)!.status).toBe('paused')
      expect(d.engine.inbox.listForThread(thread.id)[0]).toMatchObject({ status: 'pending' })
      expect(effectsOf(d, first.runId!, 'run.resume').map((entry) => entry.status)).toEqual(['pending'])

      await d.orch.resumePausedRun(first.runId!)
      await waitFor(() => settled(d, thread.id) && pi.turns.length === 2, 'the continuation to finish')
      expect(pi.turns[1].prompt.split(NOTICE_MARK).length - 1).toBe(1)
      expect(d.engine.inbox.listForThread(thread.id)[0]).toMatchObject({ status: 'acknowledged' })
    })

    it('a steer the live turn never read waits behind the continue turn instead of starting beside the pause', async () => {
      const gate = deferred()
      const pi = scripted([{ gate: gate.promise, fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi], { runs: { resumeAfterUsageLimit: false } })
      const thread = d.store.createThread('Steered')
      d.orch.setThreadModelOverride(thread.id, PI)
      const first = await d.orch.send('Do the work', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
      await waitFor(() => pi.turns.length === 1, 'the first turn')
      // The live turn takes the steer into its pending text; the limit ends the turn before it is read.
      expect(d.orch.steerThread(thread.id, 'also check the logs')).toBe(true)
      gate.release()
      await waitFor(() => d.engine.getRun(first.runId!)!.status === 'paused', 'the pause')
      await new Promise((resolve) => setTimeout(resolve, 300))

      // Held like any queued message: not started, and the pause is intact.
      expect(pi.turns).toHaveLength(1)
      expect(d.engine.getRun(first.runId!)!.status).toBe('paused')
      expect(queueOf(d, thread.id).map((item) => item.content)).toEqual(['also check the logs'])

      await d.orch.resumePausedRun(first.runId!)
      await waitFor(() => pi.turns.length === 3 && settled(d, thread.id), 'the continue turn and the steer')
      expect(pi.turns.map((turn) => turn.prompt)).toEqual(['Do the work', CONTINUE_TEXT, 'also check the logs'])
    })

    it('a steer effect that fires after the pause is held too, and keeps the pause', async () => {
      const pi = scripted([{ fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi], { runs: { resumeAfterUsageLimit: false } })
      const { thread, run } = await paused(d, pi)
      ;(d.orch as any).executeTurnSteerEffect({ effectId: 'steer-1', payload: { runId: run.runId, threadId: thread.id, text: 'late guidance' } })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(d.engine.getRun(run.runId)!.status).toBe('paused')
      expect(pi.turns).toHaveLength(1)
      expect(queueOf(d, thread.id).map((item) => item.source)).toEqual(['steer-late'])

      await d.orch.resumePausedRun(run.runId)
      await waitFor(() => pi.turns.length === 3 && settled(d, thread.id), 'the continue turn and the late steer')
      expect(pi.turns.map((turn) => turn.prompt)).toEqual(['Do the work', CONTINUE_TEXT, 'late guidance'])
    })
  })

  describe.each([['a message a person queued', 'gui'], ['a follow-up a parent queued for a subagent', 'delegation'], ['a message another thread\'s agent queued', 'mcp']])('%s before the limit', (_name, source) => {
    const ordered = async (automatic: boolean) => {
      const gate = deferred()
      const pi = scripted([{ gate: gate.promise, fail: () => limit({ ms: automatic ? 1500 : 60_000 }) }])
      const home = newHome()
      const d = boot(home, [pi], { runs: { resumeAfterUsageLimit: automatic } })
      const thread = d.store.createThread('Queued')
      d.orch.setThreadModelOverride(thread.id, PI)
      const first = await d.orch.send('first', false, { threadId: thread.id, clientRequestId: 'a', awaitMode: 'ack' })
      await waitFor(() => pi.turns.length === 1, 'the first turn')
      const queued = source === 'mcp' ? await agentSend(d, thread.id, 'b') : await d.orch.send('second', false, { threadId: thread.id, clientRequestId: 'b', source, awaitMode: 'ack' })
      expect(queued.queued).toBe(true)
      gate.release()
      await waitFor(() => d.engine.getRun(first.runId!)!.status === 'paused', 'the pause')
      return { d, pi, home, thread, first }
    }

    it('stays queued while paused and runs after the continue turn (Resume now)', async () => {
      const { d, pi, thread, first } = await ordered(false)
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(pi.turns).toHaveLength(1)
      expect(queueOf(d, thread.id).filter((item) => !item.internal).map((item) => item.content)).toEqual([expect.stringContaining('second')])

      await d.orch.resumePausedRun(first.runId!)
      await waitFor(() => pi.turns.length === 3 && settled(d, thread.id), 'both turns')
      expect(pi.turns.map((turn) => turn.prompt)).toEqual(['first', CONTINUE_TEXT, expect.stringContaining('second')])
      expect(queueOf(d, thread.id)).toEqual([])
    })

    it('runs after the continue turn at the reset, also across a restart', async () => {
      const { d, pi, home, thread, first } = await ordered(true)
      await d.crash()
      const second = boot(home, [pi], { pid: 2 })
      // The startup drain looks at the thread too: the queue is held, so it takes nothing.
      second.orch.recoverAndDrainPendingQueues()
      expect(queueOf(second, thread.id).filter((item) => !item.internal).map((item) => item.content)).toEqual([expect.stringContaining('second')])
      await waitFor(() => pi.turns.length === 3 && settled(second, thread.id), 'both turns')
      expect(pi.turns.map((turn) => turn.prompt)).toEqual(['first', CONTINUE_TEXT, expect.stringContaining('second')])
      expect(second.engine.getRun(first.runId!)!.status).toBe('interrupted')
    })
  })

  describe('a crash at each step of the resume', () => {
    /** Throws once at `point`: the effect that was running ends as a crash leaves it, and runs again. */
    const crashOnce = (point: string) => {
      const state = { fired: false }
      const fault = (name: string): void => {
        if (name !== point || state.fired) return
        state.fired = true
        throw new Error(`crash at ${name}`)
      }
      return { state, fault }
    }
    /** A paused run with a notice row waiting for it, whose limit resets in a moment. */
    const pausedWithRow = async (home: string, pi: ScriptedAdapter, fault: (point: string) => void) => {
      const d = boot(home, [pi], { pid: 1, fault })
      const out = await paused(d, pi)
      d.engine.inbox.append({ inboxId: rowId(out.thread.id), threadId: out.thread.id, kind: 'pr_update', payload: { text: NOTICE, number: 7, headSha: 'abcdef0123', changes: ['checks_failed'] } })
      return { d, ...out }
    }

    /** One continuation, the notice delivered once and acknowledged, nothing queued, no row owned by a missing item. */
    const expectOneContinuation = (d: Phase6Daemon, pi: ScriptedAdapter, threadId: string) => {
      expect(runsOf(d, threadId)).toHaveLength(2)
      expect(runsOf(d, threadId)[1]).toMatchObject({ status: 'completed', source: 'resume' })
      expect(pi.turns).toHaveLength(2)
      expect(pi.turns[1].prompt.split(NOTICE_MARK).length - 1).toBe(1)
      expect(d.engine.inbox.listForThread(threadId)[0]).toMatchObject({ status: 'acknowledged' })
      expect(queueOf(d, threadId)).toEqual([])
      expect(d.engine.inbox.listDeliveredByQueue()).toEqual([])
      expect(systemLines(d, threadId).filter((text) => text.startsWith('Continuing run'))).toHaveLength(1)
    }

    it.each(['resume.afterPrepare', 'resume.afterItem', 'resume.afterRows'])('%s: a retry in the same process', async (point) => {
      const pi = scripted([{ fail: () => limit({ ms: 1500 }) }])
      const { state, fault } = crashOnce(point)
      const { d, thread } = await pausedWithRow(newHome(), pi, fault)
      await waitFor(() => runsOf(d, thread.id).length === 2 && settled(d, thread.id), 'the continuation to finish')
      expect(state.fired).toBe(true)
      expectOneContinuation(d, pi, thread.id)
    })

    it.each(['resume.afterPrepare', 'resume.afterItem', 'resume.afterRows'])('%s: a restart, with no client retry', async (point) => {
      const home = newHome()
      const pi = scripted([{ fail: () => limit({ ms: 1500 }) }])
      const { state, fault } = crashOnce(point)
      const { d: first, thread } = await pausedWithRow(home, pi, fault)
      await waitFor(() => state.fired, 'the crash')
      await first.crash()

      const second = boot(home, [pi], { pid: 2 })
      await waitFor(() => runsOf(second, thread.id).length === 2 && settled(second, thread.id), 'the continuation to finish')
      expectOneContinuation(second, pi, thread.id)
    })

    it('a restart at resume.afterItem with the startup drain claiming the item first: the replay marks nothing, later rows stay pending', async () => {
      const home = newHome()
      const pi = scripted([{ fail: () => limit({ ms: 1500 }) }])
      const { state, fault } = crashOnce('resume.afterItem')
      const { d: first, thread, run } = await pausedWithRow(home, pi, fault)
      await waitFor(() => state.fired, 'the crash')
      await first.crash()

      const second = boot(home, [pi], { pid: 2 })
      // The item is on the disk queue, its rows not marked yet; the startup drain runs before the effect's replay.
      second.orch.recoverAndDrainPendingQueues()
      await waitFor(() => runsOf(second, thread.id).length === 2 && settled(second, thread.id), 'the continuation to finish')
      // The hand-over cancelled the retrying timer (a pending timer of a pause that ended is never run); nothing is left to replay.
      expect(effectsOf(second, run.runId, 'run.resume').map((effect) => effect.status)).toEqual(['cancelled'])

      // The continue turn ran with the fixed text alone; the row was never owned by the item, so it is still pending for rule 4.
      expect(pi.turns).toHaveLength(2)
      expect(pi.turns[1].prompt).toBe(CONTINUE_TEXT)
      expect(second.engine.inbox.listForThread(thread.id)[0]).toMatchObject({ status: 'pending' })
      expect(second.engine.inbox.listDeliveredByQueue()).toEqual([])
      expect(queueOf(second, thread.id)).toEqual([])
    })

    it('the first queue save throws after the item was built: no row is owned before the item is durable, and the retry delivers each once', async () => {
      const pi = scripted([{ fail: () => limit({ ms: 1500 }) }])
      const { d, thread } = await pausedWithRow(newHome(), pi, () => undefined)
      const save = vi.spyOn(d.store, 'saveMessageQueue')
      let ownedAtFailure = -1
      save.mockImplementationOnce(() => {
        ownedAtFailure = d.engine.inbox.listDeliveredByQueue().length
        throw new Error('the queue file could not be written')
      })
      await waitFor(() => runsOf(d, thread.id).length === 2 && settled(d, thread.id), 'the continuation to finish')
      expect(ownedAtFailure).toBe(0)
      expectOneContinuation(d, pi, thread.id)
    })

    it('every carried row read before the claim: the continue turn still runs with the fixed text, and nothing stays owned', async () => {
      const pi = scripted([{ fail: () => limit({ ms: 60_000 }) }])
      let acknowledge: (() => void) | undefined
      const d = boot(newHome(), [pi], { fault: (point) => { if (point === 'resume.afterRows') { const run = acknowledge; acknowledge = undefined; run?.() } } })
      const { thread, run } = await paused(d, pi)
      d.engine.inbox.append({ inboxId: rowId(thread.id), threadId: thread.id, kind: 'pr_update', payload: { text: NOTICE, number: 7, headSha: 'abcdef0123', changes: ['checks_failed'] } })
      // `task_status` reads the row between the item's write and its claim.
      acknowledge = () => d.engine.inbox.markAcknowledged([rowId(thread.id)])

      await d.orch.resumePausedRun(run.runId)
      await waitFor(() => runsOf(d, thread.id).length === 2 && settled(d, thread.id), 'the continuation to finish')

      expect(pi.turns.map((turn) => turn.prompt)).toEqual(['Do the work', CONTINUE_TEXT])
      expect(d.engine.getRun(run.runId)!.status).toBe('interrupted')
      expect(d.engine.inbox.listDeliveredByQueue()).toEqual([])
      expect(queueOf(d, thread.id)).toEqual([])
    })

    it('a crash between the continuation\'s admission and its turn.start: the queue re-drains the item, one run', async () => {
      const pi = scripted([{ fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi], { runs: { resumeAfterUsageLimit: false } })
      const { thread, run } = await paused(d, pi)
      const startTurn = vi.spyOn(d.orch as any, 'startTurn')
      startTurn.mockImplementationOnce(() => { throw new Error('crash before the turn.start was recorded') })

      await d.orch.resumePausedRun(run.runId)
      await waitFor(() => d.engine.getRun(run.runId)!.status === 'interrupted', 'the hand-over')
      expect(runsOf(d, thread.id)[1]).toMatchObject({ status: 'queued', source: 'resume_now' })
      expect(pi.turns).toHaveLength(1)

      // The queue's own recovery: the item is still on the disk queue and its dispatch replays the same run.
      d.orch.recoverAndDrainPendingQueues()
      await waitFor(() => runsOf(d, thread.id)[1].status === 'completed', 'the continuation')
      expect(runsOf(d, thread.id)).toHaveLength(2)
      expect(pi.turns.map((turn) => turn.prompt)).toEqual(['Do the work', CONTINUE_TEXT])
      expect(queueOf(d, thread.id)).toEqual([])
    })
  })

  describe('superseded between the first step and the item', () => {
    it.each(['cancel', 'user_message'] as const)('%s lands between the first step and the item: the item is retired without reaching the provider and no row stays owned', async (endedBy) => {
      const pi = scripted([{ fail: () => limit({ ms: 1000 }) }])
      let target: { d: Phase6Daemon; runId: string } | undefined
      let landed = false
      const d = boot(newHome(), [pi], {
        fault: (point) => {
          // The pause ends in the same instant the effect's first step finishes: the item is written for a pause that is over.
          if (point !== 'resume.afterPrepare' || landed || !target) return
          landed = true
          target.d.engine.endPause(target.runId, endedBy)
        }
      })
      const { thread, run } = await paused(d, pi)
      target = { d, runId: run.runId }
      d.engine.inbox.append({ inboxId: `inbox:pr-update:${thread.id}:1:0`, threadId: thread.id, kind: 'pr_update', payload: { text: NOTICE, number: 7, headSha: 'abcdef0123', changes: ['checks_failed'] } })

      await waitFor(() => landed && queueOf(d, thread.id).length === 0 && effectsOf(d, run.runId, 'run.resume').every((effect) => effect.status === 'succeeded'), 'the item to be retired')

      expect(d.engine.getRun(run.runId)).toMatchObject({ status: 'cancelled', outcome: { pause: { endedBy } } })
      expect(runsOf(d, thread.id)).toHaveLength(1)
      expect(pi.turns).toHaveLength(1)
      expect(d.engine.inbox.listDeliveredByQueue()).toEqual([])
      expect(d.engine.inbox.listForThread(thread.id)[0]).toMatchObject({ status: 'pending' })
    })
  })

  describe('the continuation', () => {
    it('keeps the grant and the mode of the run it continues, whatever the settings say by then', async () => {
      const pi = scripted([{ fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi], { runs: { resumeAfterUsageLimit: false } })
      d.settings.agentAccess = { level: 'lineage', projectIds: [], answerApprovals: false }
      const thread = d.store.createThread('Planning')
      d.orch.setThreadModelOverride(thread.id, PI)
      d.orch.setThreadPermissionMode(thread.id, 'ask')
      const first = await d.orch.send({ content: 'Plan it', mode: 'plan' }, false, { threadId: thread.id, clientRequestId: 'plan-1' })
      const pausedRun = d.engine.getRun(first.runId!)!
      expect(pausedRun.status).toBe('paused')
      expect(pausedRun.accessGrant).toBe('lineage')
      const mode = d.orch.runPermissionMode(pausedRun.runId)

      // The profile is loosened while the run waits.
      d.settings.agentAccess = { level: 'manage', projectIds: [], answerApprovals: false }
      d.orch.setThreadPermissionMode(thread.id, 'full')
      await d.orch.resumePausedRun(pausedRun.runId)
      await waitFor(() => runsOf(d, thread.id).length === 2 && settled(d, thread.id), 'the continuation to finish')

      const continued = runsOf(d, thread.id)[1]
      expect(continued.accessGrant).toBe('lineage')
      const [start] = effectsOf(d, continued.runId, 'turn.start')
      expect(start.payload).toMatchObject({ input: { mode: 'plan' }, permissionMode: mode })
      expect(d.orch.runPermissionMode(continued.runId)).toBe(mode)
    })

    it('the automatic one is held to the same limits as Resume now', async () => {
      const pi = scripted([{ fail: () => limit({ ms: 1000 }) }])
      const d = boot(newHome(), [pi])
      const thread = d.store.createThread('Timer')
      d.orch.setThreadModelOverride(thread.id, PI)
      const first = await d.orch.send({ content: 'Plan it', mode: 'plan' }, false, { threadId: thread.id, clientRequestId: 'plan-1' })
      d.settings.agentAccess = { level: 'manage', projectIds: [], answerApprovals: false }
      await waitFor(() => runsOf(d, thread.id).length === 2 && settled(d, thread.id), 'the continuation to finish')
      const continued = runsOf(d, thread.id)[1]
      expect(continued).toMatchObject({ source: 'resume', outcome: { continuationOf: first.runId } })
      expect(continued.accessGrant).toBe('lineage')
      expect(effectsOf(d, continued.runId, 'turn.start')[0].payload).toMatchObject({ input: { mode: 'plan' } })
    })
  })

  describe('stale items, unreadable pauses and the race with settling', () => {
    it('a continue item already on disk is not run more than a day after the reset: startup recovery retires it, Resume now still continues', async () => {
      const home = newHome()
      const pi = scripted([{ fail: () => limit({ ms: 1500 }) }])
      let crashed = false
      // The timer's executor writes the item and then dies, for good.
      const first = boot(home, [pi], { pid: 1, fault: (point) => { if (point === 'resume.afterItem') { crashed = true; throw new Error('crash at resume.afterItem') } } })
      const { thread, run } = await paused(first, pi)
      first.engine.inbox.append({ inboxId: rowId(thread.id), threadId: thread.id, kind: 'pr_update', payload: { text: NOTICE, number: 7, headSha: 'abcdef0123', changes: ['checks_failed'] } })
      await waitFor(() => crashed && queueOf(first, thread.id).length === 1, 'the item to be on disk')
      await first.crash()

      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * 24 * 3_600_000 })
      const second = boot(home, [pi], { pid: 2 })
      second.orch.recoverAndDrainPendingQueues()
      await waitFor(() => second.engine.getRun(run.runId)!.outcome!.pause!.stale === true && queueOf(second, thread.id).length === 0, 'the item to be retired')

      expect(second.engine.getRun(run.runId)).toMatchObject({ status: 'paused', outcome: { pause: { autoResume: false, stale: true } } })
      expect(runsOf(second, thread.id)).toHaveLength(1)
      expect(pi.turns).toHaveLength(1)
      expect(second.orch.getTurnState(thread.id)).toMatchObject({ phase: 'paused', pause: { autoResume: false } })
      expect(systemLines(second, thread.id).filter((text) => text.startsWith('The usage limit reset while Mousse was off'))).toHaveLength(1)
      // The row the item owned is given back, and nothing is left owned by a missing item.
      expect(second.engine.inbox.listDeliveredByQueue()).toEqual([])
      expect(second.engine.inbox.listForThread(thread.id)[0]).toMatchObject({ status: 'pending' })

      await second.orch.resumePausedRun(run.runId)
      await waitFor(() => runsOf(second, thread.id).length === 2 && settled(second, thread.id), 'the continuation to finish')
      expect(runsOf(second, thread.id)[1]).toMatchObject({ source: 'resume_now', status: 'completed' })
    })

    it('a pause that cannot be read holds the queue instead of letting it drain', async () => {
      const pi = scripted([{ fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi], { runs: { resumeAfterUsageLimit: false } })
      const { thread, run } = await paused(d, pi)
      d.orch.enqueueForThread(thread.id, 'queued before', { source: 'gui' })
      const read = vi.spyOn(d.engine.store, 'getPausedRun').mockImplementation(() => { throw new Error('the run database could not be read') })

      expect((d.orch as any).pausedHoldsQueue(thread.id, [])).toBe(true)
      ;(d.orch as any).scheduleQueueDrain(d.orch.getOrCreateSession(thread.id))
      await new Promise((resolve) => setTimeout(resolve, 200))
      read.mockRestore()

      expect(pi.turns).toHaveLength(1)
      expect(queueOf(d, thread.id).filter((item) => item.state === 'pending')).toHaveLength(1)
      expect(d.engine.getRun(run.runId)!.status).toBe('paused')
    })

    it('a Resume now that finds the item an automatic timer wrote is a person\'s resume, and starts a fresh chain', async () => {
      const pi = scripted([{ fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi])
      const { thread, run } = await paused(d, pi)
      // The thread is busy elsewhere, so the item the timer writes is not drained yet.
      const session = d.orch.getOrCreateSession(thread.id)
      session.turnAdmitted = true
      await (d.orch as any).executeResumeEffect({ effectId: 'timer', payload: { kind: 'resume', runId: run.runId, threadId: thread.id, until: run.outcome!.pause!.until } })
      expect(queueOf(d, thread.id).map((item) => item.source)).toEqual(['resume'])

      await d.orch.resumePausedRun(run.runId)
      await waitFor(() => queueOf(d, thread.id).some((item) => item.source === 'resume_now'), 'the item to become a person\'s')
      session.turnAdmitted = false
      ;(d.orch as any).scheduleQueueDrain(session)
      await waitFor(() => runsOf(d, thread.id).length === 2 && settled(d, thread.id), 'the continuation to finish')

      const continued = runsOf(d, thread.id)[1]
      expect(continued).toMatchObject({ source: 'resume_now', outcome: { resumedFromPause: 'user' } })
      // A continuation a person asked for is a person's turn for "Always" rules; the timer's is not.
      expect(startedByPerson({ origin: 'interactive', source: continued.source })).toBe(true)
      expect(startedByPerson({ origin: 'interactive', source: 'resume' })).toBe(false)
    })

    it('a limit that ends the turn while the paused turn is still settling is continued without any other trigger', async () => {
      const pi = scripted([{ fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi], { runs: { resumeAfterUsageLimit: false } })
      const thread = d.store.createThread('Settling')
      d.orch.setThreadModelOverride(thread.id, PI)
      // Resume now lands in the window between the pause and the end of the turn's settlement: the turn still holds the thread.
      let pressed = false
      d.orch.on('turn-state', (state) => {
        if (state.phase !== 'paused' || pressed) return
        pressed = true
        const effect = d.engine.requestResume(state.pause!.runId, true)
        void (d.orch as any).executeResumeEffect(effect)
      })

      const first = await d.orch.send('Do the work', false, { threadId: thread.id, clientRequestId: 'first' })
      expect(pressed).toBe(true)
      await waitFor(() => runsOf(d, thread.id).length === 2 && settled(d, thread.id), 'the continuation to finish')

      expect(d.engine.getRun(first.runId!)!.status).toBe('interrupted')
      expect(pi.turns.map((turn) => turn.prompt)).toEqual(['Do the work', CONTINUE_TEXT])
    })

    it('a pi limit that the harness retried until it gave up still pauses, and is not a connection failure', async () => {
      const exhausted = () => usageLimitError({ provider: 'openai-codex', estimated: true, limitKind: 'five_hour' }, undefined, { retriesExhausted: true })
      expect(isRetriesExhausted(exhausted())).toBe(true)
      const pi = scripted([{ fail: exhausted }])
      const d = boot(newHome(), [pi])
      const events: string[] = []
      for (const name of ['connection-failed', 'turn-paused', 'turn-failed']) d.orch.on(name, () => events.push(name))
      const { run } = await paused(d, pi)
      expect(events).toEqual(['turn-paused'])
      expect(run.outcome!.pause).toMatchObject({ provider: 'openai-codex', estimated: true })
    })

    it('says which provider hit its limit with the labels the failure text uses', () => {
      expect(pauseProviderName('openai-codex')).toBe('ChatGPT')
      expect(pauseProviderName('openai')).toBe('OpenAI')
      expect(pauseProviderName('anthropic')).toBe('Anthropic')
      expect(pauseProviderName(undefined)).toBeUndefined()
      expect(pausedLine({ until: new Date(Date.now() + 3_600_000).toISOString(), estimated: true, provider: 'openai-codex', limitKind: 'five_hour', autoResume: false })).toMatch(/ChatGPT's 5-hour limit was reached \(estimated\)\. Press Resume now or send a message to continue\.$/)
    })

    it('the Bridge is not sent a turn.paused event: older peers reject event types they do not know', () => {
      expect(BRIDGE_THREAD_EVENT_TYPES).not.toContain('turn.paused')
      expect(BRIDGE_THREAD_EVENT_TYPES).toContain('turn.state')
    })
  })

  describe('pre-pause work that is cancelled when it would start', () => {
    it('keeps a finished background task\'s notice for the continuation and says an integration never started', async () => {
      const gate = deferred()
      const pi = scripted([{ gate: gate.promise, fail: () => limit({ ms: 60_000 }) }])
      const d = boot(newHome(), [pi], { runs: { resumeAfterUsageLimit: false } })
      const thread = d.store.createThread('Cancelling')
      d.orch.setThreadModelOverride(thread.id, PI)
      const first = await d.orch.send('Do the work', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
      await waitFor(() => pi.turns.length === 1, 'the first turn')
      const admit = async (clientRequestId: string, source: string) => {
        const result = await d.engine.dispatch({ kind: 'send', threadId: thread.id, clientRequestId, source })
        if (result.status !== 'accepted') throw new Error('send rejected')
        return result.runId
      }
      const continuationRun = await admit('continuation:c1', 'provider-continuation')
      const integrationRun = await admit('integration:1', 'integration')
      gate.release()
      await waitFor(() => d.engine.getRun(first.runId!)!.status === 'paused', 'the pause')

      const cancel = (payload: object): boolean => (d.orch as any).cancelStartOnPausedThread({ payload })
      expect(cancel({ kind: 'continuation', threadId: thread.id, runId: continuationRun, continuationId: 'c1', note: 'A background task finished: the build is green.' })).toBe(true)
      expect(cancel({ kind: 'integration', threadId: thread.id, runId: integrationRun, delegationId: 'task-9' })).toBe(true)

      expect(d.engine.getRun(continuationRun)!.status).toBe('cancelled')
      expect(d.engine.getRun(integrationRun)!.status).toBe('cancelled')
      const rows = d.engine.inbox.listForThread(thread.id)
      const integrationRow = rows.find((row) => (row.payload as { type?: string }).type === 'integration_failed')!
      expect((integrationRow.payload as { text: string; interrupted?: boolean }).text).toContain('did not start')
      expect((integrationRow.payload as { text: string }).text).not.toContain('outcome was known')
      expect((integrationRow.payload as { interrupted?: boolean }).interrupted).toBeUndefined()
      expect(rows.some((row) => (row.payload as { type?: string }).type === 'background_task_finished')).toBe(true)

      await d.orch.resumePausedRun(first.runId!)
      await waitFor(() => pi.turns.length === 2 && settled(d, thread.id), 'the continuation to finish')
      const prompt = pi.turns[1].prompt
      expect(prompt.split('A background task finished: the build is green.').length - 1).toBe(1)
      expect(prompt).toContain('did not start')
    })
  })
})

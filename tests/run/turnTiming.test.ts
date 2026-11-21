/**
 * Every thread's turn logs where its time went from its run's request onward (`src/mms/diagnostics/turnTiming.ts`): one
 * `[turn-timing]` line naming the run, the renderer's request id and how long the service's event loop was held.
 *
 * The orchestrator case runs a real orchestrator, Run Engine and effect worker with a scripted provider that answers
 * with no text (as a reply of tool calls only does), so its line is the one written as the turn ends. The scripted
 * provider is hand-authored: it proves only Mousse's side, not when a real provider writes its first word.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { turnTimingBeginRun, turnTimingEnd, turnTimingMark } from '../../src/mms/diagnostics/turnTiming'
import { PI, phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './phase6Fixture'

vi.setConfig({ testTimeout: 120_000 })

interface TimingLine {
  threadId: string
  runId?: string
  request?: string
  source?: string
  queuedMs?: number
  lagMaxMs?: number
  ended?: string
  ms: Record<string, number>
}

const parse = (line: string): TimingLine => JSON.parse(line.slice('[turn-timing] '.length)) as TimingLine

describe("the event loop's lag while a turn is timed", () => {
  afterEach(() => vi.restoreAllMocks())

  it('records a held event loop in the turn, and runs its heartbeat only while the turn is open', async () => {
    const started = vi.spyOn(globalThis, 'setInterval')
    const cleared = vi.spyOn(globalThis, 'clearInterval')
    const lines: string[] = []
    const turn = turnTimingBeginRun('lag-thread', { runId: 'lag-run' })
    expect(started).toHaveBeenCalledTimes(1)
    turnTimingMark('lag-thread', 'harness')
    const until = performance.now() + 200
    while (performance.now() < until) { /* The loop is held. */ }
    // The heartbeat's late tick runs now and notes the delay.
    await new Promise((resolve) => setTimeout(resolve, 80))
    turnTimingEnd('lag-thread', turn, (line) => lines.push(line))

    expect(lines).toHaveLength(1)
    expect(parse(lines[0])).toMatchObject({ threadId: 'lag-thread', runId: 'lag-run', ended: 'noText' })
    expect(parse(lines[0]).lagMaxMs).toBeGreaterThanOrEqual(120)
    // No turn is open: the heartbeat's timer is gone.
    expect(cleared).toHaveBeenCalledWith(started.mock.results[0]!.value)
    expect(started).toHaveBeenCalledTimes(1)
  })
})

describe("an ordinary thread's turn timing", () => {
  let home: string | undefined
  let previousHome: string | undefined
  let daemon: Phase6Daemon | undefined

  afterEach(async () => {
    await daemon?.stop().catch(() => undefined)
    daemon = undefined
    vi.restoreAllMocks()
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    home = undefined
  })

  it('logs one line for the turn, with its run, its request id and its steps in order', async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-turn-timing-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const projectDir = join(home, 'project')
    mkdirSync(projectDir)
    const lines: TimingLine[] = []
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      const text = String(args[0])
      if (text.startsWith('[turn-timing] ')) lines.push(parse(text))
    })
    const pi = piAdapter(() => '')
    const d = (daemon = phase6Daemon(home, [pi]))
    const project = d.projects.openProject(projectDir)
    const thread = d.store.createThread('Timed thread', project.id)
    d.orch.setThreadModelOverride(thread.id, PI)

    const sent = await d.orch.send('Hello', false, { threadId: thread.id, clientRequestId: 'request-1', awaitMode: 'ack' })
    await waitFor(() => pi.turns.length === 1 && !d.orch.getOrCreateSession(thread.id).isTurnRunning(), 'the turn to settle', 60_000)
    await waitFor(() => lines.length > 0, 'the timing line')

    expect(lines).toHaveLength(1)
    const [line] = lines
    expect(line).toMatchObject({ threadId: thread.id, runId: sent.runId, request: 'request-1', ended: 'noText' })
    expect(line.source).toEqual(expect.any(String))
    expect(line.queuedMs).toBeGreaterThanOrEqual(0)
    expect(line.lagMaxMs).toBeGreaterThanOrEqual(0)
    // Timed from the run's request: its setup is the first step, and the provider's call comes after it.
    const steps = Object.keys(line.ms)
    expect(steps[0]).toBe('setup')
    expect(steps.indexOf('harness')).toBeGreaterThan(0)
    expect(line.ms.setup).toBeLessThanOrEqual(line.ms.harness)
  })
})

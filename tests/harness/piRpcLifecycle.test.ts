import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PI_RPC_CAPS } from '../../src/mms/harness/drivers/pi'
import { instanceEnv } from '../../src/mms/harness/env'
import { PiRpcEngine } from '../../src/mms/harness/pi/engine'
import type { AdapterHost, TurnControl, TurnInput, TurnSink } from '../../src/mms/harness/adapter'
import type { PermissionPrompter } from '../../src/mms/harness/acp/permissions'
import type { ProviderRef } from '../../src/mms/run/types'
import { isRetriesExhausted } from '../../src/shared/harness/types'
import { SteerHold, type PendingSteerFacts } from '../../src/mms/orchestrator/steerHold'
import { cleanBase, scratchDir } from './piRpcFixture'

// The engine's process lifecycle against a stand-in for Pi's RPC mode (`fixtures/pi-rpc-stub.mjs`):
// stalls, crashes with a helper that holds Pi's output, warm Stop, failed turns, refs during cold
// starts. The stub talks only to the engine's own bridge on 127.0.0.1.

const stub = resolve(__dirname, 'fixtures', 'pi-rpc-stub.mjs')
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function setup(options: { warmMs?: number; promptDeadlineMs?: number; commandDeadlineMs?: number; interruptDeadlineMs?: number; apiKey?: () => string; sweepHook?: () => Promise<void>; onCommand?: (type: string) => void } = {}) {
  const scratch = scratchDir('mousse-pi-life-')
  cleanups.push(() => scratch.cleanup())
  const stateDir = join(scratch.dir, 'state')
  const userHome = join(scratch.dir, 'user')
  mkdirSync(userHome, { recursive: true })
  const env = instanceEnv({ instanceId: 'pi:stub', driver: 'pi', configRevision: 0, home: join(stateDir, 'home'), searchPath: [], base: cleanBase(userHome) })
  const spawned: Array<{ pid: number; threadId: string }> = []
  const engine = new PiRpcEngine({
    instanceId: 'pi:stub', provider: 'stub', label: 'Stub', capabilities: PI_RPC_CAPS, env: () => env, stateDir,
    runtime: () => ({ root: scratch.dir, entry: stub, extension: join(scratch.dir, 'unused.mjs') }),
    catalog: () => ({ revision: 1, provider: { id: 'stub', builtin: false, models: [] } }),
    readyDeadlineMs: 10_000,
    commandDeadlineMs: options.commandDeadlineMs ?? 5_000,
    ...(options.promptDeadlineMs ? { promptDeadlineMs: options.promptDeadlineMs } : {}),
    ...(options.interruptDeadlineMs ? { interruptDeadlineMs: options.interruptDeadlineMs } : {}),
    ...(options.warmMs ? { warmMs: options.warmMs } : {}),
    onSpawn: (pid, threadId) => spawned.push({ pid, threadId }),
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.sweepHook ? { sweepHook: options.sweepHook } : {}),
    ...(options.onCommand ? { onCommand: options.onCommand } : {})
  })
  cleanups.push(() => engine.stop())
  const project = (name: string, config: Record<string, unknown> = {}) => {
    const dir = join(scratch.dir, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pi-stub.json'), JSON.stringify(config))
    return dir
  }
  return { engine, spawned, project, stateDir }
}

function turn(cwd: string, overrides: Partial<TurnInput> = {}) {
  const controller = new AbortController()
  const refs: ProviderRef[] = []
  const noop = () => {}
  const input: TurnInput = {
    runId: 'r', attemptId: 'a', threadId: 't', cwd, instanceId: 'pi:stub', model: 'm', llmProvider: 'stub', modelPinned: true,
    mode: 'agent' as TurnInput['mode'], prompt: 'hi', messages: [], signal: controller.signal, ...overrides
  }
  const sink: TurnSink = {
    text: noop, thinking: noop, tool: noop, nativeMessages: noop, compaction: noop, retry: noop, progress: noop, usage: noop,
    providerRef: (ref) => void refs.push(ref), steerAccepted: noop, providerMetrics: noop, lineEdits: noop
  }
  const ctl: TurnControl = { drainSteer: () => undefined, heartbeat: noop }
  const host: AdapterHost = { tools: {}, context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: (text) => text } }
  return { input, sink, ctl, host, controller, refs }
}

const run = (engine: PiRpcEngine, t: ReturnType<typeof turn>) => engine.startTurn(t.input, t.sink, t.ctl, t.host)

describe('Pi RPC engine lifecycle (stub Pi)', () => {
  it('bounds a prompt Pi never accepts, and Stop cancels the wait', async () => {
    const { engine, project } = setup({ promptDeadlineMs: 500 })
    const cwd = project('p', { onPrompt: 'stall' })
    await expect(run(engine, turn(cwd))).rejects.toMatchObject({ code: 'protocol' })
    const patient = setup({ promptDeadlineMs: 20_000 })
    const stopped = turn(patient.project('q', { onPrompt: 'stall' }), { threadId: 't2' })
    const pending = run(patient.engine, stopped)
    await new Promise((done) => setTimeout(done, 1500))
    stopped.controller.abort()
    await expect(pending).resolves.toMatchObject({ aborted: true })
  }, 30_000)

  it('a crash with a helper holding Pi’s output ends interrupted, kills the helper, and stop() waits for it', async () => {
    const { engine, project } = setup()
    const cwd = project('p', { onPrompt: 'crash' })
    await expect(run(engine, turn(cwd))).rejects.toMatchObject({ code: 'interrupted' })
    const helper = Number(readFileSync(join(cwd, 'helper.pid'), 'utf8'))
    cleanups.push(() => { try { process.kill(helper) } catch { /* gone */ } })
    if (process.platform === 'win32') await vi.waitFor(() => expect(alive(helper)).toBe(false), { timeout: 15_000, interval: 100 })
    await engine.stop()
  }, 40_000)

  it('Stop for a thread with no live turn kills its warm process and background work', async () => {
    const { engine, spawned, project } = setup()
    const cwd = project('p', { helperAtStart: true })
    await run(engine, turn(cwd))
    const pid = spawned[0].pid
    const helper = Number(readFileSync(join(cwd, 'helper.pid'), 'utf8'))
    cleanups.push(() => { try { process.kill(helper) } catch { /* gone */ } })
    expect(alive(pid)).toBe(true)
    expect(alive(helper)).toBe(true)
    await expect(engine.stopThread('t')).resolves.toBe('stopped')
    await vi.waitFor(() => {
      expect(alive(pid)).toBe(false)
      expect(alive(helper)).toBe(false)
    }, { timeout: 15_000, interval: 100 })
    await expect(engine.stopThread('t')).resolves.toBe('not_active')
  }, 40_000)

  it('a failed turn leaves its process for the warm period only', async () => {
    const { engine, spawned, project } = setup({ warmMs: 300 })
    const cwd = project('p', { events: [{ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '400 bad request' } }] })
    await expect(run(engine, turn(cwd))).rejects.toBeTruthy()
    const pid = spawned[0].pid
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000, interval: 100 })
  }, 30_000)

  it('flags retriesExhausted only when the last allowed attempt failed; an early refusal keeps its own error', async () => {
    const { engine, project } = setup()
    const refused = project('refused', { events: [
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 5, delayMs: 1, errorMessage: '503' },
      { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'mousse_anthropic_oauth_refused' } },
      { type: 'auto_retry_end', success: false, attempt: 1, finalError: 'mousse_anthropic_oauth_refused' }
    ] })
    const early = await run(engine, turn(refused)).catch((error: unknown) => error)
    expect(isRetriesExhausted(early)).toBe(false)
    expect(early).toMatchObject({ code: 'auth_expired' })
    const exhausted = project('exhausted', { events: [
      { type: 'auto_retry_start', attempt: 5, maxAttempts: 5, delayMs: 1, errorMessage: '503' },
      { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '503 Service unavailable' } },
      { type: 'auto_retry_end', success: false, attempt: 5, finalError: '503 Service unavailable' }
    ] })
    expect(isRetriesExhausted(await run(engine, turn(exhausted, { threadId: 't2' })).catch((error: unknown) => error))).toBe(true)
  }, 30_000)

  it('says the turn waits for the model at its first request only, and passes a retry on with its attempts and delay', async () => {
    const { engine, project } = setup()
    const cwd = project('p', { events: [
      { type: 'turn_start' },
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 5, delayMs: 3000, errorMessage: '503' },
      { type: 'turn_start' },
      // A later request of the same turn (after a tool call) is not a new wait for the model.
      { type: 'turn_start' },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' } }
    ] })
    const t = turn(cwd)
    const statuses: string[] = []
    const retries: unknown[] = []
    t.sink.status = (status) => void statuses.push(status)
    t.sink.retry = (attempt, detail) => void retries.push({ attempt, ...detail })
    await run(engine, t)
    expect(statuses).toEqual(['waiting'])
    expect(retries).toEqual([{ attempt: 1, maxAttempts: 5, delayMs: 3000 }])
  }, 30_000)

  it('reports output after a retry too, so the retry ends when the retried reply streams into the same row', async () => {
    const { engine, project } = setup()
    const delta = (text: string) => ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } })
    const cwd = project('p', { events: [
      { type: 'turn_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
      delta('Part'),
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: '503' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
      delta('The retried '),
      delta('reply'),
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'The retried reply' }], stopReason: 'stop' } }
    ] })
    const t = turn(cwd)
    const order: string[] = []
    t.sink.progress = () => void order.push('progress')
    t.sink.retry = () => void order.push('retry')
    await run(engine, t)
    // Every output reports progress, the retried reply's included: one before the retry, three after it.
    expect(order).toEqual(['progress', 'progress', 'retry', 'progress', 'progress', 'progress'])
  }, 30_000)

  it('reports the prompt cache lifetime where Pi says how much it wrote for an hour, and none where it does not', async () => {
    const { engine, project } = setup()
    const answer = (usage: Record<string, number>) => ({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', usage } })
    const metricsOf = async (cwd: string, threadId: string) => {
      const t = turn(cwd, { threadId })
      const reports: Array<Parameters<TurnSink['providerMetrics']>[0]> = []
      t.sink.providerMetrics = (metrics) => void reports.push(metrics)
      await run(engine, t)
      return reports.at(-1)
    }
    // Pi's Anthropic transport reports the one-hour share of a write; the rest is the default five minutes.
    const hour = await metricsOf(project('hour', { events: [answer({ input: 5, output: 3, cacheRead: 0, cacheWrite: 900, cacheWrite1h: 600 })] }), 't-hour')
    expect(hour?.promptCache).toEqual({ at: expect.any(Number), ttlMs: 60 * 60_000 })
    const fiveMinutes = await metricsOf(project('five', { events: [answer({ input: 5, output: 3, cacheRead: 0, cacheWrite: 900, cacheWrite1h: 0 })] }), 't-five')
    expect(fiveMinutes?.promptCache).toEqual({ at: expect.any(Number), ttlMs: 5 * 60_000 })
    // Another provider says nothing of a lifetime: the turn only says when it was answered.
    const unknown = await metricsOf(project('unknown', { events: [answer({ input: 5, output: 3, cacheRead: 40, cacheWrite: 900 })] }), 't-unknown')
    expect(unknown?.promptCache?.at).toEqual(expect.any(Number))
    expect(unknown?.promptCache?.ttlMs).toBeUndefined()
  }, 30_000)

  it('hands out the registered turn token as the attempt token Mousse calls are stamped with', async () => {
    const { engine, project } = setup()
    const cwd = project('p', { onPrompt: 'turn' })
    const t = turn(cwd)
    t.host.bridge = { mcp: null, turnToken: 'registered-turn-token', sessionInstructions: 'rules', turnPreamble: '', userMcp: 'proxy' }
    await run(engine, t)
    expect(JSON.parse(readFileSync(join(cwd, 'turn.json'), 'utf8'))).toMatchObject({ attemptToken: 'registered-turn-token', sessionInstructions: 'rules' })
  }, 30_000)

  it('reuses the warm process (same pid) while the key is unchanged, and restarts it after the key rotates', async () => {
    let key = 'key-1'
    const { engine, spawned, project } = setup({ apiKey: () => key })
    const cwd = project('p')
    await run(engine, turn(cwd))
    await run(engine, turn(cwd, { runId: 'r2' }))
    expect(spawned).toHaveLength(1)
    key = 'key-2'
    await run(engine, turn(cwd, { runId: 'r3' }))
    expect(spawned).toHaveLength(2)
    await vi.waitFor(() => expect(alive(spawned[0].pid)).toBe(false), { timeout: 10_000, interval: 100 })
  }, 30_000)

  it('Stop with steers queued in Pi returns each one once and ends the turn aborted', async () => {
    const { engine, project } = setup()
    const t = turn(project('p', { onPrompt: 'hang', queued: ['first steer', 'second steer'] }))
    const returned: Array<[string, string | undefined]> = []
    t.ctl.returnSteer = (text, token) => void returned.push([text, token])
    const pending = run(engine, t)
    await vi.waitFor(() => expect(t.refs.some((ref) => ref.sessionId)).toBe(true), { timeout: 10_000 })
    t.controller.abort()
    await expect(pending).resolves.toMatchObject({ aborted: true })
    expect(returned.map(([text]) => text)).toEqual(['first steer', 'second steer'])
  }, 30_000)

  it('a steer Pi queued after its last step is handed back once when the turn ends, after Pi’s queue is cleared (#368)', async () => {
    const order: string[] = []
    const { engine, project } = setup({ onCommand: (type) => void order.push(type) })
    const t = turn(project('p', { onPrompt: 'steerAtEnd' }))
    let drains = 0
    t.ctl.drainSteerEntry = () => (drains++ === 0 ? { text: 'late steer', token: 'drain-1', cut: true } : undefined)
    const taken: Array<string | undefined> = []
    const accepted: string[] = []
    const returned: Array<[string, string | undefined]> = []
    t.ctl.steerTaken = (token) => void taken.push(token)
    t.sink.steerAccepted = (text) => void accepted.push(text)
    t.ctl.returnSteer = (text, token) => {
      returned.push([text, token])
      order.push('handed back')
    }
    const result = await run(engine, t)
    expect(result.aborted).toBeFalsy()
    // Never read, so neither taken nor accepted: handed back once, with its drain, to run as the next turn.
    expect(taken).toEqual([])
    expect(accepted).toEqual([])
    expect(returned).toEqual([['late steer', 'drain-1']])
    // Pi's queue was emptied before the hand-back, and the turn settled only after both: Pi will not inject it later.
    expect(order.filter((step) => ['steer', 'clear_queue', 'handed back'].includes(step))).toEqual(['steer', 'clear_queue', 'handed back'])
  }, 30_000)

  /** Two steers, one per `turn_end`: the first is answered and stays unread in Pi, the second is never answered. */
  const twoSteers = (t: ReturnType<typeof turn>) => {
    let drains = 0
    t.ctl.drainSteerEntry = () => {
      drains += 1
      return drains <= 2 ? { text: `steer ${drains}`, token: `drain-${drains}`, cut: true } : undefined
    }
  }

  it('a steer send that hangs until Pi is killed sends nothing more to Pi: the steers come back once and the finished reply stands', async () => {
    const commands: string[] = []
    const { engine, project } = setup({ commandDeadlineMs: 1_500, onCommand: (type) => void commands.push(type) })
    const t = turn(project('p', { onPrompt: 'steerAtEnd', steer: 'hangSecond' }))
    twoSteers(t)
    const returned: Array<[string, string | undefined]> = []
    t.ctl.returnSteer = (text, token) => void returned.push([text, token])
    const result = await run(engine, t)
    expect(result.aborted).toBeFalsy()
    expect(result.text).toContain('done')
    // The hung one first (its send failed), then the one Pi held: each once.
    expect(returned).toEqual([['steer 2', 'drain-2'], ['steer 1', 'drain-1']])
    expect(commands.filter((type) => ['steer', 'clear_queue', 'abort'].includes(type))).toEqual(['steer', 'steer'])
  }, 30_000)

  it('a steer hand-back that throws at the turn’s end still settles the turn', async () => {
    const { engine, project } = setup({ commandDeadlineMs: 1_500 })
    const t = turn(project('p', { onPrompt: 'steerAtEnd', steer: 'hangSecond' }))
    twoSteers(t)
    const attempts: string[] = []
    t.ctl.returnSteer = (text) => {
      attempts.push(text)
      throw new Error('database is locked')
    }
    const result = await run(engine, t)
    expect(result.aborted).toBeFalsy()
    expect(result.text).toContain('done')
    // Each hand-back was tried once; the rows of those that failed stay `steering` for the next claim to run.
    expect(attempts).toEqual(['steer 2', 'steer 1'])
  }, 30_000)

  it('Stop waits for a steer send still unanswered before it clears Pi’s queue, so the steer comes back once and Pi keeps nothing', async () => {
    const commands: string[] = []
    const { engine, project } = setup({ onCommand: (type) => void commands.push(type) })
    const t = turn(project('p', { onPrompt: 'stepThenHang', steerDelayMs: 800 }))
    let drains = 0
    t.ctl.drainSteerEntry = () => (drains++ === 0 ? { text: 'late steer', token: 'drain-1', cut: true } : undefined)
    const returned: Array<[string, string | undefined]> = []
    t.ctl.returnSteer = (text, token) => void returned.push([text, token])
    const pending = run(engine, t)
    await vi.waitFor(() => expect(commands).toContain('steer'), { timeout: 10_000, interval: 10 })
    // Stop while Pi has not answered the steer yet.
    t.controller.abort()
    await expect(pending).resolves.toMatchObject({ aborted: true })
    // `clear_queue` went after Pi queued the steer, and returned it: handed back once, Pi's queue empty.
    expect(commands.filter((type) => ['steer', 'clear_queue', 'abort'].includes(type))).toEqual(['steer', 'clear_queue', 'abort'])
    expect(returned).toEqual([['late steer', 'drain-1']])
  }, 30_000)

  it('stop() with a turn running (the instance removed) kills the process and ends the turn', async () => {
    const { engine, spawned, project } = setup()
    const t = turn(project('p', { onPrompt: 'hang' }))
    const pending = run(engine, t)
    await vi.waitFor(() => expect(t.refs.some((ref) => ref.sessionId)).toBe(true), { timeout: 10_000 })
    await engine.stop()
    expect(alive(spawned[0].pid)).toBe(false)
    await expect(pending).rejects.toMatchObject({ code: 'interrupted' })
  }, 30_000)

  it('Stop before Pi accepted the prompt kills the process and forgets its session; the prompt never runs', async () => {
    const { engine, spawned, project, stateDir } = setup()
    const cwd = project('p', { onPrompt: 'slowAck', ackDelayMs: 2000 })
    await run(engine, turn(cwd))
    const first = turn(cwd, { runId: 'r2', nativeHistory: 'hi' })
    // A first turn saved the session; the slow one is stopped through its signal before Pi answers.
    writeFileSync(join(cwd, 'pi-stub.json'), JSON.stringify({ onPrompt: 'slowAck', ackDelayMs: 3000 }))
    rmSync(join(cwd, 'ran.txt'))
    const pending = run(engine, first)
    // Pi has the prompt (its ref names the session) but has not answered it yet.
    await vi.waitFor(() => expect(first.refs.some((ref) => ref.sessionId)).toBe(true), { timeout: 10_000 })
    expect(existsSync(join(cwd, 'ran.txt'))).toBe(false)
    const startedAt = Date.now()
    first.controller.abort()
    await expect(pending).resolves.toMatchObject({ aborted: true })
    expect(Date.now() - startedAt).toBeLessThan(10_000)
    for (const { pid } of spawned) expect(alive(pid)).toBe(false)
    await new Promise((done) => setTimeout(done, 3500))
    // The stopped prompt never ran: its process is gone, and its session is forgotten.
    expect(existsSync(join(cwd, 'ran.txt'))).toBe(false)
    const saved = existsSync(join(stateDir, 'threads.json')) ? JSON.parse(readFileSync(join(stateDir, 'threads.json'), 'utf8')) as Record<string, unknown> : {}
    expect(saved.t).toBeUndefined()
  }, 40_000)

  it('Stop while the old process is being replaced (the history changed): no replacement is spawned', async () => {
    const { engine, spawned, project } = setup()
    const cwd = project('p')
    await run(engine, turn(cwd))
    expect(spawned).toHaveLength(1)
    const pending = run(engine, turn(cwd, { runId: 'r2', nativeHistory: 'a different history' })).catch((error: unknown) => error)
    await expect(engine.stopThread('t')).resolves.toBe('stopped')
    await expect(pending).resolves.toMatchObject({ aborted: true })
    await new Promise((done) => setTimeout(done, 1500))
    expect(spawned).toHaveLength(1)
    expect(alive(spawned[0].pid)).toBe(false)
    // The same through the turn's signal, on a fresh warm process each time.
    for (let round = 0; round < 3; round += 1) {
      await run(engine, turn(cwd, { runId: `w${round}` }))
      const count = spawned.length
      const replacing = turn(cwd, { runId: `x${round}`, nativeHistory: `history ${round}` })
      const aborted = run(engine, replacing).catch((error: unknown) => error)
      replacing.controller.abort()
      await expect(aborted).resolves.toMatchObject({ aborted: true })
      await new Promise((done) => setTimeout(done, 500))
      expect(spawned).toHaveLength(count)
    }
  }, 60_000)

  it('the crashed turn and stop() both wait for the cleanup after a crash, not only for the process', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let swept = false
    const { engine, project } = setup({ sweepHook: async () => { await held; swept = true } })
    // The turn (and its writer) ends only after the sweep: held, it has not ended yet.
    let ended = false
    const crashed = run(engine, turn(project('p', { onPrompt: 'crash' }))).catch((error: unknown) => { ended = true; return error })
    await new Promise((done) => setTimeout(done, 1500))
    expect(ended).toBe(false)
    let stopped = false
    const stopping = engine.stop().then(() => { stopped = true })
    await new Promise((done) => setTimeout(done, 500))
    expect(stopped).toBe(false)
    release()
    await stopping
    expect(swept).toBe(true)
    await expect(crashed).resolves.toMatchObject({ code: 'interrupted' })
  }, 40_000)

  it('stop() and thread Stop wait for the cleanup after an explicit kill of a warm process', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let swept = false
    const { engine, project } = setup({ sweepHook: async () => { await held; swept = true } })
    await run(engine, turn(project('p')))
    let done = false
    const stopping = engine.stopThread('t').then(() => { done = true })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(done).toBe(false)
    let stopped = false
    const shutdown = engine.stop().then(() => { stopped = true })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(stopped).toBe(false)
    release()
    await Promise.all([stopping, shutdown])
    expect(swept).toBe(true)
  }, 30_000)

  it('interrupt() during a silent prompt ends the turn at once, not at the prompt deadline', async () => {
    const { engine, project } = setup({ promptDeadlineMs: 60_000 })
    const t = turn(project('p', { onPrompt: 'stall' }))
    const pending = run(engine, t)
    await vi.waitFor(() => expect(t.refs.some((ref) => ref.sessionId)).toBe(true), { timeout: 10_000 })
    const startedAt = Date.now()
    await expect(engine.interrupt(t.refs.at(-1)!)).resolves.toBe('interrupted')
    await expect(pending).resolves.toMatchObject({ aborted: true })
    expect(Date.now() - startedAt).toBeLessThan(10_000)
  }, 40_000)

  it('Stop for a thread whose process has not spawned yet: nothing spawns afterwards', async () => {
    const { engine, spawned, project } = setup()
    const t = turn(project('p'))
    const pending = run(engine, t)
    await expect(engine.stopThread('t')).resolves.toBe('stopped')
    await expect(pending).resolves.toMatchObject({ aborted: true })
    await new Promise((done) => setTimeout(done, 1500))
    for (const { pid } of spawned) expect(alive(pid)).toBe(false)
  }, 30_000)

  it('stop() during a slow start returns without waiting for the ready deadline', async () => {
    const { engine, spawned, project } = setup()
    const pending = run(engine, turn(project('p', { readyDelayMs: 8000 }))).catch((error: unknown) => error)
    await vi.waitFor(() => expect(spawned).toHaveLength(1), { timeout: 10_000 })
    const startedAt = Date.now()
    await engine.stop()
    expect(Date.now() - startedAt).toBeLessThan(5000)
    await pending
  }, 30_000)

  it('a non-retryable failure on the last allowed attempt is not retriesExhausted', async () => {
    const { engine, project } = setup()
    const cwd = project('p', { events: [
      { type: 'auto_retry_start', attempt: 5, maxAttempts: 5, delayMs: 1, errorMessage: '503' },
      { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '401 Unauthorized: invalid api key' } },
      { type: 'auto_retry_end', success: false, attempt: 5, finalError: '401 Unauthorized: invalid api key' }
    ] })
    expect(isRetriesExhausted(await run(engine, turn(cwd)).catch((error: unknown) => error))).toBe(false)
  }, 30_000)

  it('a turn stopped through interrupt() returns aborted', async () => {
    const { engine, project } = setup()
    const cwd = project('p', { onPrompt: 'hang' })
    const t = turn(cwd)
    const pending = run(engine, t)
    await vi.waitFor(() => expect(t.refs.some((ref) => ref.sessionId)).toBe(true), { timeout: 10_000 })
    await expect(engine.interrupt(t.refs.at(-1)!)).resolves.toBe('interrupted')
    await expect(pending).resolves.toMatchObject({ aborted: true })
  }, 30_000)

  it('a ref names its own turn from the first one: Stop and kill during a cold start reach no other thread', async () => {
    const { engine, spawned, project } = setup()
    const busy = turn(project('b', { onPrompt: 'hang' }), { threadId: 'b' })
    const runningB = run(engine, busy)
    await vi.waitFor(() => expect(busy.refs.some((ref) => ref.sessionId)).toBe(true), { timeout: 10_000 })
    const cold = turn(project('a', { readyDelayMs: 3000 }), { threadId: 'a' })
    const startingA = run(engine, cold)
    const refA = cold.refs[0]
    expect(refA.nativeTurnId).toBeTruthy()
    expect(refA.sessionId).toBeUndefined()
    // During A's cold start: kill/Stop of A leave B running.
    engine.terminate(refA)
    await expect(engine.interrupt(refA)).resolves.toBe('interrupted')
    await expect(startingA).resolves.toMatchObject({ aborted: true })
    const pidB = spawned.find((entry) => entry.threadId === 'b')!.pid
    expect(alive(pidB)).toBe(true)
    // A ref with neither key nor session matches nothing.
    await expect(engine.interrupt({ provider: 'stub', instanceId: 'pi:stub' })).resolves.toBe('not_active')
    await expect(engine.interrupt(busy.refs.at(-1)!)).resolves.toBe('interrupted')
    await expect(runningB).resolves.toMatchObject({ aborted: true })
  }, 40_000)

  it('stop() during a cold start leaves no process behind', async () => {
    const { engine, spawned, project } = setup()
    const pending = run(engine, turn(project('p', { readyDelayMs: 2000 }))).catch((error: unknown) => error)
    await vi.waitFor(() => expect(spawned).toHaveLength(1), { timeout: 10_000 })
    await engine.stop()
    await pending
    expect(alive(spawned[0].pid)).toBe(false)
  }, 30_000)
})

// -- Pi cuts in (docs/design/steer-and-interruptions.md §3) ------------------------------------------

/**
 * The turn on the hold, as the orchestrator runs it: the real `SteerHold` decides from the tool events the engine
 * reports, and pending steers are drained, handed back, taken and accepted by token. Records what reaches the turn.
 */
function onHold(t: ReturnType<typeof turn>) {
  const open = new Map<string, string>()
  // A call whose approval the person is asked for is not a running tool (`toolAwaiting`).
  const hold = new SteerHold({ caps: PI_RPC_CAPS, strict: false, foreground: (waiting) => [...open].filter(([callId]) => !waiting.has(callId)).map(([callId, toolName]) => ({ callId, toolName })) })
  type Entry = { text: string; person: boolean; key: string }
  const pending: Entry[] = []
  const drains = new Map<string, Entry[]>()
  let seq = 0
  let drainSeq = 0
  const record = { taken: [] as string[], accepted: [] as string[], returned: [] as string[], held: [] as string[], forced: [] as string[], toolStarts: [] as number[], toolEnds: [] as number[], texts: [] as string[], opened: [] as string[], closed: new Map<string, string>(), responses: new Map<string, string>() }
  const facts = (): PendingSteerFacts | undefined => (pending.length ? { person: pending.some((entry) => entry.person), keys: pending.map((entry) => entry.key), itemIds: [] } : undefined)
  const decide = () => {
    const current = facts()
    if (!current) {
      hold.clear()
      return undefined
    }
    let decision = hold.decide(current)!
    if (decision.delivery === 'hold') record.held.push(hold.hold(current, decision.tools, 'r').waitsFor)
    if (hold.settleForces().applied.length) decision = hold.decide(current)!
    return decision
  }
  t.sink.tool = (event) => {
    if (event.phase === 'start' && event.callId) {
      if (!open.has(event.callId)) record.opened.push(event.callId)
      open.set(event.callId, String(event.title).replace(/^Tool /, ''))
      record.toolStarts.push(Date.now())
    }
    if (event.phase === 'complete' && event.callId) {
      record.closed.set(event.callId, String(event.summary))
      record.responses.set(event.callId, String(event.response ?? ''))
      open.delete(event.callId)
      record.toolEnds.push(Date.now())
    }
    hold.toolEvent()
  }
  t.sink.text = (event) => {
    hold.modelOutput(event.phase)
    if (event.phase === 'complete') record.texts.push(event.content)
  }
  t.sink.thinking = (event) => hold.modelOutput(event.phase)
  t.sink.boundary = (at) => hold.boundary(at)
  t.sink.toolAwaiting = (callId, waiting) => hold.awaiting(callId, waiting)
  t.sink.compaction = (phase) => hold.compacting(phase === 'start')
  t.ctl.peekSteer = () => {
    const decision = decide()
    return decision && { delivery: decision.delivery, ...(decision.holdGeneration !== undefined ? { holdGeneration: decision.holdGeneration } : {}) }
  }
  t.ctl.drainSteerEntry = (opts) => {
    const decision = decide()
    if (!decision) return undefined
    const expected = opts?.expect === undefined ? undefined : Array.isArray(opts.expect) ? opts.expect : [opts.expect]
    if (expected && !expected.includes(decision.delivery)) return undefined
    const entries = pending.splice(0)
    const token = `drain-${++drainSeq}`
    drains.set(token, entries)
    hold.drained(token, decision.forced)
    if (decision.forced) record.forced.push(token)
    return { text: entries.map((entry) => entry.text).join('\n'), token, cut: entries.some((entry) => entry.person), ...(decision.forced ? { forced: true } : {}) }
  }
  t.ctl.mayCut = (token) => hold.mayCut(token)
  t.ctl.returnSteer = (text, token) => {
    record.returned.push(text)
    const entries = token ? drains.get(token) : undefined
    if (token) drains.delete(token)
    pending.unshift(...(entries ?? [{ text, person: true, key: `back-${++seq}` }]))
  }
  t.ctl.steerTaken = (token) => void record.taken.push(token)
  t.sink.steerAccepted = (text) => void record.accepted.push(text)
  return {
    record,
    pending,
    /** A person's steer (or an agent's, `person: false`) promoted into the running turn. */
    steer: (text: string, person = true) => void pending.push({ text, person, key: `k-${++seq}` }),
    /** Send now on the hold shown. */
    sendNow: () => hold.requestForce({ holdGeneration: hold.holdGeneration!, requestId: `now-${++seq}`, itemIds: [] }),
    /** Until the turn reported its first tool call (announced or running). */
    toolStarted: () => vi.waitFor(() => expect(record.toolStarts.length).toBeGreaterThan(0), { timeout: 10_000, interval: 10 })
  }
}

type StubLog = { at: number; command?: string; message?: string; event?: string; aborted?: boolean; read?: string; prompt?: string; cleared?: string[]; refused?: string; abortedBeforeRequest?: boolean }
const stubLog = (cwd: string): StubLog[] => (existsSync(join(cwd, 'log.jsonl')) ? readFileSync(join(cwd, 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as StubLog) : [])
const commandsIn = (cwd: string) => stubLog(cwd).flatMap((entry) => (entry.command ? [entry.command] : []))
const promptsIn = (cwd: string) => stubLog(cwd).flatMap((entry) => (entry.command === 'prompt' ? [entry.message] : []))
const firstAt = (cwd: string, match: (entry: StubLog) => boolean) => stubLog(cwd).find(match)?.at
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
/** A tool step whose `turn_end` releases a steer held during it as Pi's native steer. */
const toolStep = (runMs = 300) => ({ tools: [{ name: 'bash', args: { command: 'sleep 1' }, runMs }] })


/**
 * The thread's questions for a turn that asks before a command (Ask): `allowAfterMs` answers Allow that long after
 * asking; `deaf` neither answers nor lets a steer or a withdrawal end the question. A steer's answer rejects.
 */
function asker(options: { allowAfterMs?: number; deaf?: boolean; allowFirst?: boolean } = {}) {
  const asked: string[] = []
  let rejected = 0
  const waiting = new Set<(answer: string | undefined) => void>()
  const permission: PermissionPrompter = {
    choose: (request, wait) => new Promise((resolve) => {
      asked.push(request.title)
      if (options.deaf) return
      if (options.allowFirst && asked.length === 1) return resolve('allow')
      const answer = (value: string | undefined) => {
        if (!waiting.delete(answer)) return
        resolve(value)
      }
      waiting.add(answer)
      wait?.signal?.addEventListener('abort', () => answer(undefined), { once: true })
      if (options.allowAfterMs !== undefined) setTimeout(() => answer('allow'), options.allowAfterMs)
    }),
    rejectPending: () => {
      if (options.deaf) return
      rejected += 1
      for (const answer of [...waiting]) answer('reject')
    }
  }
  const bridge = { mcp: null, turnToken: 'turn-token', sessionInstructions: '', turnPreamble: '', userMcp: 'proxy' as const, permission }
  return { bridge, asked, rejected: () => rejected }
}

describe('Pi cuts in (stub Pi)', () => {
  it('a steer while Pi writes cuts the reply: the shown text stays, the same turn goes on with the steer, taken once', async () => {
    const { engine, project } = setup()
    const cwd = project('p', { onPrompt: 'script', runs: [[{ forever: true }], [{ text: 'using pnpm now' }]] })
    const t = turn(cwd)
    const h = onHold(t)
    const pending = run(engine, t)
    await vi.waitFor(() => expect(stubLog(cwd).some((entry) => entry.command === 'prompt')).toBe(true), { timeout: 10_000 })
    await sleep(300)
    h.steer('use pnpm')
    const result = await pending
    expect(result.aborted).toBeFalsy()
    expect(commandsIn(cwd)).toEqual(['prompt', 'clear_queue', 'abort', 'prompt'])
    expect(promptsIn(cwd)).toEqual(['hi', 'use pnpm'])
    expect(h.record.taken).toEqual(['drain-1'])
    expect(h.record.accepted).toEqual(['use pnpm'])
    // The cut-off words close their own segment, above the steer; the answer follows in a new one.
    expect(h.record.texts[0]).toMatch(/^word0 word1/)
    expect(result.text).toMatch(/^word0 word1[\s\S]*\n\nusing pnpm now$/)
  }, 30_000)

  it('two cuts in a row each wait for their own settlement and go in once', async () => {
    const { engine, project } = setup()
    const cwd = project('p', { onPrompt: 'script', runs: [[{ forever: true }], [{ forever: true }], [{ text: 'both done' }]] })
    const t = turn(cwd)
    const h = onHold(t)
    const pending = run(engine, t)
    await vi.waitFor(() => expect(promptsIn(cwd)).toEqual(['hi']), { timeout: 10_000 })
    await sleep(200)
    h.steer('first')
    await vi.waitFor(() => expect(promptsIn(cwd)).toEqual(['hi', 'first']), { timeout: 10_000 })
    await sleep(200)
    h.steer('second')
    const result = await pending
    expect(result.aborted).toBeFalsy()
    expect(promptsIn(cwd)).toEqual(['hi', 'first', 'second'])
    expect(h.record.accepted).toEqual(['first', 'second'])
    expect(stubLog(cwd).filter((entry) => entry.refused)).toEqual([])
  }, 30_000)

  for (const steerDelayMs of [0, 600]) {
    it(`a cut while an agent's native steer is ${steerDelayMs ? 'sending' : 'queued'} takes it out of Pi's queue and carries both, in order, each once`, async () => {
      const { engine, project } = setup()
      const cwd = project('p', { onPrompt: 'script', steerDelayMs, runs: [[toolStep(), { forever: true }], [{ text: 'ok' }]] })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await h.toolStarted()
      // An agent's note while the tool runs keeps Pi's native path: sent at the step's end, it waits in Pi's queue.
      h.steer('note from an agent', false)
      await vi.waitFor(() => expect(commandsIn(cwd)).toContain('steer'), { timeout: 10_000 })
      await sleep(100)
      h.steer('a person cuts in')
      const result = await pending
      expect(result.aborted).toBeFalsy()
      expect(commandsIn(cwd)).toEqual(['prompt', 'steer', 'clear_queue', 'abort', 'prompt'])
      expect(promptsIn(cwd)).toEqual(['hi', 'note from an agent\na person cuts in'])
      expect(h.record.accepted).toEqual(['note from an agent', 'a person cuts in'])
      expect(h.record.taken).toEqual(['drain-1', 'drain-2'])
      // Pi's queue was emptied: the model never reads the note a second time on its own.
      expect(stubLog(cwd).filter((entry) => entry.read === 'note from an agent')).toEqual([])
    }, 30_000)
  }

  it('a person’s steer held during a tool goes in natively at its end, and cuts the next reply Pi started without it (release at turn_end)', async () => {
    const { engine, project } = setup()
    const cwd = project('p', { onPrompt: 'script', runs: [[toolStep(), { forever: true }], [{ text: 'answered' }]] })
    const t = turn(cwd)
    const h = onHold(t)
    const pending = run(engine, t)
    await h.toolStarted()
    h.steer('wait, use pnpm')
    const result = await pending
    expect(result.aborted).toBeFalsy()
    // Held for the tool, never cut while it ran.
    expect(h.record.held).toContain('bash')
    expect(firstAt(cwd, (entry) => entry.command === 'abort')!).toBeGreaterThanOrEqual(h.record.toolEnds[0])
    expect(commandsIn(cwd)).toEqual(['prompt', 'steer', 'clear_queue', 'abort', 'prompt'])
    expect(promptsIn(cwd)).toEqual(['hi', 'wait, use pnpm'])
    expect(h.record.accepted).toEqual(['wait, use pnpm'])
  }, 30_000)

  it('an agent’s steer queued at turn_end never cuts: Pi reads it at its next step', async () => {
    const { engine, project } = setup()
    const cwd = project('p', { onPrompt: 'script', runs: [[toolStep(), { text: 'one two three four five six', deltaMs: 40 }]] })
    const t = turn(cwd)
    const h = onHold(t)
    const pending = run(engine, t)
    await h.toolStarted()
    h.steer('a subagent finished', false)
    const result = await pending
    expect(result.aborted).toBeFalsy()
    expect(commandsIn(cwd)).toEqual(['prompt', 'steer'])
    expect(stubLog(cwd).some((entry) => entry.read === 'a subagent finished')).toBe(true)
    expect(h.record.accepted).toEqual(['a subagent finished'])
  }, 30_000)

  it('(a) the reply starts before the native steer is answered and never ends: the cut lands once the answer comes', async () => {
    const { engine, project } = setup()
    const cwd = project('p', { onPrompt: 'script', steerDelayMs: 500, runs: [[toolStep(), { forever: true }], [{ text: 'answered' }]] })
    const t = turn(cwd)
    const h = onHold(t)
    const pending = run(engine, t)
    await h.toolStarted()
    h.steer('stop and use pnpm')
    const result = await pending
    expect(result.aborted).toBeFalsy()
    expect(commandsIn(cwd)).toEqual(['prompt', 'steer', 'clear_queue', 'abort', 'prompt'])
    expect(promptsIn(cwd)).toEqual(['hi', 'stop and use pnpm'])
    expect(h.record.accepted).toEqual(['stop and use pnpm'])
    expect(h.record.taken).toHaveLength(1)
  }, 30_000)

  for (const order of ['okThenStart', 'startThenOk'] as const) {
    it(`(b) the native steer's answer and the reply's start in one stdout chunk (${order}): cut once`, async () => {
      const { engine, project } = setup()
      const cwd = project('p', { onPrompt: 'script', runs: [[toolStep(), { waitSteer: order, forever: true }], [{ text: 'answered' }]] })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await h.toolStarted()
      h.steer('use pnpm')
      const result = await pending
      expect(result.aborted).toBeFalsy()
      expect(commandsIn(cwd)).toEqual(['prompt', 'steer', 'clear_queue', 'abort', 'prompt'])
      expect(promptsIn(cwd)).toEqual(['hi', 'use pnpm'])
      expect(h.record.accepted).toEqual(['use pnpm'])
    }, 30_000)
  }

  it('a native steer Pi reads before answering it is taken once, and its answer changes nothing: no cut', async () => {
    const { engine, project } = setup()
    const cwd = project('p', { onPrompt: 'script', runs: [[toolStep(), { waitSteer: 'readFirst', text: 'answering the steer' }]] })
    const t = turn(cwd)
    const h = onHold(t)
    const pending = run(engine, t)
    await h.toolStarted()
    h.steer('use pnpm')
    const result = await pending
    expect(result.aborted).toBeFalsy()
    expect(commandsIn(cwd)).toEqual(['prompt', 'steer'])
    expect(h.record.accepted).toEqual(['use pnpm'])
    expect(h.record.taken).toEqual(['drain-1'])
    expect(h.record.returned).toEqual([])
  }, 30_000)

  it('a tool announced while the cut waits for the native steer’s answer: no abort, the steer is held again and goes in after the tool', async () => {
    const { engine, project } = setup()
    const cwd = project('p', {
      onPrompt: 'script', steerDelayMs: 500,
      runs: [[toolStep(), { text: 'checking', tools: [{ name: 'bash', args: { command: 'npm test' }, runMs: 1500 }] }, { forever: true }], [{ text: 'answered' }]]
    })
    const t = turn(cwd)
    const h = onHold(t)
    const pending = run(engine, t)
    await h.toolStarted()
    h.steer('use pnpm')
    const result = await pending
    expect(result.aborted).toBeFalsy()
    // The check at dispatch handed it back once; nothing was aborted until the second command had its result.
    expect(h.record.returned).toEqual(['use pnpm'])
    expect(h.record.toolEnds).toHaveLength(2)
    expect(firstAt(cwd, (entry) => entry.command === 'abort')!).toBeGreaterThanOrEqual(h.record.toolEnds[1])
    expect(h.record.accepted).toEqual(['use pnpm'])
    expect(promptsIn(cwd)).toEqual(['hi', 'use pnpm'])
  }, 30_000)

  it('a steer during a retry’s backoff cuts it, and the continuation prompt is sent', async () => {
    const { engine, project } = setup()
    const cwd = project('p', { onPrompt: 'script', runs: [[{ fail: true, delayMs: 8000 }], [{ text: 'answered' }]] })
    const t = turn(cwd)
    const h = onHold(t)
    const pending = run(engine, t)
    await vi.waitFor(() => expect(stubLog(cwd).some((entry) => entry.event === 'auto_retry_start')).toBe(true), { timeout: 10_000 })
    const steeredAt = Date.now()
    h.steer('try another way')
    const result = await pending
    expect(result.aborted).toBeFalsy()
    expect(Date.now() - steeredAt).toBeLessThan(5000)
    expect(promptsIn(cwd)).toEqual(['hi', 'try another way'])
    expect(h.record.accepted).toEqual(['try another way'])
    expect(result.text).toBe('answered')
  }, 30_000)

  it('the settlement barrier is the first agent_settled after the abort, not an agent_end: several agent_end come before it', async () => {
    const { engine, project } = setup()
    // A failed attempt (its own agent_end), the retried reply, then a cut whose abort is answered at once and whose
    // prompt settles 500 ms after its agent_end: only the agent_settled says the prompt is over.
    const cwd = project('p', { onPrompt: 'script', abortSettleDelayMs: 500, abortAnswerFirst: true, runs: [[{ fail: true, delayMs: 50 }, { forever: true }], [{ text: 'answered' }]] })
    const t = turn(cwd)
    const h = onHold(t)
    const pending = run(engine, t)
    await vi.waitFor(() => expect(stubLog(cwd).filter((entry) => entry.event === 'agent_end')).toHaveLength(1), { timeout: 10_000 })
    await sleep(300)
    h.steer('use pnpm')
    const result = await pending
    expect(result.aborted).toBeFalsy()
    const log = stubLog(cwd)
    const settled = log.find((entry) => entry.event === 'agent_settled')!
    expect(settled.aborted).toBe(true)
    expect(log.filter((entry) => entry.event === 'agent_end' && entry.at <= settled.at).length).toBeGreaterThanOrEqual(2)
    const continuation = log.find((entry) => entry.command === 'prompt' && entry.message === 'use pnpm')!
    expect(continuation.at).toBeGreaterThanOrEqual(settled.at)
    expect(log.filter((entry) => entry.refused)).toEqual([])
    expect(h.record.accepted).toEqual(['use pnpm'])
  }, 30_000)

  it('an abort that never settles misses the deadline: the steer comes back once and the turn ends as a Stop would', async () => {
    const { engine, project, spawned } = setup({ interruptDeadlineMs: 1000 })
    const cwd = project('p', { onPrompt: 'script', abort: 'never', runs: [[{ forever: true }]] })
    const t = turn(cwd)
    const h = onHold(t)
    const pending = run(engine, t)
    await vi.waitFor(() => expect(stubLog(cwd).some((entry) => entry.command === 'prompt')).toBe(true), { timeout: 10_000 })
    await sleep(200)
    const steeredAt = Date.now()
    h.steer('use pnpm')
    const result = await pending
    expect(result.aborted).toBe(true)
    expect(Date.now() - steeredAt).toBeLessThan(8000)
    expect(h.record.returned).toEqual(['use pnpm'])
    expect(h.record.accepted).toEqual([])
    expect(h.pending.map((entry) => entry.text)).toEqual(['use pnpm'])
    await vi.waitFor(() => expect(alive(spawned[0].pid)).toBe(false), { timeout: 10_000, interval: 100 })
  }, 30_000)

  it('a steer during a compaction waits for it: the compaction is never stopped, and the cut comes after it', async () => {
    const { engine, project } = setup()
    // Pi compacts while it prepares a step (after the previous step's end), as it does after a tool's result.
    const cwd = project('p', { onPrompt: 'script', runs: [[toolStep(100), { compactMs: 800, forever: true }], [{ text: 'answered' }]] })
    const t = turn(cwd)
    const h = onHold(t)
    const pending = run(engine, t)
    await vi.waitFor(() => expect(stubLog(cwd).some((entry) => entry.event === 'compaction_start')).toBe(true), { timeout: 10_000 })
    h.steer('use pnpm')
    const result = await pending
    expect(result.aborted).toBeFalsy()
    expect(h.record.held).toContain('compaction')
    expect(firstAt(cwd, (entry) => entry.command === 'abort')!).toBeGreaterThanOrEqual(firstAt(cwd, (entry) => entry.event === 'compaction_end')!)
    expect(h.record.accepted).toEqual(['use pnpm'])
  }, 30_000)

  it('Send now during a compaction forces the cut once the compaction ends, even with a tool announced right after it', async () => {
    const { engine, project } = setup()
    const cwd = project('p', { onPrompt: 'script', runs: [[toolStep(100), { compactMs: 800, tools: [{ name: 'bash', args: { command: 'npm test' }, runMs: 20_000 }] }], [{ text: 'answered' }]] })
    const t = turn(cwd)
    const h = onHold(t)
    const pending = run(engine, t)
    await vi.waitFor(() => expect(stubLog(cwd).some((entry) => entry.event === 'compaction_start')).toBe(true), { timeout: 10_000 })
    h.steer('use pnpm')
    await vi.waitFor(() => expect(h.record.held).toContain('compaction'), { timeout: 5000, interval: 20 })
    h.sendNow()
    const result = await pending
    expect(result.aborted).toBeFalsy()
    const compacted = firstAt(cwd, (entry) => entry.event === 'compaction_end')!
    const abortAt = firstAt(cwd, (entry) => entry.command === 'abort')!
    expect(abortAt).toBeGreaterThanOrEqual(compacted)
    expect(abortAt - compacted).toBeLessThan(5000)
    expect(h.record.forced).toHaveLength(1)
    expect(h.record.accepted).toEqual(['use pnpm'])
  }, 30_000)

  it('Send now during a running tool cuts it at once', async () => {
    const { engine, project } = setup()
    const cwd = project('p', { onPrompt: 'script', runs: [[{ tools: [{ name: 'bash', args: { command: 'sleep 60' }, runMs: 60_000 }] }], [{ text: 'answered' }]] })
    const t = turn(cwd)
    const h = onHold(t)
    const pending = run(engine, t)
    await h.toolStarted()
    h.steer('use pnpm')
    await vi.waitFor(() => expect(h.record.held).toContain('bash'), { timeout: 5000, interval: 20 })
    await sleep(300)
    expect(commandsIn(cwd)).toEqual(['prompt'])
    h.sendNow()
    const result = await pending
    expect(result.aborted).toBeFalsy()
    expect(h.record.forced).toHaveLength(1)
    expect(commandsIn(cwd)).toEqual(['prompt', 'clear_queue', 'abort', 'prompt'])
    expect(h.record.accepted).toEqual(['use pnpm'])
  }, 30_000)

  describe('ownership across generations', () => {
    it('agent steer A read by Pi while its answer is late, then person steer B cuts: A is taken once, its late answer changes nothing, and the continuation carries only B', async () => {
      const { engine, project } = setup()
      // A, sent at the tool step's end, is queued at once and answered 800 ms later; Pi prepares the next step for
      // 300 ms, takes A from its queue then, and shows it before the reply that B cuts.
      const cwd = project('p', { onPrompt: 'script', steerDelayMs: 800, runs: [[toolStep(), { prepareMs: 300, forever: true }], [{ text: 'answered' }]] })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await h.toolStarted()
      h.steer('A from an agent', false)
      await vi.waitFor(() => expect(stubLog(cwd).some((entry) => entry.read === 'A from an agent')).toBe(true), { timeout: 10_000 })
      await sleep(100)
      h.steer('B from a person')
      const result = await pending
      expect(result.aborted).toBeFalsy()
      expect(h.record.accepted).toEqual(['A from an agent', 'B from a person'])
      expect(h.record.taken).toHaveLength(2)
      expect(promptsIn(cwd)).toEqual(['hi', 'B from a person'])
      expect(h.record.returned).toEqual([])
    }, 30_000)

    it('agent steer A taken from Pi’s queue at a step’s end when B’s cut clears it: Pi still shows A, which is taken once, and the continuation carries only B', async () => {
      const { engine, project } = setup()
      // A is queued during a reply (Pi checked its queue before it came). B cuts as that reply ends; Pi reads the
      // clear_queue only after the step's end, where it took A out of its queue and prepares the next step for 1.5 s:
      // clear_queue returns A's text, and Pi then shows A all the same (pi-coding-agent keeps it until shown).
      const cwd = project('p', {
        onPrompt: 'script', clearDelayMs: 400,
        runs: [[toolStep(), { waitSteer: 'okThenStart', text: 'one two three four five six seven eight nine ten', deltaMs: 40 }, { prepareMs: 1500, forever: true }], [{ text: 'answered' }]]
      })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await h.toolStarted()
      h.steer('A from an agent', false)
      await vi.waitFor(() => expect(commandsIn(cwd)).toContain('steer'), { timeout: 10_000 })
      await sleep(250)
      h.steer('B from a person')
      const result = await pending
      expect(result.aborted).toBeFalsy()
      const log = stubLog(cwd)
      expect(log.find((entry) => entry.cleared)?.cleared).toEqual(['A from an agent'])
      expect(log.filter((entry) => entry.read === 'A from an agent')).toHaveLength(1)
      // The abort waited until Pi's next request started, after it showed A.
      expect(firstAt(cwd, (entry) => entry.command === 'abort')!).toBeGreaterThanOrEqual(firstAt(cwd, (entry) => entry.read === 'A from an agent')!)
      expect(promptsIn(cwd)).toEqual(['hi', 'B from a person'])
      expect(h.record.accepted).toEqual(['A from an agent', 'B from a person'])
      expect(h.record.taken).toHaveLength(2)
      expect(h.record.returned).toEqual([])
    }, 30_000)

    it('Stop while the cut waits for a native steer’s answer gives the steers back once; nothing starts after it', async () => {
      const { engine, project } = setup()
      const cwd = project('p', { onPrompt: 'script', steerDelayMs: 1000, runs: [[toolStep(), { forever: true }], [{ text: 'answered' }]] })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await h.toolStarted()
      h.steer('use pnpm')
      await vi.waitFor(() => expect(commandsIn(cwd)).toContain('steer'), { timeout: 10_000 })
      await sleep(200)
      t.controller.abort()
      const result = await pending
      expect(result.aborted).toBe(true)
      await sleep(800)
      expect(h.record.returned).toEqual(['use pnpm'])
      expect(h.record.accepted).toEqual([])
      expect(promptsIn(cwd)).toEqual(['hi'])
    }, 30_000)

    it('Stop while the cut waits for its settlement gives the steer back once; the late settlement starts nothing', async () => {
      const { engine, project } = setup()
      const cwd = project('p', { onPrompt: 'script', abortSettleDelayMs: 1000, runs: [[{ forever: true }], [{ text: 'answered' }]] })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await vi.waitFor(() => expect(stubLog(cwd).some((entry) => entry.command === 'prompt')).toBe(true), { timeout: 10_000 })
      await sleep(200)
      h.steer('use pnpm')
      await vi.waitFor(() => expect(commandsIn(cwd)).toContain('abort'), { timeout: 10_000 })
      t.controller.abort()
      const result = await pending
      expect(result.aborted).toBe(true)
      // Back by the time the turn ends (Pi settles before it answers Stop's abort): a later hand-back lands nowhere.
      expect(h.record.returned).toEqual(['use pnpm'])
      expect(h.record.accepted).toEqual([])
      await sleep(1500)
      expect(h.record.returned).toEqual(['use pnpm'])
      expect(promptsIn(cwd)).toEqual(['hi'])
    }, 30_000)

    it('Stop while Pi still checks the continuation prompt waits for its answer: Pi keeps an accepted prompt, so the steer is taken once, not handed back', async () => {
      const { engine, project } = setup()
      const cwd = project('p', { onPrompt: 'script', continuationDelayMs: 1000, runs: [[{ forever: true }], [{ text: 'answered' }]] })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await vi.waitFor(() => expect(stubLog(cwd).some((entry) => entry.command === 'prompt')).toBe(true), { timeout: 10_000 })
      await sleep(200)
      h.steer('use pnpm')
      await vi.waitFor(() => expect(promptsIn(cwd)).toEqual(['hi', 'use pnpm']), { timeout: 10_000 })
      t.controller.abort()
      const result = await pending
      expect(result.aborted).toBe(true)
      // Pi answered it and recorded its user message, though it ran no request for it (spike S3 item 7).
      expect(stubLog(cwd).some((entry) => entry.abortedBeforeRequest)).toBe(true)
      expect(h.record.accepted).toEqual(['use pnpm'])
      expect(h.record.returned).toEqual([])
      await sleep(500)
      expect(h.record.returned).toEqual([])
    }, 30_000)

    it('Stop while Pi does not answer the continuation prompt in time: the process goes with its session, and the steer comes back once, before the turn ends', async () => {
      const { engine, project, spawned } = setup({ interruptDeadlineMs: 1000 })
      // The first prompt's reply streams for 2 s: a new process runs it again for the next turn, and it ends.
      const cwd = project('p', { onPrompt: 'script', continuationDelayMs: 8000, runs: [[{ text: 'one two three four five six seven eight nine ten', deltaMs: 200 }], [{ text: 'answered' }]] })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await vi.waitFor(() => expect(promptsIn(cwd)).toEqual(['hi']), { timeout: 10_000 })
      await sleep(200)
      h.steer('use pnpm')
      await vi.waitFor(() => expect(promptsIn(cwd)).toEqual(['hi', 'use pnpm']), { timeout: 10_000 })
      const stoppedAt = Date.now()
      t.controller.abort()
      const result = await pending
      expect(result.aborted).toBe(true)
      expect(Date.now() - stoppedAt).toBeLessThan(5000)
      expect(h.record.returned).toEqual(['use pnpm'])
      expect(h.record.accepted).toEqual([])
      expect(alive(spawned[0].pid)).toBe(false)
      // The next turn starts a new process on a new session: nothing of the stopped continuation is in it.
      const next = turn(cwd, { prompt: 'use pnpm' })
      expect((await run(engine, next)).aborted).toBe(false)
      expect(spawned).toHaveLength(2)
    }, 30_000)

    it('Stop when Pi does not act on the cut’s abort ends at once: it does not wait for that abort', async () => {
      const { engine, project } = setup({ interruptDeadlineMs: 8000 })
      const cwd = project('p', { onPrompt: 'script', abort: 'ignoreFirst', runs: [[{ forever: true }]] })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await vi.waitFor(() => expect(promptsIn(cwd)).toEqual(['hi']), { timeout: 10_000 })
      await sleep(200)
      h.steer('use pnpm')
      await vi.waitFor(() => expect(commandsIn(cwd)).toContain('abort'), { timeout: 10_000 })
      await sleep(200)
      const stoppedAt = Date.now()
      t.controller.abort()
      const result = await pending
      expect(result.aborted).toBe(true)
      expect(Date.now() - stoppedAt).toBeLessThan(3000)
      expect(h.record.returned).toEqual(['use pnpm'])
    }, 30_000)

    it('a refused continuation prompt gives the steer back once and ends the turn with what it has', async () => {
      const { engine, project } = setup()
      // Pi refuses every prompt after the first.
      const cwd = project('p', { onPrompt: 'script', runs: [[{ forever: true }]], refuseContinuation: true })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await vi.waitFor(() => expect(stubLog(cwd).some((entry) => entry.command === 'prompt')).toBe(true), { timeout: 10_000 })
      await sleep(200)
      h.steer('use pnpm')
      const result = await pending
      expect(result.aborted).toBeFalsy()
      expect(h.record.returned).toEqual(['use pnpm'])
      expect(h.record.accepted).toEqual([])
      expect(result.text).toMatch(/^word0/)
    }, 30_000)
  })

  it('#368 on the hold: a steer sent at the last step comes back once, after clear_queue, before the turn settles', async () => {
    const order: string[] = []
    const { engine, project } = setup({ onCommand: (type) => void order.push(type) })
    const t = turn(project('p', { onPrompt: 'steerAtEnd' }))
    const h = onHold(t)
    // Pending when the last step ends: Pi reads its queue before the native steer reaches it.
    h.steer('late note', false)
    const back = t.ctl.returnSteer!
    t.ctl.returnSteer = (text, token) => {
      order.push('handed back')
      back(text, token)
    }
    const result = await run(engine, t)
    expect(result.aborted).toBeFalsy()
    expect(h.record.accepted).toEqual([])
    expect(h.record.returned).toEqual(['late note'])
    expect(h.pending.map((entry) => entry.text)).toEqual(['late note'])
    expect(order.filter((step) => ['steer', 'clear_queue', 'abort', 'handed back'].includes(step))).toEqual(['steer', 'clear_queue', 'handed back'])
  }, 30_000)

  describe('matching', () => {
    it('repeated identical steers are each taken once, by their own token', async () => {
      const { engine, project } = setup()
      const cwd = project('p', { onPrompt: 'script', runs: [[{ forever: true }], [{ forever: true }], [{ text: 'ok' }]] })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await vi.waitFor(() => expect(promptsIn(cwd)).toEqual(['hi']), { timeout: 10_000 })
      await sleep(200)
      h.steer('again')
      await vi.waitFor(() => expect(promptsIn(cwd)).toEqual(['hi', 'again']), { timeout: 10_000 })
      await sleep(200)
      h.steer('again')
      await pending
      expect(h.record.accepted).toEqual(['again', 'again'])
      expect(new Set(h.record.taken).size).toBe(2)
    }, 30_000)

    it('a steer whose text is part of another, both read natively, is matched by its exact text', async () => {
      const { engine, project } = setup()
      const cwd = project('p', { onPrompt: 'script', runs: [[toolStep(), toolStep(), { text: 'ok' }]] })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await h.toolStarted()
      h.steer('fix', false)
      await vi.waitFor(() => expect(commandsIn(cwd)).toContain('steer'), { timeout: 10_000 })
      h.steer('fix the bug', false)
      await pending
      const reads = stubLog(cwd).flatMap((entry) => (entry.read && entry.read !== 'hi' ? [entry.read] : []))
      expect(reads).toEqual(['fix', 'fix the bug'])
      expect(h.record.accepted).toEqual(['fix', 'fix the bug'])
      expect(h.record.taken).toEqual(['drain-1', 'drain-2'])
    }, 30_000)
  })

  describe('review fixes', () => {
    const gated = (command: string, runMs = 50) => ({ name: 'bash', args: { command }, gate: true, runMs })

    it('a steer while the first of two calls waits for approval cuts at once: it answers the approval, the call Pi never starts is closed, and a later steer cuts the continuation', async () => {
      const { engine, project } = setup()
      const cwd = project('p', { onPrompt: 'script', runs: [[{ tools: [gated('echo one'), gated('echo two')] }], [{ forever: true }], [{ text: 'second answered' }]] })
      const t = turn(cwd, { permissionMode: 'ask' })
      const ask = asker({ allowAfterMs: 2500 })
      t.host.bridge = ask.bridge
      const h = onHold(t)
      const pending = run(engine, t)
      await vi.waitFor(() => expect(ask.asked).toHaveLength(1), { timeout: 10_000 })
      // The call asking is not running, and neither is the second: Pi starts it only after the first passes the gate.
      const steeredAt = Date.now()
      h.steer('use pnpm')
      await vi.waitFor(() => expect(promptsIn(cwd)).toEqual(['hi', 'use pnpm']), { timeout: 10_000 })
      expect(Date.now() - steeredAt).toBeLessThan(2000)
      expect(h.record.held).not.toContain('bash')
      expect(ask.rejected()).toBe(1)
      await sleep(300)
      h.steer('and one more thing')
      const result = await pending
      expect(result.aborted).toBeFalsy()
      expect(promptsIn(cwd)).toEqual(['hi', 'use pnpm', 'and one more thing'])
      // Every row that opened closed; the call Pi never started says so.
      expect(h.record.opened.every((callId) => h.record.closed.has(callId))).toBe(true)
      expect(h.record.closed.get('call_2')).toMatch(/^Not run/)
      expect(stubLog(cwd).some((entry) => entry.event === 'tool_execution_start' && (entry as { call?: string }).call === 'call_2')).toBe(false)
      expect(h.record.accepted).toEqual(['use pnpm', 'and one more thing'])
    }, 30_000)

    it('a steer while the only call waits for approval cuts at once and answers it as the person', async () => {
      const { engine, project } = setup()
      const cwd = project('p', { onPrompt: 'script', runs: [[{ tools: [gated('rm -rf build')] }], [{ text: 'answered' }]] })
      const t = turn(cwd, { permissionMode: 'ask' })
      const ask = asker()
      t.host.bridge = ask.bridge
      const h = onHold(t)
      const pending = run(engine, t)
      await vi.waitFor(() => expect(ask.asked).toHaveLength(1), { timeout: 10_000 })
      const steeredAt = Date.now()
      h.steer('do not delete it')
      const result = await pending
      expect(result.aborted).toBeFalsy()
      expect(Date.now() - steeredAt).toBeLessThan(5000)
      expect(h.record.held).not.toContain('bash')
      expect(ask.rejected()).toBe(1)
      expect(promptsIn(cwd)).toEqual(['hi', 'do not delete it'])
      expect(h.record.closed.get('call_1')).toBeDefined()
    }, 30_000)

    it('Send now while a call waits for the writer cuts at once: the abort does not wait for the writer', async () => {
      const { engine, project } = setup()
      const cwd = project('p', { onPrompt: 'script', runs: [[{ tools: [gated('npm run build')] }], [{ text: 'answered' }]] })
      const t = turn(cwd, { permissionMode: 'full' })
      // The writer never comes (another writer holds the workspace).
      t.host.tools = { toolAccess: { execute: () => new Promise(() => {}) } as never }
      const h = onHold(t)
      const pending = run(engine, t)
      await h.toolStarted()
      h.steer('skip the build')
      await vi.waitFor(() => expect(h.record.held).toContain('bash'), { timeout: 5000, interval: 20 })
      await sleep(200)
      const nowAt = Date.now()
      h.sendNow()
      const result = await pending
      expect(result.aborted).toBeFalsy()
      expect(Date.now() - nowAt).toBeLessThan(5000)
      expect(promptsIn(cwd)).toEqual(['hi', 'skip the build'])
    }, 30_000)

    it('Stop while a call waits for an approval nobody answers ends at once, not after the abort deadline', async () => {
      const { engine, project } = setup()
      const cwd = project('p', { onPrompt: 'script', runs: [[{ tools: [gated('echo hi')] }]] })
      const t = turn(cwd, { permissionMode: 'ask' })
      const ask = asker({ deaf: true })
      t.host.bridge = ask.bridge
      const h = onHold(t)
      const pending = run(engine, t)
      await vi.waitFor(() => expect(ask.asked).toHaveLength(1), { timeout: 10_000 })
      const stoppedAt = Date.now()
      t.controller.abort()
      const result = await pending
      expect(result.aborted).toBe(true)
      expect(Date.now() - stoppedAt).toBeLessThan(4000)
      // The model reads why the call did not run: a Stop, not a new message.
      expect(h.record.responses.get('call_1')).toMatch(/stopped the run/)
    }, 30_000)

    it('a steer while the second of two calls waits for approval cuts at once, though the first was approved: it has not run yet', async () => {
      const { engine, project } = setup()
      const cwd = project('p', { onPrompt: 'script', runs: [[{ tools: [gated('echo one', 20_000), gated('echo two')] }], [{ text: 'answered' }]] })
      const t = turn(cwd, { permissionMode: 'ask' })
      const ask = asker({ allowFirst: true })
      t.host.bridge = ask.bridge
      const h = onHold(t)
      const pending = run(engine, t)
      await vi.waitFor(() => expect(ask.asked).toHaveLength(2), { timeout: 10_000 })
      const steeredAt = Date.now()
      h.steer('use pnpm')
      const result = await pending
      expect(result.aborted).toBeFalsy()
      expect(Date.now() - steeredAt).toBeLessThan(3000)
      expect(h.record.held).not.toContain('bash')
      expect(ask.rejected()).toBe(1)
      expect(promptsIn(cwd)).toEqual(['hi', 'use pnpm'])
    }, 30_000)

    it('Stop while the turn’s end waits for a native steer’s answer: the steer is back by the time the turn ends', async () => {
      const { engine, project } = setup()
      // The last step ends with an agent's note sent natively; Pi answers it 1.5 s later, and settles meanwhile without it.
      const cwd = project('p', { onPrompt: 'script', steerDelayMs: 1500, runs: [[{ text: 'one two three four five six', deltaMs: 60 }]] })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await vi.waitFor(() => expect(promptsIn(cwd)).toEqual(['hi']), { timeout: 10_000 })
      h.steer('a note from an agent', false)
      await vi.waitFor(() => expect(stubLog(cwd).some((entry) => entry.event === 'agent_settled')).toBe(true), { timeout: 10_000 })
      expect(commandsIn(cwd)).toEqual(['prompt', 'steer'])
      await sleep(300)
      t.controller.abort()
      const result = await pending
      expect(result.aborted).toBe(true)
      expect(h.record.returned).toEqual(['a note from an agent'])
      expect(h.record.accepted).toEqual([])
    }, 30_000)

    it('a person’s steer that cuts answers every question pending on the thread, Mousse’s own as well as Pi’s', async () => {
      const { engine, project } = setup()
      const cwd = project('p', { onPrompt: 'script', runs: [[{ forever: true }], [{ text: 'answered' }]] })
      const t = turn(cwd)
      const ask = asker()
      t.host.bridge = ask.bridge
      const h = onHold(t)
      const pending = run(engine, t)
      await vi.waitFor(() => expect(promptsIn(cwd)).toEqual(['hi']), { timeout: 10_000 })
      await sleep(200)
      // A Mousse tool's question (an `ask_user`) is pending on the thread; Pi asks nothing.
      h.steer('use pnpm')
      const result = await pending
      expect(result.aborted).toBeFalsy()
      expect(ask.rejected()).toBe(1)
      expect(h.record.accepted).toEqual(['use pnpm'])
    }, 30_000)

    it('a cut whose clear_queue Pi answers after its agent_end and during its compaction aborts nothing: the steer runs next, the compaction ends, and no cut starts before Pi settles', async () => {
      const { engine, project, spawned } = setup()
      const cwd = project('p', { onPrompt: 'script', clearDelayMs: 800, compactAfterMs: 1500, settleDelayMs: 600, runs: [[{ text: 'one two three four five', deltaMs: 60 }]] })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await vi.waitFor(() => expect(promptsIn(cwd)).toEqual(['hi']), { timeout: 10_000 })
      await sleep(80)
      h.steer('use pnpm')
      const result = await pending
      expect(result.aborted).toBeFalsy()
      expect(commandsIn(cwd)).toEqual(['prompt', 'clear_queue'])
      expect(stubLog(cwd).filter((entry) => entry.event === 'compaction_end' && entry.aborted)).toEqual([])
      expect(h.record.returned).toEqual(['use pnpm'])
      expect(h.pending.map((entry) => entry.text)).toEqual(['use pnpm'])
      // The process stays for the next turn.
      await sleep(500)
      expect(alive(spawned[0].pid)).toBe(true)
    }, 30_000)

    it('Pi reads the steer and settles while the cut waits for the steer’s answer: the turn settles, with no abort', async () => {
      const { engine, project } = setup()
      const cwd = project('p', { onPrompt: 'script', steerDelayMs: 1500, runs: [[toolStep(), { text: 'one two three four five six', deltaMs: 40 }]] })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await h.toolStarted()
      h.steer('use pnpm')
      const result = await pending
      expect(result.aborted).toBeFalsy()
      expect(commandsIn(cwd)).toEqual(['prompt', 'steer'])
      expect(h.record.accepted).toEqual(['use pnpm'])
      expect(h.record.returned).toEqual([])
    }, 30_000)

    it('a retry starts while the cut clears and a call is announced: the cut gives up and the turn runs again, so the steer goes in at the step’s end', async () => {
      const { engine, project } = setup()
      const cwd = project('p', {
        onPrompt: 'script', clearDelayMs: 700,
        runs: [[{ fail: true, delayMs: 300 }, { tools: [{ name: 'bash', args: { command: 'npm test' }, runMs: 900 }] }, { forever: true }], [{ text: 'answered' }]]
      })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await vi.waitFor(() => expect(stubLog(cwd).some((entry) => entry.event === 'auto_retry_start')).toBe(true), { timeout: 10_000 })
      h.steer('use pnpm')
      const result = await pending
      expect(result.aborted).toBeFalsy()
      expect(commandsIn(cwd)).toEqual(['prompt', 'clear_queue', 'steer', 'clear_queue', 'abort', 'prompt'])
      expect(promptsIn(cwd)).toEqual(['hi', 'use pnpm'])
      expect(h.record.accepted).toEqual(['use pnpm'])
    }, 30_000)

    it('Send now whose clear_queue lands as Pi starts a compaction waits for it: a steer never stops a compaction', async () => {
      const { engine, project } = setup()
      const cwd = project('p', { onPrompt: 'script', clearDelayMs: 400, runs: [[toolStep(600), { compactMs: 1000, forever: true }], [{ text: 'answered' }]] })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await h.toolStarted()
      h.steer('use pnpm')
      await vi.waitFor(() => expect(h.record.held).toContain('bash'), { timeout: 5000, interval: 20 })
      await sleep(250)
      h.sendNow()
      const result = await pending
      expect(result.aborted).toBeFalsy()
      expect(stubLog(cwd).filter((entry) => entry.event === 'compaction_end' && entry.aborted)).toEqual([])
      expect(firstAt(cwd, (entry) => entry.command === 'abort')!).toBeGreaterThanOrEqual(firstAt(cwd, (entry) => entry.event === 'compaction_end')!)
      expect(h.record.accepted).toEqual(['use pnpm'])
    }, 30_000)

    it('a steer starting with / goes in as written: Pi does not expand it, and it is read once', async () => {
      const { engine, project } = setup()
      const cwd = project('p', { onPrompt: 'script', runs: [[toolStep(), toolStep(), { text: 'ok' }]] })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await h.toolStarted()
      h.steer('/review the diff', false)
      const result = await pending
      expect(result.aborted).toBeFalsy()
      expect(stubLog(cwd).filter((entry) => entry.read?.trim() === '/review the diff')).toHaveLength(1)
      expect(h.record.accepted).toEqual(['/review the diff'])
      expect(h.record.returned).toEqual([])
    }, 30_000)

    it('a second steer during a cut joins its continuation: one abort, one continuation with both', async () => {
      const { engine, project } = setup()
      const cwd = project('p', { onPrompt: 'script', abortSettleDelayMs: 800, runs: [[{ forever: true }], [{ text: 'both' }]] })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await vi.waitFor(() => expect(promptsIn(cwd)).toEqual(['hi']), { timeout: 10_000 })
      await sleep(200)
      h.steer('first')
      await vi.waitFor(() => expect(commandsIn(cwd)).toContain('abort'), { timeout: 10_000 })
      h.steer('second')
      const result = await pending
      expect(result.aborted).toBeFalsy()
      expect(commandsIn(cwd).filter((command) => command === 'abort')).toHaveLength(1)
      expect(promptsIn(cwd)).toEqual(['hi', 'first\nsecond'])
      expect(h.record.accepted).toEqual(['first', 'second'])
    }, 30_000)

    it('a compaction whose end never comes holds no steer past the next step’s start', async () => {
      const { engine, project } = setup()
      const cwd = project('p', { onPrompt: 'script', runs: [[toolStep(100), { compactionLost: true, forever: true }], [{ text: 'answered' }]] })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await vi.waitFor(() => expect(stubLog(cwd).some((entry) => entry.event === 'compaction_start')).toBe(true), { timeout: 10_000 })
      await sleep(200)
      h.steer('use pnpm')
      const result = await pending
      expect(result.aborted).toBeFalsy()
      expect(promptsIn(cwd)).toEqual(['hi', 'use pnpm'])
    }, 30_000)

    it('Pi crashes during a cut: the steer comes back once and the turn ends interrupted', async () => {
      const { engine, project } = setup()
      const cwd = project('p', { onPrompt: 'script', abort: 'crash', runs: [[{ forever: true }]] })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await vi.waitFor(() => expect(promptsIn(cwd)).toEqual(['hi']), { timeout: 10_000 })
      await sleep(200)
      h.steer('use pnpm')
      await expect(pending).rejects.toThrow(/stopped unexpectedly/)
      expect(h.record.returned).toEqual(['use pnpm'])
      expect(h.record.accepted).toEqual([])
      expect(h.pending.map((entry) => entry.text)).toEqual(['use pnpm'])
    }, 30_000)

    it('a cut keeps only the words shown: what Pi received and never streamed stays out of the reply', async () => {
      const { engine, project } = setup()
      const cwd = project('p', { onPrompt: 'script', abortedText: 'never shown', runs: [[{ holdMs: 5000, text: 'x' }], [{ text: 'answered' }]] })
      const t = turn(cwd)
      const h = onHold(t)
      const pending = run(engine, t)
      await vi.waitFor(() => expect(promptsIn(cwd)).toEqual(['hi']), { timeout: 10_000 })
      await sleep(200)
      h.steer('use pnpm')
      const result = await pending
      expect(result.aborted).toBeFalsy()
      expect(result.text).toBe('answered')
    }, 30_000)
  })
})

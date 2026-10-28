import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PI_RPC_CAPS } from '../../src/mms/harness/drivers/pi'
import { instanceEnv } from '../../src/mms/harness/env'
import { PiRpcEngine } from '../../src/mms/harness/pi/engine'
import type { AdapterHost, TurnControl, TurnInput, TurnSink } from '../../src/mms/harness/adapter'
import type { ProviderRef } from '../../src/mms/run/types'
import { isRetriesExhausted } from '../../src/shared/harness/types'
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

function setup(options: { warmMs?: number; promptDeadlineMs?: number; apiKey?: () => string; sweepHook?: () => Promise<void> } = {}) {
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
    commandDeadlineMs: 5_000,
    ...(options.promptDeadlineMs ? { promptDeadlineMs: options.promptDeadlineMs } : {}),
    ...(options.warmMs ? { warmMs: options.warmMs } : {}),
    onSpawn: (pid, threadId) => spawned.push({ pid, threadId }),
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.sweepHook ? { sweepHook: options.sweepHook } : {})
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

  it('a steer sent while Pi had not accepted the prompt comes back once when Stop kills the process', async () => {
    const { engine, project } = setup()
    const t = turn(project('p', { onPrompt: 'slowAck', ackDelayMs: 5000 }))
    const returned: string[] = []
    t.ctl.returnSteer = (text) => void returned.push(text)
    const pending = run(engine, t)
    await vi.waitFor(() => expect(t.refs.some((ref) => ref.sessionId)).toBe(true), { timeout: 10_000 })
    await expect(engine.steer(t.refs.at(-1)!, 'typed during compaction')).resolves.toBe('delivered')
    t.controller.abort()
    await expect(pending).resolves.toMatchObject({ aborted: true })
    expect(returned).toEqual(['typed during compaction'])
  }, 30_000)

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

  it('a ref names its own turn from the first one: steer, Stop and kill during a cold start reach no other thread', async () => {
    const { engine, spawned, project } = setup()
    const busy = turn(project('b', { onPrompt: 'hang' }), { threadId: 'b' })
    const runningB = run(engine, busy)
    await vi.waitFor(() => expect(busy.refs.some((ref) => ref.sessionId)).toBe(true), { timeout: 10_000 })
    const cold = turn(project('a', { readyDelayMs: 3000 }), { threadId: 'a' })
    const startingA = run(engine, cold)
    const refA = cold.refs[0]
    expect(refA.nativeTurnId).toBeTruthy()
    expect(refA.sessionId).toBeUndefined()
    // During A's cold start: a steer for A goes nowhere, and kill/Stop of A leave B running.
    await expect(engine.steer(refA, 'for A')).resolves.toBe('not_active')
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

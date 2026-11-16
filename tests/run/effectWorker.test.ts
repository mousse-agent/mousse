import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectOutbox } from '../../src/mms/run/EffectOutbox'
import { EffectDeferredError, EffectWorker, WorkerStoppedError, type EffectExecutor, type EffectWorkerFibres } from '../../src/mms/run/EffectWorker'
import { RunStore } from '../../src/mms/run/RunStore'
import type { EffectKind, EffectRecord } from '../../src/mms/run/types'

async function waitFor(check: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

describe('EffectWorker', () => {
  let profileHome: string | undefined
  let db: ProfileDatabase | undefined
  const workers: EffectWorker[] = []

  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.stop()
    vi.restoreAllMocks()
    db?.close()
    db = undefined
    if (profileHome) rmSync(profileHome, { recursive: true, force: true })
    profileHome = undefined
  })

  const setup = (
    executors: Partial<Record<EffectKind, EffectExecutor>>,
    options: { timeoutMs?: number; fibres?: number; laneFibres?: Partial<EffectWorkerFibres>; pollMs?: number } = {}
  ) => {
    profileHome = mkdtempSync(join(tmpdir(), 'mousse-worker-'))
    db = new ProfileDatabase({ profileHome })
    const store = new RunStore(db)
    const outbox = new EffectOutbox(store, {
      kindSpec: {
        'turn.steer': { class: 'process_bound', timeoutMs: options.timeoutMs ?? 30_000 }
      }
    })
    const worker = new EffectWorker({
      outbox,
      executors,
      owner: '1:1',
      // `turn.steer` runs on the control fibres.
      fibres: options.laneFibres ?? { control: options.fibres ?? 2 },
      pollMs: options.pollMs ?? 60_000
    })
    workers.push(worker)
    return { store, outbox, worker }
  }

  it('executes a claimed effect and settles it as succeeded', async () => {
    const seen: EffectRecord[] = []
    const { outbox, worker } = setup({
      'turn.steer': async (effect) => {
        seen.push(effect)
      }
    })
    worker.start()
    // Woken by the outbox commit, not the 60 s poll.
    const effect = outbox.enqueue({ threadId: 't', kind: 'turn.steer', payload: { text: 'hi' } })
    await waitFor(() => outbox.get(effect.effectId)!.status === 'succeeded', 'success')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ effectId: effect.effectId, payload: { text: 'hi' }, attempts: 1 })
    expect(worker.inFlight()).toBe(0)
  })

  it('fails a timed-out execution with "timeout" and retries it', async () => {
    let calls = 0
    const hung = deferred()
    const { outbox, worker } = setup(
      {
        'turn.steer': async () => {
          calls++
          // The first attempt hangs and ignores its signal; the deadline still settles it.
          if (calls === 1) await hung.promise
        }
      },
      { timeoutMs: 50 }
    )
    const effect = outbox.enqueue({ threadId: 't', kind: 'turn.steer' })
    worker.start()
    await waitFor(() => outbox.get(effect.effectId)!.lastError === 'timeout', 'timeout')
    // Retried after the 100 ms backoff.
    await waitFor(() => outbox.get(effect.effectId)!.status === 'succeeded', 'retry')
    expect(outbox.get(effect.effectId)).toMatchObject({ attempts: 2, lastError: 'timeout' })
    expect(calls).toBe(2)
    // The abandoned first attempt is still tracked; stop() waits for it (H5).
    hung.resolve()
  })

  it('an executor that defers puts its effect back to pending later, without counting the attempt', async () => {
    let calls = 0
    const { outbox, worker } = setup({
      'turn.steer': async () => {
        calls++
        if (calls === 1) throw new EffectDeferredError(80, 'thread_busy')
      }
    })
    const effect = outbox.enqueue({ threadId: 't', kind: 'turn.steer' })
    worker.start()
    await waitFor(() => outbox.get(effect.effectId)!.lastError === 'thread_busy', 'deferral')
    // The row rules (back to pending, attempt not counted, available later) are EffectOutbox.defer's (effectOutbox.test.ts).
    await waitFor(() => outbox.get(effect.effectId)!.status === 'succeeded', 'the deferred run')
    expect(outbox.get(effect.effectId)!.attempts).toBe(1)
    expect(calls).toBe(2)
  })

  it('fails an effect without an executor with "no executor"', async () => {
    const { outbox, worker } = setup({})
    const effect = outbox.enqueue({ threadId: 't', kind: 'turn.interrupt' })
    worker.start()
    await waitFor(() => outbox.get(effect.effectId)!.lastError === 'no executor', 'no executor')
    expect(outbox.get(effect.effectId)!.status).toBe('pending')
  })

  it('renews the lease every timeout/3 while executing', async () => {
    let leaseDuringRun: string | null = null
    let initialLease: string | null = null
    const { outbox, worker } = setup(
      {
        'turn.steer': async (effect, ctx) => {
          initialLease = outbox.get(effect.effectId)!.leaseExpiresAt
          await new Promise((resolve) => setTimeout(resolve, 200))
          leaseDuringRun = outbox.get(effect.effectId)!.leaseExpiresAt
          expect(ctx.renewLease()).toBe(true)
        }
      },
      { timeoutMs: 300 }
    )
    const effect = outbox.enqueue({ threadId: 't', kind: 'turn.steer' })
    worker.start()
    await waitFor(() => outbox.get(effect.effectId)!.status === 'succeeded', 'success')
    expect(initialLease).not.toBeNull()
    expect(Date.parse(leaseDuringRun!)).toBeGreaterThan(Date.parse(initialLease!))
  })

  it('discards a late result after the lease was lost', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const release = deferred()
    let started = false
    const { outbox, worker } = setup(
      {
        'turn.steer': async () => {
          started = true
          await release.promise
        }
      },
      { fibres: 1 }
    )
    const effect = outbox.enqueue({ threadId: 't', kind: 'turn.steer' })
    worker.start()
    await waitFor(() => started, 'start')
    // Another daemon reclaims the expired lease and claims the effect.
    const far = new Date(Date.now() + 3_600_000).toISOString()
    expect(outbox.reclaimExpired(far)).toEqual([effect.effectId])
    expect(outbox.claimNext('2:2', addMinutes(far, 1))!.effectId).toBe(effect.effectId)
    release.resolve()
    await waitFor(() => warn.mock.calls.length > 0, 'warning')
    expect(String(warn.mock.calls[0][0])).toContain('lost the lease')
    expect(outbox.get(effect.effectId)).toMatchObject({ status: 'running', leaseOwner: '2:2' })
  })

  it('aborts an in-flight execution with cancelInFlight', async () => {
    let aborted = false
    const { outbox, worker } = setup({
      'turn.steer': (_effect, ctx) =>
        new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('aborted'))
          })
        })
    })
    const effect = outbox.enqueue({ threadId: 't', kind: 'turn.steer' })
    worker.start()
    await waitFor(() => worker.inFlight() === 1, 'in flight')
    expect(worker.cancelInFlight('effect:other')).toBe(false)
    expect(worker.cancelInFlight(effect.effectId)).toBe(true)
    await waitFor(() => outbox.get(effect.effectId)!.status === 'cancelled', 'cancelled')
    expect(aborted).toBe(true)
    expect(outbox.get(effect.effectId)!.lastError).toBe('cancelled')
    expect(worker.inFlight()).toBe(0)
  })

  it('stop() interrupts fibres, waits for in-flight executors to settle, and leaves the row to recovery (H5)', async () => {
    const release = deferred()
    let finished = false
    const { outbox, worker } = setup({
      // Ignores its signal until released, then still writes (like a turn unwinding).
      'turn.steer': async () => {
        await release.promise
        finished = true
      }
    })
    const effect = outbox.enqueue({ threadId: 't', kind: 'turn.steer' })
    worker.start()
    await waitFor(() => worker.inFlight() === 1, 'in flight')
    let stopped = false
    const stopping = worker.stop().then(() => {
      stopped = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    // The fibre has returned, but the executor promise has not settled: stop() is still waiting.
    expect(stopped).toBe(false)
    release.resolve()
    await stopping
    expect(finished).toBe(true)
    expect(worker.inFlight()).toBe(0)
    expect(outbox.get(effect.effectId)).toMatchObject({ status: 'running', leaseOwner: '1:1' })
    // A stopped worker claims nothing.
    const next = outbox.enqueue({ threadId: 'u', kind: 'turn.steer' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(outbox.get(next.effectId)!.status).toBe('pending')
  })

  it('starts every due turn at once, keeps one turn per thread, reaches a live turn with a Stop, and stop() waits for every turn', async () => {
    const gate = deferred()
    const started: string[] = []
    const finished: string[] = []
    const interrupted: string[] = []
    const { store, outbox, worker } = setup({
      // Each turn ignores its signal until the gate opens, as a turn still unwinding does.
      'turn.start': async (effect) => {
        started.push(effect.threadId)
        await gate.promise
        finished.push(effect.threadId)
      },
      'turn.interrupt': async (effect) => {
        interrupted.push(effect.threadId)
      }
    })
    worker.start()
    const send = (threadId: string, source: string) =>
      outbox.enqueue({ threadId, runId: store.createRun({ threadId, source }).runId, kind: 'turn.start' })
    // Twelve threads: people's messages (window, phone, CLI) and background work (subagents, wakes, bots, schedules).
    const sources = ['gui', 'delegation', 'wake', 'bot', 'schedule', 'remote', 'cli', 'delegation', 'resume', 'bot', 'goal', 'gui']
    sources.forEach((source, i) => send(`t${i + 1}`, source))
    await waitFor(() => started.length === 12, 'twelve turns', 1000)
    expect([...started].sort()).toEqual(sources.map((_, i) => `t${i + 1}`).sort())
    // A thirteenth thread's turn starts too; a second turn of a thread waits for that thread's first.
    send('t13', 'delegation')
    const second = send('t1', 'gui')
    await waitFor(() => started.length === 13, 'the thirteenth turn', 1000)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(started.filter((thread) => thread === 't1')).toHaveLength(1)
    expect(outbox.get(second.effectId)!.status).toBe('pending')
    // A Stop reaches a live turn while every turn runs.
    const stop = outbox.enqueue({ threadId: 't2', kind: 'turn.interrupt' })
    await waitFor(() => outbox.get(stop.effectId)!.status === 'succeeded', 'the interrupt', 1000)
    expect(interrupted).toEqual(['t2'])
    // stop() returns only once every turn it started has settled.
    let stopped = false
    const stopping = worker.stop().then(() => {
      stopped = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(stopped).toBe(false)
    gate.resolve()
    await stopping
    expect(finished).toHaveLength(13)
    expect(worker.inFlight()).toBe(0)
    expect(outbox.get(second.effectId)!.status).toBe('pending')
  })

  it('starts the next turn of a thread as soon as its turn before ends', async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>()
    const started: string[] = []
    const { store, outbox, worker } = setup({
      'turn.start': async (effect) => {
        started.push(effect.runId!)
        const gate = deferred()
        gates.set(effect.runId!, gate)
        await gate.promise
      }
    })
    worker.start()
    const first = store.createRun({ threadId: 't', source: 'gui' }).runId
    outbox.enqueue({ threadId: 't', runId: first, kind: 'turn.start' })
    const next = store.createRun({ threadId: 't', source: 'gui' }).runId
    outbox.enqueue({ threadId: 't', runId: next, kind: 'turn.start' })
    await waitFor(() => started.length === 1, 'the first turn')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(started).toEqual([first])
    gates.get(first)!.resolve()
    // Woken by the first turn's settlement, not the 60 s poll.
    await waitFor(() => started.length === 2, 'the next turn', 1000)
    expect(started).toEqual([first, next])
    gates.get(next)!.resolve()
  })

  it('aborts in-flight executions with WorkerStoppedError on stop()', async () => {
    let reason: unknown
    const { outbox, worker } = setup({
      'turn.start': (_effect, ctx) =>
        new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => {
            reason = ctx.signal.reason
            reject(ctx.signal.reason as Error)
          })
        })
    })
    outbox.enqueue({ threadId: 't', kind: 'turn.start' })
    worker.start()
    await waitFor(() => worker.inFlight() === 1, 'in flight')
    await worker.stop()
    expect(reason).toBeInstanceOf(WorkerStoppedError)
  })

  it('survives a failing claim: logs it, idles for the poll interval and claims again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const seen: string[] = []
    const { outbox, worker } = setup({ 'turn.steer': async (effect) => { seen.push(effect.effectId) } }, { pollMs: 20 })
    vi.spyOn(outbox, 'claimNext').mockImplementationOnce(() => { throw new Error('database is locked') })
    const effect = outbox.enqueue({ threadId: 't', kind: 'turn.steer' })
    worker.start()
    await waitFor(() => outbox.get(effect.effectId)!.status === 'succeeded', 'recovery after the failed claim')
    expect(warn).toHaveBeenCalledWith('[effect-worker] claim failed: database is locked')
    expect(seen).toEqual([effect.effectId])
  })

  it('wakes on notify() and on the next available_at', async () => {

    const done: string[] = []
    const { outbox, worker } = setup({
      'turn.steer': async (effect) => {
        done.push(effect.effectId)
      }
    })
    worker.start()
    const soon = outbox.enqueue({
      threadId: 't',
      kind: 'turn.steer',
      availableAt: new Date(Date.now() + 80).toISOString()
    })
    await waitFor(() => done.includes(soon.effectId), 'timer wake')
    // A row inserted behind the outbox's back is picked up on notify().
    db!
      .statement(
        `INSERT INTO effects(effect_id, thread_id, kind, class, status, payload, timeout_ms,
           available_at, created_at, updated_at)
         VALUES('manual', 'u', 'turn.steer', 'process_bound', 'pending', 'null', 30000, ?, ?, ?)`
      )
      .run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString())
    worker.notify()
    await waitFor(() => done.includes('manual'), 'notify wake')
  })

  it('runs request.respond (an approval request\'s answer) on a control fibre beside a turn, and never retries it', async () => {
    profileHome = mkdtempSync(join(tmpdir(), 'mousse-worker-'))
    db = new ProfileDatabase({ profileHome })
    const outbox = new EffectOutbox(new RunStore(db))
    const turn = deferred()
    const delivered: string[] = []
    const worker = new EffectWorker({
      outbox,
      executors: {
        'turn.start': async () => turn.promise,
        'request.respond': async (effect) => {
          delivered.push((effect.payload as { requestId: string }).requestId)
          if (delivered.length === 1) throw new Error('the callback is gone')
        }
      },
      owner: '1:1',
      fibres: { control: 1 },
      pollMs: 60_000
    })
    workers.push(worker)
    worker.start()
    // A long turn is live; the answer is not queued behind it.
    outbox.enqueue({ threadId: 't', kind: 'turn.start' })
    const first = outbox.enqueue({ threadId: 't', kind: 'request.respond', payload: { requestId: 'req-1' } })
    await waitFor(() => outbox.get(first.effectId)!.status === 'failed', 'the failed delivery')
    // Delivered at most once: a failure is final, not another attempt.
    expect(outbox.get(first.effectId)).toMatchObject({ status: 'failed', attempts: 1, maxAttempts: 1 })
    const second = outbox.enqueue({ threadId: 't', kind: 'request.respond', payload: { requestId: 'req-2' } })
    await waitFor(() => outbox.get(second.effectId)!.status === 'succeeded', 'the delivery')
    expect(delivered).toEqual(['req-1', 'req-2'])
    turn.resolve()
  })
})

function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString()
}

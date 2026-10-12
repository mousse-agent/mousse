import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { EffectOutbox } from '../../src/mms/run/EffectOutbox'
import { EffectWorker, WorkerStoppedError, type EffectExecutor, type EffectWorkerFibres } from '../../src/mms/run/EffectWorker'
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
    const { outbox, worker } = setup(
      {
        'turn.steer': async () => {
          calls++
          // The first attempt hangs and ignores its signal; the deadline still settles it.
          if (calls === 1) await new Promise(() => undefined)
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

  it('stop() interrupts fibres, returns, and leaves the in-flight row to recovery', async () => {
    const { outbox, worker } = setup({
      // Ignores its signal entirely.
      'turn.steer': () => new Promise<void>(() => undefined)
    })
    const effect = outbox.enqueue({ threadId: 't', kind: 'turn.steer' })
    worker.start()
    await waitFor(() => worker.inFlight() === 1, 'in flight')
    await worker.stop()
    expect(worker.inFlight()).toBe(0)
    expect(outbox.get(effect.effectId)).toMatchObject({ status: 'running', leaseOwner: '1:1' })
    // A stopped worker claims nothing.
    const next = outbox.enqueue({ threadId: 'u', kind: 'turn.steer' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(outbox.get(next.effectId)!.status).toBe('pending')
  })

  it('runs a stop while every turn fibre holds a live turn, and caps concurrent turns', async () => {
    const gate = deferred()
    const started: string[] = []
    const interrupted: string[] = []
    const { outbox, worker } = setup({
      'turn.start': async (effect) => {
        started.push(effect.threadId)
        await gate.promise
      },
      'turn.interrupt': async (effect) => {
        interrupted.push(effect.threadId)
      }
    })
    expect(worker.fibreCounts).toEqual({ turn: 8, control: 2, replaySafe: 2 })
    worker.start()
    for (let i = 1; i <= 9; i++) outbox.enqueue({ threadId: `t${i}`, kind: 'turn.start' })
    await waitFor(() => started.length === 8, 'eight live turns')
    const stop = outbox.enqueue({ threadId: 't1', kind: 'turn.interrupt' })
    await waitFor(() => outbox.get(stop.effectId)!.status === 'succeeded', 'the interrupt', 1000)
    expect(interrupted).toEqual(['t1'])
    // The ninth turn waits for a turn fibre; control fibres never take it.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(started).toHaveLength(8)
    gate.resolve()
    await waitFor(() => started.length === 9, 'the ninth turn')
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
})

function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString()
}

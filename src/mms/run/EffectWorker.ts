import { addMs, type EffectOutbox, type EffectSettlement } from './EffectOutbox'
import type { EffectKind, EffectLaneClass, EffectRecord } from './types'

export type EffectExecutor = (
  effect: EffectRecord,
  ctx: { signal: AbortSignal; renewLease: () => boolean }
) => Promise<void>

/**
 * Fibres per lane class (SPEC §12.3) for the effects that are not turns: `control` fibres claim only interrupts,
 * steers and answers, so a Stop reaches a live turn however many turns run; `replaySafe` fibres claim the replay-safe
 * kinds. `turn.start` has no fibres: one claimer starts every turn as soon as it is due, with no limit on how many
 * run at once.
 */
export interface EffectWorkerFibres {
  control: number
  replaySafe: number
}

export const DEFAULT_EFFECT_WORKER_FIBRES: Readonly<EffectWorkerFibres> = {
  control: 2,
  replaySafe: 2
}

export interface EffectWorkerOptions {
  outbox: EffectOutbox
  executors: Partial<Record<EffectKind, EffectExecutor>>
  /** Lease owner, `"<daemonEpoch>:<pid>"`. */
  owner: string
  /** Fibres per lane class; missing classes use `DEFAULT_EFFECT_WORKER_FIBRES`. */
  fibres?: Partial<EffectWorkerFibres>
  now?: () => string
  /** Safety poll. Default 30 s. */
  pollMs?: number
}

const DEFAULT_POLL_MS = 30_000

/**
 * The abort reason of every in-flight execution when the worker stops (profile shutdown). The
 * `turn.start` executor reads it to record the run as cut off by a restart, not stopped by a user.
 */
export class WorkerStoppedError extends Error {
  constructor() {
    super('worker stopped')
    this.name = 'WorkerStoppedError'
  }
}

/**
 * Thrown by an executor that cannot run its effect yet (its thread is busy with another turn): the
 * effect goes back to `pending`, available after `delayMs`, and the attempt is not counted.
 */
export class EffectDeferredError extends Error {
  constructor(
    readonly delayMs: number,
    readonly reason = 'deferred'
  ) {
    super(reason)
    this.name = 'EffectDeferredError'
  }
}

class LeaseLostError extends Error {
  constructor() {
    super('lease lost')
  }
}

class EffectCancelledError extends Error {
  constructor() {
    super('cancelled')
  }
}

/**
 * In-process effect worker (SPEC §12.3): one turn claimer and async fibres for the other lane classes claim from
 * the outbox, execute under a deadline and settle by CAS on the lease. The turn claimer starts each `turn.start` it
 * claims without waiting for it and claims again, so every due turn runs at once; the outbox's lanes still keep one
 * turn per thread. Wake sources: outbox commits (`subscribe`), `notify()`, the next `available_at` and a safety poll.
 *
 * Settlement rules: success → `succeed`; `EffectDeferredError` → `defer` (pending again later);
 * failure → `fail(message)` (`'timeout'` when the deadline fired); `cancelInFlight` →
 * owner-checked `cancel`; a lost lease or `stop()` writes nothing (the reconciler or boot recovery
 * owns that row now). A CAS miss on settlement is logged and ignored. `stop()` returns only after
 * every executor promise it started has settled, so nothing writes after it.
 */
export class EffectWorker {
  private readonly outbox: EffectOutbox
  private readonly executors: Partial<Record<EffectKind, EffectExecutor>>
  private readonly owner: string
  private readonly fibres: Readonly<EffectWorkerFibres>
  private readonly now: () => string
  private readonly pollMs: number
  private stopController: AbortController | null = null
  private loops: Array<Promise<void>> = []
  private unsubscribe: (() => void) | null = null
  private readonly wakers = new Set<() => void>()
  private generation = 0
  private readonly running = new Map<string, AbortController>()
  /** Turn executions the turn claimer started that have not settled yet (`stop()` waits for them). */
  private readonly turns = new Set<Promise<void>>()
  /** Executor promises still running, including ones a race already gave up on. */
  private readonly executing = new Set<Promise<unknown>>()

  constructor(options: EffectWorkerOptions) {
    this.outbox = options.outbox
    this.executors = options.executors
    this.owner = options.owner
    const fibres = { ...DEFAULT_EFFECT_WORKER_FIBRES, ...(options.fibres ?? {}) }
    this.fibres = {
      control: Math.max(1, Math.floor(fibres.control)),
      replaySafe: Math.max(1, Math.floor(fibres.replaySafe))
    }
    this.now = options.now ?? (() => new Date().toISOString())
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
  }

  start(): void {
    if (this.stopController) return
    const controller = new AbortController()
    this.stopController = controller
    this.unsubscribe = this.outbox.subscribe(() => this.notify())
    const lanes = Object.keys(this.fibres) as Array<keyof EffectWorkerFibres>
    this.loops = [
      this.turnLoop(controller.signal),
      ...lanes.flatMap((lane) => Array.from({ length: this.fibres[lane] }, () => this.loop(controller.signal, [lane])))
    ]
  }

  /**
   * Interrupts the turn claimer, every fibre and every in-flight execution, then waits for them, for every turn the
   * claimer started and for every executor promise to settle: an aborted executor may still be unwinding (writing
   * its run's terminal state) after its execution has moved on.
   */
  async stop(): Promise<void> {
    const controller = this.stopController
    if (!controller) return
    this.stopController = null
    this.unsubscribe?.()
    this.unsubscribe = null
    controller.abort(new WorkerStoppedError())
    this.notify()
    await Promise.all(this.loops)
    this.loops = []
    while (this.turns.size) await Promise.allSettled([...this.turns])
    while (this.executing.size) await Promise.allSettled([...this.executing])
  }

  /** Wakes the idle turn claimer and fibres to claim again. */
  notify(): void {
    this.generation++
    const wakers = [...this.wakers]
    this.wakers.clear()
    for (const wake of wakers) wake()
  }

  /** Aborts the local execution of a claimed effect. Returns false when it is not in flight. */
  cancelInFlight(effectId: string): boolean {
    const controller = this.running.get(effectId)
    if (!controller) return false
    controller.abort(new EffectCancelledError())
    return true
  }

  inFlight(): number {
    return this.running.size
  }

  /**
   * Claims every due `turn.start` and starts each at once, without waiting for it to end, then claims again; idles
   * only when nothing is claimable. A turn waits only for its own thread's lane (one turn per thread at a time).
   */
  private async turnLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const generation = this.generation
      const now = this.now()
      let effect: EffectRecord | null
      try {
        effect = this.outbox.claimNext(this.owner, now, { lanes: ['turn'] })
      } catch (error) {
        console.warn(`[effect-worker] claim failed: ${messageOf(error)}`)
        await this.idle(signal, generation, this.pollMs)
        continue
      }
      if (effect) this.startTurn(effect, signal)
      else await this.idle(signal, generation, this.idleDelay(now))
    }
  }

  private startTurn(effect: EffectRecord, signal: AbortSignal): void {
    const execution = this.execute(effect, signal).catch((error: unknown) => {
      console.warn(`[effect-worker] executing ${effect.effectId} failed: ${messageOf(error)}`)
    })
    this.turns.add(execution)
    void execution.then(() => this.turns.delete(execution))
  }

  private async loop(signal: AbortSignal, lanes: readonly EffectLaneClass[]): Promise<void> {
    while (!signal.aborted) {
      const generation = this.generation
      const now = this.now()
      let effect: EffectRecord | null
      try {
        effect = this.outbox.claimNext(this.owner, now, { lanes })
      } catch (error) {
        console.warn(`[effect-worker] claim failed: ${messageOf(error)}`)
        await this.idle(signal, generation, this.pollMs)
        continue
      }
      if (effect) await this.execute(effect, signal)
      else await this.idle(signal, generation, this.idleDelay(now))
    }
  }

  private idleDelay(now: string): number {
    let next: string | null = null
    try {
      next = this.outbox.nextFutureAvailableAt(now)
    } catch {
      return this.pollMs
    }
    if (!next) return this.pollMs
    const delay = Date.parse(next) - Date.parse(now)
    // A due row we could not claim is lane-blocked behind an earlier one; that one (or a settlement, or the
    // poll) frees it. So the wake is for the next row that is waiting out a delay, which may be that head.
    return delay > 0 ? Math.min(this.pollMs, delay) : this.pollMs
  }

  private idle(signal: AbortSignal, generation: number, delayMs: number): Promise<void> {
    if (signal.aborted || generation !== this.generation) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.wakers.delete(done)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, delayMs)
      this.wakers.add(done)
      signal.addEventListener('abort', done, { once: true })
    })
  }

  private async execute(effect: EffectRecord, stopSignal: AbortSignal): Promise<void> {
    const { effectId } = effect
    const cancel = new AbortController()
    const lease = new AbortController()
    const timeout = AbortSignal.timeout(effect.timeoutMs)
    const signal = AbortSignal.any([stopSignal, cancel.signal, timeout, lease.signal])
    this.running.set(effectId, cancel)
    const renewLease = (): boolean => {
      let renewed = false
      try {
        renewed = this.outbox.renewLease(effectId, this.owner, this.now())
      } catch {
        renewed = false
      }
      if (!renewed && !lease.signal.aborted) lease.abort(new LeaseLostError())
      return renewed
    }
    const renewer = setInterval(renewLease, Math.max(1, Math.floor(effect.timeoutMs / 3)))
    let error: string | null = null
    let deferred: EffectDeferredError | null = null
    try {
      const executor = this.executors[effect.kind]
      if (!executor) error = 'no executor'
      else {
        const work = Promise.resolve().then(() => executor(effect, { signal, renewLease }))
        this.executing.add(work)
        const settled = (): void => {
          this.executing.delete(work)
        }
        void work.then(settled, settled)
        await raceAbort(work, signal)
      }
    } catch (cause) {
      if (cause instanceof EffectDeferredError && !signal.aborted) deferred = cause
      else error = timeout.aborted ? 'timeout' : messageOf(cause)
    } finally {
      clearInterval(renewer)
      this.running.delete(effectId)
    }

    let settlement: EffectSettlement
    try {
      if (deferred) {
        const now = this.now()
        settlement = this.outbox.defer(effectId, this.owner, now, addMs(now, deferred.delayMs), deferred.reason)
      } else if (error === null) settlement = this.outbox.succeed(effectId, this.owner, this.now())
      else if (lease.signal.aborted) {
        console.warn(`[effect-worker] lost the lease on ${effectId}; discarding the result`)
        return
      } else if (stopSignal.aborted) return
      else if (cancel.signal.aborted)
        settlement = this.outbox.cancel(effectId, this.now(), 'cancelled', this.owner)
      else settlement = this.outbox.fail(effectId, this.owner, this.now(), error)
    } catch (cause) {
      console.warn(`[effect-worker] settling ${effectId} failed: ${messageOf(cause)}`)
      return
    }
    // A cancel that reached the row first (a Stop or a delegation cancel) already settled it.
    if (!settlement.settled && !(cancel.signal.aborted && settlement.status === 'cancelled'))
      console.warn(
        `[effect-worker] lost the lease on ${effectId} (now ${String(settlement.status)}); discarding the result`
      )
  }
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined)
    return Promise.reject(signal.reason as Error)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason as Error)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (cause: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(cause as Error)
      }
    )
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

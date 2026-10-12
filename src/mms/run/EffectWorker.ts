import type { EffectOutbox, EffectSettlement } from './EffectOutbox'
import type { EffectKind, EffectLaneClass, EffectRecord } from './types'

export type EffectExecutor = (
  effect: EffectRecord,
  ctx: { signal: AbortSignal; renewLease: () => boolean }
) => Promise<void>

/**
 * Fibres per lane class (SPEC §12.3). `turn` fibres claim only `turn.start` and so cap the
 * profile's concurrent turns; `control` fibres claim only interrupts, steers and answers, so a
 * Stop runs however many turns are live; `replaySafe` fibres claim the replay-safe kinds.
 */
export interface EffectWorkerFibres {
  turn: number
  control: number
  replaySafe: number
}

export const DEFAULT_EFFECT_WORKER_FIBRES: Readonly<EffectWorkerFibres> = {
  turn: 8,
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
 * In-process effect worker (SPEC §12.3): async fibres, grouped by lane class, claim from the
 * outbox, execute under a deadline and settle by CAS on the lease. Wake sources: outbox commits
 * (`subscribe`), `notify()`, the next `available_at` and a safety poll.
 *
 * Settlement rules: success → `succeed`; failure → `fail(message)` (`'timeout'` when the deadline
 * fired); `cancelInFlight` → owner-checked `cancel`; a lost lease or `stop()` writes nothing (the
 * reconciler or boot recovery owns that row now). A CAS miss on settlement is logged and ignored.
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

  constructor(options: EffectWorkerOptions) {
    this.outbox = options.outbox
    this.executors = options.executors
    this.owner = options.owner
    const fibres = { ...DEFAULT_EFFECT_WORKER_FIBRES, ...(options.fibres ?? {}) }
    this.fibres = {
      turn: Math.max(1, Math.floor(fibres.turn)),
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
    const lanes = Object.keys(this.fibres) as EffectLaneClass[]
    this.loops = lanes.flatMap((lane) =>
      Array.from({ length: this.fibres[lane] }, () => this.loop(controller.signal, [lane]))
    )
  }

  /** Fibres per lane class; `turn` is the profile's concurrent-turn cap. */
  get fibreCounts(): Readonly<EffectWorkerFibres> {
    return this.fibres
  }

  /** Interrupts every fibre (and its in-flight execution) and waits for them to return. */
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
  }

  /** Wakes idle fibres to claim again. */
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
      next = this.outbox.nextAvailableAt()
    } catch {
      return this.pollMs
    }
    if (!next) return this.pollMs
    const delay = Date.parse(next) - Date.parse(now)
    // A due row we could not claim is lane-blocked; a settlement or the poll will wake us.
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
    try {
      const executor = this.executors[effect.kind]
      if (!executor) error = 'no executor'
      else
        await raceAbort(
          Promise.resolve().then(() => executor(effect, { signal, renewLease })),
          signal
        )
    } catch (cause) {
      error = timeout.aborted ? 'timeout' : messageOf(cause)
    } finally {
      clearInterval(renewer)
      this.running.delete(effectId)
    }

    let settlement: EffectSettlement
    try {
      if (error === null) settlement = this.outbox.succeed(effectId, this.owner, this.now())
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
    if (!settlement.settled)
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

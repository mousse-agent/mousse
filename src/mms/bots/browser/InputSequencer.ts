import type { BotBrowserAck, BotBrowserRefusal } from '../../../shared/bots/personal/browser'

/**
 * One hold's input channel on the host: each numbered input is applied once, in number order, one at
 * a time, and answered (`BotBrowserAck`), as a remote terminal's typing is (docs/net/threat-model.md,
 * "Terminals").
 *
 * - **In order.** An input that comes before the one ahead of it waits for it, at most `gapWaitMs`
 *   (250 ms). A gap that does not fill in that time refuses what waits behind it as `gap`, without using
 *   up its number: the sender sends the missing one and those after it again.
 * - **Once.** A number at or below the last one taken is a duplicate: answered as one (with the outcome
 *   of the original answer, while it is remembered), never applied again. A resend of an input that is
 *   waiting or being applied gets that input's own answer. What a copy read is not remembered: a
 *   duplicate of a copy carries no text.
 * - **Used up.** A number taken is used up whether it was applied, refused (the page changed, the
 *   tab closed) or skipped (the sender gave up on it): the sender never resends it as new.
 * - **Never a hole.** A refusal that does not use its number (`gap`, `busy`) is sent again by the
 *   sender while the hold lasts; one it gives up on comes as a skip, which uses the number.
 * - **Bounded.** At most `maxWaiting` inputs wait; more are refused as `busy`. Closing the channel (the
 *   hold ended) refuses what waits and what comes after; the one being applied finishes.
 */
export interface InputSequencerOptions<T> {
  /** Applies one input; a rejection is answered as `failed`. */
  apply(item: T, seq: number): Promise<Omit<BotBrowserAck, 'seq'>>
  /** The number taken last (a channel picked up again goes on from there). */
  lastSeq?: number
  gapWaitMs?: number
  /** Answers remembered for duplicates. */
  remember?: number
  maxWaiting?: number
  setTimer?(fn: () => void, ms: number): { clear(): void }
}

interface Waiting {
  promise: Promise<BotBrowserAck>
  resolve(ack: BotBrowserAck): void
}

export const GAP_WAIT_MS = 250

const defaultTimer = (fn: () => void, ms: number): { clear(): void } => {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return { clear: () => clearTimeout(timer) }
}

export class InputSequencer<T> {
  /** The number taken last: applied, refused, or being applied. */
  private last: number
  private readonly waiting = new Map<number, Waiting & { item: T }>()
  private readonly answers = new Map<number, BotBrowserAck>()
  private current: { seq: number; promise: Promise<BotBrowserAck> } | undefined
  private gap: { clear(): void } | undefined
  private closed: { reason: BotBrowserRefusal; text?: string } | undefined
  private readonly gapWaitMs: number
  private readonly remember: number
  private readonly maxWaiting: number
  private readonly setTimer: (fn: () => void, ms: number) => { clear(): void }

  constructor(private readonly options: InputSequencerOptions<T>) {
    this.last = options.lastSeq ?? 0
    this.gapWaitMs = options.gapWaitMs ?? GAP_WAIT_MS
    this.remember = options.remember ?? 256
    this.maxWaiting = options.maxWaiting ?? 256
    this.setTimer = options.setTimer ?? defaultTimer
  }

  /** The number taken last: a view that picks the hold up again goes on after it. */
  get lastSeq(): number {
    return this.last
  }

  /** Takes input `seq`; answers once it is applied or refused, or at once for a duplicate. */
  submit(seq: number, item: T): Promise<BotBrowserAck> {
    if (this.current?.seq === seq) return this.current.promise
    if (seq <= this.last) return Promise.resolve(this.duplicate(seq))
    const known = this.waiting.get(seq)
    if (known) return known.promise
    if (this.closed) return Promise.resolve({ seq, status: 'refused', reason: this.closed.reason, ...(this.closed.text ? { text: this.closed.text } : {}) })
    if (this.waiting.size >= this.maxWaiting) return Promise.resolve({ seq, status: 'refused', reason: 'busy', text: 'Too much at once' })
    let resolve!: (ack: BotBrowserAck) => void
    const promise = new Promise<BotBrowserAck>((done) => { resolve = done })
    this.waiting.set(seq, { item, promise, resolve })
    this.pump()
    return promise
  }

  /**
   * The hold ended: what waits, and what comes later, is refused with `reason`. Resolves once the input
   * being applied (if any) is done, so nothing of this hold reaches the page after.
   */
  async close(reason: BotBrowserRefusal, text?: string): Promise<void> {
    this.closed = { reason, ...(text ? { text } : {}) }
    this.gap?.clear()
    this.gap = undefined
    for (const [seq, entry] of [...this.waiting]) {
      this.waiting.delete(seq)
      entry.resolve({ seq, status: 'refused', reason, ...(text ? { text } : {}) })
    }
    await this.current?.promise
  }

  /** Resolves once nothing is being applied. */
  async idle(): Promise<void> {
    while (this.current) await this.current.promise
  }

  private duplicate(seq: number): BotBrowserAck {
    const answered = this.answers.get(seq)
    // What it was answered first, so a resend after a lost answer learns it; a refusal keeps its reason.
    return answered?.status === 'refused'
      ? { seq, status: 'duplicate', reason: answered.reason!, ...(answered.text ? { text: answered.text } : {}), ...(answered.detail ? { detail: answered.detail } : {}) }
      : { seq, status: 'duplicate' }
  }

  private pump(): void {
    if (this.current) return
    const seq = this.last + 1
    const next = this.waiting.get(seq)
    if (!next) {
      if (this.waiting.size) this.armGap()
      return
    }
    this.gap?.clear()
    this.gap = undefined
    this.waiting.delete(seq)
    this.last = seq
    const promise = this.options.apply(next.item, seq).then(
      (ack): BotBrowserAck => ({ ...ack, seq }),
      (error: unknown): BotBrowserAck => ({ seq, status: 'refused', reason: 'failed', text: error instanceof Error ? error.message : String(error) })
    )
    this.current = { seq, promise }
    void promise.then((ack) => {
      // The outcome alone is kept for a duplicate: never what a copy read.
      const { copied: _copied, ...outcome } = ack
      this.answers.set(seq, outcome)
      if (this.answers.size > this.remember) this.answers.delete(this.answers.keys().next().value!)
      this.current = undefined
      next.resolve(ack)
      this.pump()
    })
  }

  /** The one before what waits has not come: it is waited for a moment, then what waits is refused. */
  private armGap(): void {
    if (this.gap) return
    this.gap = this.setTimer(() => {
      this.gap = undefined
      if (this.current || this.waiting.has(this.last + 1)) {
        this.pump()
        return
      }
      for (const [seq, entry] of [...this.waiting]) {
        this.waiting.delete(seq)
        entry.resolve({ seq, status: 'refused', reason: 'gap', text: 'An earlier input did not arrive' })
      }
    }, this.gapWaitMs)
  }
}

import { MAX_BOT_BROWSER_SENT, type BotBrowserAck, type BotBrowserInput, type BotBrowserSent } from '../../shared/bots/personal/browser'

/**
 * A view's end of its hold's input channel: every input the person makes gets the next number and the
 * picture they made it on, goes to the host in order, and stays until the host answers it.
 *
 * - **Numbered once, in order.** Batches are sent as they form (a move or a wheel turn waits a moment
 *   to merge with the next of its kind; anything else goes at once). Only an input not sent yet merges,
 *   and only with the one just before it of the same kind, so nothing is reordered: text typed before
 *   Enter reaches the page before Enter.
 * - **Answered.** Each input settles with the host's answer: applied, a duplicate of one it took
 *   already, or refused with a reason. A `gap` refusal (an earlier input did not arrive) sends it again
 *   after the earlier ones.
 * - **Sent again, never applied twice.** A call that fails is sent again by itself (backing off); Retry
 *   sends everything unanswered at once. The host answers what it already took as a duplicate.
 * - **Health.** Nothing unanswered: `ok`. Something unanswered for half a second: `sending`. For three
 *   seconds: `unreachable`.
 */

export type ChannelHealth = 'ok' | 'sending' | 'unreachable'

export interface ChannelOptions {
  /** Sends a batch; resolves with the host's answers. */
  send(inputs: BotBrowserSent[]): Promise<{ acks: BotBrowserAck[]; lastSeq: number }>
  /** The health changed. */
  health?(health: ChannelHealth): void
  /** An input was answered (its seq, the answer, and the input as sent). */
  answered?(ack: BotBrowserAck, input: BotBrowserInput): void
  /** The host's last number (a hold picked up again): the count goes on after it. */
  lastSeq?: number
  now?(): number
  setTimer?(fn: () => void, ms: number): { clear(): void }
}

/** Half a second unanswered: "Sending…". */
export const SENDING_AFTER_MS = 500
/** Three seconds unanswered: "Not reaching …". */
export const UNREACHABLE_AFTER_MS = 3_000
/** How long a move or a wheel turn waits to merge with the next (about 40 a second). */
export const MERGE_MS = 25
/** A call in flight longer than this no longer holds the next batch back. */
const PIPELINE_AFTER_MS = 250

interface Entry {
  seq: number
  picture?: number
  input: BotBrowserInput
  /** When the person made it. */
  at: number
  /** Sent and not answered (or answered `gap`, to go again). */
  sent: boolean
  resolve(ack: BotBrowserAck): void
  done: Promise<BotBrowserAck>
}

const browserTimer = (fn: () => void, ms: number): { clear(): void } => {
  const timer = setTimeout(fn, ms)
  return { clear: () => clearTimeout(timer) }
}

/** Whether `next` can merge into `last` (both unsent): a move into a move with the same buttons, a wheel turn into a wheel turn. */
function mergeable(last: BotBrowserInput, next: BotBrowserInput): boolean {
  if (last.kind === 'pointer' && next.kind === 'pointer') return last.type === 'move' && next.type === 'move' && last.buttons === next.buttons && (last.modifiers ?? 0) === (next.modifiers ?? 0)
  if (last.kind === 'scroll' && next.kind === 'scroll') return (last.modifiers ?? 0) === (next.modifiers ?? 0)
  if (last.kind === 'compose' && next.kind === 'compose') return true
  return false
}

function merged(last: BotBrowserInput, next: BotBrowserInput): BotBrowserInput {
  // Wheel turns add up, never dropped; a move or a composition is the latest.
  if (last.kind === 'scroll' && next.kind === 'scroll') return { ...next, deltaX: last.deltaX + next.deltaX, deltaY: last.deltaY + next.deltaY }
  return next
}

export class BotBrowserChannel {
  private next: number
  private readonly entries: Entry[] = []
  private flushTimer: { clear(): void } | undefined
  private healthTimer: { clear(): void } | undefined
  private retryTimer: { clear(): void } | undefined
  private retryMs = 500
  private inFlight = new Set<number>()
  private lastCallAt = 0
  private state: ChannelHealth = 'ok'
  private closed = false
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => { clear(): void }

  constructor(private readonly options: ChannelOptions) {
    this.next = (options.lastSeq ?? 0) + 1
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? browserTimer
  }

  get health(): ChannelHealth {
    return this.state
  }

  /** Inputs not answered yet. */
  get unanswered(): number {
    return this.entries.length
  }

  /** The person's input, made on picture `picture`: numbered (or merged into the one before it), and on its way. */
  push(input: BotBrowserInput, picture?: number): { seq: number; done: Promise<BotBrowserAck> } {
    if (this.closed) {
      const seq = this.next
      return { seq, done: Promise.resolve({ seq, status: 'refused', reason: 'not-held', text: 'You don\'t hold the browser now' }) }
    }
    const last = this.entries.at(-1)
    if (last && !last.sent && mergeable(last.input, input)) {
      last.input = merged(last.input, input)
      if (picture !== undefined) last.picture = picture
      this.schedule(input)
      return { seq: last.seq, done: last.done }
    }
    let resolve!: (ack: BotBrowserAck) => void
    const done = new Promise<BotBrowserAck>((settle) => { resolve = settle })
    const entry: Entry = { seq: this.next++, input, at: this.now(), sent: false, resolve, done, ...(picture !== undefined ? { picture } : {}) }
    this.entries.push(entry)
    this.schedule(input)
    this.watchHealth()
    return { seq: entry.seq, done }
  }

  /** Sends everything unanswered again, now (Retry). */
  retry(): void {
    if (this.closed) return
    for (const entry of this.entries) entry.sent = false
    this.retryTimer?.clear()
    this.retryTimer = undefined
    this.retryMs = 500
    this.inFlight.clear()
    this.flush()
  }

  /** The hold was picked up again at the host's `lastSeq`: numbering goes on after it, and what is unanswered goes again. */
  resume(lastSeq: number): void {
    this.next = Math.max(this.next, lastSeq + 1)
    this.retry()
  }

  /** Resolves once everything sent is answered, or after `ms`. */
  async drain(ms: number): Promise<void> {
    this.flush()
    const until = this.now() + ms
    while (this.entries.length && this.now() < until) await new Promise((resolve) => setTimeout(resolve, 25))
  }

  /** The hold ended: what is unanswered is refused here (`text` says why), and nothing more is sent. */
  close(text = 'You don\'t hold the browser now'): void {
    if (this.closed) return
    this.closed = true
    this.flushTimer?.clear()
    this.healthTimer?.clear()
    this.retryTimer?.clear()
    for (const entry of this.entries.splice(0)) {
      const ack: BotBrowserAck = { seq: entry.seq, status: 'refused', reason: 'not-held', text }
      entry.resolve(ack)
      this.options.answered?.(ack, entry.input)
    }
    this.setHealth('ok')
  }

  private schedule(input: BotBrowserInput): void {
    const waits = (input.kind === 'pointer' && input.type === 'move') || input.kind === 'scroll'
    if (this.flushTimer && waits) return
    this.flushTimer?.clear()
    this.flushTimer = this.setTimer(() => {
      this.flushTimer = undefined
      this.flush()
    }, waits ? MERGE_MS : 0)
  }

  /** Sends what is not sent yet, in order, in batches; one call at a time unless the one in flight is slow. */
  private flush(): void {
    if (this.closed) return
    const unsent = this.entries.filter((entry) => !entry.sent)
    if (!unsent.length) return
    if (this.inFlight.size && this.now() - this.lastCallAt < PIPELINE_AFTER_MS) {
      // The call in flight answers soon: this batch goes when it does, or once it is slow.
      this.flushTimer ??= this.setTimer(() => {
        this.flushTimer = undefined
        this.flush()
      }, PIPELINE_AFTER_MS)
      return
    }
    for (let at = 0; at < unsent.length; at += MAX_BOT_BROWSER_SENT) this.call(unsent.slice(at, at + MAX_BOT_BROWSER_SENT))
  }

  private call(batch: Entry[]): void {
    const id = this.now() + Math.random()
    this.inFlight.add(id)
    this.lastCallAt = this.now()
    for (const entry of batch) entry.sent = true
    const sent: BotBrowserSent[] = batch.map((entry) => ({ seq: entry.seq, ...(entry.picture !== undefined ? { picture: entry.picture } : {}), input: entry.input }))
    void this.options.send(sent).then(({ acks }) => {
      this.inFlight.delete(id)
      if (this.closed) return
      this.retryMs = 500
      let again = false
      for (const ack of acks) {
        const entry = this.entries.find((candidate) => candidate.seq === ack.seq)
        if (!entry) continue
        if (ack.status === 'refused' && ack.reason === 'gap') {
          // An earlier one did not arrive: it goes again, and this after it.
          entry.sent = false
          again = true
          continue
        }
        this.entries.splice(this.entries.indexOf(entry), 1)
        entry.resolve(ack)
        this.options.answered?.(ack, entry.input)
      }
      this.watchHealth()
      if (again) this.retryAfter(0)
      else this.flush()
    }, () => {
      this.inFlight.delete(id)
      if (this.closed) return
      // Not delivered (the service did not take the call): it goes again, a little later each time.
      for (const entry of batch) if (this.entries.includes(entry)) entry.sent = false
      this.retryAfter(this.retryMs)
      this.retryMs = Math.min(5_000, this.retryMs * 2)
      this.watchHealth()
    })
  }

  private retryAfter(ms: number): void {
    if (this.retryTimer) return
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = undefined
      this.flush()
    }, ms)
  }

  /** Health follows the oldest input not answered: re-checked when it would change. */
  private watchHealth(): void {
    this.healthTimer?.clear()
    this.healthTimer = undefined
    const oldest = this.entries[0]
    if (!oldest) {
      this.setHealth('ok')
      return
    }
    const age = this.now() - oldest.at
    this.setHealth(age >= UNREACHABLE_AFTER_MS ? 'unreachable' : age >= SENDING_AFTER_MS ? 'sending' : 'ok')
    const nextAt = age < SENDING_AFTER_MS ? SENDING_AFTER_MS : age < UNREACHABLE_AFTER_MS ? UNREACHABLE_AFTER_MS : undefined
    if (nextAt !== undefined) this.healthTimer = this.setTimer(() => this.watchHealth(), nextAt - age)
  }

  private setHealth(health: ChannelHealth): void {
    if (this.state === health) return
    this.state = health
    this.options.health?.(health)
  }
}

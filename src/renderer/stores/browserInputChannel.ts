import { MAX_WATCHED_BROWSER_SENT, watchedBrowserInputProblem, type WatchedBrowserAck, type WatchedBrowserInput, type WatchedBrowserSent } from '../../shared/browser/watched'

/**
 * A view's end of its hold's input channel: every input the person makes gets the next number and the
 * picture they made it on, goes to the host in order, and stays until the host answers it.
 *
 * - **Numbered once, in order.** Batches are sent as they form (a move or a wheel turn waits a moment
 *   to merge with the next of its kind; anything else goes at once). Only an input not sent yet merges,
 *   and only with the one just before it of the same kind, so nothing is reordered: text typed before
 *   Enter reaches the page before Enter.
 * - **Answered.** Each input settles with the host's answer: applied, a duplicate of one it took
 *   already, or refused with a reason.
 * - **Never a hole.** Every number given out reaches the host as its input or as a skip. An input the
 *   service never takes (too long, malformed) is refused here before it gets a number; one it refuses
 *   anyway (a batch refused as a whole is sent again one by one to find it) is dropped, said once, and
 *   its number skipped. A refusal that did not use its number (`gap`, `busy`) is sent again, backing
 *   off, for `RESEND_FOR_MS` after it was made; then it is dropped, said once, and its number skipped.
 *   A gap the host reports below what this view still has is filled with skips.
 * - **Sent again, never applied twice.** A call that fails is sent again by itself (backing off); Retry
 *   sends everything unanswered at once. The host answers what it already took as a duplicate.
 * - **Back-pressure.** While `MAX_UNANSWERED` inputs wait for an answer, or none has come for three
 *   seconds, the view takes no new press, key or text: each is refused here at once and the view says
 *   "Not reaching …", so typing does not pile up to arrive in a burst later. Letting go (a button or a
 *   key going up) always goes, unless what went down was refused here too.
 * - **Health.** Nothing unanswered: `ok`. Something unanswered for half a second: `sending`. For three
 *   seconds, or under back-pressure: `unreachable`.
 */

export type ChannelHealth = 'ok' | 'sending' | 'unreachable'

/** Whether this window runs on a Mac: its Command key is the page's Control key elsewhere. */
export function viewerPlatform(): 'mac' | 'other' {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'mac' : 'other'
}

export interface ChannelOptions {
  /** Sends a batch; resolves with the host's answers. */
  send(inputs: WatchedBrowserSent[]): Promise<{ acks: WatchedBrowserAck[]; lastSeq: number }>
  /** The health changed. */
  health?(health: ChannelHealth): void
  /** An input was answered (its seq, the answer, and the input as sent). */
  answered?(ack: WatchedBrowserAck, input: WatchedBrowserInput): void
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
/** The most inputs waiting for an answer: past this the view takes no more (back-pressure). */
export const MAX_UNANSWERED = 24
/** An input the host refused without using its number goes again for this long after it was made; then it is dropped. */
export const RESEND_FOR_MS = 10_000
/** Sending again after such a refusal backs off: from this, doubling, to `RESEND_MAX_MS`. */
const RESEND_FIRST_MS = 250
const RESEND_MAX_MS = 4_000
/** What a dropped input says, once. */
export const DROPPED_TEXT = 'Not sent: the page did not take it in time'

interface Entry {
  seq: number
  picture?: number
  /** The person's input; none for a number only skipped (a gap the host reported). */
  input?: WatchedBrowserInput
  /** Goes as a skip: given up on, or a hole to fill. */
  skip?: boolean
  /** When the person made it. */
  at: number
  /** Sent and not answered. */
  sent: boolean
  /** Sent in a call of its own (a batch the service refused as a whole is split to find the input it never takes). */
  alone?: boolean
  /** Not sent again before then (a refusal that did not use its number backs off). */
  notBefore: number
  backoff: number
  /** The person was told already (it was dropped): only its skip waits for the host. */
  settled?: boolean
  resolve(ack: WatchedBrowserAck): void
  done: Promise<WatchedBrowserAck>
}

const browserTimer = (fn: () => void, ms: number): { clear(): void } => {
  const timer = setTimeout(fn, ms)
  return { clear: () => clearTimeout(timer) }
}

/** Whether `next` can merge into `last` (both unsent): a move into a move with the same buttons, a wheel turn into a wheel turn. */
function mergeable(last: WatchedBrowserInput, next: WatchedBrowserInput): boolean {
  if (last.kind === 'pointer' && next.kind === 'pointer') return last.type === 'move' && next.type === 'move' && last.buttons === next.buttons && (last.modifiers ?? 0) === (next.modifiers ?? 0)
  if (last.kind === 'scroll' && next.kind === 'scroll') return (last.modifiers ?? 0) === (next.modifiers ?? 0)
  if (last.kind === 'compose' && next.kind === 'compose') return true
  return false
}

function merged(last: WatchedBrowserInput, next: WatchedBrowserInput): WatchedBrowserInput {
  // Wheel turns add up, never dropped; a move or a composition is the latest.
  if (last.kind === 'scroll' && next.kind === 'scroll') return { ...next, deltaX: last.deltaX + next.deltaX, deltaY: last.deltaY + next.deltaY }
  return next
}

/** What lets go of something held, or answers the page: never held back. */
function lettingGo(input: WatchedBrowserInput): boolean {
  if (input.kind === 'pointer') return input.type === 'up'
  if (input.kind === 'keys') return input.type === 'up'
  return input.kind === 'release' || input.kind === 'dialog' || input.kind === 'files' || (input.kind === 'compose' && !input.text)
}

/** What went down (a key, a button), so its going up can be matched. */
function heldKey(input: WatchedBrowserInput): string | undefined {
  if (input.kind === 'keys') return `key:${input.code || input.key}`
  if (input.kind === 'pointer' && input.type !== 'move') return `button:${input.button}`
  return undefined
}

/** A refusal that did not use its number: the input goes again. */
const unused = (ack: WatchedBrowserAck) => ack.status === 'refused' && (ack.reason === 'gap' || ack.reason === 'busy')

/** The service will never take this call as it is (malformed or too large), as opposed to not reaching it. */
function neverTaken(cause: unknown): boolean {
  const code = String((cause as { code?: unknown } | null)?.code ?? '')
  return ['invalid_params', 'invalid_action', 'platform_invalid_params', 'platform_params_too_large', 'unknown_field'].includes(code)
}

export class BrowserInputChannel {
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
  /** Keys and buttons whose going down was refused here: their going up is not sent either. */
  private readonly refusedDowns = new Set<string>()
  /** Local refusals get numbers of their own, below zero: they never reach the host. */
  private localSeq = 0
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

  /** Inputs not answered yet (a skip that waits counts). */
  get unanswered(): number {
    return this.entries.length
  }

  /** The person's input, made on picture `picture`: numbered (or merged into the one before it), and on its way; or refused here. */
  push(input: WatchedBrowserInput, picture?: number): { seq: number; done: Promise<WatchedBrowserAck> } {
    if (this.closed) return this.refuseHere(input, { status: 'refused', reason: 'not-held', text: 'You don\'t hold the browser now' }, false)
    // What the service never takes never gets a number, so it never holds up what comes after it.
    const problem = watchedBrowserInputProblem(input)
    if (problem) return this.refuseHere(input, { status: 'refused', reason: 'invalid', text: problem })
    const held = heldKey(input)
    if (lettingGo(input)) {
      // A key or button that never went down (refused here) does not go up either.
      if (held && this.refusedDowns.delete(held)) return this.refuseHere(input, { status: 'refused', reason: 'busy', text: 'Not sent' }, false)
    } else if (this.pressured()) {
      if (held) this.refusedDowns.add(held)
      this.setHealth('unreachable')
      return this.refuseHere(input, { status: 'refused', reason: 'busy', text: 'Not sent: the page is not taking input now' })
    }
    const last = this.entries.at(-1)
    if (last?.input && !last.sent && !last.skip && mergeable(last.input, input)) {
      last.input = merged(last.input, input)
      if (picture !== undefined) last.picture = picture
      this.schedule(input)
      return { seq: last.seq, done: last.done }
    }
    const entry = this.entry(this.next++, input, picture)
    this.entries.push(entry)
    this.schedule(input)
    this.watchHealth()
    return { seq: entry.seq, done: entry.done }
  }

  /** Sends everything unanswered again, now (Retry): back-off and waiting reset. */
  retry(): void {
    if (this.closed) return
    for (const entry of this.entries) {
      entry.sent = false
      entry.notBefore = 0
      entry.backoff = 0
    }
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
    for (const entry of this.entries.splice(0)) this.settle(entry, { seq: entry.seq, status: 'refused', reason: 'not-held', text })
    this.setHealth('ok')
  }

  private entry(seq: number, input: WatchedBrowserInput | undefined, picture?: number): Entry {
    let resolve!: (ack: WatchedBrowserAck) => void
    const done = new Promise<WatchedBrowserAck>((settle) => { resolve = settle })
    return { seq, at: this.now(), sent: false, notBefore: 0, backoff: 0, resolve, done, ...(input ? { input } : { skip: true, settled: true }), ...(picture !== undefined ? { picture } : {}) }
  }

  /** An input refused here, before it got a number: answered at once (`tell`: the person hears of it). */
  private refuseHere(input: WatchedBrowserInput, answer: Omit<WatchedBrowserAck, 'seq'>, tell = true): { seq: number; done: Promise<WatchedBrowserAck> } {
    const ack: WatchedBrowserAck = { seq: --this.localSeq, ...answer }
    if (tell) this.options.answered?.(ack, input)
    return { seq: ack.seq, done: Promise.resolve(ack) }
  }

  /** Too much waits for an answer, or nothing has been answered for a while: no new press, key or text. */
  private pressured(): boolean {
    return this.entries.length >= MAX_UNANSWERED || this.state === 'unreachable'
  }

  /** The person hears what became of their input, once. */
  private settle(entry: Entry, ack: WatchedBrowserAck): void {
    if (entry.settled || !entry.input) return
    entry.settled = true
    entry.resolve(ack)
    this.options.answered?.(ack, entry.input)
  }

  /** Gives up on an input the host has not taken: the person hears it, and its number goes as a skip. */
  private dropToSkip(entry: Entry, ack: WatchedBrowserAck): void {
    this.settle(entry, ack)
    entry.skip = true
    entry.sent = false
  }

  private schedule(input: WatchedBrowserInput): void {
    const waits = (input.kind === 'pointer' && input.type === 'move') || input.kind === 'scroll'
    if (this.flushTimer && waits) return
    this.flushTimer?.clear()
    this.flushTimer = this.setTimer(() => {
      this.flushTimer = undefined
      this.flush()
    }, waits ? MERGE_MS : 0)
  }

  /**
   * Sends what is not sent yet, in order, in batches, up to the first that must wait (backing off):
   * nothing goes ahead of it. One call at a time unless the one in flight is slow. One sent alone goes
   * in a call of its own.
   */
  private flush(): void {
    if (this.closed) return
    const now = this.now()
    const due: Entry[] = []
    let wait: number | undefined
    for (const entry of this.entries) {
      if (entry.sent) continue
      if (entry.notBefore > now) {
        wait = entry.notBefore - now
        break
      }
      due.push(entry)
    }
    if (wait !== undefined) this.retryAfter(wait)
    if (!due.length) return
    if (this.inFlight.size && now - this.lastCallAt < PIPELINE_AFTER_MS) {
      // The call in flight answers soon: this batch goes when it does, or once it is slow.
      this.flushTimer ??= this.setTimer(() => {
        this.flushTimer = undefined
        this.flush()
      }, PIPELINE_AFTER_MS)
      return
    }
    let batch: Entry[] = []
    const go = () => {
      if (batch.length) this.call(batch)
      batch = []
    }
    for (const entry of due) {
      if (entry.alone) {
        go()
        this.call([entry])
        continue
      }
      batch.push(entry)
      if (batch.length >= MAX_WATCHED_BROWSER_SENT) go()
    }
    go()
  }

  private call(batch: Entry[]): void {
    const id = this.now() + Math.random()
    this.inFlight.add(id)
    this.lastCallAt = this.now()
    for (const entry of batch) entry.sent = true
    const sent: WatchedBrowserSent[] = batch.map((entry) => entry.skip || !entry.input
      ? { seq: entry.seq, skip: true }
      : { seq: entry.seq, ...(entry.picture !== undefined ? { picture: entry.picture } : {}), input: entry.input })
    void this.options.send(sent).then(({ acks, lastSeq }) => {
      this.inFlight.delete(id)
      if (this.closed) return
      this.retryMs = 500
      let gap = false
      const now = this.now()
      for (const ack of acks) {
        const entry = this.entries.find((candidate) => candidate.seq === ack.seq)
        if (!entry) continue
        if (unused(ack)) {
          gap ||= ack.reason === 'gap'
          entry.sent = false
          // Not taken: it goes again a little later, while it still means something; then its number
          // goes at once as a skip, which the host always takes.
          if (!entry.skip && now - entry.at > RESEND_FOR_MS) {
            this.dropToSkip(entry, { seq: entry.seq, status: 'refused', reason: 'dropped', text: DROPPED_TEXT })
            entry.backoff = 0
            entry.notBefore = 0
            continue
          }
          entry.backoff = entry.backoff ? Math.min(RESEND_MAX_MS, entry.backoff * 2) : ack.reason === 'gap' ? RESEND_FIRST_MS / 2 : RESEND_FIRST_MS
          entry.notBefore = now + (ack.reason === 'gap' && !entry.notBefore ? 0 : entry.backoff)
          continue
        }
        this.entries.splice(this.entries.indexOf(entry), 1)
        this.settle(entry, ack)
      }
      // The host waits on a number below everything this view still has: a hole, filled with skips.
      if (gap) this.fillHoles(lastSeq)
      this.watchHealth()
      this.flush()
    }, (cause: unknown) => {
      this.inFlight.delete(id)
      if (this.closed) return
      const waiting = batch.filter((entry) => this.entries.includes(entry))
      if (neverTaken(cause)) {
        // The service never takes this call: one by one, the input it never takes is found, dropped and skipped.
        if (waiting.length > 1) {
          for (const entry of waiting) {
            entry.alone = true
            entry.sent = false
          }
        } else if (waiting[0]) {
          const entry = waiting[0]
          if (entry.skip) this.entries.splice(this.entries.indexOf(entry), 1)
          else this.dropToSkip(entry, { seq: entry.seq, status: 'refused', reason: 'invalid', text: 'That can\'t be sent to the page' })
        }
        this.watchHealth()
        this.flush()
        return
      }
      // Not delivered (the service did not take the call): it goes again, a little later each time.
      for (const entry of waiting) entry.sent = false
      this.retryAfter(this.retryMs)
      this.retryMs = Math.min(5_000, this.retryMs * 2)
      this.watchHealth()
    })
  }

  /** Numbers between the host's last and the first this view still has were dropped somewhere: each goes as a skip. */
  private fillHoles(lastSeq: number): void {
    const first = this.entries[0]?.seq
    if (first === undefined || lastSeq + 1 >= first) return
    const holes: Entry[] = []
    for (let seq = lastSeq + 1; seq < first; seq += 1) holes.push(this.entry(seq, undefined))
    this.entries.unshift(...holes)
  }

  private retryAfter(ms: number): void {
    if (this.retryTimer) return
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = undefined
      this.flush()
    }, Math.max(0, ms))
  }

  /** Health follows the oldest input not answered (and how many wait): re-checked when it would change. */
  private watchHealth(): void {
    this.healthTimer?.clear()
    this.healthTimer = undefined
    const oldest = this.entries[0]
    if (!oldest) {
      this.refusedDowns.clear()
      this.setHealth('ok')
      return
    }
    const age = this.now() - oldest.at
    this.setHealth(age >= UNREACHABLE_AFTER_MS || this.entries.length >= MAX_UNANSWERED ? 'unreachable' : age >= SENDING_AFTER_MS ? 'sending' : 'ok')
    const nextAt = age < SENDING_AFTER_MS ? SENDING_AFTER_MS : age < UNREACHABLE_AFTER_MS ? UNREACHABLE_AFTER_MS : undefined
    if (nextAt !== undefined) this.healthTimer = this.setTimer(() => this.watchHealth(), nextAt - age)
  }

  private setHealth(health: ChannelHealth): void {
    if (this.state === health) return
    this.state = health
    this.options.health?.(health)
  }
}

import { SETTLE_NOTICE_RESULT_CHARS, SETTLE_WATCH_TTL_MS, type SettleNoticeItem } from '../../shared/settleNotice'
import { threadLink } from '../../shared/threadLink'
import type { RunEngine } from '../run/RunEngine'
import { followMessage, type WatchTarget } from '../run/settle/follow'
import { ThreadWatches, type ThreadWatchRecord } from '../run/settle/ThreadWatches'
import type { ThreadEvent } from '../run/types'

/** The longest a timer waits before it looks at the watches' expiry again (setTimeout holds 2^31 - 1 ms at most). */
const EXPIRY_CHECK_MAX_MS = 60 * 60 * 1000

/** A notice as it goes into the sender's queue. */
export interface PlannedSettleNotice {
  item: SettleNoticeItem
  /** What the sender's model reads. */
  text: string
  /** The count of agent messages in a row of the run the notice is about; the turn it starts carries it. */
  hops: number
}

export interface SettleNoticeHost {
  engine: RunEngine
  /** The target's runs and queue on this computer. */
  target: WatchTarget
  titleOf(threadId: string): string | undefined
  /** The thread exists and is not deleted. */
  threadLive(threadId: string): boolean
  /** A question or an approval of the thread waits for a person. */
  waitingForPerson(threadId: string): boolean
  /** The final text of a run, when it left one. */
  resultText(threadId: string, runId: string): string | undefined
  stopGeneration(threadId: string): number
  isSubagent(threadId: string): boolean
  /** The thread's person works in Plan (its latest message is a plan turn). */
  inPlan(threadId: string): boolean
  /** Puts the notice in the sender's queue; `held`: it must not start a turn by itself. Throws when it cannot. */
  deliver(watcherThreadId: string, notice: PlannedSettleNotice, held: boolean): void
  /** The sender's queue already carries this notice (a delivery repeated after a restart). */
  delivered(watcherThreadId: string, item: Pick<SettleNoticeItem, 'watchId' | 'event'>): boolean
  now?(): Date
}

/**
 * The settle notice on this computer (docs/run-engine/SPEC.md §15.1, "Told when it settles"). An agent that sends with
 * `notify` gets one watch for its message (`thread_watches`); this service follows the message through the target's runs
 * and queue (`followMessage`) and tells the sender at most twice: the first time the work waits on a person, and when it
 * ends, or once, without starting a turn, when 24 hours pass first. The notice goes into the sender's queue (the host's
 * `deliver`), so it starts a turn when the sender is idle and waits behind a running one; notices that meet there are
 * delivered as one. Every decision is written to the watch before the notice is delivered, so a restart delivers what
 * was decided and re-reads what it missed.
 */
export class SettleNotices {
  readonly watches: ThreadWatches
  private readonly checks = new Set<string>()
  private checkScheduled = false
  private expiryTimer: ReturnType<typeof setTimeout> | undefined
  private unsubscribe: (() => void) | undefined
  private stopped = false

  constructor(private readonly host: SettleNoticeHost) {
    this.watches = new ThreadWatches(host.engine.store, () => this.now())
  }

  private now(): Date {
    return this.host.now?.() ?? new Date()
  }

  /** Starts following: what the previous daemon decided is delivered, every active watch is read again. */
  start(): void {
    this.stopped = false
    this.unsubscribe = this.host.engine.store.onEvent((event) => this.onEvent(event))
    for (const watch of this.watches.listDue()) this.deliverDue(watch)
    for (const watch of this.watches.listActive()) this.checkWatch(watch)
    this.expireDue()
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
  }

  /**
   * Watches the message `messageKey` an agent just sent (once: a retry of the same send keeps its watch). The message is
   * read at once, so a run that ended before the watch existed is still told.
   */
  watch(input: { messageKey: string; watcherThreadId: string; watcherRunId: string; targetThreadId: string; runId: string }): ThreadWatchRecord {
    // A queued message keeps its queue item through an edit, a steer and a hand-back; its run may not.
    const queued = this.host.target.queueItemForRun(input.targetThreadId, input.runId)
    const { watch, created } = this.watches.create({
      ...input,
      watcherStopGeneration: this.host.stopGeneration(input.watcherThreadId),
      queueItemId: queued ?? null,
      ttlMs: SETTLE_WATCH_TTL_MS
    })
    if (created) {
      this.checkWatch(watch)
      this.armExpiry()
    }
    return this.watches.get(watch.watchId) ?? watch
  }

  /** Something about the thread changed that may move or settle a watched message (its queue, a question). */
  touch(threadId: string): void {
    if (this.stopped) return
    this.checks.add(threadId)
    if (this.checkScheduled) return
    this.checkScheduled = true
    setImmediate(() => {
      this.checkScheduled = false
      const threads = [...this.checks]
      this.checks.clear()
      if (this.stopped) return
      for (const threadId of threads) {
        try {
          for (const watch of this.watches.listActive(threadId)) this.checkWatch(watch)
        } catch (error) {
          console.warn('the settle watches of a thread could not be read', { threadId, error: error instanceof Error ? error.message : String(error) })
        }
      }
    })
  }

  private onEvent(event: ThreadEvent): void {
    if (event.type !== 'run.status' && event.type !== 'run.created') return
    this.touch(event.threadId)
  }

  /** Reads where the watch's message is now and tells the sender what it has not been told. */
  private checkWatch(watch: ThreadWatchRecord): void {
    try {
      if (watch.state !== 'active') return
      if (!this.host.threadLive(watch.targetThreadId)) {
        if (this.watches.markEnded(watch.watchId, 'deleted', watch.runId)) this.deliverDue(this.watches.get(watch.watchId)!)
        return
      }
      const followed = followMessage(this.host.target, watch.targetThreadId, watch.runId, watch.queueItemId)
      if (followed.kind === 'ended') {
        if (this.watches.markEnded(watch.watchId, followed.status, followed.runId)) this.deliverDue(this.watches.get(watch.watchId)!)
        return
      }
      if (followed.runId !== watch.runId) this.watches.follow(watch.watchId, followed.runId)
      // The work waits on a person: a question or an approval of the thread while the message's run is its active one.
      if (followed.kind === 'live' && watch.needsInput === null && this.host.waitingForPerson(watch.targetThreadId)) {
        const active = this.host.target.activeRun(watch.targetThreadId)
        if (active?.runId === followed.runId && this.watches.markNeedsInput(watch.watchId)) this.deliverDue(this.watches.get(watch.watchId)!)
      }
    } catch (error) {
      console.warn('a settle watch could not be read', { watchId: watch.watchId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Delivers what the watch decided and has not delivered yet. A failure leaves it due for the next start. */
  private deliverDue(watch: ThreadWatchRecord): void {
    if (watch.needsInput === 'due') this.deliverOne(watch, 'needs_input')
    if (watch.endNotice === 'due') this.deliverOne(watch, watch.state === 'expired' ? 'expired' : 'ended')
  }

  private deliverOne(watch: ThreadWatchRecord, event: SettleNoticeItem['event']): void {
    const which = event === 'needs_input' ? 'needs_input' : 'end'
    try {
      // A sender that is gone hears nothing; the decision is settled so it is not tried again.
      if (!this.host.threadLive(watch.watcherThreadId) || this.host.delivered(watch.watcherThreadId, { watchId: watch.watchId, event })) {
        this.watches.markSent(watch.watchId, which)
        return
      }
      const notice = this.plan(watch, event)
      this.host.deliver(watch.watcherThreadId, notice, this.held(watch, event))
      this.watches.markSent(watch.watchId, which)
    } catch (error) {
      console.warn('a settle notice could not be delivered', { watchId: watch.watchId, event, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * A notice never starts a turn (it waits in the queue) in a subagent's thread, whose result is its parent's; in a
   * sender a person stopped after it subscribed; in a sender kept in Plan; and when it only says Mousse stopped watching.
   */
  private held(watch: ThreadWatchRecord, event: SettleNoticeItem['event']): boolean {
    if (event === 'expired') return true
    if (this.host.isSubagent(watch.watcherThreadId)) return true
    if (this.host.stopGeneration(watch.watcherThreadId) > watch.watcherStopGeneration) return true
    return this.host.inPlan(watch.watcherThreadId)
  }

  private plan(watch: ThreadWatchRecord, event: SettleNoticeItem['event']): PlannedSettleNotice {
    const run = watch.runId ? this.host.target.getRun(watch.runId) : null
    return planSettleNotice({
      watch,
      event,
      title: this.host.titleOf(watch.targetThreadId) ?? null,
      run: run ? { runId: run.runId, error: run.outcome?.error, hops: run.outcome?.agentHops ?? 0 } : undefined,
      resultText: event === 'ended' && run ? this.host.resultText(watch.targetThreadId, run.runId) : undefined
    })
  }

  /** Ends the watches whose 24 hours are over (each read once more first), and arms the timer for the next. The timer runs it. */
  expireDue(): void {
    if (this.stopped) return
    const now = this.now().getTime()
    for (const watch of this.watches.listActive()) {
      if (Date.parse(watch.expiresAt) > now) continue
      this.checkWatch(watch)
      const current = this.watches.get(watch.watchId)
      if (current?.state === 'active' && this.watches.markExpired(watch.watchId)) this.deliverDue(this.watches.get(watch.watchId)!)
    }
    this.armExpiry()
  }

  private armExpiry(): void {
    if (this.stopped) return
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    const next = this.watches.nextExpiry()
    if (!next) return
    const wait = Math.min(EXPIRY_CHECK_MAX_MS, Math.max(0, Date.parse(next) - this.now().getTime()))
    this.expiryTimer = setTimeout(() => this.expireDue(), wait)
    this.expiryTimer.unref?.()
  }
}

/** One line of a title: no line breaks, quotes or brackets, at most 80 characters. */
function titleLine(title: string | null): string {
  const line = (title ?? '').replace(/[\r\n"“”«»[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim()
  return line || 'Untitled'
}

/** How a run's end reads: "finished", "failed: <error>", "was stopped". */
function endPhrase(status: string, error: string | undefined): string {
  switch (status) {
    case 'completed': return 'finished'
    case 'failed':
    case 'uncertain': return error ? `failed: ${error.replace(/\s+/g, ' ').trim().slice(0, 300)}` : 'failed'
    case 'interrupted': return 'was stopped before it finished'
    case 'cancelled': return 'was cancelled before it finished'
    case 'deleted': return 'ended: that thread was deleted'
    case 'removed': return 'never ran: your message left that thread\'s queue first (a person removed it, or stopped the thread)'
    default: return `ended (${status})`
  }
}

/**
 * The notice Mousse writes for one event of a watch: who it is about (the thread's title and link), what happened, and
 * for an end the run's reply cut to `SETTLE_NOTICE_RESULT_CHARS` with a pointer to `thread_read` for the rest. Written
 * by Mousse from the watch and the run, never from either agent's words, except the quoted reply.
 */
export function planSettleNotice(input: {
  watch: Pick<ThreadWatchRecord, 'watchId' | 'targetThreadId' | 'endStatus'>
  event: SettleNoticeItem['event']
  title: string | null
  run?: { runId: string; error?: string; hops: number }
  resultText?: string
}): PlannedSettleNotice {
  const { watch, event, run } = input
  const thread = `thread "${titleLine(input.title)}" (${threadLink(watch.targetThreadId)})`
  const base: SettleNoticeItem = { watchId: watch.watchId, threadId: watch.targetThreadId, title: input.title, event, ...(run ? { runId: run.runId } : {}) }
  const hops = run?.hops ?? 0
  const header = '[Mousse notice, not from the user or any agent: about the message you sent with notify.]'
  if (event === 'needs_input') {
    return {
      item: base,
      hops,
      text: `${header}\nThe work your message started in ${thread} is waiting for a person to answer a question or an approval there. Mousse will tell you again when it ends; do not call thread_wait or thread_read to check.`
    }
  }
  if (event === 'expired') {
    return {
      item: base,
      hops,
      text: `${header}\nMousse stopped watching ${thread} for you after 24 hours. The work your message started there is still going; read it with thread_read when you need it.`
    }
  }
  const status = watch.endStatus ?? 'completed'
  const reply = input.resultText?.trim() ?? ''
  const shown = reply.slice(0, SETTLE_NOTICE_RESULT_CHARS)
  const cut = shown.length < reply.length
  const lines = [`${header}\nThe work your message started in ${thread} ${endPhrase(status, run?.error)}${run && status !== 'removed' && status !== 'deleted' ? ` (run ${run.runId})` : ''}.`]
  if (shown) lines.push(`Its reply:\n${shown}`)
  if (cut) lines.push(`[The reply is cut at ${SETTLE_NOTICE_RESULT_CHARS.toLocaleString('en-US')} of ${reply.length.toLocaleString('en-US')} characters; read the rest with thread_read on thread ${watch.targetThreadId}.]`)
  return { item: { ...base, status, ...(cut ? { cut: true } : {}) }, hops, text: lines.join('\n') }
}

import { SETTLE_NOTICE_RESULT_CHARS, SETTLE_WATCH_TTL_MS, type SettleNoticeItem } from '../../shared/settleNotice'
import { notice, quoted, type NoticePart } from '../../shared/mousseContext'
import { threadLink } from '../../shared/threadLink'
import { qualifyId } from '../../shared/threadRef'
import { chainIdOf } from '../run/AgentChains'
import type { RunEngine } from '../run/RunEngine'
import { followMessage, type WatchTarget } from '../run/settle/follow'
import { ThreadWatches, type ThreadWatchRecord } from '../run/settle/ThreadWatches'
import type { ThreadEvent } from '../run/types'
import { RemoteSettleFollower, type RemoteNoticeDetails, type RemoteSettleHost } from './remoteSettleFollow'

/** The longest a timer waits before it looks at the watches' expiry again (setTimeout holds 2^31 - 1 ms at most). */
const EXPIRY_CHECK_MAX_MS = 60 * 60 * 1000

/** A notice as it goes into the sender's queue. */
export interface PlannedSettleNotice {
  item: SettleNoticeItem
  /** What the sender's model reads. */
  text: string
  /** The count of agent messages in a row of the run the notice is about; the turn it starts carries it. */
  hops: number
  /** The chain of the message sent with notify (its sender's run); the turn it starts stays in it (issue #1442). */
  chain?: string
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
  /** Puts the notice in the sender's queue; `held`: it must not start a turn by itself. Throws when it cannot. */
  deliver(watcherThreadId: string, notice: PlannedSettleNotice, held: boolean): void
  /** The sender's queue already carries this notice (a delivery repeated after a restart). */
  delivered(watcherThreadId: string, item: Pick<SettleNoticeItem, 'watchId' | 'event'>): boolean
  /** Threads this computer's agents launched on other computers (issue #1160); without it only threads here are watched. */
  remote?: RemoteSettleHost
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
 *
 * A watch on a thread this computer's agent launched on another computer is followed there by `RemoteSettleFollower`
 * through routed reads; what it decides is written and delivered here the same way.
 */
export class SettleNotices {
  readonly watches: ThreadWatches
  private readonly checks = new Set<string>()
  private checkScheduled = false
  private expiryTimer: ReturnType<typeof setTimeout> | undefined
  private unsubscribe: (() => void) | undefined
  private stopped = false
  /** Follows the watches on threads of other computers; absent without `host.remote`. */
  readonly remote: RemoteSettleFollower | undefined
  /** What a remote notice says about its run, read when it was decided, by `<watchId>:<needs_input|end>`, until delivered. */
  private readonly remoteDetails = new Map<string, RemoteNoticeDetails>()

  constructor(private readonly host: SettleNoticeHost) {
    this.watches = new ThreadWatches(host.engine.store, () => this.now())
    this.remote = host.remote
      ? new RemoteSettleFollower(this.watches, host.remote, {
          needsInput: (watchId, details) => {
            this.remoteDetails.set(`${watchId}:needs_input`, details)
            if (this.watches.markNeedsInput(watchId)) this.deliverDue(this.watches.get(watchId)!)
          },
          ended: (watchId, status, runId, details) => {
            if (details) this.remoteDetails.set(`${watchId}:end`, details)
            if (this.watches.markEnded(watchId, status, runId)) this.deliverDue(this.watches.get(watchId)!)
          }
        }, () => this.now().getTime())
      : undefined
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
    // A watch on another computer resumes from its row alone: its loop finds the message there again.
    if (this.remote) for (const watch of this.watches.listActiveRemote()) this.remote.follow(watch.watchId)
    this.expireDue()
  }

  /** The other computers may answer again (Bridge came up): every remote watch waiting to try again tries now. */
  remoteReachable(): void {
    this.remote?.wake()
  }

  stop(): void {
    this.stopped = true
    this.remote?.stop()
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
  }

  /**
   * Watches the message `messageKey` an agent just sent (once: a retry of the same send keeps its watch). The message is
   * read at once, so a run that ended before the watch existed is still told.
   */
  watch(input: { messageKey: string; watcherThreadId: string; watcherRunId: string; targetThreadId: string; runId: string; targetNode?: string }): ThreadWatchRecord {
    if (input.targetNode) return this.watchRemote({ ...input, targetNode: input.targetNode })
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

  /**
   * Watches a message sent to a thread on another computer (`targetNode`, `targetThreadId` its id there). The follower
   * finds its queue item there itself, on its first read.
   */
  private watchRemote(input: { messageKey: string; watcherThreadId: string; watcherRunId: string; targetThreadId: string; runId: string; targetNode: string }): ThreadWatchRecord {
    if (!this.remote) throw new Error('Mousse cannot watch threads on other computers here.')
    const { watch, created } = this.watches.create({
      ...input,
      watcherStopGeneration: this.host.stopGeneration(input.watcherThreadId),
      ttlMs: SETTLE_WATCH_TTL_MS
    })
    if (created) {
      this.remote.follow(watch.watchId)
      this.armExpiry()
    }
    return watch
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
        this.remoteDetails.delete(`${watch.watchId}:${which}`)
        return
      }
      const notice = { ...this.plan(watch, event), ...(this.host.engine.store.getRun(watch.watcherRunId) ? { chain: chainIdOf(this.host.engine.store, watch.watcherRunId) } : {}) }
      this.host.deliver(watch.watcherThreadId, notice, this.held(watch, event))
      this.watches.markSent(watch.watchId, which)
      this.remoteDetails.delete(`${watch.watchId}:${which}`)
    } catch (error) {
      console.warn('a settle notice could not be delivered', { watchId: watch.watchId, event, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * A notice never starts a turn (it waits in the queue) in a subagent's thread, whose result is its parent's; in a
   * sender a person stopped after it subscribed; and when it only says Mousse stopped watching.
   */
  private held(watch: ThreadWatchRecord, event: SettleNoticeItem['event']): boolean {
    if (event === 'expired') return true
    if (this.host.isSubagent(watch.watcherThreadId)) return true
    return this.host.stopGeneration(watch.watcherThreadId) > watch.watcherStopGeneration
  }

  private plan(watch: ThreadWatchRecord, event: SettleNoticeItem['event']): PlannedSettleNotice {
    if (watch.targetNode) return this.planRemote(watch, watch.targetNode, event)
    const run = watch.runId ? this.host.target.getRun(watch.runId) : null
    return planSettleNotice({
      watch,
      event,
      title: this.host.titleOf(watch.targetThreadId) ?? null,
      run: run ? { runId: run.runId, error: run.outcome?.error, hops: run.outcome?.agentHops ?? 0 } : undefined,
      resultText: event === 'ended' && run ? this.host.resultText(watch.targetThreadId, run.runId) : undefined
    })
  }

  /**
   * A notice about a thread on another computer: named by its qualified id and its computer, with what the follower read
   * when it decided. A notice decided before a restart and delivered after it has only the watch's row: its status, and
   * the count the send carried.
   */
  private planRemote(watch: ThreadWatchRecord, node: string, event: SettleNoticeItem['event']): PlannedSettleNotice {
    const launched = this.host.remote?.launched(node, watch.targetThreadId)
    const details = this.remoteDetails.get(`${watch.watchId}:${event === 'needs_input' ? 'needs_input' : 'end'}`)
    const hops = details?.hops ?? this.host.remote?.sentHops(watch.watcherRunId) ?? 1
    const runId = details?.runId ?? watch.runId ?? undefined
    return planSettleNotice({
      watch: { ...watch, targetThreadId: qualifyId(node, watch.targetThreadId) },
      event,
      title: launched?.title ?? null,
      computer: launched?.computer ?? 'another computer',
      ...(runId ? { run: { runId, hops, ...(details?.error ? { error: details.error } : {}) } } : {}),
      ...(event === 'ended' && details?.resultText !== undefined ? { resultText: details.resultText } : {}),
      ...(event === 'ended' && details?.resultChars ? { resultChars: details.resultChars } : {})
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
    // A watch on another computer stops following first; what its follow last saw stands.
    for (const watch of this.watches.listActiveRemote()) {
      if (Date.parse(watch.expiresAt) > now) continue
      this.remote?.cancel(watch.watchId)
      if (this.watches.markExpired(watch.watchId)) this.deliverDue(this.watches.get(watch.watchId)!)
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

/**
 * Why a watch on another computer ended without the work ending (`unreachable:<code>[:<reason>]`): that computer refused
 * this device, stopped sharing its threads, is too old, or agents here may no longer work there.
 */
function unreachablePhrase(status: string, computer: string): string {
  const [, code, reason] = status.split(':')
  const stopped = `Mousse stopped watching it; read it with thread_read when ${computer} answers again.`
  switch (code) {
    case 'computer_not_shared':
      return `can no longer be followed from here: ${reason === 'blocked' ? `${computer} refused this device` : reason === 'setting_off' ? `works on threads is off on ${computer}` : `${computer} does not share its threads with this computer any more`}. ${stopped}`
    case 'computer_outdated':
      return `can no longer be followed from here: Mousse on ${computer} is too old to report on it. Update Mousse there; until then Mousse does not watch it.`
    case 'computer_not_allowed':
      return `is no longer followed: the user turned off agents of this computer working on ${computer} (Settings → Agents → Agent access), so Mousse stopped watching it.`
    default:
      return `can no longer be followed from here (${code ?? 'refused'}). ${stopped}`
  }
}

/** How a run's end reads: "finished", "failed: <error>", "was stopped". */
function endPhrase(status: string, error: string | undefined, computer?: string): string {
  if (status.startsWith('unreachable:')) return unreachablePhrase(status, computer ?? 'that computer')
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
  /** The thread is on another computer, named so; `watch.targetThreadId` is then its qualified id. */
  computer?: string
  /** The reply's full length when it was cut before it got here (that computer sends at most 4,000 characters). */
  resultChars?: number
}): PlannedSettleNotice {
  const { watch, event, run } = input
  const thread = `thread "${titleLine(input.title)}"${input.computer ? ` on ${input.computer}` : ''} (${threadLink(watch.targetThreadId)})`
  const base: SettleNoticeItem = { watchId: watch.watchId, threadId: watch.targetThreadId, title: input.title, event, ...(run ? { runId: run.runId } : {}) }
  const hops = run?.hops ?? 0
  // About the message the sender sent with notify; Mousse's words, with the run's reply quoted.
  const about = `The work your message (sent with notify) started in ${thread}`
  if (event === 'needs_input') {
    return {
      item: base,
      hops,
      text: notice({ kind: 'thread_watch' }, [`${about} is waiting for a person to answer a question or an approval there. Mousse will tell you again when it ends; do not call thread_wait or thread_read to check.`])
    }
  }
  if (event === 'expired') {
    return {
      item: base,
      hops,
      text: notice({ kind: 'thread_watch' }, [input.computer
        ? `Mousse stopped watching ${thread} for you after 24 hours. The work your message started there had not ended when Mousse last reached ${input.computer}; read it with thread_read when you need it.`
        : `Mousse stopped watching ${thread} for you after 24 hours. The work your message started there is still going; read it with thread_read when you need it.`])
    }
  }
  const status = watch.endStatus ?? 'completed'
  const unreachable = status.startsWith('unreachable:')
  const reply = input.resultText?.trim() ?? ''
  const shown = reply.slice(0, SETTLE_NOTICE_RESULT_CHARS)
  const total = Math.max(reply.length, input.resultChars ?? 0)
  const cut = shown.length > 0 && shown.length < total
  const said = endPhrase(status, run?.error, input.computer)
  const ref = run && !unreachable && status !== 'removed' && status !== 'deleted' ? run.runId : undefined
  const parts: NoticePart[] = [`${about} ${said}${said.endsWith('.') ? '' : '.'}`]
  if (shown) parts.push(quoted('its reply', shown))
  if (cut) parts.push(`The reply is cut at ${SETTLE_NOTICE_RESULT_CHARS.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} characters; read the rest with thread_read on thread ${watch.targetThreadId}.`)
  return { item: { ...base, status: unreachable ? 'unreachable' : status, ...(cut ? { cut: true } : {}) }, hops, text: notice({ kind: 'thread_watch', ...(ref ? { ref } : {}) }, parts) }
}

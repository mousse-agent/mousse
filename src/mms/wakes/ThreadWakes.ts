import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_EVENT_WAKE_HOURS,
  MAX_EVENT_WAKE_HOURS,
  MAX_SAME_WAKES,
  MAX_WAKE_BRIEF_CHARS,
  wakeEventLabel,
  wakeFiredLabel,
  wakeInput,
  wakeLoopKey,
  type BotWakeEvent,
  type BotWakeFired
} from '../../shared/bots/personal/wakes'
import { notice } from '../../shared/mousseContext'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { clockTime } from '../bots/chat/projection'
import {
  pullRequestWakeEvent,
  threadWakeEvent,
  type WakePullRequestState,
  type WakeThreadState
} from '../bots/wakeSources'
import type { ThreadWakePayload } from '../run/types'
import { WakeDetector } from './wakeDetector'

/**
 * A thread agent's wake-ups (`wake`): it carries on later in its own thread without the person writing, at a time, when
 * another thread finishes its turn, or when a pull request merges, its checks settle or it gets a review. The same tool,
 * limits and decisions as a personal bot's wakes (`shared/bots/personal/wakes`, `bots/wakeSources`); only where they are
 * kept and how they are said differ:
 *
 * - they are kept in one small file per profile, so a daemon restart keeps them, and a time that passed while Mousse was
 *   off or the computer slept fires at the next start or tick (said late);
 * - a due wake goes to the thread's inbox (`post`), the path agents' notes and monitor events take: an idle thread starts
 *   a turn no person started, a running turn takes it as a steer or with its next Mousse tool call, and it waits while
 *   the thread waits on a person's answer. It grants nothing and changes no permission mode;
 * - once posted it is the run engine's, which keeps it across restarts; the file then drops it. A crash between the two
 *   posts it again under the same key, which the inbox takes once.
 *
 * Wakes on a thread or a pull request are looked at by the poll bots' wakes use too (`WakeDetector`).
 *
 * Loop detection is the one limit, as for bots: the same brief waiting on the same thing, set `MAX_SAME_WAKES` times since
 * the person last wrote in the thread, is refused. A wake on an event gives up after its hours and still wakes once.
 * Nothing here runs at a turn's start: timers run only while a wake waits.
 */

/** How often waiting wakes are looked at: what a timer paused by sleep catches up within, and thread events between run ends. */
export const THREAD_WAKE_TICK_MS = 30_000
/** A time wake fired this much after its time is said to be late (Mousse was off, or the computer slept). */
const LATE_MS = 60_000
const HOUR_MS = 60 * 60_000
/** Wakes set are remembered this long for loop detection, and at most this many per thread. */
const HISTORY_MS = 30 * 24 * HOUR_MS
const HISTORY_PER_THREAD = 200

export class ThreadWakeError extends Error {}

/** A wake the file keeps until it fires or is cancelled. */
export interface ThreadWake {
  id: string
  threadId: string
  brief: string
  setAt: string
  /** A time wake's time; a wake on an event gives up then. */
  dueAt: string
  event: Extract<BotWakeEvent, { kind: 'thread' | 'pr' }> | null
  /** Wakes set in the thread since the person last wrote, this one included. */
  chain: number
}

/** One wake as the tools and the app show it. */
export interface ThreadWakeView {
  wakeId: string
  brief: string
  setAt: string
  dueAt: string
  /** What it waits for ("when acme/app#12 merges"); absent for a time wake. */
  waitsFor?: string
}

interface SetEntry {
  threadId: string
  key: string
  at: string
}

interface StoredRecord {
  version: 1
  wakes: ThreadWake[]
  /** Every wake set, for loop detection: cancelled and fired ones count. */
  set: SetEntry[]
}

export interface ThreadWakesDeps {
  /** Where the wakes are kept. */
  file: string
  /** Puts a wake's notice in the thread's inbox; `key` names it, so the same wake is never posted twice. */
  post(threadId: string, payload: ThreadWakePayload, key: string): void
  /** The thread's wakes changed: the app is told (`thread.backgroundWork`). */
  changed?(threadId: string): void
  /** How thread `threadId` stands for the agent of thread `from` (`wakeThreadState`). */
  threadState(from: string, threadId: string): WakeThreadState
  /** A pull request of one of the person's projects (`pullRequestStateOf`). */
  pullRequestState(repo: string, number: number): Promise<WakePullRequestState | { none: true } | { problem: string }>
  /** When the person last wrote in the thread; undefined when they never did. */
  personLastWroteAt(threadId: string): string | undefined
  /** Whether the thread still exists (a wake of a deleted one is dropped). */
  threadExists(threadId: string): boolean
  now?(): number
  setTimer?(callback: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimer?(timer: ReturnType<typeof setTimeout>): void
}

function parseRecord(text: string): StoredRecord {
  try {
    const parsed = JSON.parse(text) as Partial<StoredRecord>
    const wakes = Array.isArray(parsed.wakes) ? parsed.wakes.filter((wake): wake is ThreadWake => Boolean(wake && typeof wake.id === 'string' && typeof wake.threadId === 'string' && typeof wake.dueAt === 'string' && typeof wake.brief === 'string')) : []
    const set = Array.isArray(parsed.set) ? parsed.set.filter((entry): entry is SetEntry => Boolean(entry && typeof entry.threadId === 'string' && typeof entry.key === 'string' && typeof entry.at === 'string')) : []
    return { version: 1, wakes, set }
  } catch {
    return { version: 1, wakes: [], set: [] }
  }
}

export class ThreadWakes {
  private record: StoredRecord
  private timer: ReturnType<typeof setTimeout> | undefined
  private started = false
  private closed = false
  /** What each wake on an event waits for, looked at as a bot's wakes are. */
  private readonly detector: WakeDetector<ThreadWake>

  constructor(private readonly deps: ThreadWakesDeps) {
    this.detector = new WakeDetector<ThreadWake>({
      waiting: () => this.record.wakes.filter((wake) => wake.event),
      threadState: (wake, threadId) => this.deps.threadState(wake.threadId, threadId),
      pullRequestState: (_wake, repo, number) => this.deps.pullRequestState(repo, number),
      // A wake cancelled, or whose thread was stopped, while its event was read stays cancelled.
      fire: (wake, fired) => !this.closed && this.record.wakes.includes(wake) && this.fire(wake, fired),
      now: () => this.now()
    })
    let text = ''
    try {
      text = readFileSync(deps.file, 'utf8')
    } catch {
      text = ''
    }
    this.record = text ? parseRecord(text) : { version: 1, wakes: [], set: [] }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  // ---------------------------------------------------------------- setting and cancelling

  /**
   * `wake`: thread `threadId`'s agent carries on later, at `dueAt` or once `event` happens (giving up after `hours`).
   * Throws `ThreadWakeError`, in words for the agent, when it can't be set.
   */
  async add(threadId: string, input: { brief: string; dueAt?: string; event?: { kind: 'thread'; threadId: string } | { kind: 'pr'; repo: string; number: number; on?: 'merged' | 'checks' | 'review' }; hours?: number }): Promise<{ wakeId: string; dueAt: string; label: string }> {
    const brief = input.brief.trim()
    if (!brief) throw new ThreadWakeError('A wake-up needs a brief: what you will do then.')
    if (brief.length > MAX_WAKE_BRIEF_CHARS) throw new ThreadWakeError(`Keep the brief to ${MAX_WAKE_BRIEF_CHARS.toLocaleString('en-US')} characters: say what to do more briefly, then try again.`)
    let event: ThreadWake['event'] = null
    let dueAt: string
    if (input.event) {
      const hours = input.hours === undefined ? DEFAULT_EVENT_WAKE_HOURS : input.hours
      if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_EVENT_WAKE_HOURS) throw new ThreadWakeError(`hours is how long to wait for it: more than 0, at most ${MAX_EVENT_WAKE_HOURS}.`)
      let checked: ThreadWake['event'] | { problem: string }
      if (input.event.kind === 'thread') {
        if (input.event.threadId === threadId) throw new ThreadWakeError('That is this thread. To carry on after this turn, wake at a time (inMinutes).')
        checked = threadWakeEvent(input.event, this.deps.threadState(threadId, input.event.threadId), clockTime)
      } else {
        checked = pullRequestWakeEvent(input.event, await this.deps.pullRequestState(input.event.repo, input.event.number), "the person's")
      }
      if ('problem' in checked) throw new ThreadWakeError(checked.problem)
      event = checked
      dueAt = new Date(this.now() + hours * HOUR_MS).toISOString()
    } else {
      const due = Date.parse(input.dueAt ?? '')
      if (!Number.isFinite(due)) throw new ThreadWakeError('A wake-up needs a time or something to wait for.')
      if (due < this.now() - 60_000) throw new ThreadWakeError('That time has passed. Pick a time from now on.')
      if (due > this.now() + MAX_EVENT_WAKE_HOURS * HOUR_MS) throw new ThreadWakeError(`A wake-up is at most ${MAX_EVENT_WAKE_HOURS / 24} days ahead. For later, create a scheduled job.`)
      dueAt = new Date(Math.max(due, this.now())).toISOString()
    }
    // Loop detection, the one limit: the same wake set again and again since the person last wrote.
    const key = wakeLoopKey(brief, event)
    const since = this.setSincePersonWrote(threadId)
    const same = since.filter((entry) => entry.key === key).length
    if (same >= MAX_SAME_WAKES)
      throw new ThreadWakeError(`You have set this same wake-up ${same} times since the person last wrote, with nothing new in it: that is a loop. Don't set it again: say where things stand and what you are waiting on, and carry on when they write. If something did change, say what in the brief.`)
    const setAt = new Date(this.now()).toISOString()
    const wake: ThreadWake = { id: `wake-${randomUUID().slice(0, 8)}`, threadId, brief, setAt, dueAt, event, chain: since.length + 1 }
    this.record.wakes.push(wake)
    this.record.set.push({ threadId, key, at: setAt })
    this.persist()
    this.arm()
    this.deps.changed?.(threadId)
    return { wakeId: wake.id, dueAt, label: event ? wakeEventLabel(event) : '' }
  }

  /** The thread's wakes still to come, soonest first. */
  list(threadId: string): ThreadWakeView[] {
    return this.record.wakes
      .filter((wake) => wake.threadId === threadId)
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
      .map((wake) => ({ wakeId: wake.id, brief: wake.brief, setAt: wake.setAt, dueAt: wake.dueAt, ...(wake.event ? { waitsFor: wakeEventLabel(wake.event) } : {}) }))
  }

  has(threadId: string): boolean {
    return this.record.wakes.some((wake) => wake.threadId === threadId)
  }

  /** Cancels one of the thread's wakes (the agent's `reminder_cancel`, or the person's Stop on its row). */
  cancel(threadId: string, wakeId: string): boolean {
    const before = this.record.wakes.length
    this.record.wakes = this.record.wakes.filter((wake) => !(wake.threadId === threadId && wake.id === wakeId))
    if (this.record.wakes.length === before) return false
    this.detector.forget(wakeId)
    this.persist()
    this.arm()
    this.deps.changed?.(threadId)
    return true
  }

  /**
   * The thread was stopped, archived or deleted: its wakes are cancelled. With `tell`, its agent is told once, with its
   * next turn (a quiet notice: a Stop never wakes it). How many were cancelled.
   */
  stopThread(threadId: string, tell: boolean, why = 'the thread was stopped'): number {
    const cancelled = this.record.wakes.filter((wake) => wake.threadId === threadId)
    if (!cancelled.length) return 0
    this.record.wakes = this.record.wakes.filter((wake) => wake.threadId !== threadId)
    for (const wake of cancelled) this.detector.forget(wake.id)
    this.persist()
    this.arm()
    if (tell) {
      const briefs = cancelled.map((wake) => `- ${wake.brief}`).join('\n')
      const text = notice({ kind: 'thread_wake' }, [
        `Your ${cancelled.length === 1 ? 'wake-up was' : `${cancelled.length} wake-ups were`} cancelled: ${why}. Set one again only if the person still wants you to follow up.`,
        `What you had written for yourself:\n${briefs}`
      ])
      const payload: ThreadWakePayload = { kind: 'thread_wake', wakeId: cancelled[0]!.id, label: `Cancelled: ${why}`, brief: cancelled.map((wake) => wake.brief).join('\n'), text, attention: 'none' }
      try {
        this.deps.post(threadId, payload, `thread-wake:${cancelled.map((wake) => wake.id).join(',')}:cancelled`)
      } catch (error) {
        console.warn('a stopped thread could not be told its wake-ups were cancelled', { threadId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    this.deps.changed?.(threadId)
    return cancelled.length
  }

  // ---------------------------------------------------------------- firing

  /** After the daemon is ready: wakes whose time passed while it was off fire now (said late), and the timer starts. */
  start(): void {
    if (this.started || this.closed) return
    this.started = true
    this.tick()
  }

  /** A thread's run ended: the wakes waiting on that thread look now, not at the next tick. */
  threadRunEnded(threadId: string): void {
    if (!this.started || !this.record.wakes.some((wake) => wake.event?.kind === 'thread' && wake.event.threadId === threadId)) return
    void this.pass({ threadId })
  }

  close(): void {
    this.closed = true
    if (this.timer) (this.deps.clearTimer ?? clearTimeout)(this.timer)
    this.timer = undefined
  }

  /** The next look: at the soonest due time, and at least every tick while any wake waits (a timer paused by sleep catches up). */
  private arm(): void {
    if (this.timer) (this.deps.clearTimer ?? clearTimeout)(this.timer)
    this.timer = undefined
    if (!this.started || this.closed || !this.record.wakes.length) return
    const soonest = Math.min(...this.record.wakes.map((wake) => Date.parse(wake.dueAt)))
    const delay = Math.max(0, Math.min(THREAD_WAKE_TICK_MS, soonest - this.now()))
    const timer = (this.deps.setTimer ?? setTimeout)(() => this.tick(), delay)
    ;(timer as { unref?: () => void }).unref?.()
    this.timer = timer
  }

  private tick(): void {
    this.timer = undefined
    void this.pass().finally(() => this.arm())
  }

  /**
   * Looks at every waiting wake (or only those on thread `only.threadId`): drops those of a deleted thread, fires those
   * whose time came, then those whose event happened (`WakeDetector`, one pass at a time).
   */
  private async pass(only?: { threadId: string }): Promise<void> {
    if (this.closed) return
    try {
      for (const wake of [...this.record.wakes]) {
        if (only && !(wake.event?.kind === 'thread' && wake.event.threadId === only.threadId)) continue
        if (!this.record.wakes.includes(wake)) continue
        const now = this.now()
        if (!this.deps.threadExists(wake.threadId)) {
          this.drop(wake)
          continue
        }
        if (Date.parse(wake.dueAt) > now) continue
        const late = !wake.event && now - Date.parse(wake.dueAt) > LATE_MS ? clockTime(wake.dueAt) : undefined
        this.fire(wake, wake.event ? { kind: 'ended', reason: 'expired' } : null, late)
      }
    } catch (error) {
      console.warn('thread wake-ups could not be checked; the next tick tries again', { error: error instanceof Error ? error.message : String(error) })
    }
    await this.detector.check(only)
  }

  /** Posts the wake's notice to its thread's inbox, then forgets it. A failed post keeps it for the next tick (false). */
  private fire(wake: ThreadWake, fired: BotWakeFired | null, late?: string): boolean {
    const text = wakeInput({ thread: true, brief: wake.brief, setAt: wake.setAt, event: wake.event, fired, ...(late ? { late } : {}), chain: wake.chain, clock: clockTime, wakeId: wake.id })
    // A time wake fired late says so on its row too ("Wake-up · was for 19:21").
    const label = !fired && late ? `${wakeFiredLabel(fired)} · was for ${late}` : wakeFiredLabel(fired)
    const payload: ThreadWakePayload = { kind: 'thread_wake', wakeId: wake.id, label, brief: wake.brief, text, attention: 'needed' }
    try {
      this.deps.post(wake.threadId, payload, `thread-wake:${wake.id}`)
    } catch (error) {
      console.warn('a thread wake-up could not be delivered; the next tick tries again', { wakeId: wake.id, error: error instanceof Error ? error.message : String(error) })
      return false
    }
    this.drop(wake)
    return true
  }

  private drop(wake: ThreadWake): void {
    this.record.wakes = this.record.wakes.filter((kept) => kept !== wake)
    this.detector.forget(wake.id)
    this.persist()
    this.deps.changed?.(wake.threadId)
  }

  // ---------------------------------------------------------------- the file

  /** The wakes set in the thread since the person last wrote there. */
  private setSincePersonWrote(threadId: string): SetEntry[] {
    const wrote = this.deps.personLastWroteAt(threadId)
    const after = wrote ? Date.parse(wrote) : Number.NEGATIVE_INFINITY
    return this.record.set.filter((entry) => entry.threadId === threadId && Date.parse(entry.at) > after)
  }

  private persist(): void {
    const oldest = this.now() - HISTORY_MS
    const counts = new Map<string, number>()
    // Newest first, so the cap per thread keeps the latest.
    const set = [...this.record.set].reverse().filter((entry) => {
      if (Date.parse(entry.at) < oldest) return false
      const count = (counts.get(entry.threadId) ?? 0) + 1
      counts.set(entry.threadId, count)
      return count <= HISTORY_PER_THREAD
    }).reverse()
    this.record = { version: 1, wakes: this.record.wakes, set }
    try {
      atomicWriteJsonSync(this.deps.file, this.record)
    } catch (error) {
      console.warn('thread wake-ups could not be saved', { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

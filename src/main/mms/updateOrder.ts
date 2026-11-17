/**
 * Orders the service's answers to reads against the updates it pushes (#1042).
 *
 * The service reads a thread's state, can wait before it answers (it loads the thread first), and keeps pushing
 * updates meanwhile. An update sent after the read can therefore reach main before the answer, and an answer applied
 * after it put the older state back: a turn the window knew had ended showed Working again.
 *
 * Every answer says where it stands (`ReadOrder`): the service that answered and its event number, in the reader's
 * profile, when it read the state. Updates carry numbers from the same counter. Main remembers, per profile and per
 * thread, the number of the newest update it applied about the thread's turn and about its status; an answer replaces
 * only the threads with nothing newer than its read. A whole-list update (every thread's status at once) counts for
 * every thread.
 */
import { isQualifiedId } from '../../shared/threadRef'
import type { ReadOrder } from './GuiMmsController'

/** What an update or an answer is about: a thread's turn (`turn.state`), or its status in the sidebar (`activity`). */
export type UpdateKind = 'turn' | 'activity'

export class UpdateOrder {
  /** The service the numbers below come from; a restarted service numbers from the start again. */
  private instance: string | undefined
  private readonly threads: Record<UpdateKind, Map<string, number>> = { turn: new Map(), activity: new Map() }
  private readonly every: Record<UpdateKind, number> = { turn: 0, activity: 0 }
  /** The highest number applied, to tell a counter that started again. */
  private highest = 0

  /**
   * A connection subscribed to this profile's updates, whose counter stands at `sequence`. A counter can only grow, so
   * one below a number already applied was started again (a restarted service, or the profile's services made again
   * in the same service): the numbers held mean nothing for it.
   */
  subscribed(instance: string | undefined, sequence: number): void {
    if (instance !== this.instance || (Number.isFinite(sequence) && sequence < this.highest)) this.reset(instance)
  }

  /** An update numbered `sequence` was applied: about one thread, or about every thread when `threadId` is absent. */
  noteUpdate(kind: UpdateKind, instance: string | undefined, sequence: number, threadId?: string): void {
    if (!Number.isFinite(sequence)) return
    if (instance !== this.instance) this.reset(instance)
    this.highest = Math.max(this.highest, sequence)
    if (threadId === undefined) {
      this.every[kind] = Math.max(this.every[kind], sequence)
      return
    }
    const seen = this.threads[kind]
    seen.set(threadId, Math.max(seen.get(threadId) ?? 0, sequence))
  }

  /**
   * Whether an answer may replace this thread's state: main applied no update about it newer than the answer's read.
   * An answer without a number (an older service, another computer's thread) or from another service is applied.
   */
  mayApply(kind: UpdateKind, order: ReadOrder, threadId: string): boolean {
    if (order.revision === undefined || isQualifiedId(threadId)) return true
    if (order.instance !== this.instance) return true
    return Math.max(this.every[kind], this.threads[kind].get(threadId) ?? 0) <= order.revision
  }

  /** The newest update applied about this thread, for the log. */
  newest(kind: UpdateKind, threadId: string): number {
    return Math.max(this.every[kind], this.threads[kind].get(threadId) ?? 0)
  }

  private reset(instance: string | undefined): void {
    this.instance = instance
    this.threads.turn.clear()
    this.threads.activity.clear()
    this.every.turn = 0
    this.every.activity = 0
    this.highest = 0
  }
}

/** One `UpdateOrder` per profile: each profile's updates have their own numbering. */
export function updateOrders(): (profileId: string) => UpdateOrder {
  const orders = new Map<string, UpdateOrder>()
  return (profileId) => {
    let order = orders.get(profileId)
    if (!order) {
      order = new UpdateOrder()
      orders.set(profileId, order)
    }
    return order
  }
}

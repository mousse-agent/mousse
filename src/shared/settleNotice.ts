/**
 * The settle notice (docs/run-engine/SPEC.md §15.1, "Told when it settles"): what Mousse tells a thread whose agent sent
 * a message with `notify` (`thread_send`, `thread_create`) about the work that message started in another thread. It is
 * written by Mousse, never by either agent, and carried structured on the message that delivers it, so the app never
 * parses the text the model reads.
 */

/** What happened to the watched work: it waits on a person (once), it ended, or Mousse stopped watching it. */
export type SettleNoticeEvent = 'needs_input' | 'ended' | 'expired'

export interface SettleNoticeItem {
  /** The watch that wrote it; one watch writes at most one `needs_input` and one `ended` or `expired`. */
  watchId: string
  /** The thread the notice is about (the one the message went to). */
  threadId: string
  /** That thread's title when the notice was written. */
  title: string | null
  event: SettleNoticeEvent
  /**
   * With `ended`: the status the work ended with (a run status), `removed` when the message left the thread's queue
   * before it ran, `deleted` when the thread was deleted, or `unreachable` when the thread is on another computer that
   * stopped answering this one's reads (it refused this device, stopped sharing, is too old) and Mousse stopped watching.
   */
  status?: string
  /** The run the notice is about, when there is one. */
  runId?: string
  /** With `ended`: the result was cut; the rest is read with `thread_read`. */
  cut?: boolean
}

/** Characters of the watched run's result a notice carries; the rest is read with `thread_read`. */
export const SETTLE_NOTICE_RESULT_CHARS = 2_000

/** How long a watch lasts: after this the sender is told once, without being woken, that the work still goes on. */
export const SETTLE_WATCH_TTL_MS = 24 * 60 * 60 * 1000

/** Whether a value read from disk or the wire is a notice item. */
export function isSettleNoticeItem(value: unknown): value is SettleNoticeItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.watchId === 'string' && typeof item.threadId === 'string' &&
    (item.event === 'needs_input' || item.event === 'ended' || item.event === 'expired')
}

/** The notice items of a value read from disk or the wire; undefined when there are none. */
export function readSettleNotice(value: unknown): SettleNoticeItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter(isSettleNoticeItem)
  return items.length ? items : undefined
}

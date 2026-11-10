/**
 * Ctrl+Enter (Cmd+Enter on macOS) while a run is going sends as a steer: in the composer it sends the text into the
 * running reply, and on a focused queued message it sends that message. Enter alone queues. The global
 * `approval.allow` shares the chord only while the composer is empty, and never on a queued message.
 */
export const STEER_BINDING = 'CommandOrControl+Enter'

/** Whether a key press is the steer chord: Enter with Ctrl (Cmd on macOS), and no other modifier. */
export function isSteerKey(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }, platform: string): boolean {
  if (event.key !== 'Enter' || event.altKey || event.shiftKey) return false
  return platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

/** Whether keyboard focus is on a queued message (or one of its buttons), where the steer chord sends that message. */
export function queuedMessageFocused(): boolean {
  const active = typeof document === 'undefined' ? null : document.activeElement
  return Boolean(active instanceof HTMLElement && active.closest('.queued-message'))
}

/**
 * Right after a steer by key the composer is empty (or the queued message has gone), so the same chord pressed again
 * would answer a waiting approval (`approval.allow`). For this long after a steer the chord does not approve.
 */
export const STEER_KEY_HOLD_MS = 1500
let lastSteerKeyAt = Number.NEGATIVE_INFINITY

/** A steer was just sent by key. */
export function markSteerKey(): void {
  lastSteerKeyAt = Date.now()
}

/** Whether a steer was sent by key a moment ago (`STEER_KEY_HOLD_MS`). */
export function steerKeyRecently(): boolean {
  return Date.now() - lastSteerKeyAt < STEER_KEY_HOLD_MS
}

/** Forgets the last steer by key: a test's fresh start. */
export function forgetSteerKey(): void {
  lastSteerKeyAt = Number.NEGATIVE_INFINITY
}

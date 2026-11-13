/**
 * While a run is going, Enter in a thread's composer follows the thread's send mode (`SendMode`), and Ctrl+Enter
 * (Cmd+Enter on macOS) does the other one: in Queue mode the chord sends the text into the running reply, in Steer
 * mode it queues it. In an empty composer, and on a focused queued message, the chord sends a queued message now (the
 * next one, or the focused one). The global `approval.allow`
 * shares the chord only while the composer is empty, and never on a queued message.
 */
export const STEER_BINDING = 'CommandOrControl+Enter'

/**
 * What Enter does in a thread's composer while a reply runs: `queue` sends the message after the reply, `steer`
 * sends it into the reply now. Each thread keeps its own (`lib/sendMode.ts`); a new thread queues.
 */
export type SendMode = 'queue' | 'steer'

type EnterKey = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }

/** Whether a key press is the steer chord: Enter with Ctrl (Cmd on macOS), and no other modifier. */
export function isSteerKey(event: EnterKey, platform: string): boolean {
  if (event.key !== 'Enter' || event.altKey || event.shiftKey) return false
  return platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

/**
 * Whether Enter pressed in the composer while a reply runs sends as a steer. Enter follows `mode`; the chord
 * (`isSteerKey`) does the other one; Alt+Enter, the earlier steer key, always steers. Any other Enter does what
 * Enter does. Shift+Enter is a new line, never a send.
 */
export function steersOnEnter(event: EnterKey, platform: string, mode: SendMode): boolean {
  if (event.key !== 'Enter' || event.shiftKey) return false
  if (event.altKey && !event.ctrlKey && !event.metaKey) return true
  if (isSteerKey(event, platform)) return mode !== 'steer'
  return mode === 'steer'
}

/** Whether keyboard focus is on a queued message (or one of its buttons), where the steer chord sends that message. */
export function queuedMessageFocused(): boolean {
  const active = typeof document === 'undefined' ? null : document.activeElement
  return Boolean(active instanceof HTMLElement && active.closest('.queued-message'))
}

/**
 * Right after a steer by key, or a send by the chord in Steer mode, the composer is empty (or the queued message has
 * gone), so the same chord pressed again would answer a waiting approval (`approval.allow`). For this long after
 * such a send the chord does not approve.
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

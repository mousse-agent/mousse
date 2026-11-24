import { useSyncExternalStore } from 'react'

/**
 * Whether the window's composers show Connecting… : the app's link to its background service (main's
 * `GuiMmsController` state, `app.onServiceConnectionChanged`) has been down for `CONNECTING_SHOWN_AFTER_MS`. A blip
 * shorter than that shows nothing. Every state but `ready` counts as down, including a reconnect that gave up: the
 * next click or key in the window tries again, so the composer keeps saying Connecting… rather than offering a retry
 * of its own. Until main has answered, the window counts as connected: the real chat only opens once the service
 * answered, and the warm start's composer says Connecting… by itself.
 */
export const CONNECTING_SHOWN_AFTER_MS = 400

let shown = false
let timer: ReturnType<typeof setTimeout> | null = null
let unlisten: (() => void) | null = null
const listeners = new Set<() => void>()

function set(next: boolean): void {
  if (shown === next) return
  shown = next
  for (const listener of listeners) listener()
}

function apply(state: string): void {
  if (state === 'ready') {
    if (timer) clearTimeout(timer)
    timer = null
    set(false)
    return
  }
  if (shown || timer) return
  timer = setTimeout(() => {
    timer = null
    set(true)
  }, CONNECTING_SHOWN_AFTER_MS)
}

/** Listens to main once for the window's life; the first composer that mounts starts it. */
function listen(): void {
  const app = window.mousse?.app
  if (!app?.onServiceConnectionChanged) return
  let heard = false
  unlisten = app.onServiceConnectionChanged((state) => {
    heard = true
    apply(state)
  })
  // A change heard first is newer than this answer.
  void app.serviceConnection?.().then((state) => { if (!heard) apply(state) }, () => undefined)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!unlisten) listen()
  return () => { listeners.delete(listener) }
}

/** True while the window's composers say Connecting… (see above). */
export function useServiceConnecting(): boolean {
  return useSyncExternalStore(subscribe, () => shown, () => false)
}

/** How soon after the warm start's composer leaves the real one counts as taking its place. */
const HANDOVER_MS = 1000
let handoverAt: number | null = null

/** The warm start's composer said Connecting… until now and gives way to the real chat's (WarmChat). */
export function noteConnectingHandover(): void {
  handoverAt = Date.now()
}

/**
 * Whether a composer mounting now takes the place of the warm start's: it starts as that one ended, and fades the dots
 * out. Every composer that mounts within HANDOVER_MS does.
 */
export function takesConnectingHandover(): boolean {
  return handoverAt !== null && Date.now() - handoverAt < HANDOVER_MS
}

/** A test's fresh start: stops listening and forgets what was heard. */
export function forgetServiceConnection(): void {
  unlisten?.()
  unlisten = null
  if (timer) clearTimeout(timer)
  timer = null
  shown = false
  handoverAt = null
}

import type { NetStatus } from '../../shared/net'

declare const __MOUSSE_ID_ORIGIN__: string | undefined

/**
 * The Mousse ID service this build signs in to. Set at build time with the
 * `MOUSSE_ID_ORIGIN` environment value (`MOUSSE_PLUS_ORIGIN` is still read as a fallback).
 * Empty in builds that set neither, which then show no Mousse ID UI. The main process can
 * also pass a runtime value from the same environment variable, which wins over this one.
 */
export const DEFAULT_MOUSSE_ID_ORIGIN: string =
  typeof __MOUSSE_ID_ORIGIN__ === 'string' ? __MOUSSE_ID_ORIGIN__.trim() : ''

/** Returns a normalized origin, or undefined when the value is not a usable service address. */
export function normalizePlusOrigin(value: string): string | undefined {
  const text = value.trim()
  if (!text) return undefined
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return undefined
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/'))
    return undefined
  return url.origin
}

/** The value wins when it is valid; otherwise the fallback. Empty when neither is usable. */
export function resolvePlusOrigin(override: string | null | undefined, fallback = DEFAULT_MOUSSE_ID_ORIGIN): string {
  return normalizePlusOrigin(override ?? '') ?? normalizePlusOrigin(fallback) ?? ''
}

/**
 * Adds the loopback address the approval page sends the browser back to once the
 * sign-in is approved or denied. The page only follows loopback callbacks.
 */
export function withSignInCallback(verificationUri: string, callbackUrl: string | undefined): string {
  if (!callbackUrl) return verificationUri
  try {
    const url = new URL(verificationUri)
    url.searchParams.set('callback', callbackUrl)
    return url.toString()
  } catch {
    return verificationUri
  }
}

/** Error codes that mean "not approved yet, ask again later". */
const WAITING = new Set(['peer_offline', 'rate_limited', 'deadline_exceeded', 'route_unreachable'])

export interface PollOptions {
  /** First wait between attempts, from the sign-in transaction. */
  intervalMs: number
  /** Epoch ms after which the sign-in can no longer be approved. */
  expiresAt: number
  signal: AbortSignal
  maxIntervalMs?: number
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export class PlusSignInError extends Error {
  constructor(readonly code: 'cancelled' | 'expired', message: string) {
    super(message)
  }
}

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new PlusSignInError('cancelled', 'Sign-in cancelled.'))
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop)
      resolve()
    }, ms)
    const stop = () => {
      clearTimeout(timer)
      reject(new PlusSignInError('cancelled', 'Sign-in cancelled.'))
    }
    signal.addEventListener('abort', stop, { once: true })
  })

/**
 * A poll sleep that `wake()` cuts short, used when the browser calls back. A wake that
 * lands while no sleep is running makes the next sleep return at once.
 */
export function createWakeableSleep(): { sleep: (ms: number, signal: AbortSignal) => Promise<void>; wake: () => void } {
  let early = false
  let cut: (() => void) | undefined
  const sleep = (ms: number, signal: AbortSignal) => {
    if (early && !signal.aborted) {
      early = false
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', stop)
        cut = undefined
      }
      const stop = () => {
        done()
        reject(new PlusSignInError('cancelled', 'Sign-in cancelled.'))
      }
      const timer = setTimeout(() => {
        done()
        resolve()
      }, ms)
      cut = () => {
        done()
        resolve()
      }
      if (signal.aborted) stop()
      else signal.addEventListener('abort', stop, { once: true })
    })
  }
  const wake = () => {
    if (cut) cut()
    else early = true
  }
  return { sleep, wake }
}

/**
 * Calls `finish` until the browser approval lands. "Not approved yet" answers back off
 * (x1.5, capped); any other error ends the wait. Stops on abort or when the sign-in expires.
 */
export async function pollPlusSignIn<T>(finish: () => Promise<T>, options: PollOptions): Promise<T> {
  const now = options.now ?? Date.now,
    sleep = options.sleep ?? abortableSleep,
    max = options.maxIntervalMs ?? 10_000
  let wait = Math.max(500, options.intervalMs)
  for (;;) {
    if (options.signal.aborted) throw new PlusSignInError('cancelled', 'Sign-in cancelled.')
    if (now() >= options.expiresAt)
      throw new PlusSignInError('expired', 'This sign-in expired. Start again.')
    try {
      return await finish()
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (options.signal.aborted) throw new PlusSignInError('cancelled', 'Sign-in cancelled.')
      if (typeof code !== 'string' || !WAITING.has(code)) throw error
    }
    await sleep(Math.min(wait, Math.max(0, options.expiresAt - now())), options.signal)
    wait = Math.min(max, Math.round(wait * 1.5))
  }
}

/** Whole seconds left, never negative. */
export const secondsLeft = (expiresAt: number, now = Date.now()) =>
  Math.max(0, Math.ceil((expiresAt - now) / 1000))

export const formatCountdown = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

/**
 * Whether sign-in can get networking ready by itself: create the identity, turn
 * networking on and protect keys with the OS keychain. Only a locked profile
 * needs the person, because unlocking takes their passphrase.
 */
export function mousseIdPreparation(net?: NetStatus): 'ready' | 'automatic' | 'manual' {
  if (net?.enabled && net.self && net.keystore === 'unlocked' && net.protected) return 'ready'
  if (net?.self && net.keystore !== 'unlocked') return 'manual'
  return 'automatic'
}

/** What to do first when Mousse ID is not ready yet. */
export function mousseIdSetupStep(net?: NetStatus): string {
  if (!net?.self) return 'Create a network identity under Devices first.'
  if (!net.enabled) return 'Enable networking for this profile under Devices first.'
  if (net.keystore !== 'unlocked') return 'Unlock this profile under Devices first.'
  return 'Protect network keys with a passphrase under Devices first.'
}

/** Sign-in failure in words a person can act on. */
export function signInErrorMessage(cause: unknown, origin: string, net?: NetStatus): string {
  let host = origin
  try {
    host = new URL(origin).host
  } catch {
    // Keep the raw address.
  }
  switch ((cause as { code?: unknown } | null)?.code) {
    case 'route_unreachable':
    case 'deadline_exceeded':
      return `Can’t reach Mousse ID at ${host}. Check your internet connection and try again.`
    case 'forbidden':
    case 'bad_request':
    case 'too_large':
      return `Mousse ID at ${host} didn’t accept the sign-in. Try again later.`
    case 'keystore_locked':
      return mousseIdSetupStep(net)
    case 'expired':
      return 'The sign-in code expired. Sign in again.'
    default:
      return String((cause as Error | null)?.message ?? cause)
  }
}

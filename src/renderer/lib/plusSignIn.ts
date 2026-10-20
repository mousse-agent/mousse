declare const __MOUSSE_ID_ORIGIN__: string | undefined

/**
 * The Mousse ID service this build signs in to. Set at build time with the
 * `MOUSSE_ID_ORIGIN` environment value (`MOUSSE_PLUS_ORIGIN` is still read as a fallback);
 * empty when the build has none.
 */
export const DEFAULT_MOUSSE_ID_ORIGIN: string =
  typeof __MOUSSE_ID_ORIGIN__ === 'string' ? __MOUSSE_ID_ORIGIN__.trim() : ''

/** localStorage key for the origin set under Advanced in settings. */
export const PLUS_ORIGIN_OVERRIDE_KEY = 'mousse.plus.originOverride'

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

/** The override wins when it is valid; otherwise the build default. Empty when neither is set. */
export function resolvePlusOrigin(override: string | null | undefined, fallback = DEFAULT_MOUSSE_ID_ORIGIN): string {
  return normalizePlusOrigin(override ?? '') ?? normalizePlusOrigin(fallback) ?? ''
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

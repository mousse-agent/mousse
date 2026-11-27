/**
 * Updating one computer from another (#476, step 2). The asking computer calls `update.*` on the other one over the
 * network; that computer's background service keeps the request, and its desktop app (the only part that can install)
 * downloads the exact version, counts down on screen and installs. See docs/releases.md.
 */

/** The Net methods another computer calls; each is held to Full control (`checkNodePolicy`). */
export const UPDATE_NET_METHODS = ['update.prepare', 'update.status', 'update.install', 'update.cancel'] as const
export type UpdateNetMethod = (typeof UPDATE_NET_METHODS)[number]

/** The local method a window calls to ask another computer (`net.update.there`), by step. */
export const UPDATE_THERE_STEPS = ['refresh', 'version', 'prepare', 'status', 'install', 'cancel'] as const
export type UpdateThereStep = (typeof UPDATE_THERE_STEPS)[number]

/**
 * Where a request stands on the computer being updated.
 * - `preparing`: its app is downloading the version.
 * - `ready`: downloaded; waits for the asking computer to say install.
 * - `countdown`: shown on its screen with Cancel until `installAt`.
 * - `waiting`: more turns run than when the asking computer confirmed; it installs once they end.
 * - `installing`: its service is stopping for the installer.
 * - `failed` / `cancelled`: over; `error` says why.
 */
export type RemoteUpdatePhase = 'preparing' | 'ready' | 'countdown' | 'waiting' | 'installing' | 'failed' | 'cancelled'

/** Why a request failed, in words both computers know. */
export type RemoteUpdateError =
  /** The app that installs is not running there now, or stopped during the update. */
  | 'not_accepting'
  /** Another update runs there (from here, another computer, or another home sharing the install). */
  | 'busy'
  /** That computer's update feed does not offer this exact version. */
  | 'version_unavailable'
  | 'download_failed'
  | 'install_failed'
  /** The request was not installed in time. */
  | 'expired'
  /** The asking computer lost Full control there. */
  | 'forbidden'
  | 'cancelled'
  | 'unknown_job'

export const REMOTE_UPDATE_ERRORS: readonly RemoteUpdateError[] = [
  'not_accepting',
  'busy',
  'version_unavailable',
  'download_failed',
  'install_failed',
  'expired',
  'forbidden',
  'cancelled',
  'unknown_job'
]

/** `update.status`: only what changes; the version and platform are in `net.info`. */
export interface RemoteUpdateStatus {
  job: string
  phase: RemoteUpdatePhase
  /** 0–100 while preparing. */
  percent?: number
  error?: RemoteUpdateError
  /** Turns working there now, across every profile of its service. */
  runningTurns: number
  /** When the countdown ends (that computer's clock, ms). */
  installAt?: number
}

/** A request as the computer being updated shows it (its app reads this from its service). */
export interface RemoteUpdateJob {
  id: string
  version: string
  /** The asking computer's name. */
  from: string
  phase: RemoteUpdatePhase
  percent?: number
  error?: RemoteUpdateError
  installAt?: number
  /** Turns running when the asking computer confirmed. */
  consentedTurns?: number
  /** Asked by this computer itself (Update everywhere): no countdown toast. */
  local?: true
}

/** Daemon methods the desktop app's main process calls on its own service. */
export const REMOTE_UPDATE_APP_METHODS = {
  /** The app can install requests now; held until its connection closes. */
  attach: 'updates.remote.attach',
  job: 'updates.remote.job',
  progress: 'updates.remote.progress',
  /** The countdown ended: may it install now? */
  begin: 'updates.remote.begin',
  /** Cancel from the countdown on this computer. */
  cancel: 'updates.remote.cancel',
  /** The turns running now in every profile of the service: what a restart of this computer stops. */
  turns: 'updates.remote.turns'
} as const

/** The service tells its app to read the request again (an installation event; replaying it is harmless). */
export const REMOTE_UPDATE_EVENT = 'updates.remote.changed'

/** Main → renderer: the countdown toast. */
export const REMOTE_UPDATE_IPC = {
  toast: 'updates:remote-toast',
  get: 'updates:remote-toast-get',
  cancel: 'updates:remote-cancel'
} as const

/** What the toast shows; `null` hides it. */
export interface RemoteUpdateToast {
  job: string
  from: string
  installAt: number
  waiting?: boolean
}

export interface RemoteUpdateLimits {
  /** How long the countdown on the updated computer runs before it installs. */
  countdownMs: number
  /** How long a request may wait between being asked for and being installed. */
  requestTtlMs: number
  /** How long the asking computer waits for one `update.*` call. */
  callDeadlineMs: number
  /**
   * How long the asking computer waits for the updated one to come back on the new version. Covers stopping its
   * service and freeing the install folder (up to about 45 s on Windows) and the installer itself.
   */
  returnMs: number
  /** How often the asking window reads the status. */
  pollMs: number
  /** While more turns run than were confirmed, how often the updated computer's app asks again. */
  busyRetryMs: number
  /** A lock on the install folder older than this, whose process is gone, is taken over. */
  lockStaleMs: number
  /** Update everywhere: how long every computer gets to download before the ready ones install without the rest. */
  rolloutPrepareMs: number
  /** Update everywhere: how long a computer gets to come back on the new version before it shows "Couldn't verify". */
  rolloutReconnectMs: number
  /** Update everywhere: a "Couldn't verify" computer is asked its version again at most this often while its results show. */
  rolloutRecheckMs: number
}

export const REMOTE_UPDATE_LIMITS: RemoteUpdateLimits = Object.freeze({
  countdownMs: 10_000,
  requestTtlMs: 30 * 60_000,
  callDeadlineMs: 15_000,
  returnMs: 10 * 60_000,
  pollMs: 1_000,
  busyRetryMs: 15_000,
  lockStaleMs: 10 * 60_000,
  rolloutPrepareMs: 20 * 60_000,
  rolloutReconnectMs: 10 * 60_000,
  rolloutRecheckMs: 60_000
})

const ENV: Record<keyof RemoteUpdateLimits, string> = {
  countdownMs: 'MOUSSE_NET_UPDATE_COUNTDOWN_MS',
  requestTtlMs: 'MOUSSE_NET_UPDATE_REQUEST_TTL_MS',
  callDeadlineMs: 'MOUSSE_NET_UPDATE_CALL_DEADLINE_MS',
  returnMs: 'MOUSSE_NET_UPDATE_RETURN_MS',
  pollMs: 'MOUSSE_NET_UPDATE_POLL_MS',
  busyRetryMs: 'MOUSSE_NET_UPDATE_BUSY_RETRY_MS',
  lockStaleMs: 'MOUSSE_NET_UPDATE_LOCK_STALE_MS',
  rolloutPrepareMs: 'MOUSSE_NET_UPDATE_ROLLOUT_PREPARE_MS',
  rolloutReconnectMs: 'MOUSSE_NET_UPDATE_ROLLOUT_RECONNECT_MS',
  rolloutRecheckMs: 'MOUSSE_NET_UPDATE_ROLLOUT_RECHECK_MS'
}

/** The limits, each overridable by its `MOUSSE_NET_UPDATE_*` variable (a positive whole number of ms). */
export function remoteUpdateLimits(env: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env): RemoteUpdateLimits {
  const out = { ...REMOTE_UPDATE_LIMITS }
  for (const key of Object.keys(ENV) as Array<keyof RemoteUpdateLimits>) {
    const raw = env[ENV[key]]
    if (raw === undefined || raw === '') continue
    const value = Number(raw)
    if (Number.isSafeInteger(value) && value > 0) out[key] = value
  }
  return out
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/

/** A release version a request may name. */
export const isReleaseVersion = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 64 && VERSION.test(value)

const PHASES: readonly RemoteUpdatePhase[] = ['preparing', 'ready', 'countdown', 'waiting', 'installing', 'failed', 'cancelled']

/** Reads `update.status` from another computer; anything off reads as nothing. */
export function parseRemoteUpdateStatus(value: unknown): RemoteUpdateStatus | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (typeof row.job !== 'string' || !PHASES.includes(row.phase as RemoteUpdatePhase)) return undefined
  const turns = Number.isSafeInteger(row.runningTurns) && (row.runningTurns as number) >= 0 ? (row.runningTurns as number) : 0
  return {
    job: row.job,
    phase: row.phase as RemoteUpdatePhase,
    runningTurns: turns,
    ...(typeof row.percent === 'number' && row.percent >= 0 && row.percent <= 100 ? { percent: Math.floor(row.percent) } : {}),
    ...(REMOTE_UPDATE_ERRORS.includes(row.error as RemoteUpdateError) ? { error: row.error as RemoteUpdateError } : {}),
    ...(Number.isSafeInteger(row.installAt) ? { installAt: row.installAt as number } : {})
  }
}

/** Over: nothing more happens to the request. */
export const isFinishedPhase = (phase: RemoteUpdatePhase): boolean => phase === 'failed' || phase === 'cancelled'

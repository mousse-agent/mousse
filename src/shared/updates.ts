/** In-app updates: state shared by the main-process updater and the renderer. See docs/releases.md. */

/** Stable follows `vX.Y.Z` releases; nightly follows `-nightly.` prereleases. */
export type UpdateChannel = 'stable' | 'nightly'

export type UpdatePhase =
  /** Updates cannot run in this build; `disabledReason` says why. */
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  /** Stopping the background service and handing over to the installer. */
  | 'installing'
  | 'error'

/** One release's notes, already reduced to plain-text items. */
export interface UpdateReleaseNote {
  version: string
  items: string[]
  /** Items before truncation; the rest are on `url`. */
  totalItems: number
  url: string
}

export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  channel: UpdateChannel
  disabledReason?: string
  availableVersion?: string
  /** Newest first. */
  releaseNotes: UpdateReleaseNote[]
  /** Releases between the current and the available version that are not listed. */
  omittedReleaseCount: number
  /** Every pull request the offered releases' notes link, listed or not: what the update brings. */
  pullRequests?: number[]
  /** 0–100 while downloading. */
  downloadPercent?: number
  error?: { message: string; during: 'check' | 'download' | 'install' }
  /** An update installed earlier did not take effect; offered again. */
  notAppliedVersion?: string
  lastCheckedAt?: number
}

/** IPC channels between the renderer and the main-process updater. */
export const UPDATE_IPC = {
  getState: 'updates:getState',
  check: 'updates:check',
  download: 'updates:download',
  install: 'updates:install',
  setChannel: 'updates:setChannel',
  state: 'updates:state'
} as const

const NIGHTLY_VERSION = /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/

/** The channel a build follows unless its user picked one. */
export function channelForVersion(version: string): UpdateChannel {
  return NIGHTLY_VERSION.test(version) ? 'nightly' : 'stable'
}

/**
 * Whether a computer's Mousse can install an update by itself, as it tells its other computers (`net.info`'s
 * `update`). Absent from a computer from before it: nothing is assumed about one that does not say.
 */
export interface SelfUpdateReport {
  /** The channel its updates follow. */
  channel: UpdateChannel
  /** Its desktop app installs updates itself. */
  self: boolean
  /** Why it can't, in plain words; only when `self` is false. */
  reason?: string
}

const REASON_MAX_CHARS = 200

/** Reads a report from another computer or a file; anything off reads as no report. */
export function parseSelfUpdateReport(value: unknown): SelfUpdateReport | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if ((row.channel !== 'stable' && row.channel !== 'nightly') || typeof row.self !== 'boolean') return undefined
  const reason =
    !row.self && typeof row.reason === 'string' ? row.reason.replace(/\s+/g, ' ').trim().slice(0, REASON_MAX_CHARS) : ''
  return { channel: row.channel, self: row.self, ...(reason ? { reason } : {}) }
}

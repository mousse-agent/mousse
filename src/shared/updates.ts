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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { channelForVersion, parseSelfUpdateReport, type SelfUpdateReport, type UpdateState } from '../../shared/updates'
import { mousseVersion } from '../appVersion'

/**
 * The desktop updater runs in the app's main process, which the background service cannot ask. The app keeps what
 * it knows (its channel, and why it can't update itself) in this file in the Mousse home, and the service reads it
 * when another computer asks (`net.info`).
 */
export const SELF_UPDATE_REPORT_FILE = 'desktop-updates.json'

/** What a service with no desktop app here says. */
export const NO_DESKTOP_APP_REASON = 'Mousse runs here without its desktop app, which installs updates.'

export function selfUpdateReportPath(home: string): string {
  return join(home, SELF_UPDATE_REPORT_FILE)
}

/** The desktop updater's state as its report. */
export function selfUpdateReportOf(state: Pick<UpdateState, 'phase' | 'channel' | 'disabledReason'>): SelfUpdateReport {
  const self = state.phase !== 'disabled'
  return { channel: state.channel, self, ...(!self && state.disabledReason ? { reason: state.disabledReason } : {}) }
}

/** This computer's report: the desktop app's, or, with no app here, the build's channel and why it can't. */
export function readSelfUpdateReport(home: string, version = mousseVersion()): SelfUpdateReport {
  try {
    const report = parseSelfUpdateReport(JSON.parse(readFileSync(selfUpdateReportPath(home), 'utf8')))
    if (report) return report
  } catch {
    // No desktop app has written one here.
  }
  return { channel: channelForVersion(version), self: false, reason: NO_DESKTOP_APP_REASON }
}

/**
 * Keeps the file in step with the desktop updater: it is written only when the report differs from what the file
 * holds, so a launch with nothing new writes nothing. A failed write leaves the last report; it never stops updates.
 */
export function selfUpdateReporter(home: string): (state: Pick<UpdateState, 'phase' | 'channel' | 'disabledReason'>) => void {
  let written: string | undefined
  return (state) => {
    const report = selfUpdateReportOf(state)
    const text = JSON.stringify(report)
    if (text === written) return
    try {
      written ??= JSON.stringify(parseSelfUpdateReport(JSON.parse(readFileSync(selfUpdateReportPath(home), 'utf8'))))
    } catch {
      written = ''
    }
    if (text === written) return
    try {
      atomicWriteJsonSync(selfUpdateReportPath(home), report)
      written = text
    } catch (error) {
      console.warn('The update report could not be written:', error instanceof Error ? error.message : String(error))
    }
  }
}

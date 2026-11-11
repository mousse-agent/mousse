import { useEffect } from 'react'
import type { MemoryNotice } from '../../shared/diagnostics/memory'
import type { MousseSettings } from '../../shared/settings'
import { showToast, type ToastInput } from '../components/ui/Toast'
import { useAppStore } from '../stores/appStore'

export const MEMORY_NOTICE_TEXT = 'High memory use'

type ReportApi = { memoryReport: () => Promise<{ ok: boolean; copied: boolean; complete: boolean }> }

/** Report: opens the prefilled issue, and says so when the browser would not open or the text went to the clipboard. */
export async function openMemoryReport(api: ReportApi | undefined = window.mousse?.diagnostics, show: (input: ToastInput) => void = showToast): Promise<void> {
  try {
    if (!api) throw new Error('unavailable')
    const result = await api.memoryReport()
    if (!result.ok) {
      show({ key: 'memory-report', tone: 'error', message: result.copied ? "Couldn't open the browser. The report is on your clipboard." : "Couldn't open the browser." })
    } else if (!result.complete && result.copied) {
      show({ key: 'memory-report', message: 'Report copied. Paste it into the new issue.' })
    }
  } catch {
    show({ key: 'memory-report', tone: 'error', message: "Couldn't make the memory report." })
  }
}

export interface MemoryNoticeDeps {
  show: (input: ToastInput) => void
  shown: (kind: MemoryNotice['kind']) => void
  report: () => void
}

/**
 * Shows the service's memory notice as one toast with Report, only while the profiler and its Memory notices are on
 * (Settings → Labs). Returns whether it showed. The service allows one a day; `seen` keeps one window
 * from showing the same notice twice.
 */
export function presentMemoryNotice(notice: MemoryNotice, enabled: boolean, seen: Set<string>, deps: MemoryNoticeDeps): boolean {
  if (!enabled) return false
  const key = `${notice.kind}:${notice.at}`
  if (seen.has(key)) return false
  seen.add(key)
  deps.show({
    key: 'memory-notice',
    message: MEMORY_NOTICE_TEXT,
    detail: `${notice.summary}. Report opens a prefilled GitHub issue; nothing is sent until you submit.`,
    tone: 'paused',
    durationMs: 20_000,
    action: { label: 'Report', run: deps.report }
  })
  deps.shown(notice.kind)
  return true
}

/**
 * The profiler and its Memory notices are both on (Settings → Labs). Settings from a service without a profiler: off.
 * The notices switch is `notifications.memoryNotices`, as before, so a person who turned it off keeps it off.
 */
export function memoryNoticesEnabled(settings: { experimental?: Partial<Pick<MousseSettings['experimental'], 'profiler'>>; notifications?: Partial<Pick<MousseSettings['notifications'], 'memoryNotices'>> } | null | undefined): boolean {
  return settings?.experimental?.profiler?.enabled === true && settings.notifications?.memoryNotices !== false
}

/**
 * Listens for the memory notice, and asks once at start for one that came while no window was open. Settings belong to
 * a profile, so nothing is read until the window is bound to one, and they are read again when it switches profile.
 */
export function useMemoryNotices(): void {
  const profileReady = useAppStore((s) => s.profileReady)
  const profileId = useAppStore((s) => s.profileId)
  useEffect(() => {
    const api = window.mousse?.diagnostics
    if (!api || !profileReady) return
    let enabled = false
    let cancelled = false
    const seen = new Set<string>()
    const deps: MemoryNoticeDeps = {
      show: (input) => { showToast(input) },
      shown: (kind) => { void api.memoryNoticeShown(kind).catch(() => undefined) },
      report: () => { void openMemoryReport(api) }
    }
    const present = (notice: MemoryNotice | null | undefined) => {
      if (!cancelled && notice) presentMemoryNotice(notice, enabled, seen, deps)
    }
    const offSettings = window.mousse.settings.onChanged((settings) => { enabled = memoryNoticesEnabled(settings) })
    const offNotice = api.onMemoryNotice(present)
    void window.mousse.settings.get()
      .then((settings) => { enabled = memoryNoticesEnabled(settings) })
      .catch(() => undefined)
      // Off, the service has no monitor to ask.
      .then(() => (enabled ? api.memoryStatus() : null))
      .then((status) => present(status?.notice))
      // An older service has no monitor.
      .catch(() => undefined)
    return () => {
      cancelled = true
      offSettings()
      offNotice()
    }
  }, [profileReady, profileId])
}

import { useEffect } from 'react'
import type { MemoryNotice } from '../../shared/diagnostics/memory'
import type { MousseSettings } from '../../shared/settings'
import { showToast, type ToastInput } from '../components/ui/Toast'

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
 * Shows the service's memory notice as one toast with Report, unless the person turned the notices off
 * (Settings > General > About). Returns whether it showed. The service allows one a day; `seen` keeps one window
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

export function memoryNoticesEnabled(settings: Pick<MousseSettings, 'notifications'> | null | undefined): boolean {
  return settings?.notifications?.memoryNotices !== false
}

/** Listens for the memory notice, and asks once at start for one that came while no window was open. */
export function useMemoryNotices(): void {
  useEffect(() => {
    const api = window.mousse?.diagnostics
    if (!api) return
    let enabled = true
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
      .then(() => api.memoryStatus())
      .then((status) => present(status?.notice))
      // An older service has no monitor.
      .catch(() => undefined)
    return () => {
      cancelled = true
      offSettings()
      offNotice()
    }
  }, [])
}

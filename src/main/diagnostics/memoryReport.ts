/** Opening the memory report's prefilled issue from main. Pure apart from the two functions it is given, so it is tested without Electron. */
import type { MemoryIssue } from '../../shared/diagnostics/memory'
import { openExternalSafely } from '../safeExternalUrl'

export interface MemoryReportResult {
  ok: boolean
  url: string
  /** The report text is on the clipboard. */
  copied: boolean
  /** The link carries the whole report. */
  complete: boolean
}

/** Opens the issue link; puts the text on the clipboard when the link cannot carry it or the browser did not open. */
export async function openMemoryIssue(issue: MemoryIssue, io: { open: (url: string) => Promise<void>; copy: (text: string) => void }): Promise<MemoryReportResult> {
  let copied = false
  const copy = () => {
    if (copied) return
    try { io.copy(issue.body); copied = true } catch { /* no clipboard */ }
  }
  if (!issue.complete) copy()
  const ok = await openExternalSafely(io.open, issue.url, 'diagnostics:memoryReport')
  if (!ok) copy()
  return { ok, url: issue.url, copied, complete: issue.complete }
}

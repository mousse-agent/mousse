/**
 * The desktop app's part of the memory monitor. About once a minute main reads every Chromium process's memory
 * (`app.getAppMetrics`: main, windows, GPU, utility) plus its own Node heap and each window's JS heap (which the
 * window's preload sends), and reports the numbers to the service, which logs them and checks the limits. The
 * window asks main for the status and the prefilled issue; main opens the issue in the browser.
 */
import { app, ipcMain, shell } from 'electron'
import { toMb, type AppProcessKind, type AppProcessMemory, type BreachKind, type MemoryIssue } from '../../shared/diagnostics/memory'
import { openExternalSafely } from '../safeExternalUrl'

type RegisterHandler = (channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown) => void

interface DaemonRequester {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
}

const REPORT_EVERY_MS = 60_000
const KINDS: Record<string, AppProcessKind> = { Browser: 'main', Tab: 'window', GPU: 'gpu', Utility: 'utility' }

/** A window's JS heap by its OS process id, as its preload last sent it (MB). */
const windowHeaps = new Map<number, { heapUsed: number; heapTotal: number; at: number }>()

function kb(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round((value / 1024) * 10) / 10 : undefined
}

/** Every app process's memory now, in MB. Cheap: one Chromium call and Node's own counters. */
export function readAppProcesses(now = Date.now()): AppProcessMemory[] {
  const out: AppProcessMemory[] = []
  for (const metric of app.getAppMetrics()) {
    const kind = KINDS[metric.type] ?? 'other'
    const entry: AppProcessMemory = { kind, rss: kb(metric.memory.workingSetSize) ?? 0 }
    const privateMb = kb(metric.memory.privateBytes)
    if (privateMb !== undefined) entry.private = privateMb
    if (kind === 'main') {
      const usage = process.memoryUsage()
      entry.heapUsed = toMb(usage.heapUsed)
      entry.heapTotal = toMb(usage.heapTotal)
      entry.external = toMb(usage.external)
      entry.arrayBuffers = toMb(usage.arrayBuffers)
    } else if (kind === 'window') {
      const heap = windowHeaps.get(metric.pid)
      if (heap && now - heap.at < REPORT_EVERY_MS * 3) {
        entry.heapUsed = heap.heapUsed
        entry.heapTotal = heap.heapTotal
      }
    }
    out.push(entry)
  }
  // Main first, then windows, so the report reads in a steady order.
  const order: AppProcessKind[] = ['main', 'window', 'gpu', 'utility', 'other']
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function registerMemoryDiagnosticsIpc(registerHandler: RegisterHandler, guiMms: DaemonRequester): { stop: () => void } {
  // A window's preload sends its heap (KB, as Electron's process.getHeapStatistics gives it).
  const onHeap = (event: Electron.IpcMainEvent, raw: unknown): void => {
    const value = raw as { usedHeapSize?: unknown; totalHeapSize?: unknown } | null
    const used = finite(value?.usedHeapSize)
    const total = finite(value?.totalHeapSize)
    if (used === null || total === null) return
    let pid = 0
    try { pid = event.sender.getOSProcessId() } catch { return }
    windowHeaps.set(pid, { heapUsed: kb(used)!, heapTotal: kb(total)!, at: Date.now() })
  }
  ipcMain.removeAllListeners('diagnostics:windowHeap')
  ipcMain.on('diagnostics:windowHeap', onHeap)

  registerHandler('diagnostics:memoryStatus', async () => guiMms.request('diagnostics.memory.status', {}))
  registerHandler('diagnostics:memoryNoticeShown', async (_event, kind: BreachKind) => guiMms.request('diagnostics.memory.noticeShown', { kind }))
  // Opens the new-issue page with the numbers filled in. The person reviews and submits it there, or not.
  registerHandler('diagnostics:memoryReport', async () => {
    const issue = await guiMms.request<MemoryIssue>('diagnostics.memory.issue', {}, 30_000)
    const ok = await openExternalSafely((target) => shell.openExternal(target), issue.url, 'diagnostics:memoryReport')
    return { ok, url: issue.url }
  })

  let unavailable = 0
  const report = async (): Promise<void> => {
    // An older service has no monitor; stop asking after a few refusals.
    if (unavailable >= 3) return
    try {
      const now = Date.now()
      for (const [pid, heap] of windowHeaps) if (now - heap.at > REPORT_EVERY_MS * 5) windowHeaps.delete(pid)
      await guiMms.request('diagnostics.memory.appReport', { processes: readAppProcesses(now) })
      unavailable = 0
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'method_not_available' || code === 'unavailable' || code === 'method_not_found') unavailable += 1
    }
  }
  const first = setTimeout(() => void report(), 15_000)
  const timer = setInterval(() => void report(), REPORT_EVERY_MS)
  first.unref?.()
  timer.unref?.()
  return {
    stop: () => {
      clearTimeout(first)
      clearInterval(timer)
      ipcMain.removeListener('diagnostics:windowHeap', onHeap)
    }
  }
}

/** Tests only. */
export function rememberWindowHeap(pid: number, heapUsed: number, heapTotal: number, at = Date.now()): void {
  windowHeaps.set(pid, { heapUsed, heapTotal, at })
}


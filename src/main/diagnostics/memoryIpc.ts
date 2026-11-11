/**
 * The desktop app's part of the memory monitor. About once a minute main reads every Chromium process
 * (`app.getAppMetrics`: main, each window's renderer, applet views, the in-app browser, GPU, network and other
 * utility processes) with its role, private memory, working set and CPU, adds its own Node heap and each window's JS
 * heap and image cache (which the window's preload sends), and a few hints at what the GPU process holds: window
 * sizes and scale, acrylic, WebGL contexts and canvases. It reports the numbers to the service, which logs them and
 * checks the limits. No GPU work is done to read any of it. The window asks main for the status and the prefilled
 * issue; main opens the issue in the browser.
 */
import { app, BrowserWindow, ipcMain, screen, shell, webContents } from 'electron'
import { toMb, type AppHints, type AppProcessMemory, type BreachKind, type MemoryIssue } from '../../shared/diagnostics/memory'
import { openExternalSafely } from '../safeExternalUrl'
import { appHints, appProcessRows, type ContentsLike, type WindowGeometry, type WindowReport } from './appProcesses'
import { webContentsRole } from './webContentsRoles'

type RegisterHandler = (channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown) => void

interface DaemonRequester {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
}

const REPORT_EVERY_MS = 60_000
const FRESH_MS = REPORT_EVERY_MS * 3

/** Each window's renderer report, by its OS process id. */
const windowReports = new Map<number, WindowReport>()

/** Every live web contents and what it is, by the process it runs in. */
function liveContents(): ContentsLike[] {
  const out: ContentsLike[] = []
  const devtools = new Set<number>()
  for (const contents of webContents.getAllWebContents()) {
    const tools = contents.devToolsWebContents
    if (tools && !tools.isDestroyed()) devtools.add(tools.id)
  }
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue
    let pid = 0
    try { pid = contents.getOSProcessId() } catch { continue }
    if (!pid) continue
    const marked = webContentsRole(contents.id)
    const type = contents.getType()
    const role: ContentsLike['role'] = devtools.has(contents.id) ? 'devtools'
      : marked ?? (type === 'window' ? 'window' : type === 'webview' ? 'browser' : 'renderer')
    out.push({ pid, role })
  }
  return out
}

function windowGeometry(): WindowGeometry[] {
  return BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).map((win) => {
    const bounds = win.getContentBounds()
    let scale = 1
    try { scale = screen.getDisplayMatching(bounds).scaleFactor } catch { /* no display yet */ }
    return { w: bounds.width, h: bounds.height, scale, visible: win.isVisible() && !win.isMinimized() }
  })
}

type ElectronProcess = NodeJS.Process & { getProcessMemoryInfo?: () => Promise<{ private: number }> }

/** Every app process's memory and the GPU hints now. Cheap: one Chromium call, Node's own counters, window bounds. */
export async function readAppMemory(acrylic: boolean, now = Date.now()): Promise<{ processes: AppProcessMemory[]; hints: AppHints }> {
  const usage = process.memoryUsage()
  let privateMb: number | undefined
  if (process.platform !== 'win32') {
    // Chromium gives private bytes per process on Windows only; main can read its own elsewhere.
    try { privateMb = Math.round((((await (process as ElectronProcess).getProcessMemoryInfo?.())?.private ?? 0) / 1024) * 10) / 10 || undefined } catch { /* not ready */ }
  }
  for (const [pid, report] of windowReports) if (now - report.at > FRESH_MS * 2) windowReports.delete(pid)
  const contents = liveContents()
  const processes = appProcessRows(
    app.getAppMetrics(),
    contents,
    windowReports,
    { heapUsed: toMb(usage.heapUsed), heapTotal: toMb(usage.heapTotal), external: toMb(usage.external), arrayBuffers: toMb(usage.arrayBuffers), ...(privateMb ? { privateMb } : {}) },
    now,
    FRESH_MS
  )
  const hints = appHints({ windows: windowGeometry(), acrylic, contents, reports: windowReports.values(), now, freshMs: FRESH_MS })
  return { processes, hints }
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function registerMemoryDiagnosticsIpc(registerHandler: RegisterHandler, guiMms: DaemonRequester, options: { acrylic: () => boolean }): { stop: () => void } {
  // A window's preload sends its renderer's heap, private memory and image cache (KB), and its canvases.
  const onWindowMemory = (event: Electron.IpcMainEvent, raw: unknown): void => {
    const value = raw as Record<string, unknown> | null
    const usedHeapKb = finite(value?.usedHeapKb)
    const totalHeapKb = finite(value?.totalHeapKb)
    if (usedHeapKb === undefined || totalHeapKb === undefined) return
    let pid = 0
    try { pid = event.sender.getOSProcessId() } catch { return }
    windowReports.set(pid, {
      usedHeapKb,
      totalHeapKb,
      privateKb: finite(value?.privateKb),
      imagesKb: finite(value?.imagesKb),
      canvases: finite(value?.canvases),
      webglContexts: finite(value?.webglContexts),
      at: Date.now()
    })
  }
  ipcMain.removeAllListeners('diagnostics:windowMemory')
  ipcMain.on('diagnostics:windowMemory', onWindowMemory)

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
      await guiMms.request('diagnostics.memory.appReport', await readAppMemory(options.acrylic()))
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
      ipcMain.removeListener('diagnostics:windowMemory', onWindowMemory)
    }
  }
}

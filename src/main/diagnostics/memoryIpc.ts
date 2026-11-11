/**
 * The desktop app's part of the profiler's memory monitor, which runs only while the profiler is on (Settings → Labs).
 * Then, about once a minute and when a profiler tool asks, main reads every Chromium process
 * (`app.getAppMetrics`: main, each window's renderer, applet views, the in-app browser, GPU, network and other
 * utility processes) with its role, private memory, working set and CPU, adds its own Node heap and each window's JS
 * heap and image cache (which each window's preload sends when asked), and a few hints at what the GPU process holds: window
 * sizes and scale, acrylic, WebGL contexts and canvases. It reports the numbers to the service, which logs them and
 * checks the limits. No GPU work is done to read any of it. The window asks main for the status and the prefilled
 * issue; main opens the issue in the browser.
 */
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, clipboard, ipcMain, screen, shell, webContents } from 'electron'
import { toMb, type AppHints, type AppProcessMemory, type BreachKind, type MemoryIssue } from '../../shared/diagnostics/memory'
import type { WindowCounters } from '../../shared/diagnostics/profiler'
import { appHints, appProcessRows, type ContentsLike, type WindowGeometry, type WindowReport } from './appProcesses'
import { openMemoryIssue } from './memoryReport'
import { markedViews, webContentsRole } from './webContentsRoles'

type RegisterHandler = (channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown) => void

interface DaemonRequester {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  on?(event: string, listener: (...args: any[]) => void): unknown
  off?(event: string, listener: (...args: any[]) => void): unknown
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

/** Each window's counters from its latest answer that had them, by web contents id. */
const windowCounters = new Map<number, { at: number; counters: Omit<WindowCounters, 'w' | 'h' | 'scale' | 'visible'> }>()
/** Collect requests waiting for windows to answer, by id. */
const waitingWindows = new Map<string, { left: Set<number>; done: () => void }>()

function windowCountersOf(raw: unknown): Omit<WindowCounters, 'w' | 'h' | 'scale' | 'visible'> | undefined {
  const value = raw as Record<string, unknown> | null
  if (!value || typeof value !== 'object') return undefined
  const n = (key: string) => finite(value[key]) ?? 0
  const caches: WindowCounters['caches'] = {}
  const rawCaches = value.caches as Record<string, unknown> | undefined
  if (rawCaches && typeof rawCaches === 'object') {
    for (const [name, cache] of Object.entries(rawCaches).slice(0, 16)) {
      const entries = finite((cache as { entries?: unknown } | null)?.entries)
      const limit = finite((cache as { limit?: unknown } | null)?.limit)
      if (/^[a-z][A-Za-z0-9]{0,39}$/.test(name) && entries !== undefined) caches[name] = { entries: Math.round(entries), ...(limit !== undefined ? { limit: Math.round(limit) } : {}) }
    }
  }
  const imageCacheMb = finite(value.imageCacheMb)
  return {
    domNodes: Math.round(n('domNodes')),
    mountedTurns: Math.round(n('mountedTurns')),
    mountedRows: Math.round(n('mountedRows')),
    images: Math.round(n('images')),
    imagesDecodedMbEstimated: n('imagesDecodedMbEstimated'),
    ...(imageCacheMb !== undefined ? { imageCacheMb } : {}),
    canvases: Math.round(n('canvases')),
    canvasMbEstimated: n('canvasMbEstimated'),
    webglContexts: Math.round(n('webglContexts')),
    browserTabs: Math.round(n('browserTabs')),
    jsHeapUsedMb: n('jsHeapUsedMb'),
    jsHeapTotalMb: n('jsHeapTotalMb'),
    caches
  }
}

/**
 * A window's preload answers a collect request: its renderer's heap, private memory and image cache (KB), and its
 * canvases; with `counters` when the request asked for the window's detail.
 */
function onWindowMemory(event: Electron.IpcMainEvent, raw: unknown): void {
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
  const counters = windowCountersOf(value?.counters)
  if (counters) windowCounters.set(event.sender.id, { at: Date.now(), counters })
  const requestId = typeof value?.requestId === 'string' ? value.requestId : undefined
  const waiting = requestId ? waitingWindows.get(requestId) : undefined
  if (waiting) {
    waiting.left.delete(event.sender.id)
    if (!waiting.left.size) waiting.done()
  }
}

/** How long main waits for the windows to answer a collect request. */
const WINDOW_ANSWER_MS = 800

/**
 * Asks every window for its memory now (with its counters when `detail`), and waits for the answers. Nothing is read
 * in a window until it is asked: no timer runs there.
 */
async function collectWindows(detail: boolean): Promise<WindowCounters[]> {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && !win.webContents.isDestroyed())
  if (!windows.length) return []
  const requestId = randomUUID()
  const asked = Date.now()
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, WINDOW_ANSWER_MS)
    function finish(): void {
      clearTimeout(timer)
      waitingWindows.delete(requestId)
      resolve()
    }
    waitingWindows.set(requestId, { left: new Set(windows.map((win) => win.webContents.id)), done: finish })
    for (const win of windows) {
      try { win.webContents.send('diagnostics:collectMemory', { requestId, detail }) } catch { /* closing */ }
    }
  })
  if (!detail) return []
  const out: WindowCounters[] = []
  for (const win of windows) {
    if (win.isDestroyed()) continue
    const answer = windowCounters.get(win.webContents.id)
    if (!answer || answer.at < asked) continue
    const bounds = win.getContentBounds()
    let scale = 1
    try { scale = screen.getDisplayMatching(bounds).scaleFactor } catch { /* no display yet */ }
    out.push({ w: bounds.width, h: bounds.height, scale, visible: win.isVisible() && !win.isMinimized(), ...answer.counters })
  }
  return out
}

/**
 * Registers the window's handlers and reports the app's processes to the service while the profiler is on: once a
 * minute, and whenever a profiler tool asks (`diagnostics.memory.collect`). Off, nothing is read or sent.
 */
export function registerMemoryDiagnosticsIpc(registerHandler: RegisterHandler, guiMms: DaemonRequester, options: { acrylic: () => boolean }): { stop: () => void } {
  ipcMain.removeListener?.('diagnostics:windowMemory', onWindowMemory)
  ipcMain.on('diagnostics:windowMemory', onWindowMemory)

  registerHandler('diagnostics:memoryStatus', async () => guiMms.request('diagnostics.memory.status', {}))
  registerHandler('diagnostics:memoryNoticeShown', async (_event, kind: BreachKind) => guiMms.request('diagnostics.memory.noticeShown', { kind }))
  // Opens the new-issue page with the numbers filled in; the person reviews and submits it there, or not. A report
  // too long for a link goes on the clipboard and the link asks to paste it; so does one the browser would not open.
  registerHandler('diagnostics:memoryReport', async () => openMemoryIssue(
    await guiMms.request<MemoryIssue>('diagnostics.memory.issue', {}, 30_000),
    { open: (target) => shell.openExternal(target), copy: (text) => clipboard.writeText(text) }
  ))
  // A heap snapshot a person asked for in Settings → Labs, after the warning.
  registerHandler('diagnostics:heapSnapshot', async () => guiMms.request('diagnostics.memory.heapSnapshot', { confirm: true }, 120_000))

  const report = async (request?: { requestId?: string; windows?: boolean }): Promise<void> => {
    try {
      const windows = await collectWindows(request?.windows === true)
      const { processes, hints } = await readAppMemory(options.acrylic())
      await guiMms.request('diagnostics.memory.appReport', {
        processes,
        hints,
        ...(request?.requestId ? { requestId: request.requestId } : {}),
        ...(request?.windows ? { windows, views: markedViews() } : {})
      })
    } catch (error) {
      // The profiler was turned off, or an older service has none: stop until it says it is on.
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'method_not_available' || code === 'unavailable' || code === 'method_not_found') setEnabled(false)
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null
  let first: ReturnType<typeof setTimeout> | null = null
  const setEnabled = (on: boolean): void => {
    if (on && !timer) {
      first = setTimeout(() => void report(), 5_000)
      timer = setInterval(() => void report(), REPORT_EVERY_MS)
      first.unref?.()
      timer.unref?.()
    } else if (!on && timer) {
      if (first) clearTimeout(first)
      clearInterval(timer)
      first = null
      timer = null
    }
  }
  const readState = (): void => {
    void guiMms.request<{ enabled?: boolean }>('diagnostics.memory.state', {})
      .then((state) => setEnabled(state?.enabled === true), () => setEnabled(false))
  }
  const onEvent = (event: { type?: string; data?: unknown; profileId?: string } | null): void => {
    if (!event || event.profileId) return
    if (event.type === 'diagnostics.memory.state') setEnabled((event.data as { enabled?: unknown } | null)?.enabled === true)
    else if (event.type === 'diagnostics.memory.collect') {
      const data = event.data as { requestId?: unknown; windows?: unknown } | null
      if (typeof data?.requestId === 'string') void report({ requestId: data.requestId, windows: data.windows === true })
    }
  }
  guiMms.on?.('event', onEvent)
  // After a reconnect the service may be another one: ask again.
  guiMms.on?.('resnapshot', readState)
  readState()
  return {
    stop: () => {
      setEnabled(false)
      guiMms.off?.('event', onEvent)
      guiMms.off?.('resnapshot', readState)
      ipcMain.removeListener?.('diagnostics:windowMemory', onWindowMemory)
    }
  }
}

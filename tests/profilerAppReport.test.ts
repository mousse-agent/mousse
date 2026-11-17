import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const sent: Array<{ channel: string; payload: unknown }> = []
  const windowContents = { id: 7, isDestroyed: () => false, send: (channel: string, payload: unknown) => sent.push({ channel, payload }), getOSProcessId: () => 4242, getType: () => 'window' }
  const win = { isDestroyed: () => false, webContents: windowContents, getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), isVisible: () => true, isMinimized: () => false }
  /** Live web contents besides the window's: in-app browser tabs, by the process each runs in. */
  const contents: unknown[] = []
  return {
    listeners,
    sent,
    windowContents,
    contents,
    getAppMetrics: vi.fn(() => [{ pid: 1, type: 'Browser', memory: { workingSetSize: 200 * 1024, privateBytes: 150 * 1024 }, cpu: { percentCPUUsage: 1 } }]),
    readFootprintsMb: vi.fn(async (_pids: number[]): Promise<Map<number, number> | null> => null),
    module: {
      app: { getAppMetrics: () => electron.getAppMetrics() },
      BrowserWindow: { getAllWindows: () => [win], fromWebContents: () => null },
      clipboard: { writeText: vi.fn() },
      shell: { openExternal: vi.fn() },
      screen: { getDisplayMatching: () => ({ scaleFactor: 1.5 }) },
      webContents: { getAllWebContents: () => contents },
      ipcMain: {
        on: (channel: string, listener: (...args: unknown[]) => void) => listeners.set(channel, listener),
        removeListener: (channel: string) => listeners.delete(channel)
      }
    }
  }
})
vi.mock('electron', () => electron.module)
// `top`, which reads footprints on macOS, is scripted: its output is tested in appProcessMemory.test.ts.
vi.mock('../src/mms/diagnostics/processMemory', () => ({ readFootprintsMb: (pids: number[]) => electron.readFootprintsMb(pids) }))

import { registerMemoryDiagnosticsIpc } from '../src/main/diagnostics/memoryIpc'

class FakeService extends EventEmitter {
  enabled = false
  requests: Array<{ method: string; params: unknown }> = []
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params })
    if (method === 'diagnostics.memory.state') return { enabled: this.enabled } as T
    if (method === 'diagnostics.memory.appReport' && !this.enabled) throw Object.assign(new Error('off'), { code: 'unavailable' })
    return { ok: true } as T
  }
  reports() {
    return this.requests.filter((r) => r.method === 'diagnostics.memory.appReport')
  }
}

/** The window's preload answers main's collect request. */
function answerCollects(): void {
  electron.sent.splice(0).forEach(({ channel, payload }) => {
    if (channel !== 'diagnostics:collectMemory') return
    const request = payload as { requestId: string; detail: boolean }
    electron.listeners.get('diagnostics:windowMemory')!({ sender: electron.windowContents }, {
      requestId: request.requestId,
      usedHeapKb: 50_000,
      totalHeapKb: 80_000,
      canvases: 1,
      webglContexts: 0,
      ...(request.detail ? { counters: { domNodes: 3000, mountedTurns: 4, mountedRows: 20, images: 1, imagesDecodedMbEstimated: 0.5, canvases: 1, canvasMbEstimated: 0.2, webglContexts: 0, browserTabs: 0, jsHeapUsedMb: 48.8, jsHeapTotalMb: 78.1, caches: { codeHighlight: { entries: 3, limit: 100 }, markdown: { entries: 9, kbEstimated: 1_536.4, limitKb: 10_240, text: '# Plan' }, 'C:/Users/alice': { entries: 1 } } } } : {})
    })
  })
}

const realPlatform = process.platform

afterEach(() => {
  vi.useRealTimers()
  electron.getAppMetrics.mockClear()
  electron.readFootprintsMb.mockReset()
  electron.readFootprintsMb.mockResolvedValue(null)
  electron.sent.splice(0)
  electron.contents.splice(0)
  Object.defineProperty(process, 'platform', { value: realPlatform })
})

/** An in-app browser tab: a webview in window 7 (or another window), in process `pid`. */
function browserTab(id: number, pid: number, hostId = 7) {
  return { id, isDestroyed: () => false, getOSProcessId: () => pid, getType: () => 'webview', hostWebContents: { id: hostId, isDestroyed: () => false } }
}

describe("the desktop app's process report", () => {
  it('reads and sends nothing while the profiler is off, and reports while it is on', async () => {
    vi.useFakeTimers()
    const service = new FakeService()
    const handle = registerMemoryDiagnosticsIpc(() => {}, service, { acrylic: () => false })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(service.reports()).toEqual([])
    expect(electron.getAppMetrics).not.toHaveBeenCalled()
    expect(electron.sent).toEqual([])

    service.enabled = true
    service.emit('event', { type: 'diagnostics.memory.state', data: { enabled: true } })
    await vi.advanceTimersByTimeAsync(5_000)
    answerCollects()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(service.reports()).toHaveLength(1)
    expect(service.reports()[0].params).toMatchObject({ processes: [{ kind: 'main', role: 'main', private: 150 }] })

    service.enabled = false
    service.emit('event', { type: 'diagnostics.memory.state', data: { enabled: false } })
    electron.getAppMetrics.mockClear()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(service.reports()).toHaveLength(1)
    expect(electron.getAppMetrics).not.toHaveBeenCalled()
    handle.stop()
  })

  it("answers a profiler tool's collect with the request id and each window's counters", async () => {
    vi.useFakeTimers()
    const service = new FakeService()
    service.enabled = true
    const handle = registerMemoryDiagnosticsIpc(() => {}, service, { acrylic: () => true })
    await vi.advanceTimersByTimeAsync(0)
    service.emit('event', { type: 'diagnostics.memory.collect', data: { requestId: 'req-1', windows: true } })
    await vi.advanceTimersByTimeAsync(0)
    expect(electron.sent).toEqual([{ channel: 'diagnostics:collectMemory', payload: { requestId: expect.any(String), detail: true } }])
    answerCollects()
    await vi.advanceTimersByTimeAsync(0)
    const report = service.reports().at(-1)!.params as { requestId: string; windows: Array<Record<string, unknown>>; hints: { acrylic: boolean } }
    expect(report.requestId).toBe('req-1')
    expect(report.hints.acrylic).toBe(true)
    // A cache whose name is not a fixed name is dropped; a cache keeps only its numbers.
    expect(report.windows).toEqual([{ w: 1200, h: 800, scale: 1.5, visible: true, domNodes: 3000, mountedTurns: 4, mountedRows: 20, images: 1, imagesDecodedMbEstimated: 0.5, canvases: 1, canvasMbEstimated: 0.2, webglContexts: 0, browserTabs: 0, jsHeapUsedMb: 48.8, jsHeapTotalMb: 78.1, caches: { codeHighlight: { entries: 3, limit: 100 }, markdown: { entries: 9, kbEstimated: 1_536, limitKb: 10_240 } } }])
    handle.stop()
  })

  it("counts a window's browser tabs by the processes that hold them", async () => {
    vi.useFakeTimers()
    // Three tabs in two processes in this window, one in another window.
    electron.contents.push(browserTab(20, 5000), browserTab(21, 5000), browserTab(22, 5001), browserTab(23, 5002, 9))
    const service = new FakeService()
    service.enabled = true
    const handle = registerMemoryDiagnosticsIpc(() => {}, service, { acrylic: () => false })
    await vi.advanceTimersByTimeAsync(0)
    service.emit('event', { type: 'diagnostics.memory.collect', data: { requestId: 'req-2', windows: true } })
    await vi.advanceTimersByTimeAsync(0)
    answerCollects()
    await vi.advanceTimersByTimeAsync(0)
    const report = service.reports().at(-1)!.params as { windows: Array<{ browserTabs: number }> }
    expect(report.windows.map((w) => w.browserTabs)).toEqual([2])
    handle.stop()
  })

  it("on macOS reports each process's footprint, read at most once a minute, and the window's Blink memory", async () => {
    vi.useFakeTimers()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    electron.contents.push(electron.windowContents)
    electron.getAppMetrics.mockReturnValue([
      { pid: 1, type: 'Browser', memory: { workingSetSize: 200 * 1024 }, cpu: { percentCPUUsage: 1 } },
      { pid: 2, type: 'GPU', memory: { workingSetSize: 110 * 1024 }, cpu: { percentCPUUsage: 3 } },
      { pid: 4242, type: 'Tab', memory: { workingSetSize: 900 * 1024 }, cpu: { percentCPUUsage: 5 } }
    ])
    electron.readFootprintsMb.mockResolvedValue(new Map([[1, 180], [2, 340], [4242, 2_155]]))
    const service = new FakeService()
    service.enabled = true
    const handle = registerMemoryDiagnosticsIpc(() => {}, service, { acrylic: () => false })
    await vi.advanceTimersByTimeAsync(5_000)
    electron.listeners.get('diagnostics:windowMemory')!({ sender: electron.windowContents }, {
      requestId: (electron.sent.at(-1)!.payload as { requestId: string }).requestId,
      usedHeapKb: 140 * 1024,
      totalHeapKb: 180 * 1024,
      blinkUsedKb: 45 * 1024,
      blinkTotalKb: 1_584 * 1024,
      resourcesKb: 30 * 1024
    })
    await vi.advanceTimersByTimeAsync(1_000)
    const first = service.reports().at(-1)!.params as { processes: Array<Record<string, unknown>>; hints: { footprintMs?: number } }
    expect(first.processes.map((p) => [p.role, p.private, p.rss])).toEqual([['main', 180, 200], ['window', 2_155, 900], ['gpu', 340, 110]])
    expect(first.processes[1]).toMatchObject({ heapUsed: 140, heapTotal: 180, blinkUsed: 45, blinkTotal: 1_584, resourcesMb: 30 })
    expect(first.hints.footprintMs).toEqual(expect.any(Number))
    expect(electron.readFootprintsMb).toHaveBeenCalledTimes(1)
    expect(electron.readFootprintsMb).toHaveBeenCalledWith([1, 2, 4242])

    // A profiler tool asking within the minute gets the same footprints without another read.
    service.emit('event', { type: 'diagnostics.memory.collect', data: { requestId: 'req-3', windows: false } })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(service.reports()).toHaveLength(2)
    expect(electron.readFootprintsMb).toHaveBeenCalledTimes(1)
    // The next minute's report reads them again.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(electron.readFootprintsMb).toHaveBeenCalledTimes(2)
    handle.stop()
    electron.getAppMetrics.mockReset()
    electron.getAppMetrics.mockReturnValue([{ pid: 1, type: 'Browser', memory: { workingSetSize: 200 * 1024, privateBytes: 150 * 1024 }, cpu: { percentCPUUsage: 1 } }])
  })

  it('reads no footprints off macOS: Windows keeps private bytes', async () => {
    vi.useFakeTimers()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const service = new FakeService()
    service.enabled = true
    const handle = registerMemoryDiagnosticsIpc(() => {}, service, { acrylic: () => false })
    await vi.advanceTimersByTimeAsync(5_000)
    answerCollects()
    await vi.advanceTimersByTimeAsync(1_000)
    const report = service.reports().at(-1)!.params as { processes: Array<Record<string, unknown>>; hints: Record<string, unknown> }
    expect(report.processes[0]).toMatchObject({ role: 'main', private: 150 })
    expect('footprintMs' in report.hints).toBe(false)
    expect(electron.readFootprintsMb).not.toHaveBeenCalled()
    handle.stop()
  })
})

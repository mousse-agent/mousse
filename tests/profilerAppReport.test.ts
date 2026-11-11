import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const sent: Array<{ channel: string; payload: unknown }> = []
  const windowContents = { id: 7, isDestroyed: () => false, send: (channel: string, payload: unknown) => sent.push({ channel, payload }), getOSProcessId: () => 4242 }
  const win = { isDestroyed: () => false, webContents: windowContents, getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), isVisible: () => true, isMinimized: () => false }
  return {
    listeners,
    sent,
    windowContents,
    getAppMetrics: vi.fn(() => [{ pid: 1, type: 'Browser', memory: { workingSetSize: 200 * 1024, privateBytes: 150 * 1024 }, cpu: { percentCPUUsage: 1 } }]),
    module: {
      app: { getAppMetrics: () => electron.getAppMetrics() },
      BrowserWindow: { getAllWindows: () => [win] },
      clipboard: { writeText: vi.fn() },
      shell: { openExternal: vi.fn() },
      screen: { getDisplayMatching: () => ({ scaleFactor: 1.5 }) },
      webContents: { getAllWebContents: () => [] },
      ipcMain: {
        on: (channel: string, listener: (...args: unknown[]) => void) => listeners.set(channel, listener),
        removeListener: (channel: string) => listeners.delete(channel)
      }
    }
  }
})
vi.mock('electron', () => electron.module)

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

afterEach(() => {
  vi.useRealTimers()
  electron.getAppMetrics.mockClear()
  electron.sent.splice(0)
})

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
})

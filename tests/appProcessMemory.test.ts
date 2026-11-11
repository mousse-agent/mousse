import { describe, expect, it } from 'vitest'
import { appHints, appProcessRows, sendAppReport, utilityRole, type MetricLike, type WindowReport } from '../src/main/diagnostics/appProcesses'
import { appProcessLabels, memoryTable, type MemorySample } from '../src/shared/diagnostics/memory'
import { liveWebGlContexts, noteWebGlContext } from '../src/renderer/lib/webglCount'

const NOW = 1_000_000
const KB = 1024
const MAIN = { heapUsed: 30, heapTotal: 40, external: 3, arrayBuffers: 1 }

/** An idle nightly as seen in Task Manager, private MB per process (Windows reports private bytes). */
const METRICS: MetricLike[] = [
  { pid: 10, type: 'Browser', cpu: { percentCPUUsage: 0.4 }, memory: { workingSetSize: 210 * KB, privateBytes: 149 * KB } },
  { pid: 11, type: 'GPU', cpu: { percentCPUUsage: 1.2 }, memory: { workingSetSize: 420 * KB, privateBytes: 334 * KB } },
  { pid: 12, type: 'Tab', memory: { workingSetSize: 300 * KB, privateBytes: 221 * KB } },
  { pid: 13, type: 'Utility', serviceName: 'network.mojom.NetworkService', memory: { workingSetSize: 30 * KB, privateBytes: 13 * KB } },
  { pid: 14, type: 'Tab', memory: { workingSetSize: 90 * KB, privateBytes: 60 * KB } },
  { pid: 15, type: 'Tab', memory: { workingSetSize: 50 * KB } },
  { pid: 16, type: 'Zygote', memory: { workingSetSize: 5 * KB } }
]

describe('app process rows', () => {
  it('labels every Chromium process by its role, with private memory, working set and CPU', () => {
    const reports = new Map<number, WindowReport>([[12, { usedHeapKb: 60 * KB, totalHeapKb: 90 * KB, at: NOW - 1_000 }]])
    const rows = appProcessRows(METRICS, [{ pid: 12, role: 'window' }, { pid: 12, role: 'devtools' }, { pid: 14, role: 'applet' }], reports, MAIN, NOW, 180_000)
    expect(rows.map((row) => [row.kind, row.role, row.private, row.rss])).toEqual([
      ['main', 'main', 149, 210],
      ['renderer', 'window', 221, 300],
      ['renderer', 'applet', 60, 90],
      ['renderer', 'renderer', undefined, 50],
      ['gpu', 'gpu', 334, 420],
      ['utility', 'network', 13, 30],
      ['other', 'other', undefined, 5]
    ])
    expect(rows[0]).toMatchObject({ heapUsed: 30, heapTotal: 40, cpu: 0.4 })
    expect(rows[1]).toMatchObject({ heapUsed: 60, heapTotal: 90 })
    expect(rows[4].cpu).toBe(1.2)
    expect(appProcessLabels(rows)).toEqual(['Main', 'Window', 'Applet view', 'Renderer', 'GPU', 'Network', 'Other'])
  })

  it('uses the private memory a window reports where Chromium gives none (macOS, Linux), and drops a stale report', () => {
    const metrics: MetricLike[] = [{ pid: 12, type: 'Tab', memory: { workingSetSize: 300 * KB } }]
    const fresh = appProcessRows(metrics, [{ pid: 12, role: 'window' }], new Map([[12, { usedHeapKb: 1, totalHeapKb: 2, privateKb: 200 * KB, at: NOW }]]), MAIN, NOW, 180_000)
    expect(fresh[0].private).toBe(200)
    const stale = appProcessRows(metrics, [{ pid: 12, role: 'window' }], new Map([[12, { usedHeapKb: 1, totalHeapKb: 2, privateKb: 200 * KB, at: NOW - 600_000 }]]), MAIN, NOW, 180_000)
    expect(stale[0].private).toBeUndefined()
    expect(stale[0].heapUsed).toBeUndefined()
  })

  it('names utility processes by their service', () => {
    expect(utilityRole('network.mojom.NetworkService')).toBe('network')
    expect(utilityRole('storage.mojom.StorageService')).toBe('storage')
    expect(utilityRole('audio.mojom.AudioService')).toBe('audio')
    expect(utilityRole('node.mojom.NodeService')).toBe('node-utility')
    expect(utilityRole(undefined)).toBe('utility')
  })
})

describe('GPU hints', () => {
  it('adds up what the shown windows draw, the views, WebGL contexts, canvases, images and chat caches', () => {
    const hints = appHints({
      windows: [{ w: 1600, h: 1000, scale: 1.5, visible: true }, { w: 800, h: 600, scale: 1, visible: false }],
      acrylic: true,
      contents: [{ pid: 1, role: 'window' }, { pid: 2, role: 'applet' }, { pid: 2, role: 'applet' }, { pid: 3, role: 'devtools' }],
      reports: [
        { usedHeapKb: 1, totalHeapKb: 1, webglContexts: 2, canvases: 3, imagesKb: 2_048, markdownCacheKb: 1_536, codeCacheKb: 10_240, at: NOW },
        { usedHeapKb: 1, totalHeapKb: 1, webglContexts: 5, canvases: 5, imagesKb: 9_000, markdownCacheKb: 9_000, at: NOW - 600_000 }
      ],
      now: NOW,
      freshMs: 180_000
    })
    // 1600 x 1000 at 1.5x is 2400 x 1500 pixels at 4 bytes: 13.7 MB; the hidden window draws nothing.
    expect(hints).toEqual({
      windows: [{ w: 1600, h: 1000, scale: 1.5, visible: true }, { w: 800, h: 600, scale: 1, visible: false }],
      surfaceMb: 13.7,
      acrylic: true,
      views: { applet: 2, browser: 0, devtools: 1 },
      webglContexts: 2,
      canvases: 3,
      imagesMb: 2,
      markdownCacheMb: 1.5,
      codeCacheMb: 10
    })
  })

  it('counts live WebGL contexts until each is released once', () => {
    const before = liveWebGlContexts()
    const release = noteWebGlContext(undefined)
    expect(liveWebGlContexts()).toBe(before + 1)
    release()
    release()
    expect(liveWebGlContexts()).toBe(before)
  })
})

describe('per-process table', () => {
  it('lists the service, its workers and providers, then every app process and the app total', () => {
    const sample: MemorySample = {
      t: NOW, up: 60,
      service: { rss: 380, private: 306, heapUsed: 90, heapTotal: 120 },
      counts: { sqliteConnections: 3, workerThreads: 2, loadedThreads: 1, threadRuntimes: 1, threadCacheThreads: 1, threadCacheMb: 1, replayEvents: 9, ptys: 0, fileWatchers: 2, providerProcesses: 1, profiles: 1, activeTurns: 0 },
      workers: [4, 6],
      children: [{ kind: 'codex', mb: 80 }],
      app: appProcessRows(METRICS.slice(0, 4), [{ pid: 12, role: 'window' }], new Map(), MAIN, NOW, 180_000)
    }
    expect(memoryTable(sample).map((row) => [row.label, row.private ?? null, row.rss ?? null, row.group])).toEqual([
      ['Service', 306, 380, 'service'],
      ['Service workers (2)', null, null, 'service'],
      ['Provider: codex', null, 80, 'service'],
      ['Main', 149, 210, 'app'],
      ['Window', 221, 300, 'app'],
      ['GPU', 334, 420, 'app'],
      ['Network', 13, 30, 'app'],
      ['App total', 717, null, 'total']
    ])
  })
})

describe('sending the report to an older service', () => {
  const hints = { windows: [], surfaceMb: 0, acrylic: false, views: { applet: 0, browser: 0, devtools: 0 }, webglContexts: 0, canvases: 0, imagesMb: 1, markdownCacheMb: 2, codeCacheMb: 3 }
  const refusal = (code: string) => Object.assign(new Error('refused'), { code })

  it('sends again without the chat cache sizes when the service refuses a field it does not know', async () => {
    const sent: unknown[] = []
    await sendAppReport(async (report) => {
      sent.push(report)
      if (sent.length === 1) throw refusal('unknown_field')
    }, { processes: [], hints })
    expect(sent).toHaveLength(2)
    expect((sent[1] as { hints: Record<string, unknown> }).hints).toEqual({ windows: [], surfaceMb: 0, acrylic: false, views: { applet: 0, browser: 0, devtools: 0 }, webglContexts: 0, canvases: 0, imagesMb: 1 })
  })

  it('sends once when the service takes it, and passes any other refusal on', async () => {
    let calls = 0
    await sendAppReport(async () => { calls += 1 }, { processes: [], hints })
    expect(calls).toBe(1)
    await expect(sendAppReport(async () => { throw refusal('unavailable') }, { processes: [], hints })).rejects.toMatchObject({ code: 'unavailable' })
    // Without the new fields there is nothing to drop: the refusal stands.
    const { markdownCacheMb: _m, codeCacheMb: _c, ...older } = hints
    await expect(sendAppReport(async () => { throw refusal('unknown_field') }, { processes: [], hints: older })).rejects.toMatchObject({ code: 'unknown_field' })
  })
})

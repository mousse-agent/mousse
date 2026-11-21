import { describe, expect, it } from 'vitest'
import { appHints, appProcessRows, browserProcessesByHost, sendAppReport, utilityRole, type MetricLike, type WindowReport } from '../src/main/diagnostics/appProcesses'
import { parseTopMemory } from '../src/mms/diagnostics/processMemory'
import type { WindowCounters } from '../src/shared/diagnostics/profiler'
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
  it('adds up what the shown windows draw, the views, WebGL contexts, canvases and images', () => {
    const hints = appHints({
      windows: [{ w: 1600, h: 1000, scale: 1.5, visible: true }, { w: 800, h: 600, scale: 1, visible: false }],
      acrylic: true,
      contents: [{ pid: 1, role: 'window' }, { pid: 2, role: 'applet' }, { pid: 2, role: 'applet' }, { pid: 3, role: 'devtools' }],
      reports: [
        { usedHeapKb: 1, totalHeapKb: 1, webglContexts: 2, canvases: 3, imagesKb: 2_048, at: NOW },
        { usedHeapKb: 1, totalHeapKb: 1, webglContexts: 5, canvases: 5, imagesKb: 9_000, at: NOW - 600_000 }
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
      imagesMb: 2
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
      ['Main', 149, 210, 'app'],
      ['Window', 221, 300, 'app'],
      ['GPU', 334, 420, 'app'],
      ['Network', 13, 30, 'app'],
      // Resident size off macOS: in the working set column, and in the app's total.
      ['Agents and tools (1)', null, 80, 'app'],
      ['Desktop total', null, 960, 'total'],
      ['Workload total', null, 1420, 'total']
    ])
  })

  it("on macOS shows each process's footprint, a window split into its heaps, and the agents' footprints", () => {
    const metrics: MetricLike[] = [
      { pid: 10, type: 'Browser', memory: { workingSetSize: 180 * KB } },
      { pid: 11, type: 'GPU', memory: { workingSetSize: 110 * KB } },
      { pid: 12, type: 'Tab', memory: { workingSetSize: 900 * KB } }
    ]
    const report: WindowReport = { usedHeapKb: 140 * KB, totalHeapKb: 180 * KB, privateKb: 2_000 * KB, blinkUsedKb: 45 * KB, blinkTotalKb: 1_584 * KB, resourcesKb: 30 * KB, at: NOW }
    // The GPU process's footprint counts the GPU and IOSurface memory its working set misses.
    const footprints = new Map([[10, 120], [11, 340], [12, 2_155]])
    const app = appProcessRows(metrics, [{ pid: 12, role: 'window' }], new Map([[12, report]]), { ...MAIN, privateMb: 100 }, NOW, 180_000, footprints)
    expect(app.map((row) => [row.role, row.private, row.rss])).toEqual([['main', 120, 180], ['window', 2_155, 900], ['gpu', 340, 110]])
    expect(app[1]).toMatchObject({ heapUsed: 140, heapTotal: 180, blinkUsed: 45, blinkTotal: 1_584, resourcesMb: 30 })

    const sample: MemorySample = {
      t: NOW, up: 60,
      service: { rss: 200 },
      counts: { sqliteConnections: 0, workerThreads: 0, loadedThreads: 0, threadRuntimes: 0, threadCacheThreads: 0, threadCacheMb: 0, replayEvents: 0, ptys: 0, fileWatchers: 0, providerProcesses: 2, profiles: 1, activeTurns: 0 },
      children: [{ kind: 'claude', mb: 143, footprint: true }, { kind: 'mcp', mb: null, footprint: true }],
      app
    }
    const rows = memoryTable(sample)
    expect(rows.find((row) => row.label === 'Window')?.detail).toBe('JS heap 140 of 180 MB, Blink 45 of 1584 MB, resource cache 30 MB, rest 391 MB')
    expect(rows.find((row) => row.label === 'Agents and tools (2)')).toMatchObject({ private: 143, detail: expect.stringContaining('claude 143, mcp - MB') })
    expect(rows.find((row) => row.label === 'Desktop total')).toMatchObject({ rss: 1190 })
    expect(rows.find((row) => row.label === 'Measured workload subtotal')).toMatchObject({ rss: 1390 })
    expect(rows.filter((row) => row.group === 'total').every((row) => row.private === undefined)).toBe(true)
  })
})

describe('in-app browser processes by window', () => {
  it('counts the processes, not the tabs: tabs sharing one count once, each window its own', () => {
    expect(browserProcessesByHost([
      { pid: 50, role: 'browser', hostId: 7 },
      { pid: 50, role: 'browser', hostId: 7 },
      { pid: 51, role: 'browser', hostId: 7 },
      { pid: 52, role: 'browser', hostId: 9 },
      // A tab not shown in any window, and the window itself, are not counted.
      { pid: 53, role: 'browser' },
      { pid: 12, role: 'window' }
    ])).toEqual(new Map([[7, 2], [9, 1]]))
  })
})

describe("reading macOS footprints from top", () => {
  it('reads MEM in each unit and skips the header', () => {
    // Recorded from `top -l 1 -stats pid,mem -pid ...` on macOS 26.6.2; the last two rows (B, and the +/- that older
    // releases append) are hand-authored.
    const text = [
      'Processes: 453 total, 5 running, 448 sleeping, 2687 threads ',
      'PhysMem: 15G used (3214M wired, 7221M compressor), 111M unused.',
      '',
      'PID    MEM  ',
      '97874  2402M',
      '17884  7201K',
      '74120  947M ',
      '301    512B',
      '302    12M+'
    ].join('\n')
    expect(parseTopMemory(text)).toEqual(new Map([[97874, 2402], [17884, 7], [74120, 947], [301, 0], [302, 12]]))
  })
})

describe('sending the report to a service from before the window caches had sizes', () => {
  const counters = { domNodes: 1, mountedTurns: 1, mountedRows: 1, images: 0, imagesDecodedMbEstimated: 0, canvases: 0, canvasMbEstimated: 0, webglContexts: 0, browserTabs: 0, jsHeapUsedMb: 1, jsHeapTotalMb: 2 }
  const sized: WindowCounters = { ...counters, caches: { codeHighlight: { entries: 3, kbEstimated: 2_048, limitKb: 51_200 }, other: { entries: 2, limit: 10 } } }
  const refusal = (code: string) => Object.assign(new Error('refused'), { code })

  it('sends again without the cache sizes when the service refuses a field it does not know', async () => {
    const sent: unknown[] = []
    await sendAppReport(async (report) => {
      sent.push(report)
      if (sent.length === 1) throw refusal('unknown_field')
    }, { processes: [], windows: [sized] })
    expect(sent).toHaveLength(2)
    expect((sent[1] as { windows: WindowCounters[] }).windows).toEqual([{ ...counters, caches: { codeHighlight: { entries: 3 }, other: { entries: 2, limit: 10 } } }])
  })

  it("sends again without a window's Blink numbers and the footprint's read time when the service does not know them", async () => {
    const sent: Array<Record<string, unknown>> = []
    const window = { kind: 'renderer' as const, role: 'window' as const, rss: 900, private: 2_155, heapUsed: 140, blinkUsed: 45, blinkTotal: 1_584, resourcesMb: 30 }
    const hints = { windows: [], surfaceMb: 0, acrylic: false, views: { applet: 0, browser: 0, devtools: 0 }, webglContexts: 0, canvases: 0, footprintMs: 180 }
    await sendAppReport(async (report) => {
      sent.push(report)
      if (sent.length === 1) throw refusal('unknown_field')
    }, { processes: [window], hints })
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual({ processes: [{ kind: 'renderer', role: 'window', rss: 900, private: 2_155, heapUsed: 140 }], hints: { ...hints, footprintMs: undefined } })
    expect('footprintMs' in (sent[1].hints as object)).toBe(false)
  })

  it('sends once when the service takes it, and passes any other refusal on', async () => {
    let calls = 0
    await sendAppReport(async () => { calls += 1 }, { processes: [], windows: [sized] })
    expect(calls).toBe(1)
    await expect(sendAppReport(async () => { throw refusal('unavailable') }, { processes: [], windows: [sized] })).rejects.toMatchObject({ code: 'unavailable' })
    // Without the sizes there is nothing to drop: the refusal stands.
    await expect(sendAppReport(async () => { throw refusal('unknown_field') }, { processes: [], windows: [{ ...counters, caches: {} }] })).rejects.toMatchObject({ code: 'unknown_field' })
  })

  it('retries once only, and passes the refusal on when the report without sizes is refused too', async () => {
    let calls = 0
    const second = refusal('unknown_field')
    const failing = sendAppReport(async () => {
      calls += 1
      throw calls === 1 ? refusal('unknown_field') : second
    }, { processes: [], windows: [sized] })
    await expect(failing).rejects.toBe(second)
    expect(calls).toBe(2)
  })
})

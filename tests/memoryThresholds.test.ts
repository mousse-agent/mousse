import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MEMORY_THRESHOLDS,
  NOTICE_EVERY_MS,
  detectBreaches,
  memoryIssue,
  memoryIssueUrl,
  noticeDue,
  resolveMemoryThresholds,
  serviceGrowthMbPerHour,
  type MemorySample,
  type ServiceCounts
} from '../src/shared/diagnostics/memory'

const MIN = 60_000
const T0 = Date.UTC(2026, 10, 11, 8, 0, 0)

const COUNTS: ServiceCounts = {
  sqliteConnections: 3,
  workerThreads: 2,
  loadedThreads: 1,
  threadRuntimes: 2,
  threadCacheThreads: 1,
  threadCacheMb: 1.5,
  replayEvents: 40,
  ptys: 0,
  fileWatchers: 2,
  providerProcesses: 1,
  profiles: 1
}

/** One sample a minute from T0, service private memory from `mb(i)`, all in one service run. */
function series(minutes: number, mb: (i: number) => number, counts: (i: number) => Partial<ServiceCounts> = () => ({})): MemorySample[] {
  return Array.from({ length: minutes + 1 }, (_, i) => ({
    t: T0 + i * MIN,
    up: 600 + i * 60,
    service: { rss: mb(i) + 30, private: mb(i), heapUsed: 50, heapTotal: 70 },
    counts: { ...COUNTS, ...counts(i) }
  }))
}

const last = (history: MemorySample[]) => history[history.length - 1].t

describe('memory limits', () => {
  it('a sustained high service breaks the limit; a spike does not', () => {
    const high = series(20, () => 700)
    expect(detectBreaches(high, DEFAULT_MEMORY_THRESHOLDS, last(high)).map((b) => b.kind)).toEqual(['service-high'])

    // One minute at 2 GB inside an otherwise normal run.
    const spike = series(20, (i) => (i === 19 ? 2_000 : 180))
    expect(detectBreaches(spike, DEFAULT_MEMORY_THRESHOLDS, last(spike))).toEqual([])

    // High for 10 of the last 15 minutes is not sustained.
    const partly = series(20, (i) => (i >= 10 ? 700 : 180))
    expect(detectBreaches(partly, DEFAULT_MEMORY_THRESHOLDS, last(partly))).toEqual([])
  })

  it('needs history covering the whole window', () => {
    const short = series(5, () => 900)
    expect(detectBreaches(short, DEFAULT_MEMORY_THRESHOLDS, last(short))).toEqual([])
  })

  it('a restart in the window starts the count again', () => {
    const history = series(20, () => 700)
    // The service restarted 5 minutes ago: uptime starts again.
    for (const [i, sample] of history.entries()) if (i >= 15) sample.up = (i - 15) * 60
    expect(detectBreaches(history, DEFAULT_MEMORY_THRESHOLDS, last(history))).toEqual([])
  })

  it('marks it severe above the severe limit', () => {
    const history = series(20, () => 1_500)
    const [breach] = detectBreaches(history, DEFAULT_MEMORY_THRESHOLDS, last(history))
    expect(breach).toMatchObject({ kind: 'service-high', severe: true })
    expect(breach.summary).toBe('Service 1500 MB, above 500 MB for 15 min')
  })

  it('finds steady growth over the window, and not a flat run with spikes', () => {
    // 200 MB to 350 MB over 3 hours: 50 MB/h, above the 300 MB floor at the end.
    const leak = series(180, (i) => 200 + (150 * i) / 180)
    const growth = serviceGrowthMbPerHour(leak, DEFAULT_MEMORY_THRESHOLDS, last(leak))
    expect(growth).toBeGreaterThan(45)
    expect(growth).toBeLessThan(55)
    expect(detectBreaches(leak, DEFAULT_MEMORY_THRESHOLDS, last(leak)).map((b) => b.kind)).toEqual(['service-growth'])

    const flat = series(180, (i) => (i % 30 === 0 ? 900 : 320))
    expect(Math.abs(serviceGrowthMbPerHour(flat, DEFAULT_MEMORY_THRESHOLDS, last(flat))!)).toBeLessThan(5)
    expect(detectBreaches(flat, DEFAULT_MEMORY_THRESHOLDS, last(flat)).map((b) => b.kind)).not.toContain('service-growth')
  })

  it('reports no growth without enough history', () => {
    const hour = series(60, (i) => 200 + i * 5)
    expect(serviceGrowthMbPerHour(hour, DEFAULT_MEMORY_THRESHOLDS, last(hour))).toBeNull()
  })

  it('a count above its bound for three samples in a row breaks it; one sample does not', () => {
    const over = series(5, () => 150, (i) => (i >= 3 ? { loadedThreads: 90 } : {}))
    const [breach] = detectBreaches(over, DEFAULT_MEMORY_THRESHOLDS, last(over))
    expect(breach.kind).toBe('counts')
    expect(breach.summary).toContain('loaded threads 90 (bound 40)')

    const once = series(5, () => 150, (i) => (i === 5 ? { workerThreads: 30 } : {}))
    expect(detectBreaches(once, DEFAULT_MEMORY_THRESHOLDS, last(once))).toEqual([])
  })

  it('checks each kind of app process against its own limit, the GPU process included', () => {
    const app = (gpu: number, window: number) => [
      { kind: 'main' as const, role: 'main' as const, rss: 200, private: 150 },
      { kind: 'renderer' as const, role: 'window' as const, rss: window + 50, private: window },
      { kind: 'gpu' as const, role: 'gpu' as const, rss: gpu + 100, private: gpu },
      { kind: 'utility' as const, role: 'network' as const, rss: 40, private: 13 }
    ]
    // The idle nightly's numbers: within every limit.
    const idle = series(20, () => 306).map((sample) => ({ ...sample, app: app(334, 221) }))
    expect(detectBreaches(idle, DEFAULT_MEMORY_THRESHOLDS, last(idle))).toEqual([])

    const gpu = series(20, () => 150).map((sample) => ({ ...sample, app: app(700, 221) }))
    expect(detectBreaches(gpu, DEFAULT_MEMORY_THRESHOLDS, last(gpu))).toEqual([{ kind: 'gpu-high', summary: 'GPU process 700 MB, above 600 MB for 15 min' }])

    const window = series(20, () => 150).map((sample) => ({ ...sample, app: app(334, 900) }))
    expect(detectBreaches(window, DEFAULT_MEMORY_THRESHOLDS, last(window)).map((b) => b.kind)).toEqual(['renderer-high'])

    // A GPU spike for a minute is not a breach.
    const spike = series(20, () => 150).map((sample, i) => ({ ...sample, app: app(i === 20 ? 1_500 : 334, 221) }))
    expect(detectBreaches(spike, DEFAULT_MEMORY_THRESHOLDS, last(spike))).toEqual([])

    // All of them together above the app limit.
    const total = series(20, () => 150).map((sample) => ({ ...sample, app: app(580, 780).concat([{ kind: 'renderer' as const, role: 'applet' as const, rss: 800, private: 700 }]) }))
    expect(detectBreaches(total, DEFAULT_MEMORY_THRESHOLDS, last(total)).map((b) => b.kind)).toEqual(['app-high'])
  })

  it('takes overrides from the environment, and ignores anything not a limit', () => {
    const t = resolveMemoryThresholds('{"servicePrivateMb":50,"serviceSustainMinutes":0,"sampleIntervalMs":10,"counts":{"ptys":1},"processPrivateMb":{"gpu":100,"x":1},"evil":"x"}')
    expect(t.processPrivateMb.gpu).toBe(100)
    expect(t.processPrivateMb.renderer).toBe(DEFAULT_MEMORY_THRESHOLDS.processPrivateMb.renderer)
    expect(t.servicePrivateMb).toBe(50)
    expect(t.serviceSustainMinutes).toBe(0)
    expect(t.sampleIntervalMs).toBe(1_000)
    expect(t.counts.ptys).toBe(1)
    expect(t.counts.loadedThreads).toBe(DEFAULT_MEMORY_THRESHOLDS.counts.loadedThreads)
    expect(resolveMemoryThresholds('not json')).toEqual(DEFAULT_MEMORY_THRESHOLDS)
    // With no sustain time a single sample counts, which is how a person tests the notice.
    const one = series(0, () => 80)
    expect(detectBreaches(one, t, last(one)).map((b) => b.kind)).toEqual(['service-high'])
  })
})

describe('notice rate limit', () => {
  it('allows one notice of each kind a day', () => {
    const shown = { 'service-high': T0 }
    expect(noticeDue(shown, 'service-high', T0 + 60 * MIN)).toBe(false)
    expect(noticeDue(shown, 'service-growth', T0 + 60 * MIN)).toBe(true)
    expect(noticeDue(shown, 'service-high', T0 + NOTICE_EVERY_MS)).toBe(true)
    // A clock set back does not silence it for good.
    expect(noticeDue(shown, 'service-high', T0 - MIN)).toBe(true)
  })
})

describe('memory issue text', () => {
  it('holds numbers, the version and the OS, and nothing personal', () => {
    const history = series(20, () => 700)
    const sample = {
      ...history[history.length - 1],
      app: [
        { kind: 'main' as const, role: 'main' as const, rss: 210, private: 160, heapUsed: 40, heapTotal: 60, cpu: 1.5 },
        { kind: 'renderer' as const, role: 'window' as const, rss: 400, private: 350 },
        { kind: 'gpu' as const, role: 'gpu' as const, rss: 420, private: 334 }
      ],
      hints: { windows: [{ w: 1600, h: 1000, scale: 1.5, visible: true }], surfaceMb: 13.7, acrylic: true, views: { applet: 2, browser: 0, devtools: 0 }, webglContexts: 1, canvases: 3, imagesMb: 4.2 },
      children: [{ kind: 'claude', mb: 220 }, { kind: 'C:\\Users\\alice\\bin\\tool', mb: 10 }],
      workers: [12.5, 3]
    }
    history[history.length - 1] = sample
    const issue = memoryIssue({
      version: '0.1.3-nightly.20261111',
      os: { platform: 'win32', release: '10.0.26300', arch: 'x64', totalMemMb: 32_768 },
      sample,
      detail: {
        heapSpaces: { old_space: 80.2, code_space: 6.1, '/home/alice/x': 1 },
        heap: { totalHeapSize: 90, usedHeapSize: 70, heapSizeLimit: 4096, mallocedMemory: 2, externalMemory: 5, nativeContexts: 2, detachedContexts: 0 }
      },
      history,
      breaches: detectBreaches(history, DEFAULT_MEMORY_THRESHOLDS, sample.t),
      thresholds: DEFAULT_MEMORY_THRESHOLDS
    })
    expect(issue.title).toBe('Memory: Service 700 MB, above 500 MB for 15 min')
    expect(issue.body).toContain('**Version:** 0.1.3-nightly.20261111')
    expect(issue.body).toContain('| Service | 700 | 730 | - | 50 | 70 |')
    expect(issue.body).toContain('| Service workers (2) | - | - | - | 15.5 | - |')
    expect(issue.body).toContain('| Provider: claude | - | 220 |')
    expect(issue.body).toContain('| Provider: other | - | 10 |')
    expect(issue.body).toContain('| Main | 160 | 210 | 1.5 | 40 | 60 |')
    expect(issue.body).toContain('| Window | 350 | 400 | - | - | - |')
    expect(issue.body).toContain('| GPU | 334 | 420 |')
    expect(issue.body).toContain('| App total | 844 |')
    expect(issue.body).toContain('1 window (1600x1000 at 1.5x; 1 shown, 13.7 MB of pixels), acrylic on, WebGL contexts 1, canvases 3, applet views 2')
    expect(issue.body).not.toMatch(/alice|Users|home\//)
    expect(issue.body).not.toMatch(/[\\]/)
    expect(issue.url.startsWith('https://github.com/mousse-agent/mousse/issues/new?title=')).toBe(true)
    expect(decodeURIComponent(issue.url)).toContain('Service counts')
  })

  it('keeps the link under the length GitHub accepts', () => {
    const body = Array.from({ length: 2_000 }, (_, i) => `line ${i} with some numbers 123.4`).join('\n')
    const url = memoryIssueUrl('Memory report', body)
    expect(url.length).toBeLessThanOrEqual(7_500)
    expect(decodeURIComponent(url)).toContain('line 0 with')
  })
})

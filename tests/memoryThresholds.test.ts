import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MEMORY_THRESHOLDS,
  MAX_ISSUE_URL,
  NOTICE_EVERY_MS,
  PASTE_REPORT_TEXT,
  detectBreaches,
  isPackagedRuntime,
  memoryIssue,
  memoryIssueLink,
  noticeDue,
  resolveMemoryThresholds,
  serviceBaselineMb,
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
  profiles: 1,
  activeTurns: 0
}

/** One sample a minute from T0 (service up 10 min at the first), private memory from `mb(i)`, one service run. */
function series(minutes: number, mb: (i: number) => number, counts: (i: number) => Partial<ServiceCounts> = () => ({}), firstUp = 600): MemorySample[] {
  return Array.from({ length: minutes + 1 }, (_, i) => ({
    t: T0 + i * MIN,
    up: firstUp + i * 60,
    run: '100-1',
    service: { rss: mb(i) + 30, private: mb(i), heapUsed: 50, heapTotal: 70 },
    counts: { ...COUNTS, ...counts(i) }
  }))
}

const last = (history: MemorySample[]) => history[history.length - 1].t
const kinds = (history: MemorySample[]) => detectBreaches(history, DEFAULT_MEMORY_THRESHOLDS, last(history)).map((b) => b.kind)

describe('service limits', () => {
  it("flags the idle nightly's 306 MB service, and not while a turn runs", () => {
    const idle = series(20, () => 306)
    const [breach] = detectBreaches(idle, DEFAULT_MEMORY_THRESHOLDS, last(idle))
    expect(breach).toEqual({ kind: 'service-high', summary: 'Service 306 MB while idle, above 300 MB for 15 min' })
    const busy = series(20, () => 306, () => ({ activeTurns: 1 }))
    expect(kinds(busy)).toEqual([])
  })

  it('a spike does not count, nor a high stretch shorter than 15 minutes', () => {
    expect(kinds(series(20, (i) => (i === 19 ? 2_000 : 180)))).toEqual([])
    expect(kinds(series(20, (i) => (i >= 10 ? 700 : 180)))).toEqual([])
    expect(kinds(series(5, () => 900))).toEqual([])
  })

  it('a busy service is judged against 2.5 times its start, never below 250 MB', () => {
    // Idle at 150 MB in minutes 5 to 15, then busy at 600 MB for the last 15 minutes: above 375 MB.
    const busyAfter = (i: number) => (i <= 10 ? {} : { activeTurns: 2 })
    const grown = series(40, (i) => (i <= 10 ? 150 : 600), busyAfter, 300)
    expect(serviceBaselineMb(grown)).toBe(150)
    expect(detectBreaches(grown, DEFAULT_MEMORY_THRESHOLDS, last(grown))).toEqual([
      { kind: 'service-high', summary: 'Service 600 MB, above 2.5x its start (150 MB) for 15 min' }
    ])
    // Busy at 330 MB: within 2.5 times 150.
    expect(kinds(series(40, (i) => (i <= 10 ? 150 : 330), busyAfter, 300))).toEqual([])
    // A tiny start: the limit is 250 MB, not 2.5 times 60.
    expect(kinds(series(40, (i) => (i <= 10 ? 60 : 200), busyAfter, 300))).toEqual([])
    expect(kinds(series(40, (i) => (i <= 10 ? 60 : 260), busyAfter, 300))).toEqual(['service-high'])
  })

  it('reads the baseline from idle samples only, and caps it at 400 MB', () => {
    // A heavy turn in minutes 5 to 10 at 700 MB, idle at 150 MB in minutes 11 to 15.
    const heavyStart = series(40, (i) => (i <= 5 ? 700 : 150), (i) => (i <= 5 ? { activeTurns: 1 } : {}), 300)
    expect(serviceBaselineMb(heavyStart)).toBe(150)
    // An idle start at 700 MB counts only as 400 MB, so the limit is 1,000 MB, not 1,750.
    const bigStart = series(40, () => 700, () => ({}), 300)
    expect(serviceBaselineMb(bigStart)).toBe(400)
    // All busy: no baseline, so only the idle and severe limits apply.
    expect(serviceBaselineMb(series(40, () => 150, () => ({ activeTurns: 1 }), 300))).toBeNull()
  })

  it('uses the baseline the caller kept when the history no longer reaches back to the start', () => {
    // Six hours of a busy service at 600 MB, starting at minute 20 of the run: no early samples left.
    const late = series(360, () => 600, () => ({ activeTurns: 1 }), 20 * 60)
    expect(serviceBaselineMb(late)).toBeNull()
    expect(detectBreaches(late, DEFAULT_MEMORY_THRESHOLDS, last(late))).toEqual([])
    expect(detectBreaches(late, DEFAULT_MEMORY_THRESHOLDS, last(late), { baselineMb: 150 }).map((b) => b.kind)).toEqual(['service-high'])
  })

  it('a hung turn does not hide a leak: 800 MB for 15 minutes is a breach while a turn runs', () => {
    // Four hours with a turn running the whole time, at 900 MB and no baseline.
    const hung = series(240, () => 900, () => ({ activeTurns: 1 }), 0)
    expect(detectBreaches(hung, DEFAULT_MEMORY_THRESHOLDS, last(hung))).toEqual([
      { kind: 'service-high', summary: 'Service 900 MB, above 800 MB for 15 min', severe: true }
    ])
    // At 700 MB with a turn running and no baseline, nothing.
    expect(kinds(series(240, () => 700, () => ({ activeTurns: 1 }), 0))).toEqual([])
  })

  it('a restart in the window starts the count again', () => {
    const history = series(20, () => 700)
    for (const [i, sample] of history.entries()) if (i >= 15) { sample.run = '200-2'; sample.up = (i - 15) * 60 }
    expect(kinds(history)).toEqual([])
  })

  it('marks it severe above 800 MB', () => {
    const [breach] = detectBreaches(series(20, () => 900), DEFAULT_MEMORY_THRESHOLDS, last(series(20, () => 900)))
    expect(breach).toMatchObject({ kind: 'service-high', severe: true })
  })

  it('finds 20 MB/h of growth over 3 hours above 200 MB, and not a flat run with spikes', () => {
    // 120 MB to 270 MB over 3 hours, under the idle limit the whole time.
    const leak = series(180, (i) => 120 + (150 * i) / 180)
    expect(serviceGrowthMbPerHour(leak, DEFAULT_MEMORY_THRESHOLDS, last(leak))).toBeCloseTo(50, -1)
    expect(kinds(leak)).toEqual(['service-growth'])
    const slow = series(180, (i) => 220 + (45 * i) / 180)
    expect(kinds(slow)).toEqual([])
    const flat = series(180, (i) => (i % 30 === 0 ? 900 : 250))
    expect(Math.abs(serviceGrowthMbPerHour(flat, DEFAULT_MEMORY_THRESHOLDS, last(flat))!)).toBeLessThan(5)
    expect(kinds(flat)).toEqual([])
  })

  it('needs one service run for the growth check', () => {
    const leak = series(180, (i) => 120 + (150 * i) / 180)
    for (const sample of leak.slice(90)) sample.run = '300-3'
    expect(kinds(leak)).toEqual([])
  })

  it('reads older log lines without a run id by their start time, which a second of jitter does not move', () => {
    const history = series(20, () => 700).map(({ run: _run, ...sample }, i) => ({ ...sample, up: sample.up - (i % 2) }))
    expect(kinds(history)).toEqual(['service-high'])
  })
})

describe('counts', () => {
  it('a count above its bound for three samples in a row breaks it; one sample does not', () => {
    const [breach] = detectBreaches(series(5, () => 150, (i) => (i >= 3 ? { loadedThreads: 90 } : {})), DEFAULT_MEMORY_THRESHOLDS, T0 + 5 * MIN)
    expect(breach).toMatchObject({ kind: 'counts' })
    expect(breach.summary).toContain('loaded threads 90 (bound 40)')
    expect(kinds(series(5, () => 150, (i) => (i === 5 ? { workerThreads: 30 } : {})))).toEqual([])
  })

  it('bounds the replay buffer at 512 events a profile', () => {
    expect(kinds(series(5, () => 150, () => ({ replayEvents: 512 })))).toEqual([])
    expect(kinds(series(5, () => 150, () => ({ replayEvents: 900, profiles: 2 })))).toEqual([])
    const [breach] = detectBreaches(series(5, () => 150, () => ({ replayEvents: 513 })), DEFAULT_MEMORY_THRESHOLDS, T0 + 5 * MIN)
    expect(breach.summary).toContain('replay events 513 (bound 512)')
  })
})

describe('app process limits', () => {
  const app = (gpu: number, window: number) => [
    { kind: 'main' as const, role: 'main' as const, rss: 200, private: 149 },
    { kind: 'renderer' as const, role: 'window' as const, rss: window + 50, private: window },
    { kind: 'gpu' as const, role: 'gpu' as const, rss: gpu + 100, private: gpu },
    { kind: 'utility' as const, role: 'network' as const, rss: 40, private: 13 }
  ]

  it('checks each kind of app process against its own limit, the GPU process at 600 MB', () => {
    const busy = { activeTurns: 1 }
    expect(kinds(series(20, () => 150, () => busy).map((s) => ({ ...s, app: app(334, 221) })))).toEqual([])
    const gpu = series(20, () => 150, () => busy).map((s) => ({ ...s, app: app(700, 221) }))
    expect(detectBreaches(gpu, DEFAULT_MEMORY_THRESHOLDS, last(gpu))).toEqual([{ kind: 'gpu-high', summary: 'GPU process 700 MB, above 600 MB for 15 min' }])
    expect(kinds(series(20, () => 150, () => busy).map((s) => ({ ...s, app: app(334, 900) })))).toEqual(['renderer-high'])
    expect(kinds(series(20, () => 150, () => busy).map((s, i) => ({ ...s, app: app(i === 20 ? 1_500 : 334, 221) })))).toEqual([])
  })
})

describe('overrides', () => {
  it('takes limits from the environment in a checkout, and ignores anything not a limit', () => {
    const t = resolveMemoryThresholds('{"servicePrivateMb":50,"serviceSustainMinutes":0,"sampleIntervalMs":10,"counts":{"ptys":1},"processPrivateMb":{"gpu":100,"x":1},"evil":"x"}')
    expect(t).toMatchObject({ servicePrivateMb: 50, serviceSustainMinutes: 0, sampleIntervalMs: 1_000 })
    expect(t.counts.ptys).toBe(1)
    expect(t.processPrivateMb.gpu).toBe(100)
    expect(resolveMemoryThresholds('not json')).toEqual(DEFAULT_MEMORY_THRESHOLDS)
    const one = series(0, () => 80)
    expect(detectBreaches(one, t, last(one)).map((b) => b.kind)).toEqual(['service-high'])
  })

  it('a packaged build takes only an interval of 30 s or more', () => {
    const packaged = (override: string) => resolveMemoryThresholds(override, DEFAULT_MEMORY_THRESHOLDS, { packaged: true })
    expect(packaged('{"servicePrivateMb":1,"serviceSustainMinutes":0,"sampleIntervalMs":5000}')).toEqual(DEFAULT_MEMORY_THRESHOLDS)
    expect(packaged('{"sampleIntervalMs":120000,"processPrivateMb":{"gpu":1}}')).toEqual({ ...DEFAULT_MEMORY_THRESHOLDS, sampleIntervalMs: 120_000 })
    expect(isPackagedRuntime({ versions: { electron: '43.2.0' } })).toBe(true)
    expect(isPackagedRuntime({ versions: { electron: '43.2.0' }, defaultApp: true })).toBe(false)
    expect(isPackagedRuntime({ versions: {} })).toBe(false)
  })
})

describe('notice rate limit', () => {
  it('allows one notice a day, whatever its kind', () => {
    expect(noticeDue(undefined, T0)).toBe(true)
    expect(noticeDue(T0, T0 + 60 * MIN)).toBe(false)
    expect(noticeDue(T0, T0 + NOTICE_EVERY_MS)).toBe(true)
    // A clock set back does not silence it for good.
    expect(noticeDue(T0, T0 - MIN)).toBe(true)
  })
})

describe('memory issue text', () => {
  const history = series(20, () => 700)
  const sample: MemorySample = {
    ...history[history.length - 1],
    app: [
      { kind: 'main', role: 'main', rss: 210, private: 160, heapUsed: 40, heapTotal: 60, cpu: 1.5 },
      { kind: 'renderer', role: 'window', rss: 400, private: 350 },
      { kind: 'gpu', role: 'gpu', rss: 420, private: 334 }
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

  it('holds numbers, the version and the OS, and nothing personal', () => {
    expect(issue.title).toBe('Memory: Service 700 MB while idle, above 300 MB for 15 min')
    expect(issue.body).toContain('**Version:** 0.1.3-nightly.20261111')
    expect(issue.body).toContain('| Service | 700 | 730 | - | 50 | 70 |')
    expect(issue.body).toContain('| Provider: claude | - | 220 |')
    expect(issue.body).toContain('| Provider: other | - | 10 |')
    expect(issue.body).toContain('| Main | 160 | 210 | 1.5 | 40 | 60 |')
    expect(issue.body).toContain('| GPU | 334 | 420 |')
    expect(issue.body).toContain('**Service at start (idle, minutes 5 to 15):** 400 MB')
    expect(issue.body).toContain('applet views 2')
    expect(`${issue.title}\n${issue.body}\n${decodeURIComponent(issue.url)}`).not.toMatch(/alice|Users|home\/|\\/)
  })

  it('a report too long for a 2,000-character link opens a short issue that asks to paste it', () => {
    expect(issue.complete).toBe(false)
    expect(issue.url.length).toBeLessThanOrEqual(MAX_ISSUE_URL)
    expect(decodeURIComponent(issue.url)).toContain(PASTE_REPORT_TEXT)
    const short = memoryIssueLink('Memory report', 'Service 150 MB')
    expect(short.complete).toBe(true)
    expect(decodeURIComponent(short.url)).toBe('https://github.com/mousse-agent/mousse/issues/new?title=Memory report&body=Service 150 MB')
  })
})
